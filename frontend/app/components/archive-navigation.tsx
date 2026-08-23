"use client";

import Link from "next/link";
import type { MouseEvent } from "react";

export type ArchiveSection =
  | "list"
  | "map"
  | "album"
  | "collections"
  | "trash";

const destinations: { section: ArchiveSection; label: string; href: string }[] = [
  { section: "list", label: "List", href: "/" },
  { section: "map", label: "Map", href: "/map" },
  { section: "album", label: "Albums", href: "/?view=album" },
  { section: "collections", label: "Collections", href: "/collections" },
  { section: "trash", label: "Trash", href: "/?view=trash" },
];

export default function ArchiveNavigation({ active, onNavigate }: {
  active: ArchiveSection;
  onNavigate?: (section: ArchiveSection, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return <nav aria-label="Archive views" className="grid w-full grid-cols-2 rounded-lg border border-stone-200 bg-stone-100 p-1 sm:w-auto sm:grid-cols-5">
    {destinations.map((destination) => <Link
      key={destination.section}
      href={destination.href}
      aria-current={active === destination.section ? "page" : undefined}
      onClick={(event) => onNavigate?.(destination.section, event)}
      className={`flex min-h-11 min-w-0 items-center justify-center rounded-md px-3 text-sm font-semibold transition sm:min-w-24 ${active === destination.section ? "bg-white text-emerald-900 shadow-sm" : "text-stone-600 hover:text-stone-900"}`}
    >{destination.label}</Link>)}
  </nav>;
}
