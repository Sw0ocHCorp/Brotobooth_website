import { describe, expect, it } from "vitest";
import { formatEuros } from "../../worker/html";

/** Les montants tels que le site, les e-mails, `/acompte`, l'administration et l'agenda les écrivent. */

describe("formatEuros", () => {
  it("écrit un montant rond sans centimes", () => {
    expect(formatEuros(25_000)).toBe("250 €");
    expect(formatEuros(7_500)).toBe("75 €");
    expect(formatEuros(0)).toBe("0 €");
    expect(formatEuros(150_000)).toMatch(/^1\s500 €$/);
  });

  it("garde deux décimales à un montant qui a des centimes", () => {
    expect(formatEuros(3_750)).toBe("37,50 €");
    expect(formatEuros(105)).toBe("1,05 €");
    expect(formatEuros(150_050)).toMatch(/^1\s500,50 €$/);
  });
});
