from pathlib import Path

import pytest

import app.main as main
from app.ollama_client import (
    ClassificationResult,
    OllamaClassificationError,
    validate_classification,
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


def test_malformed_model_output_is_not_accepted_as_metadata():
    with pytest.raises(OllamaClassificationError, match="must be a boolean"):
        validate_classification({"is_animal": "yes"}, "local-model")


def test_primary_failure_uses_local_fallback(monkeypatch):
    calls: list[str] = []

    def classify(_path: Path, model: str):
        calls.append(model)
        if model == main.AI_PRIMARY_MODEL:
            raise OllamaClassificationError("Ollama unavailable")
        return result(model)

    monkeypatch.setattr(main, "classify_image", classify)
    classified = main.classify_with_fallback(Path("unused.jpg"), 0.65)
    assert classified.model == main.AI_FALLBACK_MODEL
    assert calls == [main.AI_PRIMARY_MODEL, main.AI_FALLBACK_MODEL]


def test_low_confidence_primary_survives_fallback_failure(monkeypatch):
    primary = result(main.AI_PRIMARY_MODEL, confidence=0.4)

    def classify(_path: Path, model: str):
        if model == main.AI_PRIMARY_MODEL:
            return primary
        raise OllamaClassificationError("Malformed fallback output")

    monkeypatch.setattr(main, "classify_image", classify)
    assert main.classify_with_fallback(Path("unused.jpg"), 0.65) is primary
