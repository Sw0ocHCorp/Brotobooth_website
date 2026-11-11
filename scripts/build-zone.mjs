// Fabrique la carte de la zone de déplacement : `npm run zone` (réseau nécessaire), jamais lancé par le build, le déploiement ni les tests.
// Les contours viennent de geo.api.gouv.fr : IGN, Admin Express, sous Licence Ouverte (https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
// Le résultat, `src/generated/zone.json`, est versionné : le site se construit sans réseau.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeBySea, contains, projector, simplify } from "./zone-geometry.mjs";

/** @typedef {import("./zone-geometry.mjs").Point} Point */
/** @typedef {{ properties: { nom: string, code: string }, geometry: { type: string, coordinates: any } }} Feature */
/** @typedef {{ name: string, x: number, y: number, side: "left" | "right", small: boolean }} Label */
/** @typedef {{ viewBox: string, zone: string, context: string, labels: Label[], communes: string[], border: string[], updated: string }} Zone */

const MAX_BYTES = 80 * 1024;
const MARGIN = 0.12;
/**
 * Les repères écrits sur la carte : le nom de la commune, le nom qu'on y lit si ce n'est pas le même, le côté du point
 * où il s'écrit (à l'écart d'un voisin) et s'il reste sur une carte étroite (moins de 400 px), où seuls quatre noms tiennent.
 */
const LANDMARKS = [
  { name: "Cassis", side: "right", small: true },
  { name: "Aubagne", side: "left", small: false },
  { name: "Signes", side: "left", small: true },
  { name: "Méounes-lès-Montrieux", shown: "Méounes", side: "right", small: false },
  { name: "Toulon", side: "left", small: true },
  { name: "Hyères", side: "right", small: true },
  { name: "La Londe-les-Maures", side: "left", small: false },
];

/** Les anneaux extérieurs d'une commune, qu'elle soit un Polygon ou un MultiPolygon (îles comprises). */
const outerRings = ({ geometry: { type, coordinates } }) => (type === "Polygon" ? [coordinates[0]] : coordinates.map((polygon) => polygon[0]));

/** L'aire (signée) d'un anneau et son centre de gravité. */
function measure(ring) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    area += cross;
    cx += (ring[i][0] + ring[i + 1][0]) * cross;
    cy += (ring[i][1] + ring[i + 1][1]) * cross;
  }
  return { area: Math.abs(area), centre: [cx / (3 * area), cy / (3 * area)] };
}

/** Le plus grand anneau extérieur d'une commune : le reste, ce sont ses îles. */
function largestRing(feature) {
  let best = { area: -1, ring: [] };
  for (const ring of outerRings(feature)) {
    const { area } = measure(ring);
    if (area > best.area) best = { area, ring };
  }
  return best.ring;
}

/** Le centre d'une commune : le centre de gravité de son plus grand anneau extérieur (l'API ne renvoie pas `centre` avec le contour). */
const centreOf = (feature) => measure(largestRing(feature)).centre;

/** L'emprise d'anneaux : ouest, sud, est, nord. */
function boundsOf(rings) {
  const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      bounds.west = Math.min(bounds.west, lon);
      bounds.south = Math.min(bounds.south, lat);
      bounds.east = Math.max(bounds.east, lon);
      bounds.north = Math.max(bounds.north, lat);
    }
  }
  return bounds;
}

/**
 * La carte, depuis les communes des deux départements : celles du contour, et celles dont le centre est dans le polygone
 * que la mer ferme, forment la zone, par leur seul plus grand anneau ; leurs îles, et les autres communes dont l'emprise
 * touche le cadre, forment le contexte.
 * @param {Feature[]} communes
 * @param {{ name: string, department: string }[]} border
 * @param {number} [width]
 * @param {number} [tolerance] simplification des contours, en degrés
 * @returns {Omit<Zone, "updated">}
 */
export function buildZone(communes, border, width = 800, tolerance = 0.0005) {
  const find = (name, department) => communes.find((c) => c.properties.nom === name && (department === undefined || c.properties.code.startsWith(department)));
  const borderCommunes = border.map(({ name, department }) => {
    const commune = find(name, department);
    if (!commune) throw new Error(`Commune du contour introuvable dans les données : ${name} (${department})`);
    return commune;
  });
  const sea = closeBySea(borderCommunes.map(centreOf));
  const inZone = (commune) => borderCommunes.includes(commune) || contains(sea, centreOf(commune));
  const zoneCommunes = communes.filter(inZone);

  const zoneRings = zoneCommunes.map(largestRing);
  const zoneBounds = boundsOf(zoneRings);
  const [dx, dy] = [(zoneBounds.east - zoneBounds.west) * MARGIN, (zoneBounds.north - zoneBounds.south) * MARGIN];
  const frame = { west: zoneBounds.west - dx, south: zoneBounds.south - dy, east: zoneBounds.east + dx, north: zoneBounds.north + dy };
  const project = projector(frame, width);
  const height = Math.round(project([frame.east, frame.south])[1]);

  const path = (rings) =>
    rings
      .map((ring) => simplify(ring, tolerance))
      .filter((ring) => ring.length)
      .map((ring) => `M${ring.slice(0, -1).map((p) => project(p).map((n) => Math.round(n * 10) / 10).join(" ")).join("L")}Z`)
      .join("");

  const touchesFrame = (commune) => {
    const b = boundsOf(outerRings(commune));
    return b.east >= frame.west && b.west <= frame.east && b.north >= frame.south && b.south <= frame.north;
  };
  const contextRings = [
    ...communes.filter((c) => !zoneCommunes.includes(c) && touchesFrame(c)).flatMap(outerRings),
    ...zoneCommunes.flatMap((c) => outerRings(c).filter((ring) => ring !== largestRing(c))),
  ];

  const labels = LANDMARKS.map(({ name, shown = name, side, small }) => {
    const commune = find(name);
    if (!commune) throw new Error(`Repère introuvable dans les données : ${name}`);
    const [x, y] = project(centreOf(commune));
    return { name: shown, x: Math.round(x), y: Math.round(y), side, small };
  });

  return {
    viewBox: `0 0 ${width} ${height}`,
    zone: path(zoneRings),
    context: path(contextRings),
    labels,
    communes: zoneCommunes.map((c) => c.properties.nom).sort((a, b) => a.localeCompare(b, "fr")),
    border: border.map(({ name }) => name),
  };
}

/** Le script : lit les contours, double la tolérance jusqu'à tenir en 80 Ko, écrit le fichier, liste les communes retenues. */
async function main() {
  // La zone vient de l'offre, lue comme le fait le contrôle d'avant publication : `buildOffer` refuse un contour mal écrit.
  const { buildOffer } = await import("../worker/offer.ts");
  const { zone: { border } } = buildOffer(JSON.parse(readFileSync(new URL("../config/offer.json", import.meta.url), "utf8")));
  const features = [];
  for (const department of new Set(border.map((b) => b.department))) {
    const response = await fetch(`https://geo.api.gouv.fr/departements/${department}/communes?fields=nom,code,centre,contour&format=geojson&geometry=contour`);
    if (!response.ok) throw new Error(`geo.api.gouv.fr, département ${department} : ${response.status}`);
    features.push(...(await response.json()).features);
  }
  const updated = new Date().toISOString().slice(0, 7);
  let tolerance = 0.0005;
  let json = JSON.stringify({ ...buildZone(features, border), updated });
  while (Buffer.byteLength(json) > MAX_BYTES) {
    tolerance *= 2;
    json = JSON.stringify({ ...buildZone(features, border, 800, tolerance), updated });
  }
  writeFileSync(fileURLToPath(new URL("../src/generated/zone.json", import.meta.url)), json);
  const { communes } = JSON.parse(json);
  console.log(`${communes.join("\n")}\n\n${communes.length} communes, ${Buffer.byteLength(json)} octets, tolérance ${tolerance}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
