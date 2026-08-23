"use client";

import { FormEvent, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { BulkPhotoActionRequest } from "../../lib/api";
import { parseTags } from "../../lib/photo-metadata";
import { BulkDialogAction } from "./bulk-selection-toolbar";

type BulkActionDialogProps = {
  action: BulkDialogAction | null;
  selectedCount: number;
  categoryOptions: string[];
  isBusy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (request: BulkPhotoActionRequest) => Promise<boolean>;
};

export default function BulkActionDialog({
  action,
  selectedCount,
  categoryOptions,
  isBusy,
  error,
  onClose,
  onSubmit,
}: BulkActionDialogProps) {
  const [tagsInput, setTagsInput] = useState("");
  const [categoryMode, setCategoryMode] = useState<"set" | "clear">("set");
  const [categoryInput, setCategoryInput] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const initialInputRef = useRef<HTMLInputElement>(null);

  function close() {
    if (isBusy) return;
    onClose();
  }

  const { handleKeyDown } = useModalAccessibility({
    isOpen: action !== null,
    dialogRef,
    initialFocusRef:
      action === "move_to_trash" ? cancelButtonRef : initialInputRef,
    onClose: close,
    isBusy,
  });

  if (!action) return null;

  const tags = parseTags(tagsInput);
  const category = categoryInput.trim();
  const title =
    action === "add_tags"
      ? `Add tags to ${selectedCount} selected photos`
      : action === "remove_tags"
        ? `Remove tags from ${selectedCount} selected photos`
        : action === "move_to_trash"
          ? `Move ${selectedCount} photos to Trash?`
          : categoryMode === "clear"
            ? `Clear category for ${selectedCount} photos`
            : `Set category for ${selectedCount} photos`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    let request: BulkPhotoActionRequest;
    if (action === "add_tags" || action === "remove_tags") {
      if (tags.length === 0) {
        setValidationError("Enter at least one non-empty tag.");
        return;
      }
      request = { operation: action, tags };
    } else if (action === "category") {
      if (categoryMode === "clear") {
        request = { operation: "clear_category" };
      } else {
        if (!category) {
          setValidationError("Enter a category or choose Clear category.");
          return;
        }
        request = { operation: "set_category", category };
      }
    } else {
      request = { operation: "move_to_trash" };
    }
    if (await onSubmit(request)) onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-950/40 p-3 sm:items-center sm:p-6">
      <form
        ref={dialogRef}
        onSubmit={submit}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-action-title"
        aria-describedby="bulk-action-description"
        tabIndex={-1}
        className="my-auto max-h-[calc(100vh-1.5rem)] w-full max-w-md overflow-y-auto rounded-lg bg-white p-4 shadow-xl sm:p-5"
      >
        <h2 id="bulk-action-title" className="text-xl font-semibold text-stone-950">
          {title}
        </h2>
        <p id="bulk-action-description" className="mt-2 text-sm leading-6 text-stone-600">
          {action === "add_tags"
            ? "New tags are added without replacing tags already on each photo."
            : action === "remove_tags"
              ? "Only the tags you enter will be removed; all other tags stay unchanged."
              : action === "category"
                ? "This overwrites the category on every selected photo."
                : "The photos will leave the active catalog but remain local and can be restored later. This is not permanent deletion."}
        </p>

        {action === "add_tags" || action === "remove_tags" ? (
          <label className="mt-4 block text-sm font-medium text-stone-700">
            Tags, separated by commas
            <input
              ref={initialInputRef}
              type="text"
              value={tagsInput}
              disabled={isBusy}
              onChange={(event) => setTagsInput(event.target.value)}
              placeholder="bird, summer"
              className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-stone-200 bg-stone-50 px-3 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
          </label>
        ) : null}

        {action === "category" ? (
          <fieldset className="mt-4 space-y-3">
            <legend className="text-sm font-medium text-stone-700">Category action</legend>
            <label className="flex min-h-11 items-center gap-3 rounded-md border border-stone-200 p-3">
              <input
                ref={initialInputRef}
                type="radio"
                name="category-mode"
                value="set"
                checked={categoryMode === "set"}
                disabled={isBusy}
                onChange={() => setCategoryMode("set")}
                className="h-5 w-5 accent-emerald-800"
              />
              Set category
            </label>
            <input
              type="text"
              aria-label="Category value"
              list="bulk-category-options"
              value={categoryInput}
              disabled={isBusy || categoryMode === "clear"}
              onChange={(event) => setCategoryInput(event.target.value)}
              className="min-h-11 w-full min-w-0 rounded-md border border-stone-200 bg-stone-50 px-3 outline-none disabled:bg-stone-100 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
            <datalist id="bulk-category-options">
              {categoryOptions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            <label className="flex min-h-11 items-center gap-3 rounded-md border border-stone-200 p-3">
              <input
                type="radio"
                name="category-mode"
                value="clear"
                checked={categoryMode === "clear"}
                disabled={isBusy}
                onChange={() => setCategoryMode("clear")}
                className="h-5 w-5 accent-emerald-800"
              />
              Clear category
            </label>
          </fieldset>
        ) : null}

        {validationError || error ? (
          <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {validationError ?? error}
          </p>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            ref={cancelButtonRef}
            type="button"
            disabled={isBusy}
            onClick={close}
            className="min-h-11 rounded-md border border-stone-300 bg-white px-3 font-semibold text-stone-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isBusy}
            className={`min-h-11 rounded-md px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${
              action === "move_to_trash"
                ? "bg-red-700 hover:bg-red-800"
                : "bg-emerald-800 hover:bg-emerald-900"
            }`}
          >
            {isBusy
              ? "Working…"
              : action === "add_tags"
                ? "Add tags"
                : action === "remove_tags"
                  ? "Remove tags"
                  : action === "move_to_trash"
                    ? "Move to Trash"
                    : categoryMode === "clear"
                      ? "Clear category"
                      : "Set category"}
          </button>
        </div>
      </form>
    </div>
  );
}
