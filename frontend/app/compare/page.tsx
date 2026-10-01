import { Suspense } from "react";
import CompareBrowser from "./compare-browser";

export default function ComparePage() {
  return <Suspense fallback={<main className="p-8 text-stone-600">Loading Compare…</main>}><CompareBrowser /></Suspense>;
}
