import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest
from sqlalchemy import event, text
from sqlmodel import Session

from app.models import Photo
from app.schemas import TagOperationApplyRequest
from app.services import tag_operations
from tests.test_catalog import add_photo
from tests.test_catalog import catalog_app as catalog_app


def preview(client, operation="rename", source="bird", destination="birds"):
    body = {"operation": operation, "source": source}
    if operation != "delete":
        body["destination"] = destination
    response = client.post("/tags/operations/preview", json=body)
    assert response.status_code == 200, response.text
    return response.json(), body


def apply(client, data, body, **extra):
    return client.post(
        "/tags/operations/apply",
        json={
            **body,
            "preview_token": data["preview_token"],
            **extra,
        },
    )


def raw_photos(engine):
    with engine.connect() as connection:
        return [
            dict(row)
            for row in connection.execute(
                text("SELECT * FROM photo ORDER BY id")
            ).mappings()
        ]


@pytest.mark.parametrize(
    "operation,destination",
    [("rename", "new"), ("rename", "birds"), ("merge", "birds"), ("delete", None)],
)
def test_operations_preview_order_duplicates_trash_and_preserved_metadata(
    catalog_app, tmp_path, operation, destination
):
    client, engine = catalog_app
    now = datetime(2026, 1, 2, tzinfo=UTC)
    with Session(engine) as session:
        add_photo(
            session,
            1,
            tags=["first", "bird", "last", "bird"],
            status="needs_review",
            rating=5,
            is_favorite=True,
            culling_state="pick",
            latitude=46.0,
            longitude=14.0,
            captured_at=datetime(2025, 1, 1),
            reviewed_at=now,
        )
        add_photo(
            session,
            2,
            tags=["bird", "other", "birds", "birds"],
            deleted_at=now,
            status="classified",
            reviewed_at=now,
        )
        add_photo(session, 3, tags=["Bird", "unchanged", "birds"])
        session.commit()
    original = tmp_path / "images" / "original" / "photo-1.jpg"
    original.parent.mkdir(parents=True, exist_ok=True)
    original.write_bytes(b"original image bytes")
    before = raw_photos(engine)
    data, body = preview(client, operation=operation, destination=destination)
    assert (data["active_photos"], data["trashed_photos"], data["total_photos"]) == (
        1,
        1,
        2,
    )
    assert data["destination_overlap"] == (1 if destination == "birds" else 0)
    assert data["destination_exists"] == (destination == "birds")
    assert len(data["examples"]) == 2
    assert raw_photos(engine) == before  # Preview is read-only, including timestamps.
    result = apply(client, data, body, confirm_delete=operation == "delete")
    assert result.status_code == 200, result.text
    assert result.json()["updated_photos"] == 2
    after = raw_photos(engine)
    expected = {
        "new": [["first", "new", "last"], ["new", "other", "birds", "birds"]],
        "birds": [["first", "birds", "last"], ["other", "birds"]],
        None: [["first", "last"], ["other", "birds", "birds"]],
    }[destination]
    for index in range(2):
        assert json.loads(after[index]["tags"]) == expected[index]
        assert after[index]["updated_at"] != before[index]["updated_at"]
        for field in before[index].keys() - {"tags", "updated_at"}:
            assert after[index][field] == before[index][field], field
    assert after[2] == before[2]
    assert original.read_bytes() == b"original image bytes"
    assert (
        apply(client, data, body, confirm_delete=True).json()["detail"]["code"]
        == "stale_preview"
    )
    assert raw_photos(engine) == after
    if destination:
        assert client.get("/catalog/photos", params={"tags": destination}).json()[
            "total"
        ] == (2 if destination == "birds" else 1)
        assert client.get("/catalog/culling", params={"tags": destination}).json()[
            "total"
        ] == (2 if destination == "birds" else 1)
        assert (
            client.get("/catalog/photos", params={"search": destination}).json()[
                "total"
            ]
            >= 1
        )
        assert client.post(f"/trash/photos/{after[1]['id']}/restore").status_code == 200
        with Session(engine) as session:
            assert session.get(Photo, after[1]["id"]).tags == list(
                dict.fromkeys(expected[1])
            )
        assert (
            client.post(
                "/photos/bulk",
                json={
                    "photo_ids": [after[0]["id"]],
                    "operation": "add_tags",
                    "tags": [destination],
                },
            ).status_code
            == 200
        )


def test_case_sensitive_merge_and_trimmed_names(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, tags=["Birds", "birds", "BIRDS"])
        add_photo(session, 2, tags=["Birds", "other"])
        session.commit()
    data, body = preview(client, "merge", " Birds ", " birds ")
    assert data["source"] == "Birds" and data["destination"] == "birds"
    assert apply(client, data, body).status_code == 200
    assert [json.loads(row["tags"]) for row in raw_photos(engine)] == [
        ["birds", "BIRDS"],
        ["birds", "other"],
    ]


def test_malformed_json_is_untouched_and_mixed_arrays_preserve_unrelated_values(
    catalog_app,
):
    client, engine = catalog_app
    values = [
        "not-json",
        "null",
        "{}",
        '"bird"',
        "42",
        '[null, 1, true, {}, [], " bird ", " keep ", "keep", "keep", "birds", " birds "]',
    ]
    with Session(engine) as session:
        for index, value in enumerate(values):
            photo = add_photo(session, index)
            session.exec(
                text("UPDATE photo SET tags=:tags WHERE id=:id").bindparams(
                    tags=value, id=photo.id
                )
            )
        session.commit()
    before = raw_photos(engine)
    data, body = preview(client)
    assert data["total_photos"] == 1
    assert apply(client, data, body).status_code == 200
    rows = raw_photos(engine)
    assert rows[:-1] == before[:-1]
    assert json.loads(rows[-1]["tags"]) == [
        None,
        1,
        True,
        {},
        [],
        " keep ",
        "keep",
        "keep",
        "birds",
    ]


@pytest.mark.parametrize(
    "change", ["tags", "trash", "timestamp", "insert_source", "insert_destination"]
)
def test_stale_previews_are_rejected_without_writes(catalog_app, change):
    client, engine = catalog_app
    with Session(engine) as session:
        photo_id = add_photo(session, 1, tags=["bird"]).id
        session.commit()
    data, body = preview(client)
    with Session(engine) as session:
        photo = session.get(Photo, photo_id)
        if change == "tags":
            photo.tags = ["bird", "added"]
        elif change == "trash":
            photo.deleted_at = datetime.now(UTC)
        elif change == "timestamp":
            photo.updated_at = datetime.now(UTC)
        else:
            add_photo(
                session, 2, tags=["bird" if change == "insert_source" else "birds"]
            )
        session.commit()
    before = raw_photos(engine)
    response = apply(client, data, body)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "stale_preview"
    assert raw_photos(engine) == before
    fresh, body = preview(client)
    assert apply(client, fresh, body).status_code == 200


def test_invalid_and_empty_operations(catalog_app):
    client, engine = catalog_app
    response = client.post(
        "/tags/operations/preview", json={"operation": "delete", "source": "bird"}
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "source_not_found"
    invalid = [
        {},
        {"operation": "oops", "source": "bird"},
        {"operation": "delete", "source": 1},
        {"operation": "delete", "source": "  "},
        {"operation": "delete", "source": "x" * 1001},
        {"operation": "delete", "source": "bad\x00tag"},
        {"operation": "delete", "source": "bird", "destination": "birds"},
        {"operation": "rename", "source": "bird"},
        {"operation": "rename", "source": "bird", "destination": " bird "},
        {"operation": "rename", "source": "bird", "destination": " "},
        {"operation": "delete", "source": "bird", "photo_ids": [1]},
    ]
    for body in invalid:
        response = client.post("/tags/operations/preview", json=body)
        assert response.status_code == 422, response.text
        assert response.json()["detail"]["code"] == "invalid_tag_operation"
    with Session(engine) as session:
        add_photo(session, 1, tags=["bird"])
        session.commit()
    response = client.post(
        "/tags/operations/preview",
        json={"operation": "merge", "source": "bird", "destination": "absent"},
    )
    assert response.json()["detail"]["code"] == "destination_not_found"
    data, body = preview(client, "delete")
    assert (
        apply(client, data, body).json()["detail"]["code"]
        == "delete_confirmation_required"
    )
    assert apply(client, data, body, confirm_delete="true").status_code == 422
    assert (
        apply(client, data, body, confirm_delete=True, total_photos=1).status_code
        == 422
    )
    data["preview_token"] += "tampered"
    assert (
        apply(client, data, body, confirm_delete=True).json()["detail"]["code"]
        == "invalid_preview"
    )


def test_preview_bound_to_operation_and_expiry(catalog_app, monkeypatch):
    client, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, tags=["bird"])
        session.commit()
    data, body = preview(client)
    assert (
        apply(client, data, {**body, "destination": "different"}).json()["detail"][
            "code"
        ]
        == "invalid_preview"
    )
    monkeypatch.setattr(tag_operations.time, "time", lambda: 10**12)
    assert apply(client, data, body).json()["detail"]["code"] == "stale_preview"


def test_large_archive_bounded_batches_and_atomic_rollback(catalog_app, monkeypatch):
    client, engine = catalog_app
    monkeypatch.setattr(tag_operations, "BATCH_SIZE", 23)
    with Session(engine) as session:
        for index in range(301):
            add_photo(session, index, tags=["bird", "other"])
        session.commit()
    data, body = preview(client)
    assert data["total_photos"] == 301 and len(data["examples"]) == 5
    before = raw_photos(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TRIGGER fail_tag_update BEFORE UPDATE OF tags ON photo WHEN OLD.id = 150 BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
        )
    response = apply(client, data, body)
    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "tag_operation_failed"
    assert raw_photos(engine) == before
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TRIGGER fail_tag_update")
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert apply(client, data, body).json()["updated_photos"] == 301
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert "BEGIN IMMEDIATE" in statements
    bounded = [sql for sql in statements if "LIMIT" in sql and "json_each" in sql]
    assert len(bounded) == 15
    assert not any("photo.animal_id" in sql for sql in statements)
    assert all(
        json.loads(row["tags"]) == ["birds", "other"] for row in raw_photos(engine)
    )


def test_concurrent_duplicate_submission_only_one_can_apply(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, tags=["bird"])
        session.commit()
    data, body = preview(client)
    request = TagOperationApplyRequest(**body, preview_token=data["preview_token"])

    def run():
        from fastapi import HTTPException

        with Session(engine) as session:
            try:
                tag_operations.apply_tag_operation(session, request)
                return 200
            except HTTPException as exc:
                return exc.status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(lambda _: run(), range(2))) == [200, 409]


def test_trash_only_source_and_destination_are_supported(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        for index, tag in enumerate(["bird", "birds"]):
            add_photo(session, index, tags=[tag], deleted_at=datetime.now(UTC))
        session.commit()
    data, body = preview(client, "merge")
    assert data["active_photos"] == 0 and data["trashed_photos"] == 1
    assert data["destination_exists"]
    assert apply(client, data, body).status_code == 200
    assert client.get("/catalog/tags").json()["tags"] == []
    assert all(json.loads(row["tags"]) == ["birds"] for row in raw_photos(engine))


def test_ten_thousand_photos_use_bounded_sql_batches_without_orm_hydration(catalog_app):
    client, engine = catalog_app
    with engine.begin() as connection:
        # Fast disposable fixture: no images, relationships or ORM instances needed.
        connection.execute(
            Photo.__table__.insert(),
            [
                {
                    "original_filename": f"large-{index}.jpg",
                    "stored_filename": f"large-{index}.jpg",
                    "resized_filename": f"large-{index}-resized.jpg",
                    "thumbnail_filename": f"large-{index}-thumb.jpg",
                    "tags": ["bird", "keep"],
                    "status": "needs_review",
                    "deleted_at": datetime.now(UTC) if index % 10 == 0 else None,
                }
                for index in range(10_000)
            ],
        )
    hydrated = []
    batches = []

    def load(_photo, _context):
        hydrated.append(1)

    def record(_connection, _cursor, statement, parameters, _context, many):
        if statement.startswith("UPDATE photo"):
            batches.append(len(parameters) if many else 1)

    event.listen(Photo, "load", load)
    event.listen(engine, "before_cursor_execute", record)
    try:
        data, body = preview(client)
        assert (data["active_photos"], data["trashed_photos"]) == (9000, 1000)
        assert len(data["examples"]) == 5
        assert apply(client, data, body).json()["updated_photos"] == 10_000
    finally:
        event.remove(Photo, "load", load)
        event.remove(engine, "before_cursor_execute", record)
    assert not hydrated
    assert len(batches) == 40 and max(batches) == 250
    with engine.connect() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM photo WHERE status='needs_review' AND tags='[\"birds\", \"keep\"]'"
                )
            ).scalar_one()
            == 10_000
        )


def test_busy_archive_returns_conflict_without_changes(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, tags=["bird"])
        session.commit()
    data, body = preview(client)
    before = raw_photos(engine)
    with engine.connect() as writer, Session(engine) as session:
        writer.exec_driver_sql("BEGIN IMMEDIATE")
        session.connection().exec_driver_sql("PRAGMA busy_timeout=1")
        request = TagOperationApplyRequest(**body, preview_token=data["preview_token"])
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as failure:
            tag_operations.apply_tag_operation(session, request)
        assert failure.value.status_code == 409
        assert failure.value.detail["code"] == "archive_busy"
        writer.rollback()
    assert raw_photos(engine) == before
