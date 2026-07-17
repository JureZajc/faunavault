"use client";

import { FormEvent, useState } from "react";
import {
  Animal,
  updateAnimalDisplayName,
} from "../lib/api";

const MAX_DISPLAY_NAME_LENGTH = 100;

export default function AnimalNameEditor({
  animal,
  onUpdated,
}: {
  animal: Animal;
  onUpdated: (animal: Animal) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState(animal.display_name ?? "");
  const [apiError, setApiError] = useState<string | null>(null);
  const normalizedLength = draft.trim().length;
  const validationError =
    normalizedLength > MAX_DISPLAY_NAME_LENGTH
      ? `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`
      : null;

  function startEditing() {
    setDraft(animal.display_name ?? "");
    setApiError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    setDraft(animal.display_name ?? "");
    setApiError(null);
    setIsEditing(false);
  }

  async function saveDisplayName(displayName: string | null) {
    setIsSaving(true);
    setApiError(null);
    try {
      const updatedAnimal = await updateAnimalDisplayName(
        animal.id,
        displayName,
      );
      setDraft(updatedAnimal.display_name ?? "");
      setIsEditing(false);
      onUpdated(updatedAnimal);
    } catch (error) {
      setApiError(
        error instanceof Error
          ? `Could not update name: ${error.message}`
          : "Could not update name.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (validationError) {
      return;
    }
    void saveDisplayName(draft);
  }

  if (isEditing) {
    return (
      <form
        aria-label={`Rename ${animal.identifier}`}
        onSubmit={handleSubmit}
        className="space-y-3"
      >
        <label
          htmlFor={`animal-display-name-${animal.id}`}
          className="block text-xs font-semibold uppercase tracking-wider text-stone-500"
        >
          Animal display name
        </label>
        <input
          id={`animal-display-name-${animal.id}`}
          type="text"
          value={draft}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          autoFocus
          disabled={isSaving}
          placeholder="e.g. Bella or Camel 1"
          onChange={(event) => {
            setDraft(event.target.value);
            setApiError(null);
          }}
          className="min-h-11 w-full rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:bg-stone-100"
        />
        <div className="flex items-center justify-between gap-3 text-xs text-stone-500">
          <span>Leave blank to remove the name.</span>
          <span>{normalizedLength}/{MAX_DISPLAY_NAME_LENGTH}</span>
        </div>
        {validationError ? (
          <p role="alert" className="text-sm text-red-700">
            {validationError}
          </p>
        ) : null}
        {apiError ? (
          <p role="alert" className="text-sm text-red-700">
            {apiError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={isSaving || Boolean(validationError)}
            className="min-h-10 rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={cancelEditing}
            disabled={isSaving}
            className="min-h-10 rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:text-stone-400"
          >
            Cancel
          </button>
          {animal.display_name ? (
            <button
              type="button"
              onClick={() => void saveDisplayName(null)}
              disabled={isSaving}
              className="min-h-10 rounded-md px-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-stone-400"
            >
              Remove name
            </button>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate font-medium text-stone-950">
          {animal.display_name || animal.identifier}
        </p>
        <p className="mt-1 truncate text-xs text-stone-500">
          {animal.display_name ? animal.identifier : "Unnamed individual"}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Edit name for ${animal.identifier}`}
        onClick={startEditing}
        className="shrink-0 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-700 transition hover:border-emerald-400 hover:text-emerald-900"
      >
        Edit name
      </button>
    </div>
  );
}
