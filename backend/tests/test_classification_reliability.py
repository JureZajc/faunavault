from __future__ import annotations

import pytest

from app.ollama_client import (
    ClassificationResult,
    OllamaAttemptContext,
    OllamaClassificationError,
)
from app.services.classification import (
    ClassificationServiceError,
    classify_with_fallback,
)


def result(model: str, confidence: float = 0.9) -> ClassificationResult:
    return ClassificationResult(
        is_animal=True,
        display_title="Red fox",
        common_name="fox",
        breed_guess=None,
        species_guess="Vulpes vulpes",
        category="mammal",
        confidence=confidence,
        description="A fox.",
        tags=["fox"],
        needs_review=confidence < 0.65,
        model=model,
    )


def transient_error(code: str = "ollama_timeout") -> OllamaClassificationError:
    return OllamaClassificationError(
        "Temporary failure.",
        code,
        category="read_timeout",
        retryable=True,
    )


def run_policy(classifier, fallback_model="fallback", **kwargs):
    return classify_with_fallback(
        "encoded-image",
        0.65,
        "primary",
        fallback_model,
        classifier,
        job_id=10,
        photo_id=20,
        sleeper=kwargs.pop("sleeper", lambda _seconds: None),
        **kwargs,
    )


def test_transient_primary_failure_retries_same_model_before_fallback():
    calls: list[tuple[str, OllamaAttemptContext]] = []
    sleeps: list[float] = []

    def classifier(_image, model, context):
        calls.append((model, context))
        if len(calls) == 1:
            raise transient_error()
        return result(model)

    outcome = run_policy(classifier, sleeper=sleeps.append)

    assert outcome.result.model == "primary"
    assert outcome.fallback_attempted is False
    assert [(model, item.role, item.request_attempt) for model, item in calls] == [
        ("primary", "primary", 1),
        ("primary", "primary", 2),
    ]
    assert sleeps == [2.0]


def test_exhausted_primary_and_fallback_each_have_one_bounded_retry():
    calls: list[tuple[str, int]] = []
    sleeps: list[float] = []

    def classifier(_image, model, context):
        calls.append((model, context.request_attempt))
        raise transient_error()

    with pytest.raises(ClassificationServiceError) as captured:
        run_policy(classifier, sleeper=sleeps.append)

    assert captured.value.code == "ollama_timeout"
    assert captured.value.fallback_attempted is True
    assert calls == [
        ("primary", 1),
        ("primary", 2),
        ("fallback", 1),
        ("fallback", 2),
    ]
    assert sleeps == [2.0, 2.0]


def test_model_unavailable_skips_primary_retry_and_uses_distinct_fallback():
    calls: list[tuple[str, int]] = []

    def classifier(_image, model, context):
        calls.append((model, context.request_attempt))
        if model == "primary":
            raise OllamaClassificationError(
                "Missing model.",
                "ollama_model_unavailable",
                category="http_model_unavailable",
            )
        return result(model)

    outcome = run_policy(classifier)
    assert outcome.result.model == "fallback"
    assert outcome.fallback_attempted is True
    assert calls == [("primary", 1), ("fallback", 1)]


def test_rejected_request_neither_retries_nor_falls_back():
    calls: list[str] = []

    def classifier(_image, model, _context):
        calls.append(model)
        raise OllamaClassificationError(
            "Rejected.",
            "ollama_request_rejected",
            category="http_request_rejected",
            fallback_eligible=False,
        )

    with pytest.raises(ClassificationServiceError) as captured:
        run_policy(classifier)
    assert captured.value.code == "ollama_request_rejected"
    assert captured.value.fallback_attempted is False
    assert calls == ["primary"]


def test_same_primary_and_fallback_has_no_fake_fallback_stage():
    calls: list[tuple[str, str, int]] = []

    def classifier(_image, model, context):
        calls.append((model, context.role, context.request_attempt))
        raise transient_error()

    with pytest.raises(ClassificationServiceError) as captured:
        run_policy(classifier, fallback_model="primary")
    assert captured.value.fallback_attempted is False
    assert calls == [
        ("primary", "primary", 1),
        ("primary", "primary", 2),
    ]


def test_low_confidence_fallback_failure_retains_primary_result():
    primary = result("primary", confidence=0.4)
    calls: list[tuple[str, int]] = []

    def classifier(_image, model, context):
        calls.append((model, context.request_attempt))
        if model == "primary":
            return primary
        raise transient_error("ollama_transient_failure")

    outcome = run_policy(classifier)
    assert outcome.result is primary
    assert outcome.fallback_attempted is True
    assert calls == [("primary", 1), ("fallback", 1), ("fallback", 2)]


def test_business_invalid_primary_skips_same_model_retry_but_allows_fallback():
    calls: list[str] = []

    def classifier(_image, model, _context):
        calls.append(model)
        if model == "primary":
            raise OllamaClassificationError(
                "Invalid metadata.",
                category="business_validation",
                retryable=False,
            )
        return result(model)

    outcome = run_policy(classifier)
    assert outcome.result.model == "fallback"
    assert calls == ["primary", "fallback"]


def test_eligibility_is_rechecked_before_retry_and_before_fallback():
    retry_calls = 0

    def transient_classifier(_image, _model, _context):
        nonlocal retry_calls
        retry_calls += 1
        raise transient_error()

    def changed():
        raise ClassificationServiceError("photo_changed", "Photo changed.")

    with pytest.raises(ClassificationServiceError) as retry_error:
        run_policy(transient_classifier, ensure_eligible=changed)
    assert retry_error.value.code == "photo_changed"
    assert retry_error.value.fallback_attempted is False
    assert retry_calls == 1

    fallback_calls = 0

    def missing_model(_image, _model, _context):
        nonlocal fallback_calls
        fallback_calls += 1
        raise OllamaClassificationError(
            "Missing model.",
            "ollama_model_unavailable",
            category="http_model_unavailable",
        )

    with pytest.raises(ClassificationServiceError) as fallback_error:
        run_policy(missing_model, ensure_eligible=changed)
    assert fallback_error.value.code == "photo_changed"
    assert fallback_error.value.fallback_attempted is False
    assert fallback_calls == 1
