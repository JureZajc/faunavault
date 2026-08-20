"use client";

import { FormEvent, useState } from "react";
import { Photo, PhotoStatus, PhotoUpdate, updatePhoto } from "../../lib/api";

const photoStatuses: PhotoStatus[] = ["pending", "classified", "needs_review"];
const statusLabels: Record<PhotoStatus, string> = {
  pending: "Pending",
  classified: "Classified",
  needs_review: "Needs review",
};

type MetadataFormState = {
  display_title: string;
  common_name: string;
  breed_guess: string;
  species_guess: string;
  category: string;
  confidence: string;
  description: string;
  tags: string;
  status: PhotoStatus;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function confidenceLabel(value: number | null) {
  return value === null ? "Not available" : `${Math.round(value * 100)}%`;
}

function formStateFromPhoto(photo: Photo): MetadataFormState {
  return {
    display_title: photo.display_title ?? "",
    common_name: photo.common_name ?? "",
    breed_guess: photo.breed_guess ?? "",
    species_guess: photo.species_guess ?? "",
    category: photo.category ?? "",
    confidence:
      photo.confidence === null
        ? ""
        : Number((photo.confidence * 100).toFixed(2)).toString(),
    description: photo.description ?? "",
    tags: photo.tags.join(", "),
    status: photo.status,
  };
}

function nullIfBlank(value: string) {
  const trimmedValue = value.trim();
  return trimmedValue === "" ? null : trimmedValue;
}

const inputClassName =
  "mt-2 min-h-11 min-w-0 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500";
const textareaClassName =
  "mt-2 min-h-28 min-w-0 w-full rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500";

function MetadataRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null;
}) {
  return (
    <div className="border-b border-stone-200 py-3 last:border-0">
      <dt className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-stone-950">
        {value ?? "Not available"}
      </dd>
    </div>
  );
}

export function PhotoMetadataDetails({ photo }: { photo: Photo }) {
  return (
    <>
      <dl className="mt-5 rounded-lg border border-stone-200 px-4">
        <MetadataRow label="Original file" value={photo.original_filename} />
        <MetadataRow label="Display title" value={photo.display_title} />
        <MetadataRow label="Common name" value={photo.common_name} />
        <MetadataRow label="Breed/type guess" value={photo.breed_guess} />
        <MetadataRow label="Species guess" value={photo.species_guess} />
        <MetadataRow label="Category" value={photo.category} />
        <MetadataRow label="Confidence" value={confidenceLabel(photo.confidence)} />
        <MetadataRow label="Status" value={statusLabels[photo.status]} />
        <MetadataRow label="Created" value={formatDateTime(photo.created_at)} />
        <MetadataRow label="Updated" value={formatDateTime(photo.updated_at)} />
      </dl>
      <div className="mt-5 border-t border-stone-200 pt-5">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
          Description
        </h2>
        <p className="mt-2 break-words text-sm leading-6 text-stone-700">
          {photo.description ?? "Not available"}
        </p>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {photo.tags.length > 0 ? (
          photo.tags.map((tag) => (
            <span
              key={tag}
              title={tag}
              className="max-w-full break-words rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800"
            >
              {tag}
            </span>
          ))
        ) : (
          <span className="text-sm text-stone-500">No tags</span>
        )}
      </div>
    </>
  );
}

type PhotoMetadataEditorProps = {
  photo: Photo;
  onSaved: (photo: Photo) => void;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string | null) => void;
};

export function PhotoMetadataEditor({
  photo,
  onSaved,
  onCancel,
  onBusyChange,
  onError,
}: PhotoMetadataEditorProps) {
  const [form, setForm] = useState(() => formStateFromPhoto(photo));
  const [isSaving, setIsSaving] = useState(false);

  function updateField<Field extends keyof MetadataFormState>(
    field: Field,
    value: MetadataFormState[Field],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const confidenceValue = form.confidence.trim();
    const confidenceNumber =
      confidenceValue === "" ? null : Number(confidenceValue);
    if (
      confidenceNumber !== null &&
      (!Number.isFinite(confidenceNumber) ||
        confidenceNumber < 0 ||
        confidenceNumber > 100)
    ) {
      onError("Confidence must be empty or a number from 0 to 100.");
      return;
    }

    const metadata: PhotoUpdate = {
      display_title: nullIfBlank(form.display_title),
      common_name: nullIfBlank(form.common_name),
      breed_guess: nullIfBlank(form.breed_guess),
      species_guess: nullIfBlank(form.species_guess),
      category: nullIfBlank(form.category),
      confidence:
        confidenceNumber === null
          ? null
          : Number((confidenceNumber / 100).toFixed(4)),
      description: nullIfBlank(form.description),
      tags: form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      status: form.status,
    };

    setIsSaving(true);
    onBusyChange(true);
    onError(null);
    try {
      onSaved(await updatePhoto(photo.id, metadata));
    } catch (nextError) {
      const message =
        nextError instanceof Error ? nextError.message : "Save failed";
      onError(`Could not save metadata: ${message}`);
    } finally {
      setIsSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-5 min-w-0 border-t border-stone-200 pt-5">
      <div className="grid gap-4">
        <MetadataInput
          label="Display title"
          value={form.display_title}
          disabled={isSaving}
          onChange={(value) => updateField("display_title", value)}
        />
        <MetadataInput
          label="Common name"
          value={form.common_name}
          disabled={isSaving}
          onChange={(value) => updateField("common_name", value)}
        />
        <MetadataInput
          label="Breed/type guess"
          value={form.breed_guess}
          disabled={isSaving}
          onChange={(value) => updateField("breed_guess", value)}
        />
        <MetadataInput
          label="Species guess"
          value={form.species_guess}
          disabled={isSaving}
          onChange={(value) => updateField("species_guess", value)}
        />
        <MetadataInput
          label="Category"
          value={form.category}
          disabled={isSaving}
          onChange={(value) => updateField("category", value)}
        />
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Confidence
          </span>
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={form.confidence}
            onChange={(event) => updateField("confidence", event.target.value)}
            disabled={isSaving}
            placeholder="0 to 100"
            className={inputClassName}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Status
          </span>
          <select
            value={form.status}
            onChange={(event) =>
              updateField("status", event.target.value as PhotoStatus)
            }
            disabled={isSaving}
            className={inputClassName}
          >
            {photoStatuses.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Description
          </span>
          <textarea
            value={form.description}
            onChange={(event) => updateField("description", event.target.value)}
            disabled={isSaving}
            className={textareaClassName}
          />
        </label>
        <MetadataInput
          label="Tags"
          value={form.tags}
          disabled={isSaving}
          placeholder="cat, pet, mammal"
          onChange={(value) => updateField("tags", value)}
        />
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <button
          type="submit"
          disabled={isSaving}
          className="min-h-11 rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          {isSaving ? "Saving metadata" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className="min-h-11 rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-800 transition hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function MetadataInput({
  label,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={inputClassName}
      />
    </label>
  );
}
