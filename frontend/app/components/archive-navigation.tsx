"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { useState } from "react";
import { CatalogState, catalogListHref, cullingListHref, hasEquipmentFilters, hasTagFilters } from "../lib/catalog-query";

export type ArchiveSection =
  | "list"
  | "tags"
  | "gear"
  | "timeline"
  | "insights"
  | "map"
  | "album"
  | "events"
  | "collections"
  | "review"
  | "cull"
  | "duplicates"
  | "trash";

const destinations: { section: ArchiveSection; label: string; href: string }[] = [
  { section: "list", label: "List", href: "/" },
  { section: "gear", label: "Gear", href: "/gear" },
  { section: "tags", label: "Tags", href: "/tags" },
  { section: "timeline", label: "Timeline", href: "/timeline" },
  { section: "insights", label: "Insights", href: "/insights" },
  { section: "map", label: "Map", href: "/map" },
  { section: "album", label: "Albums", href: "/?view=album" },
  { section: "collections", label: "Collections", href: "/collections" },
  { section: "events", label: "Trips & Events", href: "/events" },
  { section: "review", label: "Review", href: "/review" },
  { section: "cull", label: "Culling", href: "/cull" },
  { section: "duplicates", label: "Duplicates", href: "/duplicates" },
  { section: "trash", label: "Trash", href: "/?view=trash" },
];

export default function ArchiveNavigation({ active, onNavigate, catalogState }: {
  active: ArchiveSection;
  catalogState?: CatalogState;
  onNavigate?: (section: ArchiveSection, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const [blocked, setBlocked] = useState<typeof destinations[number] | null>(null);
  const filtered = catalogState && (hasTagFilters(catalogState) || hasEquipmentFilters(catalogState));
  const listHref = catalogState ? catalogListHref(catalogState) : "/";
  return <div className="w-full min-w-0"><nav aria-label="Archive views" className="grid w-full min-w-0 grid-cols-3 rounded-lg border border-stone-200 bg-stone-100 p-1 sm:grid-cols-4 xl:grid-cols-6">
    {destinations.map((destination) => <Link
      key={destination.section}
      href={filtered && destination.section === "list" ? listHref : filtered && destination.section === "cull" ? cullingListHref(catalogState, catalogState.search ?? "", listHref) : destination.href}
      aria-current={active === destination.section ? "page" : undefined}
      onClick={(event) => {
        if (filtered && destination.section !== "list" && destination.section !== "cull") {
          event.preventDefault();
          setBlocked(destination);
          return;
        }
        onNavigate?.(destination.section, event);
      }}
      className={`flex min-h-11 min-w-0 items-center justify-center rounded-md px-2 text-sm font-semibold transition lg:px-3 ${active === destination.section ? "bg-white text-emerald-900 shadow-sm" : "text-stone-600 hover:text-stone-900"}`}
    >{destination.label}</Link>)}
  </nav>{blocked && filtered && <p role="alert" className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">{blocked.label} does not apply the current {catalogState && hasEquipmentFilters(catalogState) ? "equipment filters" : "exact tag filters"}. <Link href={listHref} className="underline">Open the filtered List</Link> or <Link href={blocked.href} className="underline">open {blocked.label} without these filters</Link>.</p>}</div>;
}
