import base64
import json
import logging
from dataclasses import dataclass
from json import JSONDecodeError
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)
OLLAMA_BASE_URL = settings.ollama_base_url.rstrip("/")
AI_PRIMARY_MODEL = settings.ai_primary_model
AI_FALLBACK_MODEL = settings.ai_fallback_model

ALLOWED_CATEGORIES = {
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
}

CLASSIFICATION_PROMPT = """
Analyze this animal photo and return only valid JSON with this exact shape:
{
  "is_animal": true,
  "display_title": "...",
  "common_name": "...",
  "breed_guess": null,
  "species_guess": "...",
  "category": "mammal | bird | reptile | amphibian | fish | insect | arachnid | mollusk | crustacean | unknown",
  "confidence": 0.0,
  "description": "...",
  "tags": ["..."],
  "needs_review": false
}

Use category "unknown", lower confidence, and needs_review true if you are uncertain.
Use is_animal false when the image does not appear to contain an animal.
display_title is the short user-facing album title. Prefer the breed/type/variety when clearly visible, otherwise use common_name.
common_name is the general animal name, such as dog, cat, horse, cow, cattle, lion, or cattle egret.
breed_guess is for breed/type/variety, especially domestic animals. Use null when unsure.
species_guess must be a biological/taxonomic species name when possible.
Do not put dog breeds into species_guess. For dogs use species_guess "Canis lupus familiaris"; for cats use "Felis catus"; for horses use "Equus ferus caballus"; for cows or cattle use "Bos taurus".
Horse breeds, coat colors, riding context, or stable context belong in breed_guess, display_title, tags, or description, not species_guess.
Do not include markdown, code fences, or explanatory text.
""".strip()
CLASSIFICATION_PROMPT_VERSION = "animal-photo-v1"
OLLAMA_CONNECT_TIMEOUT_SECONDS = 10.0
OLLAMA_REQUEST_TIMEOUT_SECONDS = 120.0


class OllamaClassificationError(RuntimeError):
    def __init__(self, message: str, code: str = "invalid_model_response"):
        super().__init__(message)
        self.code = code


def response_error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except JSONDecodeError:
        body = None

    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return body["error"]

    text = response.text.strip()
    return text or response.reason_phrase


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


def classify_image(image_path: Path, model: str) -> ClassificationResult:
    try:
        image_base64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    except OSError as exc:
        raise OllamaClassificationError(
            "The image could not be read for classification.", "image_unavailable"
        ) from exc
    payload = {
        "model": model,
        "prompt": CLASSIFICATION_PROMPT,
        "images": [image_base64],
        "stream": False,
        "options": {
            "temperature": 0.1,
        },
    }

    try:
        response = httpx.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json=payload,
            timeout=httpx.Timeout(
                OLLAMA_REQUEST_TIMEOUT_SECONDS,
                connect=OLLAMA_CONNECT_TIMEOUT_SECONDS,
            ),
        )
        response.raise_for_status()
    except httpx.ConnectError as exc:
        logger.warning(
            "Could not connect to Ollama at %s for %s", OLLAMA_BASE_URL, model
        )
        raise OllamaClassificationError(
            "Could not connect to Ollama. Check that it is running.",
            "ollama_unavailable",
        ) from exc
    except httpx.TimeoutException as exc:
        raise OllamaClassificationError(
            "Ollama did not respond before the classification timeout.",
            "ollama_timeout",
        ) from exc
    except httpx.HTTPStatusError as exc:
        detail = response_error_detail(exc.response)
        logger.warning(
            "Ollama returned %s for %s: %s",
            exc.response.status_code,
            model,
            detail,
        )
        if exc.response.status_code == 404:
            raise OllamaClassificationError(
                "The configured Ollama model is unavailable.",
                "ollama_model_unavailable",
            ) from exc
        raise OllamaClassificationError(
            "Ollama rejected the classification request.",
            "ollama_request_failed",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning("Ollama request failed at %s for %s", OLLAMA_BASE_URL, model)
        raise OllamaClassificationError(
            "The Ollama classification request failed.",
            "ollama_request_failed",
        ) from exc

    try:
        body = response.json()
    except JSONDecodeError as exc:
        raise OllamaClassificationError(
            "Ollama returned an invalid JSON response"
        ) from exc

    model_text = body.get("response")
    if not isinstance(model_text, str) or not model_text.strip():
        raise OllamaClassificationError(
            "Ollama response did not include classification text"
        )

    parsed = extract_json_object(model_text)
    return validate_classification(parsed, model)


def extract_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[index:])
        except JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise OllamaClassificationError(
        "Model response did not contain a valid JSON object"
    )


def validate_classification(data: dict[str, Any], model: str) -> ClassificationResult:
    is_animal = require_bool(data, "is_animal")
    display_title = optional_string(data, "display_title")
    common_name = require_string(data, "common_name")
    breed_guess = optional_string(data, "breed_guess")
    species_guess = require_string(data, "species_guess")
    category = require_string(data, "category").lower()
    confidence = require_number(data, "confidence")
    description = require_string(data, "description")
    tags = require_string_list(data, "tags")
    needs_review = require_bool(data, "needs_review")

    if category not in ALLOWED_CATEGORIES:
        raise OllamaClassificationError(
            f"Model returned unsupported category: {category}"
        )

    if confidence < 0 or confidence > 1:
        raise OllamaClassificationError(
            "Model returned confidence outside the 0.0 to 1.0 range"
        )

    if not is_animal:
        display_title = display_title or "Not an animal"
        common_name = common_name or "Not an animal"
        breed_guess = None
        species_guess = species_guess or "unknown"
        category = "unknown"
        needs_review = True

    return ClassificationResult(
        is_animal=is_animal,
        display_title=display_title,
        common_name=common_name,
        breed_guess=breed_guess,
        species_guess=species_guess,
        category=category,
        confidence=confidence,
        description=description,
        tags=tags,
        needs_review=needs_review,
        model=model,
    )


def require_bool(data: dict[str, Any], key: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise OllamaClassificationError(f"Model JSON field {key!r} must be a boolean")
    return value


def require_string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise OllamaClassificationError(f"Model JSON field {key!r} must be a string")
    return value.strip()


def optional_string(data: dict[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise OllamaClassificationError(
            f"Model JSON field {key!r} must be a string or null"
        )
    stripped_value = value.strip()
    return stripped_value or None


def require_number(data: dict[str, Any], key: str) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OllamaClassificationError(f"Model JSON field {key!r} must be a number")
    return float(value)


def require_string_list(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key)
    if not isinstance(value, list):
        raise OllamaClassificationError(f"Model JSON field {key!r} must be a list")

    tags: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise OllamaClassificationError(
                f"Model JSON field {key!r} must contain only strings"
            )
        tag = item.strip()
        if tag:
            tags.append(tag)
    return tags
