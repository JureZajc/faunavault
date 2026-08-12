import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI

import app.main as main
from app.clients.gbif import GbifClient, GbifClientError, get_gbif_client


def usage_payload(key=1, **overrides):
    return {
        "key": key,
        "scientificName": "Panthera leo (Linnaeus, 1758)",
        "canonicalName": "Panthera leo",
        "rank": "SPECIES",
        "kingdom": "Animalia",
        "phylum": "Chordata",
        "class": "Mammalia",
        "order": "Carnivora",
        "family": "Felidae",
        "genus": "Panthera",
        "species": "Panthera leo",
        **overrides,
    }


def test_search_parses_and_caches_only_remote_results():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"results": [usage_payload()]})

    client = GbifClient(
        "https://example.test/v1",
        transport=httpx.MockTransport(handler),
    )
    first = client.search_taxa(" Lion ", 12)
    second = client.search_taxa("lion", 12)

    assert first == second
    assert first[0].key == 1
    assert first[0].taxonomic_class == "Mammalia"
    assert len(calls) == 1
    assert calls[0].url.params["q"] == " Lion "
    assert calls[0].url.params["limit"] == "24"
    assert calls[0].url.params["status"] == "ACCEPTED"
    client.close()


def test_search_cache_expires_and_is_bounded():
    now = [0.0]
    calls = []

    def handler(request):
        calls.append(request.url.params["q"])
        return httpx.Response(200, json={"results": [usage_payload()]})

    client = GbifClient(
        "https://example.test/v1",
        cache_ttl_seconds=10,
        cache_max_entries=1,
        clock=lambda: now[0],
        transport=httpx.MockTransport(handler),
    )
    client.search_taxa("lion", 2)
    client.search_taxa("tiger", 2)
    client.search_taxa("lion", 2)
    now[0] = 20
    client.search_taxa("lion", 2)
    assert calls == ["lion", "tiger", "lion", "lion"]
    client.close()


@pytest.mark.parametrize(
    ("raised", "code"),
    [
        (httpx.ReadTimeout("slow"), "timeout"),
        (httpx.ConnectError("offline"), "unavailable"),
    ],
)
def test_request_errors_are_typed_and_not_cached(raised, code):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        raised.request = request
        raise raised

    client = GbifClient(
        "https://example.test/v1",
        transport=httpx.MockTransport(handler),
    )
    for _ in range(2):
        with pytest.raises(GbifClientError) as error:
            client.search_taxa("lion", 2)
        assert error.value.code == code
    assert calls == 2
    client.close()


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"not-json"),
        httpx.Response(200, json={"results": {}}),
        httpx.Response(200, json={"results": [{"key": 1}]}),
    ],
)
def test_invalid_search_responses_are_typed(response):
    client = GbifClient(
        "https://example.test/v1",
        transport=httpx.MockTransport(lambda _request: response),
    )
    with pytest.raises(GbifClientError) as error:
        client.search_taxa("lion", 2)
    assert error.value.code == "invalid_response"
    client.close()


def test_resolve_follows_accepted_taxon_and_prefers_english_vernacular():
    paths = []

    def handler(request):
        paths.append(request.url.path)
        if request.url.path.endswith("/species/10"):
            return httpx.Response(200, json=usage_payload(10, acceptedKey=20))
        if request.url.path.endswith("/species/20"):
            return httpx.Response(200, json=usage_payload(20))
        return httpx.Response(
            200,
            json={
                "results": [
                    {"language": "sl", "vernacularName": "Lev"},
                    {"language": "en", "vernacularName": "Lion"},
                ]
            },
        )

    client = GbifClient(
        "https://example.test/v1",
        transport=httpx.MockTransport(handler),
    )
    resolved = client.resolve_taxon(10)
    assert resolved.requested_key == 10
    assert resolved.usage.key == 20
    assert resolved.usage.common_name == "Lion"
    assert paths == [
        "/v1/species/10",
        "/v1/species/20",
        "/v1/species/20/vernacularNames",
    ]
    client.close()


def test_match_parsing_and_idempotent_close():
    client = GbifClient(
        "https://example.test/v1",
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={
                    "matchType": "EXACT",
                    "confidence": 100,
                    "usageKey": 1,
                    "rank": "SPECIES",
                    "kingdom": "Animalia",
                },
            )
        ),
    )
    close = Mock(wraps=client._client.close)
    client._client.close = close
    assert client.match_taxon("Panthera leo").usage_key == 1
    client.close()
    client.close()
    close.assert_called_once_with()


class LifecycleClient:
    def __init__(self):
        self.close_count = 0

    def close(self):
        self.close_count += 1


class LifecycleWorker:
    def __init__(self, fail_start=False, fail_stop=False):
        self.fail_start = fail_start
        self.fail_stop = fail_stop
        self.started = False

    async def start(self):
        if self.fail_start:
            raise RuntimeError("worker start failed")
        self.started = True

    async def stop(self):
        if self.fail_stop:
            raise RuntimeError("worker stop failed")


def test_lifespan_wires_dependency_and_closes_client(monkeypatch):
    application = FastAPI()
    client = LifecycleClient()
    application.state.gbif_client_factory = lambda: client
    application.state.classification_worker = LifecycleWorker()
    monkeypatch.setattr(main, "on_startup", lambda: None)
    monkeypatch.setattr(main, "recover_interrupted_jobs", lambda _engine: None)

    async def exercise():
        async with main.lifespan(application):
            request = SimpleNamespace(app=application)
            assert get_gbif_client(request) is client
            assert client.close_count == 0

    asyncio.run(exercise())
    assert client.close_count == 1
    assert not hasattr(application.state, "gbif_client")


def test_lifespan_closes_client_when_other_shutdown_fails(monkeypatch):
    application = FastAPI()
    client = LifecycleClient()
    application.state.gbif_client_factory = lambda: client
    application.state.classification_worker = LifecycleWorker(fail_stop=True)
    monkeypatch.setattr(main, "on_startup", lambda: None)
    monkeypatch.setattr(main, "recover_interrupted_jobs", lambda _engine: None)

    async def exercise():
        with pytest.raises(RuntimeError, match="worker stop failed"):
            async with main.lifespan(application):
                pass

    asyncio.run(exercise())
    assert client.close_count == 1
    assert not hasattr(application.state, "gbif_client")


def test_lifespan_closes_client_when_startup_fails(monkeypatch):
    application = FastAPI()
    client = LifecycleClient()
    application.state.gbif_client_factory = lambda: client
    application.state.classification_worker = LifecycleWorker(fail_start=True)
    monkeypatch.setattr(main, "on_startup", lambda: None)
    monkeypatch.setattr(main, "recover_interrupted_jobs", lambda _engine: None)

    async def exercise():
        with pytest.raises(RuntimeError, match="worker start failed"):
            async with main.lifespan(application):
                pass

    asyncio.run(exercise())
    assert client.close_count == 1
    assert not hasattr(application.state, "gbif_client")
