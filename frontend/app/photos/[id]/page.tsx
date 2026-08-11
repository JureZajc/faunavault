import PhotoDetail from "./photo-detail";

export default async function PhotoDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { id } = await params;
  const { returnTo } = await searchParams;

  return <PhotoDetail id={id} returnTo={returnTo} />;
}
