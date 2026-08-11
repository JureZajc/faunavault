"use client";

import { useState } from "react";
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

  async function movePhoto() {
    setIsMoving(true);
    try {
      await deletePhoto(photo.id);
      setIsOpen(false);
      await onMoved(photo);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "Could not move photo to Trash");
    } finally {
      setIsMoving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={
          className ??
          "min-h-9 rounded-md border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 hover:border-red-200 hover:text-red-700"
        }
      >
        Move to Trash
      </button>
      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`trash-title-${photo.id}`}
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
          >
            <h2 id={`trash-title-${photo.id}`} className="text-xl font-semibold">
              Move photo to Trash?
            </h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              {photo.original_filename} will be hidden from the active collection.
              You can restore it later.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={isMoving}
                onClick={() => setIsOpen(false)}
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

