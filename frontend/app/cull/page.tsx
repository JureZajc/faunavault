import { Suspense } from "react";
import CullingBrowser from "./culling-browser";

export default function CullingPage() {
  return <Suspense fallback={<main className="p-8 text-stone-600">Loading Culling…</main>}><CullingBrowser /></Suspense>;
}
