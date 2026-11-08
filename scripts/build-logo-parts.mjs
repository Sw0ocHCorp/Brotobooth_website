// Découpe `logo-blanc.svg` en cinq morceaux pour l'animation d'ouverture, dans `src/generated/logo-parts.json` :
//   broto, left, right : le tracé blanc, par sous-chemin (BROTO en haut, puis le B de BOOTH, puis le T et le H) ;
//   rose, orange       : les deux O de BOOTH, repris tels quels ;
//   tip                : le point de la fente, entre les deux O, là où les moitiés se rejoignent.
// Le logo ne se retouche pas à la main (il est produit par le dépôt de la borne) : relancer ce script après chaque
// changement de `logo-blanc.svg` et versionner le résultat.
//   node scripts/build-logo-parts.mjs

import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = new URL("../logo-blanc.svg", import.meta.url);
const TARGET = new URL("../src/generated/logo-parts.json", import.meta.url);

const FILLS = { white: "#FFFFFF", rose: "#F2559B", orange: "#FF8A3D" };
/** Le B de BOOTH commence à gauche de cette abscisse ; le T et le H, à sa droite. */
const LEFT_EDGE_MAX_X = 1000;
/** L'inclinaison de la fente par rapport à la verticale, en degrés. */
const SLIT_ANGLE = 24;
const SLIT_ANGLE_TOLERANCE = 0.1;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** Le tracé (`d`) de chaque `<path>`, par couleur de remplissage. */
function readPaths(svg) {
  const found = Object.fromEntries([...svg.matchAll(/<path\s+fill="([^"]+)"[^>]*\sd="([^"]+)"/g)].map(([, fill, d]) => [fill, d]));
  for (const fill of Object.values(FILLS)) if (!found[fill]) fail(`Aucun tracé ${fill} dans logo-blanc.svg.`);
  return found;
}

/** Les sous-chemins d'un tracé, avec leurs points. Seuls M, L et Z sont lus : une courbe ferait échouer le script plutôt que mal découper. */
function subpaths(d) {
  return d.match(/M[^M]*/g).map((text) => {
    const source = text.trim();
    if (!/^M[\d .\-L]+Z$/.test(source)) fail(`Sous-chemin inattendu (seuls M, L et Z sont gérés) : ${source.slice(0, 60)}…`);
    const points = [...source.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
    return { source, points };
  });
}

const minOf = (path, axis) => Math.min(...path.points.map((point) => point[axis]));
const maxY = (paths) => Math.max(...paths.flatMap((path) => path.points.map(([, y]) => y)));
const joined = (paths) => paths.map((path) => path.source).join(" ");

/** L'abscisse à `y` du plus long côté droit d'un O : le bord de coupe, qui doit pencher de 24°. */
function cutEdgeAt(oShape, y) {
  const [first] = oShape;
  let longest = { length: 0 };
  first.points.forEach(([x1, y1], i) => {
    const [x2, y2] = first.points[(i + 1) % first.points.length];
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length > longest.length) longest = { length, x1, y1, x2, y2 };
  });
  const { x1, y1, x2, y2 } = longest;
  const angle = (Math.atan(Math.abs(x2 - x1) / Math.abs(y2 - y1)) * 180) / Math.PI;
  if (Math.abs(angle - SLIT_ANGLE) > SLIT_ANGLE_TOLERANCE) fail(`Le bord de coupe penche de ${angle.toFixed(2)}° et non de ${SLIT_ANGLE}°.`);
  return x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
}

const paths = readPaths(readFileSync(SOURCE, "utf8"));
const [rose, orange] = [subpaths(paths[FILLS.rose]), subpaths(paths[FILLS.orange])];

const white = { broto: [], left: [], right: [] };
for (const path of subpaths(paths[FILLS.white])) {
  if (minOf(path, 1) < 0) white.broto.push(path);
  else if (minOf(path, 0) < LEFT_EDGE_MAX_X) white.left.push(path);
  else white.right.push(path);
}
for (const [name, list] of Object.entries(white)) if (list.length === 0) fail(`Le morceau « ${name} » est vide.`);

// La fente part du bas des O, à leur point le plus bas ; son axe passe à mi-chemin des deux bords de coupe.
const tipY = maxY([...rose, ...orange]);
const tipX = Math.round(((cutEdgeAt(rose, tipY) + cutEdgeAt(orange, tipY)) / 2) * 10) / 10;

const parts = {
  broto: joined(white.broto),
  left: joined(white.left),
  rose: joined(rose),
  orange: joined(orange),
  right: joined(white.right),
  tip: [tipX, tipY],
};
writeFileSync(TARGET, `${JSON.stringify(parts, null, 2)}\n`);
console.log(`logo-parts.json : ${white.broto.length} + ${white.left.length} + ${white.right.length} sous-chemins blancs, fente en (${tipX}, ${tipY}).`);
