import { Suspense } from "react";
import InsightsBrowser from "./insights-browser";

export default function InsightsPage() {
  return <Suspense fallback={<p role="status" className="p-6">Loading Wildlife Insights…</p>}><InsightsBrowser /></Suspense>;
}
