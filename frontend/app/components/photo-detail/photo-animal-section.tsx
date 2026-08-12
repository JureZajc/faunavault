"use client";

import { useEffect, useRef, useState } from "react";
import AnimalNameEditor from "../animal-name-editor";
import TaxonomyPicker from "../taxonomy-picker";
import { Animal, getAnimal } from "../../lib/api";

export default function PhotoAnimalSection({ animalId }: { animalId: number }) {
  const [animal, setAnimal] = useState<Animal | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const nextRequestId = requestId.current + 1;
    requestId.current = nextRequestId;
    const timer = window.setTimeout(() => {
      setAnimal(null);
      setError(null);
      setIsLoading(true);
      getAnimal(animalId)
        .then((nextAnimal) => {
          if (requestId.current === nextRequestId) setAnimal(nextAnimal);
        })
        .catch((nextError: Error) => {
          if (requestId.current === nextRequestId) setError(nextError.message);
        })
        .finally(() => {
          if (requestId.current === nextRequestId) setIsLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      requestId.current += 1;
    };
  }, [animalId]);

  return (
    <>
      <section className="mt-5 border-t border-stone-200 pt-5">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
          Linked individual
        </h2>
        {isLoading ? (
          <p className="text-sm text-stone-500">Loading individual…</p>
        ) : animal ? (
          <AnimalNameEditor animal={animal} onUpdated={setAnimal} />
        ) : (
          <p role="alert" className="text-sm text-red-700">
            {error ?? "Could not load linked individual."}
          </p>
        )}
      </section>
      <TaxonomyPicker animalId={animalId} />
    </>
  );
}
