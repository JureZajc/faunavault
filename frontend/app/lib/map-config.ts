export const MAP_TILE_CONFIG = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
} as const;

export const ARCHIVE_BOUNDS_MAX_ZOOM = 14;
export const PHOTO_MAP_ZOOM = 15;
export const FOCUSED_PHOTO_ZOOM = 16;
