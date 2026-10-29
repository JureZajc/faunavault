import TimelineBrowser from "./timeline-browser";
import { Suspense } from "react";

export default function TimelinePage() {
  return <Suspense fallback={<p role="status">Loading Timeline…</p>}><TimelineBrowser /></Suspense>;
}
