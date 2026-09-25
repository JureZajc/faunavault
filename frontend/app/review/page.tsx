import { Suspense } from "react";
import ReviewBrowser from "./review-browser";

export default function ReviewPage() {
  return (
    <Suspense fallback={<main className="p-8 text-stone-600">Loading review inbox…</main>}>
      <ReviewBrowser />
    </Suspense>
  );
}
