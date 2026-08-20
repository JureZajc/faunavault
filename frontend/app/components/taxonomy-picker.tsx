"use client";

import { useState } from "react";
import {
  searchTaxonomy,
  selectAnimalTaxon,
  TaxonCandidate,
} from "../lib/api";

export default function TaxonomyPicker({ animalId }: { animalId: number }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaxonCandidate[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function search() {
    if (query.trim().length < 2) return;
    setIsBusy(true);
    setStatus(null);
    try {
      const response = await searchTaxonomy(query.trim());
      setResults(response.results);
      setStatus(response.warning);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Taxonomy search failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function select(candidate: TaxonCandidate) {
    setIsBusy(true);
    try {
      await selectAnimalTaxon(animalId, candidate.external_taxon_id);
      setResults([]);
      setQuery(candidate.canonical_name);
      setStatus(`Linked to ${candidate.scientific_name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Taxonomy update failed");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="mt-5 border-t border-stone-200 pt-5">
      <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
        GBIF taxonomy
      </h2>
      <div className="mt-2 flex min-w-0 gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void search();
          }}
          placeholder="Common or scientific name"
          className="min-h-10 min-w-0 flex-1 rounded-md border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-emerald-500"
        />
        <button
          type="button"
          disabled={isBusy || query.trim().length < 2}
          onClick={() => void search()}
          className="min-h-10 shrink-0 rounded-md border border-emerald-700 px-3 text-sm font-semibold text-emerald-900 disabled:opacity-50"
        >
          Search
        </button>
      </div>
      {status ? (
        <p className="mt-2 break-words text-xs text-stone-600">{status}</p>
      ) : null}
      {results.length ? (
        <div className="mt-2 max-h-56 space-y-1 overflow-auto">
          {results.map((candidate) => (
            <button
              key={candidate.external_taxon_id}
              type="button"
              disabled={isBusy}
              onClick={() => void select(candidate)}
              className="block min-h-10 w-full min-w-0 break-words rounded-md border border-stone-200 bg-white p-2 text-left text-xs hover:border-emerald-400"
            >
              <strong>
                {candidate.common_name || candidate.canonical_name}
              </strong>
              <span className="ml-1 italic text-stone-500">
                {candidate.scientific_name}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
