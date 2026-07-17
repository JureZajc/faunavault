import AlbumDetailView from "./album-detail";

export default async function AlbumPage({
  params,
}: {
  params: Promise<{ albumKey: string }>;
}) {
  const { albumKey } = await params;
  return <AlbumDetailView albumKey={decodeURIComponent(albumKey)} />;
}
