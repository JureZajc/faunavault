import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import MoveToTrashButton from "../app/components/move-to-trash-button";
import TrashBrowser from "../app/components/trash-browser";
import { Photo } from "../app/lib/api";

const api = vi.hoisted(() => ({
  deletePhoto: vi.fn(),
  getTrashPhotos: vi.fn(),
  permanentlyDeleteTrashPhoto: vi.fn(),
  restoreTrashPhoto: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/lib/api")>();
  return { ...original, ...api };
});

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 7,
    original_filename: "fox.jpg",
    stored_filename: "fox.jpg",
    resized_filename: "fox-resized.jpg",
    thumbnail_filename: "fox-thumb.jpg",
    display_title: "Red fox",
    common_name: "fox",
    breed_guess: null,
    species_guess: "Vulpes vulpes",
    category: "mammal",
    confidence: 0.93,
    description: null,
    tags: [],
    status: "classified",
    animal_id: 4,
    content_sha256: "a".repeat(64),
    original_size_bytes: 100,
    media_type: "image/jpeg",
    deleted_at: "2026-08-11T08:00:00Z",
    created_at: "2026-08-10T08:00:00Z",
    updated_at: "2026-08-11T08:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getTrashPhotos.mockResolvedValue({
    items: [photo()],
    total: 1,
    page: 1,
    page_size: 24,
  });
  api.restoreTrashPhoto.mockResolvedValue({ status: "restored", photo_id: 7 });
  api.permanentlyDeleteTrashPhoto.mockResolvedValue({
    status: "deleted",
    photo_id: 7,
    missing_files: 0,
  });
  api.deletePhoto.mockResolvedValue({ status: "trashed", photo_id: 7 });
});

test("restores a photo and removes it from the Trash view", async () => {
  const onNotice = vi.fn();
  const onRestored = vi.fn();
  render(<TrashBrowser onNotice={onNotice} onRestored={onRestored} />);
  await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
  expect(api.restoreTrashPhoto).toHaveBeenCalledWith(7);
  expect(screen.queryByText("Red fox")).toBeNull();
  expect(onRestored).toHaveBeenCalledWith(photo());
  expect(onNotice).toHaveBeenCalledWith("Restored fox.jpg to the catalog.");
});

test("does not report a successful backend restore as failed when catalog sync fails", async () => {
  const onNotice = vi.fn();
  render(
    <TrashBrowser
      onNotice={onNotice}
      onRestored={vi.fn().mockRejectedValue(new Error("Catalog unavailable"))}
    />,
  );

  await userEvent.click(await screen.findByRole("button", { name: "Restore" }));

  expect(await screen.findByText("Trash is empty.")).toBeTruthy();
  expect(onNotice).toHaveBeenCalledWith("Restored fox.jpg to the catalog.");
  expect(
    screen.getByText(
      "Photo was restored, but the catalog could not be updated: Catalog unavailable",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Restore failed")).toBeNull();
});

test("requires the filename before permanent deletion", async () => {
  render(<TrashBrowser onNotice={vi.fn()} onRestored={vi.fn()} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Permanently delete" }),
  );
  const submit = within(screen.getByRole("dialog")).getByRole("button", {
    name: "Permanently delete",
  });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Filename confirmation" }),
    "fox.jpg",
  );
  await userEvent.click(submit);
  await waitFor(() => expect(api.permanentlyDeleteTrashPhoto).toHaveBeenCalledWith(7));
});

test("moves an active photo without navigating", async () => {
  const onMoved = vi.fn();
  render(
    <MoveToTrashButton
      photo={photo({ deleted_at: null })}
      onMoved={onMoved}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
  await userEvent.click(
    screen.getAllByRole("button", { name: "Move to Trash" })[1],
  );
  await waitFor(() => expect(api.deletePhoto).toHaveBeenCalledWith(7));
  expect(onMoved).toHaveBeenCalled();
});
