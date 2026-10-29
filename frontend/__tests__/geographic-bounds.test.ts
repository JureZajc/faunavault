import { expect, test } from "vitest";
import { areaSummary, boundsError, boundsFromCorners, displayAreaBounds, hasArea, parseCoordinate } from "../app/lib/geographic-bounds";
import { DEFAULT_CATALOG_STATE, mapCatalogHref, mapListHref, parseCatalogState, writeCatalogState } from "../app/lib/catalog-query";
import { savedQueryFromState } from "../app/lib/smart-collections";
import { photoMapDetailHref } from "../app/lib/photo-map";

const area = { bbox_south: 0, bbox_north: 10, bbox_west: 170, bbox_east: -170 };

test("validates complete finite non-degenerate coordinates, including zero and crossing areas", () => {
  expect(boundsError(area)).toBeNull();
  expect(boundsError({})).toBeNull();
  expect(hasArea({ bbox_south: 0 })).toBe(true);
  for (const invalid of [ { bbox_south: 0 }, { ...area, bbox_south: NaN }, { ...area, bbox_north: Infinity },
    { ...area, bbox_north: 91 }, { ...area, bbox_west: -181 }, { ...area, bbox_south: 10 },
    { ...area, bbox_east: 170 }, { ...area, bbox_west: 180, bbox_east: -180 } ]) expect(boundsError(invalid)).toBeTruthy();
  for (const value of ["", " ", "NaN", "Infinity", "0x10", "12,3", "46bad"]) expect(parseCoordinate(value)).toBeNaN();
  expect(parseCoordinate("0")).toBe(0);
  expect(parseCoordinate("-1.23456789012345")).toBe(-1.23456789012345);
});

test("drawn world coordinates preserve crossing and global intervals", () => {
  expect(boundsFromCorners({ lat: 0, lng: 170 }, { lat: 10, lng: 190 })).toEqual(area);
  expect(boundsFromCorners({ lat: 10, lng: 190 }, { lat: 0, lng: 170 })).toEqual(area);
  expect(displayAreaBounds(area)).toEqual([[0, 170], [10, 190]]);
  expect(boundsFromCorners({ lat: -95, lng: -190 }, { lat: 95, lng: 190 })).toEqual({ bbox_south: -90, bbox_north: 90, bbox_west: -180, bbox_east: 180 });
  expect(areaSummary(area)).toContain("crosses antimeridian");
});

test("URL and navigation preserve precise bounds, compatible and unsupported criteria", () => {
  const state = { ...DEFAULT_CATALOG_STATE, ...area, bbox_south: 0.123456789012345, category: "bird", tags: ["sunset"], rating_min: 4 as const, event_id: 7, page: 8 };
  const params = writeCatalogState(new URLSearchParams(), state);
  expect(parseCatalogState(params)).toMatchObject(state);
  for (const href of [mapCatalogHref(state), mapListHref(state)]) {
    expect(href).toContain("catalog_bbox_south=0.123456789012345");
    expect(href).toContain("catalog_bbox_east=-170");
    expect(href).toContain("catalog_category=bird");
    expect(href).toContain("catalog_tag=sunset");
    expect(href).toContain("catalog_rating_min=4");
    expect(href).toContain("catalog_event_id=7");
    expect(href).not.toContain("catalog_page");
  }
  const detail = photoMapDetailHref({ id: 17 } as Parameters<typeof photoMapDetailHref>[0], mapCatalogHref(state));
  expect(new URLSearchParams(detail.split("?")[1]).get("returnTo")).toContain("catalog_bbox_east=-170");
  expect(() => savedQueryFromState(state, "")).toThrow("Geographic area filters cannot be saved");
});

test.each(["catalog_bbox_south=", "catalog_bbox_south=NaN", "catalog_bbox_south=0&catalog_bbox_north=10&catalog_bbox_west=170", "catalog_bbox_south=0&catalog_bbox_south=5&catalog_bbox_north=10&catalog_bbox_west=170&catalog_bbox_east=-170"])("invalid URLs stay invalid through serialization: %s", (query) => {
  const parsed = parseCatalogState(new URLSearchParams(query));
  expect(boundsError(parsed)).toBeTruthy();
  expect(boundsError(parseCatalogState(writeCatalogState(new URLSearchParams(), parsed)))).toBeTruthy();
});
