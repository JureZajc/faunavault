from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import and_, case, exists, func, or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased
from sqlmodel import Session, select

from app.clients.gbif import (
    GbifClient,
    GbifClientError,
    GbifResolvedTaxon,
    GbifUsage,
)
from app.models import Animal, Taxon, utc_now

logger = logging.getLogger(__name__)


class AnimalNotFoundError(Exception):
    pass


@dataclass(frozen=True)
class PreparedTaxonSelection:
    existing_taxon_id: int | None = None
    resolved: GbifResolvedTaxon | None = None


@dataclass(frozen=True)
class LegacyReconciliationGroup:
    legacy_group: str
    legacy_name: str
    animal_count: int


def taxon_to_candidate(taxon: Taxon, cached: bool = True) -> dict:
    return {
        "provider": taxon.provider,
        "external_taxon_id": int(taxon.external_taxon_id),
        "scientific_name": taxon.scientific_name,
        "canonical_name": taxon.canonical_name,
        "common_name": taxon.common_name,
        "rank": taxon.taxonomic_rank,
        "kingdom": taxon.kingdom,
        "phylum": taxon.phylum,
        "class": taxon.taxonomic_class,
        "order": taxon.taxonomic_order,
        "family": taxon.family,
        "genus": taxon.genus,
        "species": taxon.species,
        "cached": cached,
    }


def usage_to_candidate(usage: GbifUsage) -> dict:
    return {
        "provider": "gbif",
        "external_taxon_id": usage.key,
        "scientific_name": usage.scientific_name,
        "canonical_name": usage.canonical_name,
        "common_name": usage.common_name,
        "rank": usage.rank,
        "kingdom": usage.kingdom,
        "phylum": usage.phylum,
        "class": usage.taxonomic_class,
        "order": usage.taxonomic_order,
        "family": usage.family,
        "genus": usage.genus,
        "species": usage.species,
        "cached": False,
    }


def assign_taxon(animal: Animal, taxon: Taxon, status: str) -> None:
    animal.taxon_id = taxon.id
    animal.taxonomy_status = status
    animal.taxonomy_note = None
    animal.updated_at = utc_now()


def _taxon_by_external_key(session: Session, key: int) -> Taxon | None:
    return session.exec(
        select(Taxon).where(
            Taxon.provider == "gbif",
            Taxon.external_taxon_id == str(key),
        )
    ).first()


def prepare_taxon_selection(
    session: Session,
    client: GbifClient,
    gbif_key: int,
) -> PreparedTaxonSelection:
    existing = _taxon_by_external_key(session, gbif_key)
    if existing is not None:
        existing_id = existing.id
        session.rollback()
        return PreparedTaxonSelection(existing_taxon_id=existing_id)
    session.rollback()
    return PreparedTaxonSelection(resolved=client.resolve_taxon(gbif_key))


def persist_taxon_selection(
    session: Session,
    selection: PreparedTaxonSelection,
) -> Taxon:
    connection = session.connection()
    driver_connection = connection.connection.driver_connection
    if connection.dialect.name == "sqlite" and not driver_connection.in_transaction:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
    if selection.existing_taxon_id is not None:
        existing = session.get(Taxon, selection.existing_taxon_id)
        if existing is None:
            raise RuntimeError("Selected local Taxon no longer exists")
        return existing
    if selection.resolved is None:
        raise RuntimeError("Taxon selection has no local or remote value")

    usage = selection.resolved.usage
    existing = _taxon_by_external_key(session, usage.key)
    if existing is not None:
        return existing

    taxon = Taxon(
        provider="gbif",
        external_taxon_id=str(usage.key),
        scientific_name=usage.scientific_name,
        canonical_name=usage.canonical_name,
        common_name=usage.common_name,
        taxonomic_rank=usage.rank,
        kingdom=usage.kingdom,
        phylum=usage.phylum,
        taxonomic_class=usage.taxonomic_class,
        taxonomic_order=usage.taxonomic_order,
        family=usage.family,
        genus=usage.genus,
        species=usage.species,
        synchronized_at=utc_now(),
    )
    try:
        with session.begin_nested():
            session.add(taxon)
            session.flush()
    except IntegrityError:
        existing = _taxon_by_external_key(session, usage.key)
        if existing is None:
            raise
        return existing
    return taxon


def search_taxonomy(
    session: Session,
    client: GbifClient,
    query: str,
    limit: int,
) -> dict:
    local_taxa = list(
        session.exec(
            select(Taxon)
            .where(
                (Taxon.scientific_name.contains(query))
                | (Taxon.canonical_name.contains(query))
                | (Taxon.common_name.contains(query))
            )
            .order_by(Taxon.id)
            .limit(limit)
        ).all()
    )
    local_results = [taxon_to_candidate(taxon) for taxon in local_taxa]
    emitted_keys = {
        (result["provider"], result["external_taxon_id"]) for result in local_results
    }
    session.rollback()

    try:
        remote_usages = [
            usage
            for usage in client.search_taxa(query, limit)
            if (usage.kingdom or "").lower() == "animalia"
            and usage.rank.upper() in {"SPECIES", "SUBSPECIES"}
        ]
    except GbifClientError as exc:
        logger.warning(
            "Taxonomy search query=%r category=%s",
            query,
            exc.code,
        )
        if not local_results:
            raise
        return {
            "results": local_results,
            "external_available": False,
            "warning": "GBIF is unavailable; showing locally cached taxa.",
        }

    remote_keys = list(dict.fromkeys(usage.key for usage in remote_usages))
    current_local_by_key: dict[int, Taxon] = {}
    if remote_keys:
        current_local_by_key = {
            int(taxon.external_taxon_id): taxon
            for taxon in session.exec(
                select(Taxon).where(
                    Taxon.provider == "gbif",
                    Taxon.external_taxon_id.in_([str(key) for key in remote_keys]),
                )
            ).all()
        }

    remote_results: list[dict] = []
    for usage in remote_usages:
        identity = ("gbif", usage.key)
        if identity in emitted_keys:
            continue
        local = current_local_by_key.get(usage.key)
        remote_results.append(
            taxon_to_candidate(local)
            if local is not None
            else usage_to_candidate(usage)
        )
        emitted_keys.add(identity)
        if len(remote_results) >= limit:
            break
    session.rollback()
    return {
        "results": local_results + remote_results,
        "external_available": True,
        "warning": None,
    }


def assign_animal_taxon(
    session: Session,
    client: GbifClient,
    animal_id: int,
    gbif_key: int,
) -> dict:
    if session.get(Animal, animal_id) is None:
        session.rollback()
        raise AnimalNotFoundError
    try:
        selection = prepare_taxon_selection(session, client, gbif_key)
    except GbifClientError as exc:
        logger.warning(
            "Taxonomy assignment animal_id=%s gbif_key=%s category=%s",
            animal_id,
            gbif_key,
            exc.code,
        )
        raise
    with session.begin():
        animal = session.get(Animal, animal_id)
        if animal is None:
            raise AnimalNotFoundError
        taxon = persist_taxon_selection(session, selection)
        assign_taxon(animal, taxon, "manually_linked")
        session.add(animal)
    session.refresh(animal)
    session.refresh(taxon)
    return {"animal": animal, "taxon": taxon_to_candidate(taxon)}


def legacy_taxonomy_groups_query():
    core = (
        select(
            Animal.legacy_species_group.label("legacy_group"),
            func.min(Animal.id).label("representative_id"),
            func.count(Animal.id).label("animal_count"),
        )
        .select_from(Animal)
        .outerjoin(Taxon, Animal.taxon_id == Taxon.id)
        .where(Taxon.id.is_(None))
        .group_by(Animal.legacy_species_group)
        .subquery("legacy_groups_without_taxon")
    )
    representative = aliased(Animal)
    legacy_name = case(
        (
            or_(
                representative.legacy_species_name.is_(None),
                representative.legacy_species_name == "",
            ),
            "Unidentified",
        ),
        else_=representative.legacy_species_name,
    )
    return (
        select(
            core.c.legacy_group,
            core.c.representative_id,
            legacy_name.label("legacy_name"),
            core.c.animal_count,
        )
        .select_from(core)
        .join(representative, representative.id == core.c.representative_id)
        .subquery("legacy_taxonomy_groups")
    )


def _unverified_group_condition(legacy_group: str):
    matching_taxon = exists(select(Taxon.id).where(Taxon.id == Animal.taxon_id))
    return and_(
        ~matching_taxon,
        Animal.legacy_species_group == legacy_group,
    )


def list_legacy_reconciliation_groups(
    session: Session, limit: int
) -> list[LegacyReconciliationGroup]:
    groups = legacy_taxonomy_groups_query()
    rows = (
        session.execute(
            select(groups)
            .where(groups.c.legacy_name != "Unidentified")
            .order_by(groups.c.representative_id)
            .limit(limit)
        )
        .mappings()
        .all()
    )
    return [
        LegacyReconciliationGroup(
            legacy_group=row.legacy_group,
            legacy_name=row.legacy_name,
            animal_count=row.animal_count,
        )
        for row in rows
    ]


def update_reconciliation_group(
    session: Session,
    group: LegacyReconciliationGroup,
    *,
    taxon: Taxon | None = None,
    status: str,
    note: str | None = None,
) -> int:
    values = {
        "taxonomy_status": status,
        "taxonomy_note": note,
        "updated_at": utc_now(),
    }
    if taxon is not None:
        values["taxon_id"] = taxon.id
    result = session.execute(
        update(Animal)
        .where(_unverified_group_condition(group.legacy_group))
        .values(**values)
    )
    return result.rowcount


def reconcile_taxonomy(
    session: Session,
    client: GbifClient,
    limit: int,
) -> dict:
    groups = list_legacy_reconciliation_groups(session, limit)
    session.rollback()
    result = {"processed": 0, "linked": 0, "ambiguous": 0, "unmatched": 0, "failed": 0}
    for group in groups:
        try:
            match = client.match_taxon(group.legacy_name)
            note = (match.note or "").lower()
            accepted = (
                match.match_type == "EXACT"
                and match.confidence == 100
                and (match.rank or "").upper() in {"SPECIES", "SUBSPECIES"}
                and (match.kingdom or "").lower() == "animalia"
                and "multiple" not in note
                and (
                    match.usage_key is not None or match.accepted_usage_key is not None
                )
            )
            status = "ambiguous" if match.match_type != "NONE" else "unmatched"
            if accepted:
                key = match.accepted_usage_key or match.usage_key
                if key is None:
                    raise GbifClientError("invalid_response", "match")
                selection = prepare_taxon_selection(session, client, key)
                with session.begin():
                    taxon = persist_taxon_selection(session, selection)
                    updated = update_reconciliation_group(
                        session,
                        group,
                        taxon=taxon,
                        status="auto_linked",
                    )
                result["linked"] += updated
            else:
                with session.begin():
                    updated = update_reconciliation_group(
                        session,
                        group,
                        status=status,
                        note=match.note or "No confident exact GBIF match",
                    )
                result[status] += updated
            result["processed"] += updated
        except Exception as exc:
            session.rollback()
            result["failed"] += group.animal_count
            category = exc.code if isinstance(exc, GbifClientError) else "local_failure"
            logger.warning(
                "Taxonomy reconciliation group=%r category=%s failed",
                group.legacy_name,
                category,
                exc_info=not isinstance(exc, GbifClientError),
            )
    return result
