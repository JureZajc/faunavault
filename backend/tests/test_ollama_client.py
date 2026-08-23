from __future__ import annotations

import json
import logging

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.ollama_client import (
    CLASSIFICATION_PROMPT,
    CLASSIFICATION_PROMPT_VERSION,
    OllamaAttemptContext,
    OllamaClassificationError,
    OllamaClient,
    validate_classification,
)


def classification_payload(**overrides) -> dict:
    payload = {
        "is_animal": True,
        "display_title": "Red fox",
        "common_name": "fox",
        "breed_guess": None,
        "species_guess": "Vulpes vulpes",
        "category": "mammal",
        "confidence": 0.91,
        "description": "A red fox standing in a field.",
        "tags": ["fox", "wildlife"],
        "needs_review": False,
    }
    return {**payload, **overrides}


def context(attempt: int = 1) -> OllamaAttemptContext:
    return OllamaAttemptContext(
        job_id=11,
        photo_id=22,
        role="primary",
        request_attempt=attempt,
    )


def test_ollama_settings_defaults_environment_and_validation(monkeypatch):
    defaults = Settings(_env_file=None)
    assert defaults.ollama_connect_timeout_seconds == 5.0
    assert defaults.ollama_request_timeout_seconds == 180.0
    assert defaults.ollama_keep_alive == "15m"

    monkeypatch.setenv("OLLAMA_CONNECT_TIMEOUT_SECONDS", "7.5")
    monkeypatch.setenv("OLLAMA_REQUEST_TIMEOUT_SECONDS", "240")
    monkeypatch.setenv("OLLAMA_KEEP_ALIVE", "0")
    overridden = Settings(_env_file=None)
    assert overridden.ollama_connect_timeout_seconds == 7.5
    assert overridden.ollama_request_timeout_seconds == 240.0
    assert overridden.ollama_keep_alive == "0"

    for field, value in (
        ("ollama_connect_timeout_seconds", 0),
        ("ollama_request_timeout_seconds", -1),
        ("ollama_request_timeout_seconds", float("inf")),
        ("ollama_keep_alive", ""),
        ("ollama_keep_alive", "-1"),
        ("ollama_keep_alive", "0m"),
        ("ollama_keep_alive", "forever"),
    ):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, **{field: value})


def test_outgoing_structured_payload_timeouts_and_timing_logs(caplog):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content)
        captured["timeouts"] = request.extensions["timeout"]
        return httpx.Response(
            200,
            json={
                "response": json.dumps(classification_payload()),
                "total_duration": 3_000_000_000,
                "load_duration": 1_000_000_000,
                "prompt_eval_duration": 1_200_000_000,
                "eval_duration": 800_000_000,
                "prompt_eval_count": 42,
                "eval_count": 18,
            },
        )

    client = OllamaClient(
        "http://ollama.invalid/",
        connect_timeout_seconds=5,
        request_timeout_seconds=180,
        keep_alive="15m",
        transport=httpx.MockTransport(handler),
    )
    with caplog.at_level(logging.INFO):
        result = client.classify_image("encoded-image", "qwen3-vl:8b", context())

    assert result.model == "qwen3-vl:8b"
    assert result.species_guess == "Vulpes vulpes"
    payload = captured["payload"]
    assert payload["model"] == "qwen3-vl:8b"
    assert payload["prompt"] == CLASSIFICATION_PROMPT
    assert "exact shape" not in payload["prompt"]
    assert "Penguins and herons are birds" in payload["prompt"]
    assert "sharks and rays are fish" in payload["prompt"]
    assert 'category "unknown" only' in payload["prompt"]
    assert payload["images"] == ["encoded-image"]
    assert payload["stream"] is False
    assert payload["think"] is False
    assert payload["keep_alive"] == "15m"
    assert payload["options"] == {"temperature": 0}
    assert "num_predict" not in payload["options"]
    assert payload["format"]["additionalProperties"] is False
    assert (
        "Broad biological group"
        in payload["format"]["properties"]["category"]["description"]
    )
    assert set(payload["format"]["required"]) == {
        "is_animal",
        "display_title",
        "common_name",
        "breed_guess",
        "species_guess",
        "category",
        "confidence",
        "description",
        "tags",
        "needs_review",
    }
    assert captured["timeouts"] == {
        "connect": 5,
        "read": 180,
        "write": 180,
        "pool": 5,
    }
    assert "load_duration_ms=1000.0" in caplog.text
    assert "prompt_eval_count=42" in caplog.text
    assert CLASSIFICATION_PROMPT_VERSION == "animal-photo-v2"
    client.close()
    client.close()
    assert client.closed is True


def test_strict_structured_output_accepts_qwen_thinking_channel_compatibility(
    caplog,
):
    client = OllamaClient(
        "http://ollama.invalid",
        connect_timeout_seconds=5,
        request_timeout_seconds=180,
        keep_alive="15m",
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={
                    "response": "",
                    "thinking": json.dumps(classification_payload()),
                },
            )
        ),
    )

    with caplog.at_level(logging.INFO):
        result = client.classify_image("encoded", "model", context())

    assert result.common_name == "fox"
    assert "output_channel=thinking" in caplog.text
    client.close()


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"response": "", "thinking": ""},
        {"response": "", "thinking": "not structured JSON"},
    ],
)
def test_missing_or_invalid_output_channels_remain_retryable(body):
    client = OllamaClient(
        "http://ollama.invalid",
        connect_timeout_seconds=5,
        request_timeout_seconds=180,
        keep_alive="15m",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=body)),
    )

    with pytest.raises(OllamaClassificationError) as captured:
        client.classify_image("encoded", "model", context())

    assert captured.value.code == "invalid_model_response"
    assert captured.value.retryable is True
    client.close()


@pytest.mark.parametrize(
    ("status_code", "expected_code", "retryable", "fallback_eligible"),
    [
        (400, "ollama_request_rejected", False, False),
        (401, "ollama_request_rejected", False, False),
        (403, "ollama_request_rejected", False, False),
        (404, "ollama_model_unavailable", False, True),
        (405, "ollama_request_rejected", False, False),
        (408, "ollama_timeout", True, True),
        (409, "ollama_request_rejected", False, False),
        (418, "ollama_request_failed", False, False),
        (429, "ollama_transient_failure", True, True),
        (500, "ollama_transient_failure", True, True),
        (502, "ollama_transient_failure", True, True),
        (503, "ollama_transient_failure", True, True),
        (504, "ollama_transient_failure", True, True),
        (422, "ollama_request_rejected", False, False),
        (501, "ollama_request_failed", False, False),
    ],
)
def test_http_statuses_have_explicit_retry_and_fallback_policy(
    status_code, expected_code, retryable, fallback_eligible
):
    client = OllamaClient(
        "http://ollama.invalid",
        connect_timeout_seconds=5,
        request_timeout_seconds=180,
        keep_alive="15m",
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                status_code,
                json={"error": "server detail\nwith a second line"},
            )
        ),
    )
    with pytest.raises(OllamaClassificationError) as captured:
        client.classify_image("encoded", "model", context())
    assert captured.value.code == expected_code
    assert captured.value.retryable is retryable
    assert captured.value.fallback_eligible is fallback_eligible
    assert captured.value.status_code == status_code
    assert captured.value.server_detail == "server detail with a second line"
    client.close()


@pytest.mark.parametrize(
    ("exception_factory", "expected_code", "expected_category"),
    [
        (
            lambda request: httpx.ConnectTimeout("connect", request=request),
            "ollama_unavailable",
            "connect_timeout",
        ),
        (
            lambda request: httpx.ReadTimeout("read", request=request),
            "ollama_timeout",
            "read_timeout",
        ),
        (
            lambda request: httpx.ConnectError("refused", request=request),
            "ollama_unavailable",
            "transport_failure",
        ),
        (
            lambda request: httpx.ReadError("reset", request=request),
            "ollama_transient_failure",
            "transport_failure",
        ),
    ],
)
def test_transport_failures_are_retryable(
    exception_factory, expected_code, expected_category
):
    def handler(request: httpx.Request) -> httpx.Response:
        raise exception_factory(request)

    client = OllamaClient(
        "http://ollama.invalid",
        connect_timeout_seconds=5,
        request_timeout_seconds=180,
        keep_alive="15m",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(OllamaClassificationError) as captured:
        client.classify_image("encoded", "model", context())
    assert captured.value.code == expected_code
    assert captured.value.category == expected_category
    assert captured.value.retryable is True
    client.close()


def test_structured_response_validation_distinguishes_shape_and_business_rules():
    with pytest.raises(OllamaClassificationError) as schema_error:
        validate_classification(classification_payload(category="unsupported"), "model")
    assert schema_error.value.category == "invalid_response"
    assert schema_error.value.retryable is True

    with pytest.raises(OllamaClassificationError) as business_error:
        validate_classification(
            classification_payload(common_name=" ", description=""), "model"
        )
    assert business_error.value.category == "business_validation"
    assert business_error.value.retryable is False

    normalized = validate_classification(
        classification_payload(species_guess="unknown", needs_review=False), "model"
    )
    assert normalized.species_guess == "unknown"
    assert normalized.needs_review is True
