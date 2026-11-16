import { describe, expect, it } from "vitest";
import { BUSINESS } from "../../src/legal";

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
