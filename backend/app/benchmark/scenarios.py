from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from sqlmodel import Session

from app.catalog_query import CatalogSavedQuery
from app.models import SmartCollection
from app.services import catalog, smart_collections

from .dataset import BASE_TIME, Dataset

PAGE_SIZE = 48
SORTS = (
    "created_at",
    "captured_at",
    "name",
    "species",
    "confidence",
    "needs_review",
    "pending",
)


@dataclass(frozen=True)
class Scenario:
    name: str
    area: str
    kind: str = "catalog"
    query: CatalogSavedQuery = field(default_factory=CatalogSavedQuery)
    page: int = 1
    collection_id: int | None = None
    equivalent: str | None = None

    def invoke(self, session: Session, *, page: int | None = None):
        selected_page = self.page if page is None else page
        if self.kind == "smart":
            return smart_collections.list_smart_collection_photos(
                self.collection_id, session, page=selected_page, page_size=PAGE_SIZE
            )
        if self.kind == "detail":
            return smart_collections.get_smart_collection(self.collection_id, session)
        if self.kind == "map":
            return catalog.list_photo_map_points(session)
        if self.kind == "timeline":
            return catalog.get_photo_timeline(session)
        if self.kind == "taxa":
            return catalog.list_catalog_taxa(
                session, page=1, page_size=50, include_id=8
            )
        return catalog.list_catalog_photos(
            session, page=selected_page, page_size=PAGE_SIZE, **self.query.model_dump()
        )


def build_scenarios(dataset: Dataset, session: Session) -> list[Scenario]:
    active = sum(row["deleted_at"] is None for row in dataset.photos)
    result = [
        Scenario("browse_first", "default catalog browsing"),
        Scenario("browse_early", "default catalog browsing", page=3),
    ]
    for fraction in (0.5, 0.9):
        page = max(1, int(active * fraction) // PAGE_SIZE + 1)
        result.append(
            Scenario(
                f"browse_depth_{int(fraction * 100)}", "deep pagination", page=page
            )
        )
    for sort in SORTS:
        for order in ("asc", "desc"):
            result.append(
                Scenario(
                    f"sort_{sort}_{order}",
                    "default catalog browsing",
                    query=CatalogSavedQuery(sort=sort, order=order),
                )
            )
    filters = {
        "category_common": {"category": "mammal"},
        "category_rare": {"category": "fish"},
        "taxon_common": {"taxon_id": 1},
        "taxon_rare": {"taxon_id": 8},
        "uncategorized": {"uncategorized": True},
        **{
            f"status_{status}": {"status": status}
            for status in ("classified", "pending", "needs_review")
        },
        "date_range": {"taken_from": date(2024, 1, 1), "taken_to": date(2024, 12, 31)},
        "combined": {
            "category": "mammal",
            "status": "classified",
            "taxon_id": 1,
            "taken_from": date(2024, 1, 1),
            "taken_to": date(2024, 12, 31),
        },
    }
    result.extend(
        Scenario(f"filter_{name}", "filtered catalog", query=CatalogSavedQuery(**query))
        for name, query in filters.items()
    )
    searches = {
        "rare": {"search": "alpine-rare"},
        "common": {"search": "wildlife"},
        "multiple": {"search": "vulpes wildlife"},
        "none": {"search": "no-such-benchmark-match"},
        "category": {"search": "wildlife", "category": "mammal"},
        "taxon": {"search": "wildlife", "taxon_id": 1},
        "date": {
            "search": "wildlife",
            "taken_from": date(2024, 1, 1),
            "taken_to": date(2024, 12, 31),
        },
        "sort": {"search": "wildlife", "sort": "name", "order": "asc"},
        "literal_percent": {"search": "100%"},
        "literal_underscore": {"search": "fox_under"},
        "literal_backslash": {"search": "\\"},
        "animal_only": {"search": "animalonly"},
        "taxon_only": {"search": "taxonomyonly"},
        "trash_only": {"search": "trashonly"},
    }
    result.extend(
        Scenario(f"search_{name}", "text search", query=CatalogSavedQuery(**query))
        for name, query in searches.items()
    )
    saved = {
        "category": CatalogSavedQuery(category="mammal"),
        "taxon": CatalogSavedQuery(taxon_id=1),
        "date": CatalogSavedQuery(**filters["date_range"], sort="captured_at"),
        "text": CatalogSavedQuery(search="wildlife"),
        "combined": CatalogSavedQuery(
            search="wildlife", **filters["combined"], sort="captured_at"
        ),
    }
    for collection_id, (name, query) in enumerate(saved.items(), 1):
        session.add(
            SmartCollection(
                id=collection_id,
                name=f"Benchmark {name}",
                name_key=f"benchmark {name}",
                query_version=1,
                query_json=query.model_dump_json(exclude_none=True),
                created_at=BASE_TIME,
                updated_at=BASE_TIME,
            )
        )
        equivalent = f"catalog_smart_equivalent_{name}"
        result.append(
            Scenario(
                equivalent,
                "text search" if query.search else "filtered catalog",
                query=query,
            )
        )
        result.append(
            Scenario(
                f"smart_{name}",
                "Smart Collection result queries",
                kind="smart",
                query=query,
                collection_id=collection_id,
                equivalent=equivalent,
            )
        )
    session.commit()
    result.extend(
        (
            Scenario(
                "smart_detail",
                "supporting paths",
                kind="detail",
                collection_id=1,
                query=saved["category"],
            ),
            Scenario("timeline", "supporting paths", kind="timeline"),
            Scenario("map", "supporting paths", kind="map"),
            Scenario("taxa", "supporting paths", kind="taxa"),
        )
    )
    return result
