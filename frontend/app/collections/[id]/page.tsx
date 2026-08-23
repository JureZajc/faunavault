import { notFound } from "next/navigation";
import { Suspense } from "react";
import CollectionDetailView from "./collection-detail";

export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id) || Number(id) < 1) notFound();
  return <Suspense fallback={<main className="min-h-screen bg-[#f7f8f4] p-8"><div className="mx-auto h-96 max-w-7xl animate-pulse rounded-xl bg-white" /></main>}><CollectionDetailView collectionId={Number(id)} /></Suspense>;
}
