import { parsePhotoFocusId } from "../lib/photo-map";
import MapBrowser from "./map-browser";

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ photo?: string | string[] }>;
}) {
  const { photo } = await searchParams;
  return <MapBrowser focusPhotoId={parsePhotoFocusId(photo)} />;
}
