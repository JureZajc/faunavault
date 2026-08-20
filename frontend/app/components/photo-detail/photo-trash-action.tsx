"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { deletePhoto, Photo } from "../../lib/api";

type PhotoTrashActionProps = {
  photo: Photo;
  disabled: boolean;
  onMoved: (photo: Photo) => void | Promise<void>;
  onBusyChange: (busy: boolean) => void;
};

export default function PhotoTrashAction({
  photo,
  disabled,
  onMoved,
  onBusyChange,
}: PhotoTrashActionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationInputRef = useRef<HTMLInputElement>(null);
  const isValid = confirmation === photo.original_filename;

  function closeDialog() {
    if (isDeleting) return;
    setIsOpen(false);
    setConfirmation("");
    setError(null);
  }

  const { handleKeyDown } = useModalAccessibility({
    isOpen,
    dialogRef,
    initialFocusRef: cancelButtonRef,
    onClose: closeDialog,
    isBusy: isDeleting,
  });

  useEffect(() => {
    if (error && !isDeleting) confirmationInputRef.current?.focus();
  }, [error, isDeleting]);

  async function confirmDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isDeleting || !isValid) return;
    setIsDeleting(true);
    onBusyChange(true);
    setError(null);
    try {
      await deletePhoto(photo.id);
      await onMoved(photo);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Delete failed");
      setIsDeleting(false);
      onBusyChange(false);
    }
  }

  return (
    <>
      <div className="mt-5 border-t border-red-100 pt-5">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-red-700">
          Destructive action
        </p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirmation("");
            setIsOpen(true);
          }}
          disabled={disabled}
          className="mt-3 min-h-11 w-full rounded-md border border-red-200 bg-red-50 px-4 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
        >
          Move to Trash
        </button>
      </div>
      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-950/40 p-3 sm:items-center sm:p-6">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-photo-title"
            aria-describedby="delete-photo-description"
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            className="my-auto max-h-[calc(100vh-1.5rem)] w-full max-w-md overflow-y-auto rounded-lg border border-stone-200 bg-white p-4 shadow-xl sm:p-5"
          >
            <div className="border-b border-red-100 pb-4">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-red-700">
                Destructive action
              </p>
              <h2 id="delete-photo-title" className="mt-2 text-xl font-semibold text-stone-950">
                Move photo to Trash
              </h2>
              <p
                id="delete-photo-description"
                className="mt-2 break-words text-sm leading-6 text-stone-600"
              >
                This will hide <span className="font-semibold text-stone-900">{photo.original_filename}</span>{" "}
                from your active collection. You can restore it from Trash.
              </p>
            </div>
            <form onSubmit={confirmDelete} className="mt-4">
              <label htmlFor="delete-photo-confirmation" className="block">
                <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
                  Type the filename to confirm
                </span>
                <input
                  ref={confirmationInputRef}
                  id="delete-photo-confirmation"
                  type="text"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={isDeleting}
                  className="mt-2 min-h-11 min-w-0 w-full rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-950 outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
                />
              </label>
              {error ? (
                <p
                  role="alert"
                  className="mt-4 break-words rounded-md bg-red-50 p-3 text-sm text-red-700"
                >
                  {error}
                </p>
              ) : null}
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={closeDialog}
                  disabled={isDeleting}
                  className="min-h-11 rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-800 transition hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isDeleting || !isValid}
                  className="min-h-11 rounded-md border border-red-200 bg-red-50 px-4 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
                >
                  {isDeleting ? "Moving photo" : "Move to Trash"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
