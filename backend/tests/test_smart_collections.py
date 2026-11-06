from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session, SQLModel, select

import app.main as main
from app.config import Settings
from app.database import create_database_engine
from app.models import Animal, CollectionPhoto, Photo, SmartCollection, Taxon
from tests.test_catalog import add_photo, add_taxon
from tests.test_tag_operations import apply as apply_tag_operation
from tests.test_tag_operations import preview as preview_tag_operation


@pytest.fixture()
def smart_app(tmp_path, monkeypatch):
    database_path = tmp_path / "smart.db"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{database_path}",
    )
    engine = create_database_engine(settings)
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "DATABASE_PATH", database_path)
    monkeypatch.setattr(main, "IMAGE_ROOT", settings.image_dir)
    monkeypatch.setattr(main, "IMAGE_DIRS", settings.image_dirs)

    def session_override():
        with Session(engine) as session:
            yield session

    main.app.dependency_overrides[main.get_session] = session_override
    with TestClient(main.app) as client:
        yield client, engine
    main.app.dependency_overrides.clear()
    engine.dispose()


def create(client, name="Birds 2026", query=None, version=1):
    response = client.post(
        "/smart-collections",
        json={"name": name, "query_version": version, "query": query or {}},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_crud_validation_round_trip_and_manual_separation(smart_app):
    client, engine = smart_app
    manual = client.post("/collections", json={"name": "Birds 2026"})
    assert manual.status_code == 201
    query = {
        "search": "  fox  ",
        "category": "mammal",
        "taken_from": "2026-01-01",
        "sort": "captured_at",
        "order": "desc",
    }
    smart = create(client, query=query)
    assert smart["name"] == "Birds 2026"
    assert smart["query"] == {**smart["query"], "search": "fox", "category": "mammal"}
    assert smart["query_version"] == 1
    assert client.get(f"/smart-collections/{smart['id']}").json() == smart
    assert len(client.get("/smart-collections").json()) == 1
    assert (
        client.post(
            "/smart-collections",
            json={"name": "birds 2026", "query_version": 1, "query": {}},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/smart-collections",
            json={"name": "Invalid", "query_version": 99, "query": {}},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={"name": "Invalid", "query_version": 1, "query": {"page": 3}},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={
                "name": "Invalid",
                "query_version": 1,
                "query": {"taken_from": 1780000000},
            },
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={
                "name": "Invalid",
                "query_version": 1,
                "query": {"category": "bird", "uncategorized": True},
            },
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={
                "name": "Invalid",
                "query_version": 1,
                "query": {"taken_from": "2026-02-01", "taken_to": "2026-01-01"},
            },
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/smart-collections/{smart['id']}", json={"query": {}}
        ).status_code
        == 422
    )
    updated = client.patch(
        f"/smart-collections/{smart['id']}",
        json={"name": "Foxes", "query_version": 1, "query": {"uncategorized": True}},
    )
    assert updated.status_code == 200
    assert updated.json()["query"]["uncategorized"] is True
    assert client.get("/collections").json()[0]["name"] == "Birds 2026"
    with Session(engine) as session:
        assert session.exec(select(CollectionPhoto)).all() == []
    assert client.delete(f"/smart-collections/{smart['id']}").status_code == 200
    assert client.get(f"/smart-collections/{smart['id']}").status_code == 404
    assert client.get("/collections").json()[0]["name"] == "Birds 2026"


def test_results_match_catalog_and_change_with_photo_lifecycle(smart_app):
    client, engine = smart_app
    with Session(engine) as session:
        first = add_photo(
            session,
            1,
            category="bird",
            original_filename="owl-first.jpg",
            captured_at=datetime(2026, 4, 1),
        )
        second = add_photo(
            session,
            2,
            category="bird",
            original_filename="owl-second.jpg",
            captured_at=datetime(2026, 4, 2),
        )
        add_photo(session, 3, category="mammal", original_filename="fox.jpg")
        session.commit()
        first_id, second_id = first.id, second.id
    query = {
        "search": "owl",
        "category": "bird",
        "taken_from": "2026-01-01",
        "taken_to": "2026-12-31",
        "sort": "captured_at",
        "order": "desc",
    }
    smart = create(client, query=query)
    url = f"/smart-collections/{smart['id']}/photos"
    catalog = client.get("/catalog/photos", params={**query, "page_size": 1}).json()
    saved = client.get(url, params={"page_size": 1}).json()
    assert [p["id"] for p in saved["items"]] == [p["id"] for p in catalog["items"]]
    assert saved["total"] == catalog["total"] == 2
    assert (
        client.get(url, params={"page": 2, "page_size": 1}).json()["items"][0]["id"]
        == first_id
    )
    assert client.get(url, params={"page_size": 101}).status_code == 422

    with Session(engine) as session:
        session.get(Photo, second_id).category = "mammal"
        session.commit()
    assert client.get(url).json()["total"] == 1
    with Session(engine) as session:
        third = add_photo(
            session,
            4,
            category="bird",
            original_filename="owl-new.jpg",
            captured_at=datetime(2026, 4, 3),
        )
        session.commit()
        third_id = third.id
    assert [p["id"] for p in client.get(url).json()["items"]] == [third_id, first_id]
    with Session(engine) as session:
        session.get(Photo, first_id).deleted_at = datetime.now(UTC)
        session.commit()
    assert [p["id"] for p in client.get(url).json()["items"]] == [third_id]
    with Session(engine) as session:
        session.get(Photo, first_id).deleted_at = None
        session.commit()
    assert client.get(url).json()["total"] == 2
    assert client.delete(f"/smart-collections/{smart['id']}").status_code == 200
    with Session(engine) as session:
        assert session.get(Photo, first_id) is not None
        assert session.exec(select(CollectionPhoto)).all() == []


@pytest.mark.parametrize(
    "criteria",
    [
        {"search": "common"},
        {"search": "rare"},
        {"search": "absent"},
        {"search": "animalprobe common"},
        {"search": "taxonprobe common"},
        {"search": "100% fox_under \\"},
        {"taxon_id": 1},
        {"taxon_id": 1, "search": "common"},
        {"search": "common", "status": "classified"},
        {"taxon_id": 1, "category": "mammal", "taken_from": "2026-01-01"},
    ],
)
def test_optimized_counts_preserve_complete_smart_catalog_parity(smart_app, criteria):
    client, engine = smart_app
    with Session(engine) as session:
        taxon = add_taxon(session, "taxonprobe species")
        assert taxon.id == 1
        first = add_photo(
            session,
            1,
            taxon=taxon,
            animal_name="animalprobe",
            display_title="common rare 100% fox_under \\",
            category="mammal",
            status="classified",
            captured_at=datetime(2026, 1, 1),
        )
        second = add_photo(session, 2, display_title="common")
        second.animal_id = first.animal_id
        add_photo(session, 3, display_title="common", deleted_at=datetime(2026, 1, 1))
        session.commit()
    smart = create(client, query=criteria)
    url = f"/smart-collections/{smart['id']}/photos"
    for page in (1, 2, 3):
        params = {"page": page, "page_size": 1}
        normal = client.get("/catalog/photos", params={**criteria, **params}).json()
        saved = client.get(url, params=params).json()
        assert saved == normal

    statements = []

    def capture(_connection, _cursor, statement, *_args):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        saved = client.get(url).json()
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert len(statements) == (5 if saved["total"] == 0 else 6)
    if saved["total"] == 0:
        assert not any("LIMIT" in statement.upper() for statement in statements[1:])
    assert saved["facets"]["active_total"] == 2


@pytest.mark.parametrize("stored_version", [99, "invalid"])
def test_invalid_saved_definition_is_isolated_and_repairable(smart_app, stored_version):
    client, engine = smart_app
    good = create(client, "Good")
    bad = create(client, "Bad")
    with Session(engine) as session:
        row = session.get(SmartCollection, bad["id"])
        row.query_version = stored_version
        session.commit()
    listed = client.get("/smart-collections").json()
    assert [item["query_valid"] for item in listed] == [False, True]
    assert listed[0]["query_version"] == (99 if stored_version == 99 else None)
    assert client.get(f"/smart-collections/{bad['id']}").json()["query"] is None
    assert client.get(f"/smart-collections/{bad['id']}/photos").status_code == 422
    assert client.get(f"/smart-collections/{good['id']}/photos").status_code == 200
    assert (
        client.patch(
            f"/smart-collections/{bad['id']}", json={"name": "Still bad"}
        ).json()["query_valid"]
        is False
    )
    assert (
        client.patch(
            f"/smart-collections/{bad['id']}", json={"query_version": 1, "query": {}}
        ).json()["query_valid"]
        is True
    )
    with Session(engine) as session:
        row = session.get(SmartCollection, bad["id"])
        row.query_json = '{"unknown": true}'
        session.commit()
    assert client.get(f"/smart-collections/{bad['id']}").json()["query_valid"] is False


def test_v2_round_trip_and_explicit_upgrade_preserve_versions_on_rename(smart_app):
    client, engine = smart_app
    criteria = {
        "tags": [" Birds ", "Birds", "birds"],
        "camera_make": " Canon ",
        "camera_model": "  ",
        "unknown_lens": True,
        "metadata_issue": "complete",
        "bbox_south": 0,
        "bbox_north": 10,
        "bbox_west": 170,
        "bbox_east": -170,
    }
    normalized = {
        **criteria,
        "tags": ["Birds", "birds"],
        "camera_make": "Canon",
        "camera_model": "",
    }
    new = create(client, "Advanced", criteria, version=2)
    legacy = create(client, "Legacy", {"search": "owl"})
    for item in (new, legacy):
        url = f"/smart-collections/{item['id']}"
        assert client.get(url).json() == item
        with Session(engine) as session:
            previous = session.get(SmartCollection, item["id"]).query_json
        renamed = client.patch(url, json={"name": f"{item['name']} renamed"})
        assert renamed.status_code == 200
        assert renamed.json()["query_version"] == item["query_version"]
        assert renamed.json()["query"] == item["query"]
        with Session(engine) as session:
            assert session.get(SmartCollection, item["id"]).query_json == previous

    assert "tags" not in legacy["query"]
    url = f"/smart-collections/{legacy['id']}"
    upgraded = client.patch(url, json={"query_version": 2, "query": criteria})
    assert upgraded.status_code == 200, upgraded.text
    assert upgraded.json()["query_version"] == 2
    assert upgraded.json()["query"] == new["query"]
    assert {key: new["query"][key] for key in normalized} == normalized
    assert client.get(url).json() == upgraded.json()
    assert [
        item["query_version"] for item in client.get("/smart-collections").json()
    ] == [2, 2]


@pytest.mark.parametrize(
    ("version", "criteria"),
    [
        (1, {"tags": ["Birds"]}),
        (1, {"unknown_camera": False}),
        (3, {}),
        ("2", {}),
        (2.0, {}),
        (True, {}),
        (2, {"tags": "Birds"}),
        (2, {"tags": ["Birds"], "untagged": True}),
        (2, {"tags": ["x"] * 21}),
        (1, {"iso_speed_min": 800}),
        (2, {"focal_length_mm_max": 400}),
        (2, {"tags": ["x" * 1001]}),
        (2, {"unknown_camera": True, "camera_make": ""}),
        (2, {"unknown_camera": True, "camera_model": "R7"}),
        (2, {"unknown_lens": True, "lens_model": "RF"}),
        (2, {"metadata_issue": "bad"}),
        (2, {"bbox_south": 0}),
        (2, {"bbox_south": 0, "bbox_north": 0, "bbox_west": 1, "bbox_east": 2}),
        (2, {"bbox_south": 0, "bbox_north": 1, "bbox_west": 180, "bbox_east": -180}),
        (2, {"bbox_south": 0, "bbox_north": 1, "bbox_west": -181, "bbox_east": 0}),
        (2, {"bbox_south": "0", "bbox_north": 1, "bbox_west": -1, "bbox_east": 0}),
        (2, {"bbox_south": True, "bbox_north": 2, "bbox_west": -1, "bbox_east": 0}),
        (2, {"event_id": 1}),
        (2, {"page": 2}),
        (2, {"page_size": 2}),
        (2, {"layout": "grouped"}),
        (2, {"selection": [1]}),
    ],
)
def test_versioned_validation_rejects_invalid_definitions_without_mutation(
    smart_app, version, criteria
):
    client, _ = smart_app
    item = create(client)
    url = f"/smart-collections/{item['id']}"
    body = {"name": "Rejected", "query_version": version, "query": criteria}
    assert client.post("/smart-collections", json=body).status_code == 422
    assert client.patch(url, json=body).status_code == 422
    assert client.get(url).json() == item


@pytest.mark.parametrize(
    ("version", "serialized"),
    [
        (1, '{"tags":["Birds"]}'),
        (2, "{"),
        (2, '{"bbox_south":0}'),
        (2, '{"event_id":1}'),
    ],
)
def test_corrupt_saved_query_can_be_replaced(smart_app, version, serialized):
    client, engine = smart_app
    item = create(client, version=version)
    url = f"/smart-collections/{item['id']}"
    with Session(engine) as session:
        session.get(SmartCollection, item["id"]).query_json = serialized
        session.commit()

    detail = client.get(url).json()
    assert detail["query"] is None and not detail["query_valid"]
    assert "Replace" in detail["query_error"]
    response = client.get(f"{url}/photos")
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_smart_collection_query"
    repaired = client.patch(
        url, json={"query_version": 2, "query": {"tags": ["Birds"]}}
    )
    assert repaired.json()["query_valid"] is True


def set_legacy_gps(engine, *rows):
    # Simulate old invalid GPS rows without weakening current Photo validation.
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        try:
            connection.exec_driver_sql(
                "UPDATE photo SET latitude=?, longitude=? WHERE id=?", list(rows)
            )
        finally:
            connection.exec_driver_sql("PRAGMA ignore_check_constraints=OFF")


def test_advanced_results_match_live_catalog_with_sql_pagination(smart_app):
    client, engine = smart_app
    bounds = {"bbox_south": 0, "bbox_north": 10, "bbox_west": 170, "bbox_east": -170}
    with Session(engine) as session:
        bird = add_taxon(session, "Bubo bubo")
        data = {
            "tags": ["Birds", "night"],
            "status": "classified",
            "category": "bird",
            "taxon": bird,
            "camera_make": "Canon",
            "camera_model": "EOS R7",
            "lens_model": "RF 100-500",
            "captured_at": datetime(2026, 4, 1),
            "latitude": 0,
            "longitude": 175,
            "is_favorite": True,
            "rating": 4,
            "culling_state": "pick",
            "display_title": "Owl",
        }
        first = add_photo(session, 1, **data).id
        second = add_photo(session, 2, **{**data, "longitude": -175}).id
        for index, override in enumerate(
            [
                {"tags": ["Birds"]},
                {"tags": ["birds", "night"]},
                {"camera_model": "EOS R7 II"},
                {"lens_model": "rf 100-500"},
                {"longitude": 0},
                {"deleted_at": datetime(2026, 4, 2)},
                {"is_favorite": False},
            ],
            start=3,
        ):
            add_photo(session, index, **{**data, **override})
        partial = add_photo(session, 20, **data).id
        invalid = add_photo(session, 21, **data).id
        session.commit()
        taxon_id = bird.id
    set_legacy_gps(engine, (None, 175, partial), (0, 181, invalid))
    query = {
        **bounds,
        "tags": ["Birds", "night"],
        "camera_make": "Canon",
        "camera_model": "EOS R7",
        "lens_model": "RF 100-500",
        "metadata_issue": "complete",
        "taken_from": "2026-01-01",
        "taken_to": "2026-12-31",
        "category": "bird",
        "taxon_id": taxon_id,
        "status": "classified",
        "favorites_only": True,
        "rating_min": 4,
        "culling_state": "pick",
        "search": "owl",
        "sort": "captured_at",
    }
    saved = create(client, query=query, version=2)
    for page, expected in [(1, [second]), (2, [first]), (3, [])]:
        params = {"page": page, "page_size": 1}
        catalog = client.get("/catalog/photos", params={**query, **params})
        result = client.get(f"/smart-collections/{saved['id']}/photos", params=params)
        assert catalog.status_code == result.status_code == 200
        assert result.json() == catalog.json()
        assert result.json()["total"] == result.json()["total_pages"] == 2
        assert [item["id"] for item in result.json()["items"]] == expected


def test_v2_untagged_unknown_equipment_and_metadata_states(smart_app):
    client, engine = smart_app
    with Session(engine) as session:
        origin = add_photo(session, 1, latitude=0, longitude=0).id
        partial = add_photo(
            session,
            2,
            captured_at=datetime(2026, 1, 1),
            camera_make=" Canon ",
            tags=["Birds"],
        ).id
        invalid = add_photo(session, 3, lens_model="RF").id
        complete = add_photo(
            session,
            4,
            captured_at=datetime(2026, 1, 1),
            latitude=1,
            longitude=1,
            camera_model="EOS R7",
            lens_model="RF",
        ).id
        session.commit()
    set_legacy_gps(engine, (0, None, partial), (91, 0, invalid))
    cases = [
        ({"untagged": True}, [complete, invalid, origin]),
        ({"unknown_camera": True}, [invalid, origin]),
        ({"unknown_lens": True}, [partial, origin]),
        ({"camera_make": "Canon", "camera_model": ""}, [partial]),
        ({"metadata_issue": "missing_capture"}, [invalid, origin]),
        ({"metadata_issue": "missing_gps"}, [invalid, partial]),
        ({"metadata_issue": "missing_both"}, [invalid]),
        ({"metadata_issue": "missing_either"}, [invalid, partial, origin]),
        ({"metadata_issue": "complete"}, [complete]),
        ({"bbox_south": -1, "bbox_north": 0, "bbox_west": 0, "bbox_east": 1}, [origin]),
    ]
    for index, (criteria, expected) in enumerate(cases):
        saved = create(client, f"Case {index}", criteria, version=2)
        actual = client.get(f"/smart-collections/{saved['id']}/photos")
        assert actual.status_code == 200
        assert actual.json() == client.get("/catalog/photos", params=criteria).json()
        assert [item["id"] for item in actual.json()["items"]] == expected


def test_v2_membership_follows_archive_edits_without_rewriting_criteria(smart_app):
    client, engine = smart_app
    with Session(engine) as session:
        owl = add_taxon(session, "Bubo bubo")
        fox = add_taxon(session, "Vulpes vulpes")
        owl_id, fox_id = owl.id, fox.id
        session.commit()
    criteria = {
        "tags": ["Birds"],
        "camera_model": "R7",
        "metadata_issue": "complete",
        "bbox_south": 0,
        "bbox_north": 10,
        "bbox_west": 0,
        "bbox_east": 10,
        "category": "bird",
        "taxon_id": owl_id,
        "taken_from": "2026-01-01",
    }
    item = create(client, query=criteria, version=2)
    url = f"/smart-collections/{item['id']}"

    def matching(*ids):
        response = client.get(f"{url}/photos")
        assert response.status_code == 200
        assert [photo["id"] for photo in response.json()["items"]] == list(ids)

    matching()
    with Session(engine) as session:
        photo = add_photo(
            session,
            1,
            category="bird",
            taxon=session.get(Taxon, owl_id),
            tags=["Birds"],
            camera_model="R7",
            captured_at=datetime(2026, 1, 1),
            latitude=0,
            longitude=0,
            extracted_latitude=0,
            extracted_longitude=0,
        )
        photo_id, animal_id = photo.id, photo.animal_id
        add_photo(session, 2, tags=["Merged"])
        session.commit()
    matching(photo_id)

    def edit(**data):
        current = client.get(f"/photos/{photo_id}").json()
        response = client.patch(
            f"/photos/{photo_id}",
            params={"expected_updated_at": current["updated_at"]},
            json=data,
        )
        assert response.status_code == 200, response.text

    edit(tags=["birds"])
    matching()
    edit(tags=["Birds"])
    matching(photo_id)
    for operation, destination in [("rename", "Renamed"), ("merge", "Merged")]:
        preview, body = preview_tag_operation(client, operation, "Birds", destination)
        assert apply_tag_operation(client, preview, body).status_code == 200
        matching()
        edit(tags=["Birds"])
        matching(photo_id)

    edit(latitude=None, longitude=None)
    matching()
    edit(latitude=0, longitude=0)
    matching(photo_id)
    edit(captured_at="2025-12-31T23:59:59", captured_at_offset_minutes=None)
    matching()
    edit(captured_at="2026-01-01T00:00:00", captured_at_offset_minutes=None)
    matching(photo_id)
    for changes in [
        {"camera_model": "R6"},
        {"camera_model": "R7", "category": "mammal"},
        {"category": "bird"},
    ]:
        with Session(engine) as session:
            photo = session.get(Photo, photo_id)
            for field, value in changes.items():
                setattr(photo, field, value)
            session.commit()
        matching(*([photo_id] if changes == {"category": "bird"} else []))
    for taxon_id, expected in [(fox_id, []), (owl_id, [photo_id])]:
        with Session(engine) as session:
            session.get(Animal, animal_id).taxon_id = taxon_id
            session.commit()
        matching(*expected)
    assert client.delete(f"/photos/{photo_id}").status_code == 200
    matching()
    assert client.post(f"/trash/photos/{photo_id}/restore").status_code == 200
    matching(photo_id)
    assert client.get(url).json() == item
    with Session(engine) as session:
        assert not session.exec(select(CollectionPhoto)).all()
