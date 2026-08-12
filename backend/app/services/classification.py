from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.models import Photo, utc_now
from app.ollama_client import (
    ClassificationResult,
    OllamaClassificationError,
    classify_image,
)

DOMESTIC_SPECIES_BY_COMMON_NAME = {
    "dog": "Canis lupus familiaris",
    "cat": "Felis catus",
    "horse": "Equus ferus caballus",
    "cow": "Bos taurus",
    "cattle": "Bos taurus",
}
DOG_BREED_GUESSES = {
    "beagle",
    "bernese mountain dog",
    "border collie",
    "boxer",
    "bulldog",
    "chihuahua",
    "cocker spaniel",
    "dachshund",
    "doberman pinscher",
    "french bulldog",
    "german shepherd",
    "golden retriever",
    "great dane",
    "labrador retriever",
    "poodle",
    "pug",
    "rottweiler",
    "shiba inu",
    "siberian husky",
    "yorkshire terrier",
}


class ClassificationServiceError(RuntimeError):
    def __init__(self, code: str, message: str, fallback_attempted: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.fallback_attempted = fallback_attempted


@dataclass(frozen=True)
class ClassificationOutcome:
    result: ClassificationResult
    fallback_attempted: bool


def normalize_tags(tags: list[str] | None) -> list[str]:
    if tags is None:
        return []
    return [tag.strip() for tag in tags if tag.strip()]


def normalize_metadata_text(value: str | None) -> str | None:
    if value is None:
        return None
    stripped_value = value.strip()
    return stripped_value or None


def normalized_lookup(value: str | None) -> str:
    normalized_value = normalize_metadata_text(value)
    return normalized_value.lower() if normalized_value is not None else ""


def canonical_common_name(value: str | None) -> str | None:
    lookup_value = normalized_lookup(value)
    if lookup_value in {"dog", "domestic dog", "canine"}:
        return "dog"
    if lookup_value in {"cat", "domestic cat", "feline"}:
        return "cat"
    if lookup_value in {"horse", "domestic horse"}:
        return "horse"
    if lookup_value in {"cow", "cattle", "domestic cow", "domestic cattle"}:
        return "cow"
    return normalize_metadata_text(value)


def apply_domestic_metadata_normalization(photo: Photo) -> None:
    common_name = canonical_common_name(photo.common_name)
    species_guess = normalize_metadata_text(photo.species_guess)
    breed_guess = normalize_metadata_text(photo.breed_guess)
    display_title = normalize_metadata_text(photo.display_title)

    photo.common_name = common_name
    photo.species_guess = species_guess
    photo.breed_guess = breed_guess
    photo.display_title = display_title

    if common_name is None:
        return

    common_lookup = normalized_lookup(common_name)
    expected_species = DOMESTIC_SPECIES_BY_COMMON_NAME.get(common_lookup)
    if expected_species is None:
        return

    species_is_expected = normalized_lookup(species_guess) == expected_species.lower()
    if common_lookup == "dog" and species_guess and not species_is_expected:
        if normalized_lookup(species_guess) in DOG_BREED_GUESSES:
            photo.breed_guess = breed_guess or species_guess
            photo.display_title = display_title or species_guess

    if common_lookup == "horse" and species_guess and not species_is_expected:
        photo.breed_guess = breed_guess or species_guess
        photo.display_title = display_title or species_guess

    photo.species_guess = expected_species
    photo.category = "mammal"


def normalize_existing_domestic_metadata(engine: Engine) -> None:
    with Session(engine) as session:
        photos = list(session.exec(select(Photo)).all())
        has_changes = False
        for photo in photos:
            original_metadata = (
                photo.display_title,
                photo.common_name,
                photo.breed_guess,
                photo.species_guess,
                photo.category,
            )
            apply_domestic_metadata_normalization(photo)
            next_metadata = (
                photo.display_title,
                photo.common_name,
                photo.breed_guess,
                photo.species_guess,
                photo.category,
            )
            if next_metadata != original_metadata:
                photo.updated_at = utc_now()
                session.add(photo)
                has_changes = True
        if has_changes:
            session.commit()


def classification_image_path(photo: Photo, settings: Settings) -> Path:
    resized_path = settings.image_dirs["resized"] / Path(photo.resized_filename).name
    if resized_path.is_file():
        return resized_path

    original_path = settings.image_dirs["original"] / Path(photo.stored_filename).name
    if original_path.is_file():
        return original_path

    raise ClassificationServiceError(
        "image_unavailable", "No image file is available for classification."
    )


def classify_with_fallback(
    image_path: Path,
    threshold: float,
    primary_model: str,
    fallback_model: str,
    classifier: Callable[[Path, str], ClassificationResult] = classify_image,
) -> ClassificationOutcome:
    primary_result: ClassificationResult | None = None
    primary_error: OllamaClassificationError | None = None

    try:
        primary_result = classifier(image_path, primary_model)
    except OllamaClassificationError as exc:
        primary_error = exc

    should_try_fallback = (
        primary_result is None or primary_result.confidence < threshold
    )
    fallback_attempted = should_try_fallback and fallback_model != primary_model
    fallback_error: OllamaClassificationError | None = None
    if fallback_attempted:
        try:
            return ClassificationOutcome(
                result=classifier(image_path, fallback_model),
                fallback_attempted=True,
            )
        except OllamaClassificationError as exc:
            fallback_error = exc

    if primary_result is not None:
        return ClassificationOutcome(
            result=primary_result,
            fallback_attempted=fallback_attempted,
        )

    failure = fallback_error or primary_error
    if failure is not None:
        raise ClassificationServiceError(
            failure.code, str(failure), fallback_attempted
        ) from failure
    raise ClassificationServiceError(
        "classification_internal_error", "Classification failed unexpectedly."
    )


def classify_photo_image(
    image_path: Path,
    settings: Settings,
    classifier: Callable[[Path, str], ClassificationResult] = classify_image,
) -> ClassificationOutcome:
    return classify_with_fallback(
        image_path,
        settings.ai_confidence_threshold,
        settings.ai_primary_model,
        settings.ai_fallback_model,
        classifier,
    )


def apply_classification(
    photo: Photo, result: ClassificationResult, threshold: float
) -> None:
    photo.display_title = result.display_title
    photo.common_name = result.common_name
    photo.breed_guess = result.breed_guess
    photo.species_guess = result.species_guess
    photo.category = result.category
    photo.confidence = result.confidence
    photo.description = result.description
    photo.tags = result.tags
    apply_domestic_metadata_normalization(photo)
    photo.status = (
        "classified"
        if result.is_animal
        and not result.needs_review
        and result.confidence >= threshold
        else "needs_review"
    )
    photo.updated_at = utc_now()
