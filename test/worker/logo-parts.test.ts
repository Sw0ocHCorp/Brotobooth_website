import { describe, expect, it } from "vitest";
import parts from "../../src/generated/logo-parts.json";

const PATHS = ["broto", "left", "right", "rose", "orange"] as const;

describe("logo découpé pour l'animation d'ouverture", () => {
  it("sépare le logo en cinq morceaux et situe la fente", () => {
    for (const k of PATHS) expect(parts[k]).toMatch(/^M/);
    expect(parts.tip[0]).toBeCloseTo(1659, 0);
    expect(parts.tip[1]).toBe(917);
  });

  it("ne garde que des tracés fermés, faits de lignes droites", () => {
    for (const k of PATHS) expect(parts[k]).toMatch(/^M[\d .\-LMZ]+Z$/);
  });
});
