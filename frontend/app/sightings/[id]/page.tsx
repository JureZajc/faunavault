import { sightingId } from "../../lib/sightings";
import SightingDetail from "./sighting-detail";

export default async function SightingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SightingDetail id={sightingId(id)} />;
}
