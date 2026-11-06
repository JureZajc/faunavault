import { Suspense } from "react";
import SightingMapBrowser from "./sighting-map-browser";

export default function SightingMapPage() {
  return <Suspense fallback={<p role="status">Loading Sightings Map…</p>}>
    <SightingMapBrowser />
  </Suspense>;
}
