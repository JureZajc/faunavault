"""Reproducible Insights timings using the existing disposable catalog dataset."""

import json
from collections import Counter

from sqlalchemy import event
from sqlmodel import Session

from app.benchmark.dataset import generate_dataset, populate
from app.benchmark.runner import measure
from app.benchmark.safety import (
    disposable_settings,
    protected_locations,
    publish_report,
    validate_output,
)
from app.cli.benchmark_catalog import build_parser
from app.database import create_database_engine
from app.services.insights import get_insights
from app.storage_startup import initialize_archive_storage


def main() -> None:
    args = build_parser().parse_args()
    protected = protected_locations()
    output = validate_output(args.output, protected) if args.output else None
    results = []
    for size in args.sizes:
        with disposable_settings(protected) as settings:
            engine = create_database_engine(settings)
            try:
                initialize_archive_storage(engine, settings)
                dataset = generate_dataset(size)
                populate(engine, dataset)
                for year in (None, 2026):

                    def invoke(engine=engine, year=year):
                        with Session(engine) as session:
                            return get_insights(session, year)

                    statements = []

                    def record(
                        _connection,
                        _cursor,
                        sql,
                        _params,
                        _context,
                        _many,
                        statements=statements,
                    ):
                        statements.append((sql, _params))

                    event.listen(engine, "before_cursor_execute", record)
                    try:
                        response = invoke()
                    finally:
                        event.remove(engine, "before_cursor_execute", record)
                    photos = [
                        photo
                        for photo in dataset.photos
                        if photo["deleted_at"] is None
                        and (
                            year is None
                            or (
                                photo["captured_at"] is not None
                                and photo["captured_at"].year == year
                            )
                        )
                    ]
                    expected_species = Counter()
                    for photo in photos:
                        animal = dataset.animals.get(photo["animal_id"])
                        taxon = dataset.taxa.get(animal["taxon_id"]) if animal else None
                        if taxon and taxon["taxonomic_rank"].upper() == "SPECIES":
                            expected_species[taxon["id"]] += 1
                    expected_top = sorted(
                        expected_species,
                        key=lambda key: (
                            -expected_species[key],
                            dataset.taxa[key]["scientific_name"].lower(),
                            key,
                        ),
                    )[:10]
                    assert response.overview.total_photos == len(photos)
                    assert response.overview.verified_species == len(expected_species)
                    assert [
                        row.taxon_id for row in response.top_species
                    ] == expected_top
                    assert [row.photo_count for row in response.top_species] == [
                        expected_species[key] for key in expected_top
                    ]
                    assert sum(row.photo_count for row in response.categories) == len(
                        photos
                    )
                    assert sum(
                        row.photo_count for row in response.classification
                    ) == len(photos)
                    assert len(statements) == (5 if year is None else 6)
                    if args.verbose:
                        with engine.connect() as connection:
                            for sql, params in statements:
                                print(sql, params)
                                print(
                                    connection.exec_driver_sql(
                                        "EXPLAIN QUERY PLAN " + sql, params
                                    ).all()
                                )
                    results.append(
                        {
                            "dataset_size": size,
                            "year": year,
                            "active_total": len(photos),
                            "query_count": len(statements),
                            "response_bytes": len(response.model_dump_json().encode()),
                            "timing": measure(invoke, args.runs),
                        }
                    )
            finally:
                engine.dispose()
    report = {
        "method": "warm-cache disposable catalog dataset, production indexes, service call including model construction; excludes HTTP/browser",
        "results": results,
    }
    if output:
        publish_report(output, report, protected)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
