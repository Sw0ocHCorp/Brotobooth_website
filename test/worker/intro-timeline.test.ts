import { describe, expect, it } from "vitest";
import { introFrame } from "../../src/scripts/intro-timeline";

describe("minutage de l'ouverture, celui de ui/widgets/BrandLogo.py", () => {
  it.each([
    [0, 300, 0],
    [0.3, 300, 0],
    [0.8, 0, 0],
    [0.875, 20, 0],
    [0.95, 0, 0],
    [1.4, 0, 0],
    [2, 0, 1],
  ])("à %s s : ouverture %s, trajet %s", (t, opening, travel) => {
    const f = introFrame(t);
    expect(f.opening).toBeCloseTo(opening, 5);
    expect(f.travel).toBeCloseTo(travel, 5);
  });

  it("les traits apparaissent à l'impact et s'effacent à 1,3 s", () => {
    expect(introFrame(0.79).burstOpacity).toBe(0);
    expect(introFrame(1.05).burstOpacity).toBe(1);
    expect(introFrame(1.3).burstOpacity).toBe(0);
  });

  it("le contenu apparaît de 1,6 à 2 s", () => {
    expect(introFrame(1.6).reveal).toBe(0);
    expect(introFrame(2).reveal).toBe(1);
  });

  it("le logo perd son relief en route et se pose à 90 % d'opacité, au-delà de 2 s compris", () => {
    expect(introFrame(1.4)).toMatchObject({ relief: 1, opacity: 1 });
    expect(introFrame(5)).toMatchObject({ travel: 1, relief: 0, opacity: 0.9, reveal: 1 });
  });
});
