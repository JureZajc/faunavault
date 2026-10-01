import { Suspense } from "react";
import ImportsBrowser from "./imports-browser";

export default function ImportsPage() {
  return <Suspense fallback={<main className="p-8">Loading Recent Imports…</main>}><ImportsBrowser /></Suspense>;
}
