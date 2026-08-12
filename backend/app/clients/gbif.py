from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Literal

import httpx
from fastapi import Depends, Request

logger = logging.getLogger(__name__)

GBIF_UNAVAILABLE_DETAIL = "GBIF taxonomy service is temporarily unavailable"
GBIF_USER_AGENT = "FaunaVault/0.1 taxonomy integration"

GbifErrorCode = Literal[
    "unavailable",
    "timeout",
    "invalid_response",
    "request_failed",
]


class GbifClientError(RuntimeError):
    def __init__(
        self,
        code: GbifErrorCode,
        operation: str,
        *,
        status_code: int | None = None,
    ) -> None:
        super().__init__(GBIF_UNAVAILABLE_DETAIL)
        self.code = code
        self.operation = operation
        self.status_code = status_code


@dataclass(frozen=True)
class GbifUsage:
    key: int
    scientific_name: str
    canonical_name: str
    rank: str
    kingdom: str | None
    phylum: str | None
    taxonomic_class: str | None
    taxonomic_order: str | None
    family: str | None
    genus: str | None
    species: str | None
    accepted_key: int | None = None
    common_name: str | None = None


@dataclass(frozen=True)
class GbifMatch:
    match_type: str
    confidence: int | float | None
    usage_key: int | None
    accepted_usage_key: int | None
    rank: str | None
    kingdom: str | None
    note: str | None


@dataclass(frozen=True)
class GbifResolvedTaxon:
    requested_key: int
    usage: GbifUsage


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _required_key(value: object, operation: str) -> int:
    if isinstance(value, bool):
        raise GbifClientError("invalid_response", operation)
    try:
        key = int(value)
    except (TypeError, ValueError) as exc:
        raise GbifClientError("invalid_response", operation) from exc
    if key < 1:
        raise GbifClientError("invalid_response", operation)
    return key


def _optional_key(value: object, operation: str) -> int | None:
    if value is None:
        return None
    return _required_key(value, operation)


def _parse_usage(payload: object, operation: str) -> GbifUsage:
    if not isinstance(payload, dict):
        raise GbifClientError("invalid_response", operation)
    key = _required_key(payload.get("key") or payload.get("usageKey"), operation)
    scientific_name = _optional_text(payload.get("scientificName"))
    canonical_name = _optional_text(payload.get("canonicalName"))
    if scientific_name is None and canonical_name is None:
        raise GbifClientError("invalid_response", operation)

    vernacular = None
    names = payload.get("vernacularNames")
    if names is not None:
        if not isinstance(names, list):
            raise GbifClientError("invalid_response", operation)
        first = names[0] if names else None
        if isinstance(first, dict):
            vernacular = _optional_text(first.get("vernacularName"))

    return GbifUsage(
        key=key,
        scientific_name=scientific_name or canonical_name or "",
        canonical_name=canonical_name or scientific_name or "",
        rank=str(payload.get("rank") or "SPECIES").upper(),
        kingdom=_optional_text(payload.get("kingdom")),
        phylum=_optional_text(payload.get("phylum")),
        taxonomic_class=_optional_text(payload.get("class")),
        taxonomic_order=_optional_text(payload.get("order")),
        family=_optional_text(payload.get("family")),
        genus=_optional_text(payload.get("genus")),
        species=_optional_text(payload.get("species")) or canonical_name,
        accepted_key=_optional_key(payload.get("acceptedKey"), operation),
        common_name=vernacular,
    )


class GbifClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: httpx.Timeout | None = None,
        cache_ttl_seconds: float = 600,
        cache_max_entries: int = 256,
        clock: Callable[[], float] = time.monotonic,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout or httpx.Timeout(10.0, connect=3.0),
            headers={"User-Agent": GBIF_USER_AGENT},
            transport=transport,
        )
        self._cache_ttl_seconds = cache_ttl_seconds
        self._cache_max_entries = cache_max_entries
        self._clock = clock
        self._search_cache: OrderedDict[
            tuple[str, int], tuple[float, tuple[GbifUsage, ...]]
        ] = OrderedDict()
        self._lock = threading.Lock()
        self._closed = False

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._search_cache.clear()
        self._client.close()

    def _request_json(
        self,
        path: str,
        *,
        operation: str,
        params: dict[str, object] | None = None,
    ) -> dict:
        try:
            response = self._client.get(path, params=params)
            response.raise_for_status()
            payload = response.json()
        except httpx.TimeoutException as exc:
            logger.warning("GBIF operation=%s category=timeout", operation)
            raise GbifClientError("timeout", operation) from exc
        except httpx.ConnectError as exc:
            logger.warning("GBIF operation=%s category=unavailable", operation)
            raise GbifClientError("unavailable", operation) from exc
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            code: GbifErrorCode = (
                "unavailable" if status_code >= 500 else "request_failed"
            )
            logger.warning(
                "GBIF operation=%s category=%s status_code=%s",
                operation,
                code,
                status_code,
            )
            raise GbifClientError(code, operation, status_code=status_code) from exc
        except httpx.RequestError as exc:
            logger.warning("GBIF operation=%s category=request_failed", operation)
            raise GbifClientError("request_failed", operation) from exc
        except ValueError as exc:
            logger.warning("GBIF operation=%s category=invalid_response", operation)
            raise GbifClientError("invalid_response", operation) from exc
        if not isinstance(payload, dict):
            logger.warning("GBIF operation=%s category=invalid_response", operation)
            raise GbifClientError("invalid_response", operation)
        return payload

    def search_taxa(self, query: str, limit: int) -> list[GbifUsage]:
        cache_key = (query.strip().lower(), limit)
        now = self._clock()
        with self._lock:
            cached = self._search_cache.get(cache_key)
            if cached is not None:
                cached_at, usages = cached
                if now - cached_at < self._cache_ttl_seconds:
                    self._search_cache.move_to_end(cache_key)
                    return list(usages)
                del self._search_cache[cache_key]

        payload = self._request_json(
            "/species/search",
            operation="search",
            params={"q": query, "limit": limit * 2, "status": "ACCEPTED"},
        )
        raw_results = payload.get("results")
        if not isinstance(raw_results, list):
            raise GbifClientError("invalid_response", "search")
        usages = tuple(_parse_usage(item, "search") for item in raw_results)
        with self._lock:
            self._search_cache[cache_key] = (now, usages)
            self._search_cache.move_to_end(cache_key)
            while len(self._search_cache) > self._cache_max_entries:
                self._search_cache.popitem(last=False)
        return list(usages)

    def match_taxon(self, name: str) -> GbifMatch:
        payload = self._request_json(
            "/species/match",
            operation="match",
            params={"name": name, "kingdom": "Animalia", "verbose": "true"},
        )
        match_type = _optional_text(payload.get("matchType"))
        if match_type is None:
            raise GbifClientError("invalid_response", "match")
        confidence = payload.get("confidence")
        if confidence is not None and (
            isinstance(confidence, bool) or not isinstance(confidence, (int, float))
        ):
            raise GbifClientError("invalid_response", "match")
        return GbifMatch(
            match_type=match_type,
            confidence=confidence,
            usage_key=_optional_key(payload.get("usageKey"), "match"),
            accepted_usage_key=_optional_key(payload.get("acceptedUsageKey"), "match"),
            rank=_optional_text(payload.get("rank")),
            kingdom=_optional_text(payload.get("kingdom")),
            note=_optional_text(payload.get("note")),
        )

    def resolve_taxon(self, key: int) -> GbifResolvedTaxon:
        usage = _parse_usage(
            self._request_json(f"/species/{key}", operation="resolve"),
            "resolve",
        )
        if usage.accepted_key is not None and usage.accepted_key != key:
            usage = _parse_usage(
                self._request_json(
                    f"/species/{usage.accepted_key}", operation="resolve_accepted"
                ),
                "resolve_accepted",
            )
        try:
            common_name = self._preferred_vernacular(usage.key)
        except GbifClientError as exc:
            logger.warning(
                "GBIF operation=vernacular key=%s category=%s; continuing without name",
                usage.key,
                exc.code,
            )
            common_name = None
        usage = GbifUsage(**{**usage.__dict__, "common_name": common_name})
        return GbifResolvedTaxon(requested_key=key, usage=usage)

    def _preferred_vernacular(self, key: int) -> str | None:
        payload = self._request_json(
            f"/species/{key}/vernacularNames",
            operation="vernacular",
        )
        names = payload.get("results")
        if not isinstance(names, list):
            raise GbifClientError("invalid_response", "vernacular")
        parsed: list[tuple[str | None, str]] = []
        for item in names:
            if not isinstance(item, dict):
                raise GbifClientError("invalid_response", "vernacular")
            name = _optional_text(item.get("vernacularName"))
            if name:
                parsed.append((_optional_text(item.get("language")), name))
        english = next(
            (
                name
                for language, name in parsed
                if (language or "").lower() in {"eng", "en"}
            ),
            None,
        )
        return english or next((name for _, name in parsed), None)


def get_gbif_client(request: Request) -> GbifClient:
    client = getattr(request.app.state, "gbif_client", None)
    if client is None:
        raise RuntimeError("GBIF client is unavailable outside application lifespan")
    return client


GbifClientDep = Annotated[GbifClient, Depends(get_gbif_client)]
