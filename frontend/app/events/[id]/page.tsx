import { Suspense } from "react";
import EventDetail from "./event-detail";
import { eventId } from "../../lib/events";
export default async function EventPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <Suspense fallback={<p role="status" className="p-8">Loading Trip/Event…</p>}><EventDetail eventId={eventId(id)} /></Suspense>; }
