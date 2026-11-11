import { describe, expect, it } from "vitest";
import { closeBySea, contains, projector, simplify } from "../../scripts/zone-geometry.mjs";

/** La géométrie de la zone, sur des figures inventées (carrés, côte en « U », cercle), jamais les vraies communes. */

type Point = [number, number];

const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

/** L'aire d'un anneau (formule du lacet), en valeur absolue. */
const area = (ring: Point[]): number =>
  Math.abs(ring.reduce((sum, [x, y], i) => {
    const [nx, ny] = ring[(i + 1) % ring.length];
    return sum + (x * ny - nx * y);
  }, 0)) / 2;

describe("contains", () => {
  it("is true inside a square, false outside, and constant on a vertex", () => {
    expect(contains(square, [5, 5])).toBe(true);
    expect(contains(square, [15, 5])).toBe(false);
    expect(contains(square, [5, -1])).toBe(false);
    expect(contains(square, [0, 0])).toBe(contains(square, [0, 0]));
  });
});

describe("closeBySea", () => {
  // Une côte imaginaire : un « U » renversé, ouvert vers le sud, du point (0, 0) au point (10, 0).
  const coast: Point[] = [[0, 0], [0, 10], [10, 10], [10, 0]];

  it("follows the contour, then goes south of the last point, south of the first, and back to the first", () => {
    expect(closeBySea(coast)).toEqual([...coast, [10, -0.3], [0, -0.3], [0, 0]]);
    expect(closeBySea(coast, 1).at(-2)).toEqual([0, -1]);
  });

  it("closes the contour by the sea: south of the line between the ends is inside until the closing points", () => {
    const ring = closeBySea(coast);
    expect(contains(ring, [5, 5])).toBe(true);
    expect(contains(ring, [5, -0.1])).toBe(true);
    expect(contains(ring, [5, -1])).toBe(false);
  });
});

describe("simplify", () => {
  const circle: Point[] = Array.from({ length: 200 }, (_, i) => [
    100 * Math.cos((2 * Math.PI * i) / 200),
    100 * Math.sin((2 * Math.PI * i) / 200),
  ]);

  it("keeps the shape of a circle (area within 5 %) with far fewer points", () => {
    const simple = simplify(circle, 2);
    expect(simple.length).toBeGreaterThanOrEqual(3);
    expect(simple.length).toBeLessThan(60);
    expect(Math.abs(area(simple) - area(circle)) / area(circle)).toBeLessThan(0.05);
  });

  it("keeps a square above the tolerance as is", () => {
    expect(simplify(square, 1)).toHaveLength(4);
  });

  it("never returns fewer than 3 points for a ring: a tiny triangle under the tolerance gives none", () => {
    expect(simplify([[0, 0], [0.1, 0], [0, 0.1]], 1)).toEqual([]);
  });

  it("keeps the closing point of a closed ring", () => {
    const closed = simplify([...square, square[0]], 1);
    expect(closed).toHaveLength(5);
    expect(closed.at(-1)).toEqual(closed[0]);
  });
});

describe("projector", () => {
  const bounds = { west: 5, south: 43, east: 7, north: 44 };
  const project = projector(bounds, 400);

  it("puts the west at x = 0, the east at x = width, and the north above the south", () => {
    expect(project([5, 43.5])[0]).toBe(0);
    expect(project([7, 43.5])[0]).toBeCloseTo(400);
    expect(project([6, 44])[1]).toBeLessThan(project([6, 43])[1]);
    expect(project([6, 44])[1]).toBeCloseTo(0);
  });

  it("corrects the longitude by the cosine of the mean latitude", () => {
    const [x, y] = project([6, 43]);
    const meanLat = (43 + 44) / 2;
    // Un degré vers l'est et un degré vers le sud : la longitude est raccourcie par le cosinus.
    expect(y / x).toBeCloseTo(1 / Math.cos((meanLat * Math.PI) / 180), 5);
  });
});
