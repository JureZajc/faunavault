import { CollectionSummary } from "../../lib/api";
import PhotoThumbnailPreview from "../photo-thumbnail-preview";

export default function CollectionCover({ collection, large = false }: { collection: CollectionSummary; large?: boolean }) {
  const aspect = large ? "aspect-[16/9] sm:aspect-[3/1]" : "aspect-[16/9]";
  return <div role="region" aria-label="Collection cover" className="min-w-0">
    {collection.cover_photo ? <PhotoThumbnailPreview key={collection.cover_photo.id} preview={collection.cover_photo} className={aspect} /> :
      <div className={`${aspect} grid place-items-center rounded-md bg-stone-100 px-4 text-center text-sm text-stone-500`}>No active Photos for a cover</div>}
  </div>;
}
