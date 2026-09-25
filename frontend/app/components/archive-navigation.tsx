"use client";

import Link from "next/link";
import type { MouseEvent } from "react";

export type ArchiveSection =
  | "list"
  | "timeline"
  | "map"
  | "album"
  | "collections"
  | "review"
  | "trash";

const destinations: { section: ArchiveSection; label: string; href: string }[] = [
  { section: "list", label: "List", href: "/" },
  { section: "timeline", label: "Timeline", href: "/timeline" },
  { section: "map", label: "Map", href: "/map" },
  { section: "album", label: "Albums", href: "/?view=album" },
  { section: "collections", label: "Collections", href: "/collections" },
  { section: "review", label: "Review", href: "/review" },
  { section: "trash", label: "Trash", href: "/?view=trash" },
];

export default function ArchiveNavigation({ active, onNavigate }: {
  active: ArchiveSection;
  onNavigate?: (section: ArchiveSection, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return <nav aria-label="Archive views" className="grid w-full min-w-0 grid-cols-2 rounded-lg border border-stone-200 bg-stone-100 p-1 sm:grid-cols-3 lg:w-auto lg:grid-cols-7">
    {destinations.map((destination) => <Link
      key={destination.section}
      href={destination.href}
      aria-current={active === destination.section ? "page" : undefined}
      onClick={(event) => onNavigate?.(destination.section, event)}
      className={`flex min-h-11 min-w-0 items-center justify-center rounded-md px-2 text-sm font-semibold transition lg:min-w-24 lg:px-3 ${active === destination.section ? "bg-white text-emerald-900 shadow-sm" : "text-stone-600 hover:text-stone-900"}`}
    >{destination.label}</Link>)}
  </nav>;
}
