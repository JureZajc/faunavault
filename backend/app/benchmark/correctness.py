"""Metadata-only oracle, independent of production predicates and SQL builders."""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict

from .dataset import Dataset
from .safety import BenchmarkError
from .scenarios import PAGE_SIZE, Scenario

PHOTO_SEARCH_FIELDS = (
    "display_title",
    "common_name",
    "breed_guess",
    "species_guess",
    "category",
    "description",
    "original_filename",
    "camera_make",
    "camera_model",
    "lens_model",
)
ANIMAL_SEARCH_FIELDS = (
    "display_name",
    "identifier",
    "legacy_common_name",
    "legacy_species_name",
)
TAXON_SEARCH_FIELDS = (
    "common_name",
    "scientific_name",
    "canonical_name",
    "kingdom",
    "phylum",
    "taxonomic_class",
    "taxonomic_order",
    "family",
    "genus",
    "species",
)
ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def sqlite_lower(value: str) -> str:
    # Catalog uses SQLite's built-in lower/NOCASE, not album Unicode folding.
    return value.translate(ASCII_LOWER)


class Oracle:
    def __init__(self, dataset: Dataset):
        self.dataset = dataset
        self.active = [row for row in dataset.photos if row["deleted_at"] is None]
        self.search_fields = {}
        for row in self.active:
            animal = dataset.animals.get(row["animal_id"], {})
            taxon = dataset.taxa.get(animal.get("taxon_id"), {})
            values = [row[key] for key in PHOTO_SEARCH_FIELDS]
            values += [json.dumps(row["tags"])]
            values += [animal.get(key) for key in ANIMAL_SEARCH_FIELDS]
            values += [taxon.get(key) for key in TAXON_SEARCH_FIELDS]
            self.search_fields[row["id"]] = tuple(
                sqlite_lower(value or "") for value in values
            )
        statuses = {status: 0 for status in ("pending", "classified", "needs_review")}
        statuses.update(Counter(row["status"] for row in self.active))
        categories = Counter(row["category"] for row in self.active)
        self.facets = {
            "active_total": len(self.active),
            "status_counts": statuses,
            "categories": sorted(
                [
                    {"value": value.strip(), "count": count}
                    for value, count in categories.items()
                    if value and value.strip()
                ],
                key=lambda item: (item["value"].casefold(), item["value"]),
            ),
            "uncategorized_count": sum(
                count
                for value, count in categories.items()
                if not (value or "").strip()
            ),
        }
        self.matches_cache = {}

    def matches(self, scenario: Scenario) -> list[dict]:
        key = scenario.query.model_dump_json()
        if key in self.matches_cache:
            return self.matches_cache[key]
        query = scenario.query
        terms = [sqlite_lower(term.lower()) for term in (query.search or "").split()]
        rows = []
        for row in self.active:
            animal = self.dataset.animals.get(row["animal_id"], {})
            if query.status and row["status"] != query.status:
                continue
            if query.category and row["category"] != query.category:
                continue
            if query.uncategorized and (row["category"] or "").strip(" "):
                continue
            if query.taxon_id and animal.get("taxon_id") != query.taxon_id:
                continue
            captured = row["captured_at"]
            if query.taken_from and (
                captured is None or captured.date() < query.taken_from
            ):
                continue
            if query.taken_to and (
                captured is None or captured.date() > query.taken_to
            ):
                continue
            if not all(
                any(term in value for value in self.search_fields[row["id"]])
                for term in terms
            ):
                continue
            rows.append(row)
        descending = query.order == "desc"
        if query.sort == "created_at":
            rows.sort(
                key=lambda row: (row["created_at"], row["id"]), reverse=descending
            )
        elif query.sort == "captured_at":
            known = [row for row in rows if row["captured_at"] is not None]
            unknown = [row for row in rows if row["captured_at"] is None]
            known.sort(
                key=lambda row: (row["captured_at"], row["id"]), reverse=descending
            )
            unknown.sort(key=lambda row: row["id"], reverse=descending)
            rows = known + unknown
        else:
            rows.sort(key=lambda row: row["id"], reverse=True)
            rows.sort(key=lambda row: sqlite_lower(row["original_filename"]))
            rows.sort(key=lambda row: row["created_at"], reverse=True)
            if query.sort in ("name", "species"):
                fields = (
                    ("display_title", "breed_guess", "common_name")
                    if query.sort == "name"
                    else ("species_guess",)
                )

                def name(row):
                    return sqlite_lower(
                        next(
                            (
                                row[key].strip(" ")
                                for key in fields
                                if row[key] and row[key].strip(" ")
                            ),
                            row["original_filename"],
                        )
                    )

                rows.sort(key=name, reverse=descending)
            elif query.sort == "confidence":
                known = [row for row in rows if row["confidence"] is not None]
                unknown = [row for row in rows if row["confidence"] is None]
                known.sort(key=lambda row: row["confidence"], reverse=descending)
                rows = known + unknown
            else:
                rows.sort(
                    key=lambda row: row["status"] == query.sort, reverse=descending
                )
        self.matches_cache[key] = rows
        return rows

    def verify(self, scenario: Scenario, response, *, page: int | None = None) -> int:
        if scenario.kind in ("catalog", "smart"):
            rows = self.matches(scenario)
            page = scenario.page if page is None else page
            expected = [
                row["id"] for row in rows[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]
            ]
            actual = [row.id for row in response.items]
            require(response.total == len(rows), scenario, "filtered total")
            require(
                actual == expected and len(set(actual)) == len(actual),
                scenario,
                "ordered page IDs",
            )
            require(
                response.page == page
                and response.page_size == PAGE_SIZE
                and response.total_pages == math.ceil(len(rows) / PAGE_SIZE),
                scenario,
                "pagination metadata",
            )
            require(
                response.facets.model_dump() == self.facets, scenario, "global facets"
            )
            return len(rows)
        if scenario.kind == "detail":
            require(
                response.query == scenario.query
                and response.query_valid
                and response.id == scenario.collection_id,
                scenario,
                "saved definition",
            )
            return 1
        if scenario.kind == "map":
            expected = [
                row
                for row in sorted(self.matches(scenario), key=lambda row: row["id"])
                if row["latitude"] is not None and row["longitude"] is not None
            ]
            require(
                [item.id for item in response] == [row["id"] for row in expected],
                scenario,
                "GPS membership/order",
            )
            for item, row in zip(response, expected, strict=True):
                require(
                    item.model_dump()
                    == {key: row[key] for key in type(item).model_fields},
                    scenario,
                    "map projection",
                )
            return len(expected)
        if scenario.kind == "timeline":
            months = defaultdict(list)
            for row in self.active:
                if row["captured_at"]:
                    months[(row["captured_at"].year, row["captured_at"].month)].append(
                        row
                    )
            expected_keys = sorted(months, reverse=True)
            actual_keys = [
                (year.year, month.month)
                for year in response.years
                for month in year.months
            ]
            require(actual_keys == expected_keys, scenario, "timeline grouping/order")
            require(
                response.unknown_capture_count
                == sum(row["captured_at"] is None for row in self.active),
                scenario,
                "unknown capture count",
            )
            for year in response.years:
                require(
                    year.photo_count
                    == sum(
                        len(rows)
                        for (candidate, _), rows in months.items()
                        if candidate == year.year
                    ),
                    scenario,
                    "year counts",
                )
                for month in year.months:
                    rows = sorted(
                        months[(year.year, month.month)],
                        key=lambda row: (row["captured_at"], row["id"]),
                        reverse=True,
                    )
                    require(
                        month.photo_count == len(rows)
                        and [item.id for item in month.previews]
                        == [row["id"] for row in rows[:4]],
                        scenario,
                        "month counts/previews",
                    )
            return len(self.active)
        counts = Counter(
            self.dataset.animals[row["animal_id"]]["taxon_id"]
            for row in self.active
            if row["animal_id"] in self.dataset.animals
            and self.dataset.animals[row["animal_id"]]["taxon_id"] is not None
        )
        taxa = self.dataset.taxa
        expected = sorted(
            counts,
            key=lambda key: (
                sqlite_lower(taxa[key]["common_name"]),
                sqlite_lower(taxa[key]["scientific_name"]),
                key,
            ),
        )
        require(
            response.total == len(expected)
            and [item.taxon_id for item in response.items] == expected[:50],
            scenario,
            "taxon membership/order",
        )
        for item in response.items:
            require(
                item.count == counts[item.taxon_id]
                and item.label == taxa[item.taxon_id]["common_name"]
                and item.scientific_name == taxa[item.taxon_id]["scientific_name"],
                scenario,
                "taxon projection/count",
            )
        require(
            response.selected.taxon_id == 8 and response.selected.count == counts[8],
            scenario,
            "selected taxon",
        )
        return len(expected)


def require(condition: bool, scenario: Scenario, message: str) -> None:
    if not condition:
        raise BenchmarkError(f"Correctness failed: {scenario.name}: {message}.")
