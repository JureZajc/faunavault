import { Suspense } from "react";
import LifeListBrowser from "./life-list-browser";

export default function LifeListPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6">Loading Life List…</p>}>
      <LifeListBrowser />
    </Suspense>
  );
}
