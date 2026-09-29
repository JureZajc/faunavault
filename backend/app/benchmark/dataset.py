from __future__ import annotations

import hashlib
import random
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import Engine

from app.album_identity import normalize_legacy_species_group
from app.models import Animal, Photo, Taxon

DATASET_VERSION = 1
SEED = 20260929
BATCH_SIZE = 1000
BASE_TIME = datetime(2026, 9, 1)
SPECIES = (
    ("Red fox", "Vulpes vulpes", "mammal", "Canidae", 30),
    ("Roe deer", "Capreolus capreolus", "mammal", "Cervidae", 20),
    ("Tawny owl", "Strix aluco", "bird", "Strigidae", 25),
    ("Robin", "Erithacus rubecula", "bird", "Muscicapidae", 12),
    ("Honey bee", "Apis mellifera", "insect", "Apidae", 7),
    ("Common frog", "Rana temporaria", "amphibian", "Ranidae", 3),
    ("Sand lizard", "Lacerta agilis", "reptile", "Lacertidae", 2),
    ("Common carp", "Cyprinus carpio", "fish", "Cyprinidae", 1),
)


@dataclass
class Dataset:
    photos: list[dict]
    animals: dict[int, dict]
    taxa: dict[int, dict]

    def distributions(self) -> dict:
        active = [row for row in self.photos if row["deleted_at"] is None]
        return {
            "photos": len(self.photos),
            "active": len(active),
            "trash": len(self.photos) - len(active),
            "animals": len(self.animals),
            "taxa": len(self.taxa),
            "active_statuses": dict(Counter(row["status"] for row in active)),
            "active_categories": dict(
                Counter(
                    (row["category"] or "").strip() or "(uncategorized)"
                    for row in active
                )
            ),
            "missing_capture": sum(row["captured_at"] is None for row in self.photos),
            "with_gps": sum(row["latitude"] is not None for row in self.photos),
            "without_animal": sum(row["animal_id"] is None for row in self.photos),
            "linked_taxonomy": sum(
                row["taxon_id"] is not None for row in self.animals.values()
            ),
            "unlinked_taxonomy": sum(
                row["taxon_id"] is None for row in self.animals.values()
            ),
        }


def generate_dataset(size: int) -> Dataset:
    if size < 1:
        raise ValueError("size must be positive")
    randomizer = random.Random(SEED)
    taxa = {}
    for index, (common, scientific, category, family, _weight) in enumerate(SPECIES, 1):
        taxa[index] = {
            "id": index,
            "provider": "gbif",
            "external_taxon_id": str(9000000 + index),
            "common_name": common,
            "scientific_name": scientific,
            "canonical_name": scientific,
            "taxonomic_rank": "SPECIES",
            "kingdom": "Animalia",
            "phylum": "Arthropoda" if category == "insect" else "Chordata",
            "taxonomic_class": {
                "mammal": "Mammalia",
                "bird": "Aves",
                "insect": "Insecta",
                "amphibian": "Amphibia",
                "reptile": "Reptilia",
                "fish": "Actinopterygii",
            }[category],
            "taxonomic_order": "taxonomyonly",
            "family": family,
            "genus": scientific.split()[0],
            "species": scientific,
            "synchronized_at": BASE_TIME,
        }
    animals = {}
    photos = []
    for index in range(1, size + 1):
        species_id = randomizer.choices(
            range(1, 9), weights=[item[4] for item in SPECIES]
        )[0]
        common, scientific, category, _family, _weight = SPECIES[species_id - 1]
        created = BASE_TIME - timedelta(minutes=index // 3)
        captured = (
            None
            if randomizer.random() < 0.2
            else datetime(2018, 1, 1)
            + timedelta(
                days=randomizer.randrange(3165), minutes=randomizer.randrange(1440)
            )
        )
        animal_id = None if randomizer.random() < 0.1 else index
        if animal_id is not None:
            linked = randomizer.random() < 0.75
            animals[index] = {
                "id": index,
                "identifier": f"FV-BENCH-{index:06d}",
                "display_name": f"animalonly {common} {index % 25}",
                "taxon_id": species_id if linked else None,
                "legacy_common_name": common,
                "legacy_species_name": scientific,
                "legacy_species_group": normalize_legacy_species_group(scientific),
                "taxonomy_status": "manually_linked" if linked else "unreviewed",
                "taxonomy_note": None,
                "created_at": created,
                "updated_at": created,
            }
        camera = randomizer.random() < 0.7
        gps = randomizer.random() < 0.35
        tags = randomizer.sample(
            ["wildlife", "woodland", "garden", "night-watch", "travel", "river"],
            randomizer.randrange(1, 5),
        )
        photos.append(
            {
                "id": index,
                "animal_id": animal_id,
                "original_filename": f"{common.lower().replace(' ', '-')}-{index:06d}.jpg",
                "stored_filename": f"bench-{index:06d}.jpg",
                "resized_filename": f"bench-{index:06d}-resized.jpg",
                "thumbnail_filename": f"bench-{index:06d}-thumb.jpg",
                "display_title": f"{common} observation {index % 100}"
                if randomizer.random() < 0.6
                else None,
                "common_name": common,
                "breed_guess": None,
                "species_guess": scientific,
                "category": randomizer.choice([None, "", "  "])
                if randomizer.random() < 0.1
                else category,
                "confidence": None
                if randomizer.random() < 0.2
                else round(randomizer.uniform(0.4, 0.99), 2),
                "description": "A wildlife observation near the woodland river."
                + (" alpine-rare" if index % 997 == 1 else ""),
                "tags": tags,
                "status": randomizer.choices(
                    ["classified", "pending", "needs_review"], weights=[75, 15, 10]
                )[0],
                "content_sha256": hashlib.sha256(
                    f"synthetic-{index}".encode()
                ).hexdigest(),
                "perceptual_hash": f"{index:016x}",
                "original_size_bytes": 2500000 + index % 500000,
                "media_type": "image/jpeg",
                "captured_at": captured,
                "captured_at_offset_minutes": 120 if captured is not None else None,
                "camera_make": "Canon" if camera else None,
                "camera_model": "EOS R7" if camera else None,
                "lens_model": "RF 100-400mm" if camera else None,
                "image_width": 6000,
                "image_height": 4000,
                "latitude": 46.0 + (index % 200) / 1000 if gps else None,
                "longitude": 14.0 + (index % 200) / 1000 if gps else None,
                "deleted_at": BASE_TIME if index % 20 == 0 else None,
                "reviewed_at": None,
                "created_at": created,
                "updated_at": created,
            }
        )
    # Stable edge records are part of the versioned workload, even at small sizes.
    for index, row in enumerate(photos[:8], 1):
        row.update(
            category="mammal",
            common_name="Red fox",
            species_guess="Vulpes vulpes",
            created_at=BASE_TIME,
            updated_at=BASE_TIME,
        )
        if row["animal_id"] is not None:
            animal = animals[index]
            animal.update(
                taxon_id=1,
                taxonomy_status="manually_linked",
                legacy_common_name="Red fox",
                legacy_species_name="Vulpes vulpes",
                legacy_species_group=normalize_legacy_species_group("Vulpes vulpes"),
            )
        row["captured_at"] = [
            datetime(2024, 1, 1),
            datetime(2024, 12, 31, 23, 59, 59),
            datetime(2023, 12, 31, 23, 59, 59),
            datetime(2025, 1, 1),
            None,
            datetime(2024, 6, 1),
            datetime(2024, 6, 1),
            None,
        ][index - 1]
        row["captured_at_offset_minutes"] = 120 if row["captured_at"] else None
    photos[0]["display_title"] = "100% fox_under \\ trail"
    if size >= 6:
        for row, category in zip(photos[3:6], [None, "", "  "], strict=True):
            row["category"] = category
    if size >= 20:
        photos[19]["description"] = "trashonly"
    return Dataset(photos, animals, taxa)


def populate(engine: Engine, dataset: Dataset) -> None:
    with engine.begin() as connection:
        connection.execute(Taxon.__table__.insert(), list(dataset.taxa.values()))
        for table, rows in (
            (Animal.__table__, list(dataset.animals.values())),
            (Photo.__table__, dataset.photos),
        ):
            for start in range(0, len(rows), BATCH_SIZE):
                connection.execute(table.insert(), rows[start : start + BATCH_SIZE])
