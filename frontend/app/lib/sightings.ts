import type { Sighting, SightingTaxon } from "./api";

export function sightingId(value: string | null) {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function taxonLabel(taxon: SightingTaxon) {
  return taxon.common_name?.trim() || taxon.canonical_name || taxon.scientific_name;
}

export function sightingName(item: Sighting) {
  return item.subject_label || (item.taxon ? taxonLabel(item.taxon) : "Unidentified sighting");
}
