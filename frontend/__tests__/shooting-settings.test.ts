import { expect, test } from "vitest";
import { DEFAULT_CATALOG_STATE, parseCatalogState, writeCatalogState } from "../app/lib/catalog-query";
import { formatShootingNumber, formatShutterSpeed, validateShootingRanges } from "../app/lib/shooting-settings";

test("formats exact reciprocal speeds, long exposures, and unusual fractions", () => {
  expect(formatShutterSpeed(1 / 2000, "en")).toBe("1/2000 s");
  expect(formatShutterSpeed(1 / 3, "en")).toBe("1/3 s");
  expect(formatShutterSpeed(0.017, "en")).toBe("0.017 s");
  expect(formatShutterSpeed(0.00050001, "en")).toBe("0.00050001 s");
  expect(formatShutterSpeed(1, "en")).toBe("1 s");
  expect(formatShutterSpeed(2.5, "sl")).toBe("2,5 s");
  expect(formatShootingNumber(5.6, "sl")).toBe("5,6");
});

test("range validation accepts one-sided and equal limits and rejects invalid values", () => {
  expect(validateShootingRanges({ aperture_f_number_min: "5,6", aperture_f_number_max: "5.6",
    focal_length_mm_max: "400.5", exposure_time_seconds_min: "5e-4" }).ranges).toEqual({
    aperture_f_number_min: 5.6, aperture_f_number_max: 5.6,
    focal_length_mm_max: 400.5, exposure_time_seconds_min: 0.0005,
  });
  for (const input of ["0", "-1", "800.5", "Infinity", "9007199254740993"]) {
    expect(validateShootingRanges({ iso_speed_min: input }).invalid).toBe("iso_speed_min");
  }
  expect(validateShootingRanges({ focal_length_mm_min: "100", focal_length_mm_max: "90" }).invalid).toBe("focal_length_mm_min");
});

test("serializes all eight URL parameters and clears only absent bounds", () => {
  const ranges = {
    iso_speed_min: 800, iso_speed_max: 1600,
    aperture_f_number_min: 2.8, aperture_f_number_max: 8,
    focal_length_mm_min: 300, focal_length_mm_max: 600,
    exposure_time_seconds_min: 0.0005, exposure_time_seconds_max: 2.5,
  };
  const state = { ...DEFAULT_CATALOG_STATE, ...ranges };
  const params = writeCatalogState(new URLSearchParams("unrelated=1"), state);
  expect(params.get("unrelated")).toBe("1");
  expect(parseCatalogState(params)).toMatchObject(state);
  expect(writeCatalogState(params, DEFAULT_CATALOG_STATE).toString()).toBe("unrelated=1");
  expect(parseCatalogState(new URLSearchParams("catalog_iso_speed_min=NaN")).iso_speed_min).toBeNaN();
});
