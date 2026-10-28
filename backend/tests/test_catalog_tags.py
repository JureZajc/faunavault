from datetime import UTC, datetime

import pytest
from sqlalchemy import event, text
from sqlmodel import Session

from tests.test_catalog import add_photo, add_taxon
from tests.test_catalog import catalog_app as catalog_app


def test_empty_tags_and_no_tags(catalog_app):
    client, engine = catalog_app
    assert client.get("/catalog/tags").json() == {
        "tags": [],
        "total_tags": 0,
        "untagged_count": 0,
    }
    with Session(engine) as session:
        add_photo(session, 1)
        session.commit()
    assert client.get("/catalog/tags").json() == {
        "tags": [],
        "total_tags": 0,
        "untagged_count": 1,
    }
    assert client.get("/catalog/photos", params={"untagged": True}).json()["total"] == 1


def test_counts_exact_and_combined_filters_pagination_and_culling(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        taxon = add_taxon(session, "Test bird")
        first = add_photo(
            session,
            1,
            tags=["birds", "sunset", "birds"],
            category="bird",
            taxon=taxon,
            rating=4,
            is_favorite=True,
        )
        second = add_photo(
            session,
            2,
            tags=["birds"],
            category="bird",
            taxon=taxon,
            rating=5,
            is_favorite=True,
        )
        add_photo(
            session, 3, tags=["bird", "Birds", "100%_x", "quote'\""], category="mammal"
        )
        add_photo(session, 4, tags=["birds"], deleted_at=datetime.now(UTC))
        ids = [first.id, second.id]
        taxon_id = taxon.id
        session.commit()
    data = client.get("/catalog/tags").json()
    counts = {tag["name"]: tag["count"] for tag in data["tags"]}
    assert counts == {
        "birds": 2,
        "sunset": 1,
        "bird": 1,
        "Birds": 1,
        "100%_x": 1,
        "quote'\"": 1,
    }
    assert data["total_tags"] == 6
    assert data["untagged_count"] == 0
    for tag, count in counts.items():
        assert (
            client.get("/catalog/photos", params={"tags": tag}).json()["total"] == count
        )
    query = [("tags", " birds "), ("tags", "sunset"), ("tags", "birds")]
    assert [
        photo["id"]
        for photo in client.get("/catalog/photos", params=query).json()["items"]
    ] == ids[:1]
    combined = {
        "tags": "birds",
        "search": "bird",
        "category": "bird",
        "taxon_id": taxon_id,
        "rating_min": 4,
        "favorites_only": True,
        "status": "pending",
        "sort": "name",
        "order": "asc",
        "page_size": 1,
    }
    page1 = client.get("/catalog/photos", params=combined).json()
    page2 = client.get("/catalog/photos", params={**combined, "page": 2}).json()
    assert page1["total"] == 2 and page1["total_pages"] == 2
    assert [page1["items"][0]["id"], page2["items"][0]["id"]] == ids
    assert page1["facets"]["active_total"] == 3
    assert (
        client.get(
            "/catalog/photos", params={"tags": "sunset", "search": "nonexistent"}
        ).json()["total"]
        == 0
    )
    assert (
        client.get(
            "/catalog/photos", params={"tags": "birds", "search": "mammal"}
        ).json()["total"]
        == 0
    )
    culling = client.get("/catalog/culling", params=query).json()
    assert culling["total"] == 1 and culling["photo"]["id"] == ids[0]


def test_malformed_legacy_values_are_safe_and_duplicates_count_once(catalog_app):
    client, engine = catalog_app
    raw = [
        "not-json",
        "null",
        "{}",
        '"birds"',
        "42",
        '[null, 3, {}, [], true, "", "  "]',
        '[" birds ", "birds", "\u2003birds\u2003", "Birds"]',
    ]
    with Session(engine) as session:
        ids = [add_photo(session, i).id for i in range(len(raw))]
        for photo_id, tags in zip(ids, raw, strict=True):
            session.exec(
                text("UPDATE photo SET tags=:tags WHERE id=:id").bindparams(
                    tags=tags, id=photo_id
                )
            )
        session.commit()
    counts = client.get("/catalog/tags").json()
    assert counts == {
        "tags": [{"name": "Birds", "count": 1}, {"name": "birds", "count": 1}],
        "total_tags": 2,
        "untagged_count": 6,
    }
    assert client.get("/catalog/photos", params={"tags": "birds"}).json()["total"] == 1
    response = client.get("/catalog/photos", params={"untagged": True})
    assert response.status_code == 200
    assert response.json()["total"] == 6
    assert all(photo["tags"] == [] for photo in response.json()["items"])


def test_updates_trash_restore_and_bulk_keep_counts_fresh(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        photo_id = add_photo(session, 1, tags=["bird"]).id
        session.commit()
    assert (
        client.patch(
            f"/photos/{photo_id}", json={"tags": [" birds ", "sunset", "birds"]}
        ).status_code
        == 200
    )
    assert client.get("/catalog/photos", params={"tags": "bird"}).json()["total"] == 0
    assert client.get("/catalog/tags").json()["total_tags"] == 2
    assert client.delete(f"/photos/{photo_id}").status_code == 200
    assert client.get("/catalog/tags").json()["total_tags"] == 0
    assert client.post(f"/trash/photos/{photo_id}/restore").status_code == 200
    assert client.get("/catalog/tags").json()["total_tags"] == 2
    for operation, count in (("add_tags", 3), ("remove_tags", 2)):
        assert (
            client.post(
                "/photos/bulk",
                json={
                    "photo_ids": [photo_id],
                    "operation": operation,
                    "tags": ["woodland"],
                },
            ).status_code
            == 200
        )
        assert client.get("/catalog/tags").json()["total_tags"] == count


@pytest.mark.parametrize("path", ["/catalog/photos", "/catalog/culling"])
def test_filter_limits_and_conflicts(catalog_app, path):
    client, _ = catalog_app
    for params in (
        [("tags", str(i)) for i in range(21)],
        {"tags": "x" * 1001},
        {"tags": "birds", "untagged": True},
    ):
        assert client.get(path, params=params).status_code == 422
    assert client.get("/catalog/map", params={"tags": "birds"}).status_code == 422
    assert client.get("/catalog/map", params={"untagged": True}).status_code == 422
    response = client.post(
        "/smart-collections",
        json={"name": "Tags", "query_version": 1, "query": {"tags": ["birds"]}},
    )
    assert response.status_code == 422


def test_aggregation_is_two_sql_queries_and_never_loads_photos(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        for index in range(100):
            add_photo(session, index, tags=["birds", "sunset", "birds"])
        session.commit()
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert client.get("/catalog/tags").json()["tags"] == [
            {"name": "birds", "count": 100},
            {"name": "sunset", "count": 100},
        ]
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert len(statements) == 2
    assert all("json_each" in sql for sql in statements)
    assert not any("photo.original_filename" in sql for sql in statements)
