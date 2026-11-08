import { describe, expect, it } from "vitest";
import { dayState, monthCells, shiftMonth } from "../../src/scripts/calendar-grid";

describe("les cases d'un mois, du lundi au dimanche", () => {
  it("novembre 2026 commence par 6 cases vides : le 1er est un dimanche", () => {
    const cells = monthCells(2026, 11);
    expect(cells.slice(0, 7)).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(cells.filter((cell) => cell !== null)).toHaveLength(30);
    expect(cells.at(-1)).toBe("2026-11-30");
  });

  it("un mois qui commence un lundi n'a aucune case vide", () => {
    expect(monthCells(2027, 2)[0]).toBe("2027-02-01");
    expect(monthCells(2027, 2)).toHaveLength(28);
  });

  it("février d'une année bissextile compte 29 jours", () => {
    expect(monthCells(2028, 2).at(-1)).toBe("2028-02-29");
  });
});

describe("l'état d'un jour", () => {
  const availability = { unavailable: ["2026-12-05", "2026-11-10"], earliest: "2026-11-15", latest: "2028-11-08" };

  it("une date indisponible est prise", () => {
    expect(dayState("2026-12-05", availability)).toBe("taken");
  });

  it("une date libre dans la fenêtre est libre", () => {
    expect(dayState("2026-12-06", availability)).toBe("free");
    expect(dayState("2026-11-15", availability)).toBe("free");
    expect(dayState("2028-11-08", availability)).toBe("free");
  });

  it("avant la première date réservable ou après la dernière, la date est hors d'atteinte", () => {
    expect(dayState("2026-11-14", availability)).toBe("out");
    expect(dayState("2028-11-09", availability)).toBe("out");
  });

  it("hors d'atteinte l'emporte sur prise : le calendrier ne dit rien d'une date qu'on ne peut pas demander", () => {
    expect(dayState("2026-11-10", availability)).toBe("out");
  });
});

describe("le mois voisin", () => {
  it.each([
    ["2026-11", 1, "2026-12"],
    ["2026-12", 1, "2027-01"],
    ["2027-01", -1, "2026-12"],
    ["2026-11", 24, "2028-11"],
  ])("%s décalé de %i donne %s", (month, by, expected) => {
    expect(shiftMonth(month, by)).toBe(expected);
  });
});
