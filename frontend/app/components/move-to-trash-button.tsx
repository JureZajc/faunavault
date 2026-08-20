"use client";

import { useEffect, useRef, useState } from "react";
import { useModalAccessibility } from "../hooks/use-modal-accessibility";
import { deletePhoto, Photo } from "../lib/api";

type MoveToTrashButtonProps = {
  photo: Photo;
  onMoved: (photo: Photo) => void | Promise<void>;
  onError?: (message: string) => void;
  className?: string;
};

export default function MoveToTrashButton({
  photo,
  onMoved,
  onError,
  className,
}: MoveToTrashButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  function closeDialog() {
    if (isMoving) return;
    setIsOpen(false);
    setDialogError(null);
  }

  const { handleKeyDown } = useModalAccessibility({
    isOpen,
    dialogRef,
    initialFocusRef: cancelButtonRef,
    onClose: closeDialog,
    isBusy: isMoving,
  });

  useEffect(() => {
    if (dialogError && !isMoving) cancelButtonRef.current?.focus();
  }, [dialogError, isMoving]);

  async function movePhoto() {
    if (isMoving) return;
    setIsMoving(true);
    setDialogError(null);
    try {
      await deletePhoto(photo.id);
      setIsOpen(false);
      await onMoved(photo);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not move photo to Trash";
      setDialogError(message);
      onError?.(message);
    } finally {
      setIsMoving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDialogError(null);
          setIsOpen(true);
        }}
        className={
          className ??
          "min-h-9 rounded-md border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 hover:border-red-200 hover:text-red-700"
        }
      >
        Move to Trash
      </button>
      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-950/40 p-3 sm:items-center sm:p-6">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`trash-title-${photo.id}`}
            aria-describedby={`trash-description-${photo.id}`}
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            className="my-auto max-h-[calc(100vh-1.5rem)] w-full max-w-md overflow-y-auto rounded-lg bg-white p-4 shadow-xl sm:p-5"
          >
            <h2 id={`trash-title-${photo.id}`} className="text-xl font-semibold">
              Move photo to Trash?
            </h2>
            <p
              id={`trash-description-${photo.id}`}
              className="mt-2 break-words text-sm leading-6 text-stone-600"
            >
              {photo.original_filename} will be hidden from the active collection.
              You can restore it later.
            </p>
            {dialogError ? (
              <p
                role="alert"
                className="mt-4 break-words rounded-md bg-red-50 p-3 text-sm text-red-700"
              >
                {dialogError}
              </p>
            ) : null}
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                ref={cancelButtonRef}
                type="button"
                disabled={isMoving}
                onClick={closeDialog}
                className="min-h-11 rounded-md border border-stone-300 font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isMoving}
                onClick={() => void movePhoto()}
                className="min-h-11 rounded-md border border-red-200 bg-red-50 font-semibold text-red-700"
              >
                {isMoving ? "Moving…" : "Move to Trash"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

