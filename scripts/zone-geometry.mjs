// La géométrie de la zone de déplacement : des fonctions pures, en JavaScript annoté pour que Node les lise sans compilation.

/** @typedef {[lon: number, lat: number]} Point */
/** @typedef {Point[]} Ring */

/**
 * Ferme par la mer un contour qui longe la frontière terrestre : le contour dans l'ordre, puis un point à `offset` degrés
 * au sud du dernier, un au sud du premier, puis le premier.
 * @param {Point[]} border
 * @param {number} [offset]
 * @returns {Ring}
 */
export function closeBySea(border, offset = 0.3) {
  const first = border[0];
  const last = border[border.length - 1];
  return [...border, [last[0], last[1] - offset], [first[0], first[1] - offset], first];
}

/**
 * Règle pair-impair : un rayon vers l'est coupe les côtés de l'anneau un nombre impair de fois si le point est dedans.
 * @param {Ring} ring
 * @param {Point} point
 * @returns {boolean}
 */
export function contains(ring, [lon, lat]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** La distance du point `p` au segment `a`–`b`. */
function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas-Peucker sur une ligne ouverte : ses extrémités, et les points qui s'écartent de plus de `tolerance`. */
function simplifyLine(line, tolerance) {
  let farthest = -1;
  let farthestDistance = tolerance;
  for (let i = 1; i < line.length - 1; i++) {
    const distance = distanceToSegment(line[i], line[0], line[line.length - 1]);
    if (distance > farthestDistance) [farthest, farthestDistance] = [i, distance];
  }
  if (farthest < 0) return [line[0], line[line.length - 1]];
  return [...simplifyLine(line.slice(0, farthest + 1), tolerance).slice(0, -1), ...simplifyLine(line.slice(farthest), tolerance)];
}

/**
 * Douglas-Peucker sur un anneau (fermé ou non : un point final identique au premier est conservé). L'anneau est coupé
 * au premier point et au point le plus éloigné de lui. Moins de trois points distincts au final : `[]`.
 * @param {Ring} ring
 * @param {number} tolerance
 * @returns {Ring}
 */
export function simplify(ring, tolerance) {
  const last = ring[ring.length - 1];
  const closed = ring.length > 1 && ring[0][0] === last[0] && ring[0][1] === last[1];
  const open = closed ? ring.slice(0, -1) : ring;
  if (open.length < 3) return [];
  let far = 1;
  for (let i = 2; i < open.length; i++) {
    if (Math.hypot(open[i][0] - open[0][0], open[i][1] - open[0][1]) > Math.hypot(open[far][0] - open[0][0], open[far][1] - open[0][1])) far = i;
  }
  const kept = [...simplifyLine(open.slice(0, far + 1), tolerance).slice(0, -1), ...simplifyLine([...open.slice(far), open[0]], tolerance).slice(0, -1)];
  return kept.length < 3 ? [] : closed ? [...kept, kept[0]] : kept;
}

/**
 * Projette (longitude, latitude) sur un plan de `width` de large, le nord en haut : équirectangulaire, la longitude
 * raccourcie par le cosinus de la latitude moyenne.
 * @param {{ west: number, south: number, east: number, north: number }} bounds
 * @param {number} width
 * @returns {(point: Point) => [x: number, y: number]}
 */
export function projector({ west, south, east, north }, width) {
  const cos = Math.cos((((south + north) / 2) * Math.PI) / 180);
  const scale = width / ((east - west) * cos);
  return ([lon, lat]) => [(lon - west) * cos * scale, (north - lat) * scale];
}
