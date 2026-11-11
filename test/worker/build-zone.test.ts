import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { buildZone } from "../../scripts/build-zone.mjs";
import raw from "../../src/generated/zone.json?raw";

/** La carte de la zone, sur de fausses communes carrées (le code ne dépend que du nom, du code et du contour). */

type Feature = { type: "Feature"; properties: { nom: string; code: string }; geometry: { type: "Polygon"; coordinates: number[][][] } };

/** Une commune carrée de 0,1° de côté centrée en (lon, lat). */
const square = (nom: string, code: string, lon: number, lat: number): Feature => ({
  type: "Feature",
  properties: { nom, code },
  geometry: {
    type: "Polygon",
    coordinates: [[[lon - 0.05, lat - 0.05], [lon + 0.05, lat - 0.05], [lon + 0.05, lat + 0.05], [lon - 0.05, lat + 0.05], [lon - 0.05, lat - 0.05]]],
  },
});

// Trois communes bordent la zone au nord (lat 43,5) ; quatre sont au sud de cette ligne ; deux sont dehors.
const communes = [
  square("Aubagne", "13001", 5.6, 43.5),
  square("Signes", "83001", 5.8, 43.5),
  square("Méounes-lès-Montrieux", "83002", 6.0, 43.5),
  square("Cassis", "13002", 5.7, 43.3),
  square("Toulon", "83003", 5.9, 43.3),
  square("Hyères", "83004", 5.8, 43.25),
  square("La Londe-les-Maures", "83005", 5.95, 43.3),
  square("Voisine", "83006", 5.8, 43.6),
  square("Lointaine", "83007", 5.8, 47),
];
const border = [
  { name: "Aubagne", department: "13" },
  { name: "Signes", department: "83" },
  { name: "Méounes-lès-Montrieux", department: "83" },
];

describe("buildZone", () => {
  const zone = buildZone(communes, border);

  it("retains the border communes and those whose centre is inside the polygon closed by the sea, no others", () => {
    expect(zone.communes).toEqual(["Aubagne", "Cassis", "Hyères", "La Londe-les-Maures", "Méounes-lès-Montrieux", "Signes", "Toulon"]);
  });

  it("a border commune missing from the data is an error naming it", () => {
    expect(() => buildZone(communes, [...border, { name: "Inconnue", department: "13" }])).toThrow(/Inconnue/);
    expect(() => buildZone(communes, [{ name: "Aubagne", department: "83" }, ...border.slice(1)])).toThrow(/Aubagne/);
  });

  it("projects the seven known landmarks inside the frame, Méounes-lès-Montrieux written Méounes", () => {
    expect(zone.labels.map((l) => l.name)).toEqual(["Cassis", "Aubagne", "Signes", "Méounes", "Toulon", "Hyères", "La Londe-les-Maures"]);
    const [, , width, height] = zone.viewBox.split(" ").map(Number);
    expect(width).toBe(800);
    for (const { x, y } of zone.labels) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(height);
    }
  });

  it("draws the retained communes in zone and the neighbours touching the frame in context, not the far ones", () => {
    expect(zone.zone).toMatch(/^M[\d .\-LMZ]+Z$/);
    expect(zone.zone.split("M").length - 1).toBe(7);
    expect(zone.context.split("M").length - 1).toBe(1);
  });

  it("a coarser tolerance never makes the map heavier", () => {
    const fine = JSON.stringify(buildZone(communes, border, 800, 0.0001));
    const coarse = JSON.stringify(buildZone(communes, border, 800, 0.05));
    expect(coarse.length).toBeLessThanOrEqual(fine.length);
  });
});

describe("the generated map", () => {
  it("exists, has the shape of a Zone and weighs at most 80 Ko", () => {
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(80 * 1024);
    const zone = JSON.parse(raw);
    expect(zone.viewBox).toMatch(/^0 0 \d+ \d+$/);
    expect(zone.zone).toMatch(/^M/);
    expect(zone.context).toMatch(/^M/);
    expect(zone.labels).toHaveLength(7);
    expect(zone.communes.length).toBeGreaterThanOrEqual(12);
  });
});

describe("package.json", () => {
  it("never runs build-zone from build, deploy, dev, dev:e2e, demo or test", () => {
    const scripts: Record<string, string> = pkg.scripts;
    expect(scripts.zone).toContain("build-zone");
    for (const name of ["build", "deploy", "dev", "dev:e2e", "demo", "test"]) expect(scripts[name]).not.toContain("build-zone");
  });
});
