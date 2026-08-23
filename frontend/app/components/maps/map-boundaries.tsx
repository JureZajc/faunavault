"use client";

import dynamic from "next/dynamic";
import type { ArchivePhotoMapProps } from "./archive-photo-map.client";
import type { SinglePhotoMapProps } from "./single-photo-map.client";
import styles from "./photo-map.module.css";

const SinglePhotoMapClient = dynamic(
  () => import("./single-photo-map.client"),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-label="Loading photo location map"
        className={`${styles.loading} ${styles.detailFrame}`}
      >
        Loading map…
      </div>
    ),
  },
);

const ArchivePhotoMapClient = dynamic(
  () => import("./archive-photo-map.client"),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-label="Loading archive map"
        className={`${styles.loading} ${styles.archiveFrame}`}
      >
        Loading map…
      </div>
    ),
  },
);

export function PhotoLocationMap(props: SinglePhotoMapProps) {
  return <SinglePhotoMapClient {...props} />;
}

export function ArchivePhotoMap(props: ArchivePhotoMapProps) {
  return <ArchivePhotoMapClient {...props} />;
}
