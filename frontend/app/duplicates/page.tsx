import { Suspense } from "react";
import DuplicateBrowser from "./duplicate-browser";

export default function DuplicatesPage() {
  return <Suspense fallback={<main className="p-8 text-stone-600">Loading duplicate review…</main>}><DuplicateBrowser /></Suspense>;
}
