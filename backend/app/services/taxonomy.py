from __future__ import annotations

from app.models import Animal, Taxon, utc_now


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


def assign_taxon(animal: Animal, taxon: Taxon, status: str) -> None:
    animal.taxon_id = taxon.id
    animal.taxonomy_status = status
    animal.taxonomy_note = None
    animal.updated_at = utc_now()
