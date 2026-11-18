import { describe, expect, it } from "vitest";
import { BUSINESS, MEDIATOR } from "../../src/legal";

/** La clé de Luhn, que respectent le SIREN et le SIRET : une faute de frappe dans un numéro la casse presque toujours. */
const luhn = (digits: string): boolean =>
  [...digits].reverse().reduce((sum, digit, index) => {
    const doubled = index % 2 ? Number(digit) * 2 : Number(digit);
    return sum + (doubled > 9 ? doubled - 9 : doubled);
  }, 0) % 10 === 0;

describe("the business identity of the legal pages", () => {
  const siren = BUSINESS.registration.replace(/\D/g, "");
  const siret = BUSINESS.siret.replace(/\D/g, "");

  it("gives an RCS registration with a valid 9-digit SIREN", () => {
    expect(BUSINESS.registration).toMatch(/^RCS [A-ZÀ-Ý][\p{L}-]+ \d{3} \d{3} \d{3}$/u);
    expect(luhn(siren)).toBe(true);
  });

  it("gives a valid 14-digit SIRET that starts with the SIREN", () => {
    expect(siret).toMatch(/^\d{14}$/);
    expect(siret.startsWith(siren)).toBe(true);
    expect(luhn(siret)).toBe(true);
  });

  it("states the VAT exemption of a micro-entreprise with its article", () => {
    expect(BUSINESS.vat).toBe("TVA non applicable, art. 293 B du CGI");
  });
});

describe("the consumer mediator of the terms of sale", () => {
  // Art. R616-1 du Code de la consommation : le nom du médiateur, ses coordonnées et l'adresse de son site.
  it("gives the mediator's name, postal address and website", () => {
    expect(MEDIATOR.name).toContain("CM2C");
    expect(MEDIATOR.address).toMatch(/^\d+ rue [\p{L} ]+, \d{5} \p{L}+$/u);
    expect(new URL(MEDIATOR.website).protocol).toBe("https:");
  });
});
