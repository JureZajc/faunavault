import { Suspense } from "react";
import EventsBrowser from "./events-browser";
export default function EventsPage() { return <Suspense fallback={<p role="status" className="p-8">Loading Trips & Events…</p>}><EventsBrowser /></Suspense>; }
