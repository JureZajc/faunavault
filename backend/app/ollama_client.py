from __future__ import annotations

import base64
import json
import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)

ClassificationCategory = Literal[
    "mammal",
    "bird",
    "reptile",
    "amphibian",
    "fish",
    "insect",
    "arachnid",
    "mollusk",
    "crustacean",
    "unknown",
]
OllamaFailureCategory = Literal[
    "connect_timeout",
    "read_timeout",
    "transport_failure",
    "http_rate_limited",
    "http_server_failure",
    "http_model_unavailable",
    "http_request_rejected",
    "http_request_failed",
    "invalid_response",
    "business_validation",
]
OllamaModelRole = Literal["primary", "fallback"]

CLASSIFICATION_PROMPT = """
Analyze this animal photo and return concise classification metadata matching the supplied JSON schema.

Set category to exactly one broad biological group: mammal, bird, reptile, amphibian, fish, insect, arachnid, mollusk, or crustacean.
Choose the animal's known group even when its exact species is uncertain. Penguins and herons are birds; snakes, lizards, and geckos are reptiles; sharks and rays are fish.
Use category "unknown" only when no animal is visible or the broad group cannot be determined; then use lower confidence and needs_review true. Use is_animal false when no animal is visible.
display_title is a short user-facing title; prefer a clearly visible breed, type, or variety, otherwise use common_name.
common_name is the general animal name. species_guess is a biological or taxonomic species name when possible.
Keep breeds out of species_guess. Use "Canis lupus familiaris" for dogs, "Felis catus" for cats, "Equus ferus caballus" for horses, and "Bos taurus" for cows or cattle.
Put breed, coat, and context details in breed_guess, display_title, tags, or description.
Keep description to one sentence and return no more than eight concise tags.
""".strip()
CLASSIFICATION_PROMPT_VERSION = "animal-photo-v2"
AUTOMATIC_REQUEST_ATTEMPTS = 2
AUTOMATIC_RETRY_BACKOFF_SECONDS = 2.0


class ClassificationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    is_animal: bool
    display_title: str | None
    common_name: str
    breed_guess: str | None
    species_guess: str | None
    category: ClassificationCategory = Field(
        description=(
            "Broad biological group. Use unknown only when no animal is visible or "
            "the broad group cannot be determined."
        )
    )
    confidence: float = Field(ge=0, le=1)
    description: str
    tags: list[str]
    needs_review: bool


@dataclass(frozen=True)
class ClassificationResult:
    is_animal: bool
    display_title: str | None
    common_name: str
    breed_guess: str | None
    species_guess: str
    category: str
    confidence: float
    description: str
    tags: list[str]
    needs_review: bool
    model: str


@dataclass(frozen=True)
class OllamaAttemptContext:
    job_id: int
    photo_id: int
    role: OllamaModelRole
    request_attempt: int


class OllamaClassificationError(RuntimeError):
    def __init__(
        self,
        message: str,
        code: str = "invalid_model_response",
        *,
        category: OllamaFailureCategory = "invalid_response",
        retryable: bool = False,
        fallback_eligible: bool = True,
        status_code: int | None = None,
        server_detail: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.category = category
        self.retryable = retryable
        self.fallback_eligible = fallback_eligible
        self.status_code = status_code
        self.server_detail = server_detail


def encode_classification_image(image_path: Path) -> str:
    try:
        image_bytes = image_path.read_bytes()
    except OSError as exc:
        raise OllamaClassificationError(
            "The image could not be read for classification.",
            "image_unavailable",
            category="business_validation",
            fallback_eligible=False,
        ) from exc
    return base64.b64encode(image_bytes).decode("ascii")


def _normalized_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _result_from_response(
    response: ClassificationResponse, model: str
) -> ClassificationResult:
    display_title = _normalized_optional_text(response.display_title)
    common_name = response.common_name.strip()
    breed_guess = _normalized_optional_text(response.breed_guess)
    species_guess = _normalized_optional_text(response.species_guess)
    description = response.description.strip()
    tags = [tag.strip() for tag in response.tags if tag.strip()]
    needs_review = response.needs_review

    if response.is_animal and (not common_name or not description):
        raise OllamaClassificationError(
            "Ollama returned incomplete animal classification metadata.",
            category="business_validation",
            retryable=False,
        )

    if not species_guess or species_guess.casefold() == "unknown":
        species_guess = "unknown"
        needs_review = True

    category = response.category
    if not response.is_animal:
        display_title = display_title or "Not an animal"
        common_name = common_name or "Not an animal"
        breed_guess = None
        category = "unknown"
        needs_review = True

    return ClassificationResult(
        is_animal=response.is_animal,
        display_title=display_title,
        common_name=common_name,
        breed_guess=breed_guess,
        species_guess=species_guess,
        category=category,
        confidence=response.confidence,
        description=description,
        tags=tags,
        needs_review=needs_review,
        model=model,
    )


def validate_classification(data: dict, model: str) -> ClassificationResult:
    try:
        response = ClassificationResponse.model_validate(data)
    except ValidationError as exc:
        raise OllamaClassificationError(
            "Ollama returned a classification response that did not match the schema.",
            category="invalid_response",
            retryable=True,
        ) from exc
    return _result_from_response(response, model)


def validate_classification_json(text: str, model: str) -> ClassificationResult:
    try:
        response = ClassificationResponse.model_validate_json(text)
    except ValidationError as exc:
        raise OllamaClassificationError(
            "Ollama returned a classification response that did not match the schema.",
            category="invalid_response",
            retryable=True,
        ) from exc
    return _result_from_response(response, model)


def _sanitized_error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except (json.JSONDecodeError, ValueError):
        body = None
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        detail = body["error"]
    else:
        detail = response.text or response.reason_phrase
    return " ".join(detail.split())[:500]


def _duration_milliseconds(body: dict, key: str) -> float | None:
    value = body.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return round(value / 1_000_000, 3)


def _optional_count(body: dict, key: str) -> int | None:
    value = body.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        *,
        connect_timeout_seconds: float,
        request_timeout_seconds: float,
        keep_alive: str,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.connect_timeout_seconds = connect_timeout_seconds
        self.request_timeout_seconds = request_timeout_seconds
        self.keep_alive = keep_alive
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(
                connect=connect_timeout_seconds,
                read=request_timeout_seconds,
                write=request_timeout_seconds,
                pool=connect_timeout_seconds,
            ),
            transport=transport,
        )
        self._lock = threading.Lock()
        self._closed = False

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._client.close()

    def classify_image(
        self,
        image_base64: str,
        model: str,
        context: OllamaAttemptContext,
    ) -> ClassificationResult:
        payload = {
            "model": model,
            "prompt": CLASSIFICATION_PROMPT,
            "images": [image_base64],
            "stream": False,
            "format": ClassificationResponse.model_json_schema(),
            "think": False,
            "keep_alive": self.keep_alive,
            "options": {"temperature": 0},
        }
        started = time.monotonic()
        try:
            response = self._client.post("/api/generate", json=payload)
            response.raise_for_status()
        except httpx.ConnectTimeout as exc:
            error = OllamaClassificationError(
                "The connection to Ollama timed out. Check that it is running.",
                "ollama_unavailable",
                category="connect_timeout",
                retryable=True,
            )
            self._log_failure(context, model, error)
            raise error from exc
        except httpx.ReadTimeout as exc:
            error = OllamaClassificationError(
                "Ollama did not complete classification before the timeout.",
                "ollama_timeout",
                category="read_timeout",
                retryable=True,
            )
            self._log_failure(context, model, error)
            raise error from exc
        except httpx.TimeoutException as exc:
            error = OllamaClassificationError(
                "The Ollama classification request timed out.",
                "ollama_transient_failure",
                category="transport_failure",
                retryable=True,
            )
            self._log_failure(context, model, error)
            raise error from exc
        except httpx.ConnectError as exc:
            error = OllamaClassificationError(
                "Could not connect to Ollama. Check that it is running.",
                "ollama_unavailable",
                category="transport_failure",
                retryable=True,
            )
            self._log_failure(context, model, error)
            raise error from exc
        except httpx.HTTPStatusError as exc:
            error = self._status_error(exc.response)
            self._log_failure(context, model, error)
            raise error from exc
        except httpx.RequestError as exc:
            error = OllamaClassificationError(
                "The connection to Ollama was interrupted.",
                "ollama_transient_failure",
                category="transport_failure",
                retryable=True,
            )
            self._log_failure(context, model, error)
            raise error from exc

        elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
        try:
            body = response.json()
        except (json.JSONDecodeError, ValueError) as exc:
            error = OllamaClassificationError(
                "Ollama returned an invalid response.",
                category="invalid_response",
                retryable=True,
            )
            self._log_failure(context, model, error)
            raise error from exc
        if not isinstance(body, dict):
            error = OllamaClassificationError(
                "Ollama returned an invalid response.",
                category="invalid_response",
                retryable=True,
            )
            self._log_failure(context, model, error)
            raise error

        model_text = body.get("response")
        output_channel = "response"
        if not isinstance(model_text, str) or not model_text.strip():
            thinking_text = body.get("thinking")
            if isinstance(thinking_text, str) and thinking_text.strip():
                model_text = thinking_text
                output_channel = "thinking"
            else:
                error = OllamaClassificationError(
                    "Ollama response did not include classification metadata.",
                    category="invalid_response",
                    retryable=True,
                )
                self._log_failure(context, model, error)
                raise error
        try:
            result = validate_classification_json(model_text, model)
        except OllamaClassificationError as error:
            self._log_failure(context, model, error)
            raise
        self._log_success(context, model, body, elapsed_ms, output_channel)
        return result

    def _status_error(self, response: httpx.Response) -> OllamaClassificationError:
        status_code = response.status_code
        detail = _sanitized_error_detail(response)
        if status_code == 404:
            return OllamaClassificationError(
                "The configured Ollama model is unavailable.",
                "ollama_model_unavailable",
                category="http_model_unavailable",
                fallback_eligible=True,
                status_code=status_code,
                server_detail=detail,
            )
        if status_code == 408:
            return OllamaClassificationError(
                "Ollama reported that the classification request timed out.",
                "ollama_timeout",
                category="read_timeout",
                retryable=True,
                status_code=status_code,
                server_detail=detail,
            )
        if status_code == 429:
            return OllamaClassificationError(
                "Ollama is temporarily busy. Classification can be retried.",
                "ollama_transient_failure",
                category="http_rate_limited",
                retryable=True,
                status_code=status_code,
                server_detail=detail,
            )
        if status_code in {500, 502, 503, 504}:
            return OllamaClassificationError(
                "Ollama reported a temporary model or server failure.",
                "ollama_transient_failure",
                category="http_server_failure",
                retryable=True,
                status_code=status_code,
                server_detail=detail,
            )
        if status_code in {400, 401, 403, 405, 409, 422}:
            return OllamaClassificationError(
                "Ollama rejected FaunaVault's classification request.",
                "ollama_request_rejected",
                category="http_request_rejected",
                fallback_eligible=False,
                status_code=status_code,
                server_detail=detail,
            )
        return OllamaClassificationError(
            "The Ollama classification request failed.",
            "ollama_request_failed",
            category="http_request_failed",
            fallback_eligible=False,
            status_code=status_code,
            server_detail=detail,
        )

    def _log_failure(
        self,
        context: OllamaAttemptContext,
        model: str,
        error: OllamaClassificationError,
    ) -> None:
        logger.warning(
            "Ollama classification request failed "
            "job_id=%s photo_id=%s role=%s model=%s request_attempt=%s "
            "category=%s code=%s status_code=%s request_timeout_seconds=%s "
            "connect_timeout_seconds=%s server_detail=%r",
            context.job_id,
            context.photo_id,
            context.role,
            model,
            context.request_attempt,
            error.category,
            error.code,
            error.status_code,
            self.request_timeout_seconds,
            self.connect_timeout_seconds,
            error.server_detail,
        )

    def _log_success(
        self,
        context: OllamaAttemptContext,
        model: str,
        body: dict,
        elapsed_ms: int,
        output_channel: str,
    ) -> None:
        logger.info(
            "Ollama classification response received "
            "job_id=%s photo_id=%s role=%s model=%s request_attempt=%s "
            "elapsed_ms=%s total_duration_ms=%s load_duration_ms=%s "
            "prompt_eval_duration_ms=%s eval_duration_ms=%s "
            "prompt_eval_count=%s eval_count=%s output_channel=%s",
            context.job_id,
            context.photo_id,
            context.role,
            model,
            context.request_attempt,
            elapsed_ms,
            _duration_milliseconds(body, "total_duration"),
            _duration_milliseconds(body, "load_duration"),
            _duration_milliseconds(body, "prompt_eval_duration"),
            _duration_milliseconds(body, "eval_duration"),
            _optional_count(body, "prompt_eval_count"),
            _optional_count(body, "eval_count"),
            output_channel,
        )
