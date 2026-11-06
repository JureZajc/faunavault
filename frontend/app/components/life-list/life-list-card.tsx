import Link from "next/link";
import type { LifeListTaxon } from "../../lib/api";
import { formatCameraLocalDate } from "../../lib/photo-metadata";
import PhotoThumbnailPreview from "../photo-thumbnail-preview";

export default function LifeListCard({ item }: { item: LifeListTaxon }) {
  const commonName = item.common_name?.trim();
  return (
    <article className="h-full min-w-0 rounded-lg border border-stone-200 bg-white p-3">
      {item.preview ? (
        <PhotoThumbnailPreview key={item.preview.id} preview={item.preview} />
      ) : (
        <div className="grid aspect-[4/3] place-items-center rounded-md bg-stone-100 text-sm text-stone-600">No active photos</div>
      )}
      <h2 className={`mt-2 break-words text-lg font-semibold text-emerald-950 ${commonName ? "" : "italic"}`}>
        {commonName || item.scientific_name}
      </h2>
      {commonName && <p className="break-words text-sm italic text-stone-700">{item.scientific_name}</p>}
      <p className="text-sm text-stone-600">
        {item.taxonomic_rank.toUpperCase() === "SUBSPECIES" && "Subspecies · "}
        {item.sighting_count.toLocaleString()} {item.sighting_count === 1 ? "sighting" : "sightings"}
      </p>
      <dl className="mt-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-2">
          <dt>First observed</dt>
          <dd><Link href={`/sightings/${item.first_sighting_id}`} className="inline-flex min-h-11 items-center text-emerald-900 underline">
            <span className="sr-only">First sighting of {item.scientific_name}, </span>
            <time dateTime={item.first_observed_at}>{formatCameraLocalDate(item.first_observed_at)}</time>
          </Link></dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2">
          <dt>Latest observed</dt>
          <dd><Link href={`/sightings/${item.last_sighting_id}`} className="inline-flex min-h-11 items-center text-emerald-900 underline">
            <span className="sr-only">Latest sighting of {item.scientific_name}, </span>
            <time dateTime={item.last_observed_at}>{formatCameraLocalDate(item.last_observed_at)}</time>
          </Link></dd>
        </div>
      </dl>
    </article>
  );
}
