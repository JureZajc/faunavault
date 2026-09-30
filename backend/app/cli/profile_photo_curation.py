"""Focused, disposable catalog profiling for Photo curation (no live archive)."""

from __future__ import annotations

import json

from sqlalchemy import event
from sqlmodel import Session

from app.benchmark.dataset import generate_dataset, populate
from app.benchmark.runner import measure
from app.benchmark.safety import disposable_settings, protected_locations
from app.catalog_query import CatalogSavedQuery
from app.database import create_database_engine
from app.services.catalog import list_catalog_photos
from app.services.smart_collections import (
    create_smart_collection,
    list_smart_collection_photos,
)
from app.storage_startup import initialize_archive_storage


def main() -> None:
    report = []
    for size in (10_000, 100_000):
        with disposable_settings(protected_locations()) as settings:
            engine = create_database_engine(settings)
            try:
                initialize_archive_storage(engine, settings)
                dataset = generate_dataset(size)
                populate(engine, dataset)
                with engine.begin() as connection:
                    connection.exec_driver_sql(
                        "UPDATE photo SET is_favorite=(id % 4 = 0), rating=CASE WHEN id % 3=0 THEN NULL ELSE id % 5 + 1 END"
                    )
                for name, criteria in [
                    ("default", {}),
                    ("favorites", {"favorites_only": True}),
                    ("exact_5", {"rating": 5}),
                    ("minimum_4", {"rating_min": 4}),
                    ("unrated", {"unrated": True}),
                    ("rating_desc", {"sort": "rating"}),
                    ("rating_asc", {"sort": "rating", "order": "asc"}),
                ]:
                    query = CatalogSavedQuery(**criteria)
                    with Session(engine) as session:
                        smart_id = create_smart_collection(name, query, session).id

                    def catalog(engine=engine, query=query):
                        with Session(engine) as session:
                            return list_catalog_photos(
                                session, page=1, page_size=48, **query.model_dump()
                            )

                    def smart(engine=engine, smart_id=smart_id):
                        with Session(engine) as session:
                            return list_smart_collection_photos(
                                smart_id, session, page=1, page_size=48
                            )

                    expected = sum(
                        photo["deleted_at"] is None
                        and (not query.favorites_only or photo["id"] % 4 == 0)
                        and (
                            query.rating is None
                            or photo["id"] % 3 != 0
                            and photo["id"] % 5 + 1 == query.rating
                        )
                        and (
                            query.rating_min is None
                            or photo["id"] % 3 != 0
                            and photo["id"] % 5 + 1 >= query.rating_min
                        )
                        and (not query.unrated or photo["id"] % 3 == 0)
                        for photo in dataset.photos
                    )
                    plans = []

                    def capture(
                        connection,
                        _cursor,
                        statement,
                        parameters,
                        _context,
                        _many,
                        plans=plans,
                    ):
                        if (
                            statement.lstrip().startswith("SELECT")
                            and "FROM photo" in statement
                        ):
                            plans.append(
                                [
                                    row[3]
                                    for row in connection.exec_driver_sql(
                                        "EXPLAIN QUERY PLAN " + statement, parameters
                                    ).fetchall()
                                ]
                            )

                    event.listen(engine, "before_cursor_execute", capture)
                    try:
                        direct = catalog()
                    finally:
                        event.remove(engine, "before_cursor_execute", capture)
                    assert direct.total == expected
                    assert smart().model_dump() == direct.model_dump()
                    report.append(
                        {
                            "size": size,
                            "scenario": name,
                            "total": expected,
                            "catalog": measure(catalog, 20),
                            "smart": measure(smart, 20),
                            "plans": plans,
                        }
                    )
            finally:
                engine.dispose()
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
