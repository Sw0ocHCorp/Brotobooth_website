import { describe, expect, it } from "vitest";
import { buildOffer, offer, type OfferConfig } from "../../worker/offer";

/** `buildOffer` refuse un contact mal écrit dans `config/offer.json` et nettoie les prénoms et les numéros. */

const withContact = (contact: Partial<OfferConfig["contact"]>): OfferConfig => ({
  ...offer,
  plans: offer.plans.map(({ name: _name, ...plan }) => plan),
  contact: { phones: [], email: "", social: [], ...contact },
});

describe("buildOffer, contact", () => {
  it("trims the founders' first names and numbers", () => {
    const built = buildOffer(withContact({ phones: [{ name: "  Camille ", number: " 06 12 34 56 78\t" }] }));
    expect(built.contact.phones).toEqual([{ name: "Camille", number: "06 12 34 56 78" }]);
    expect(built.contact.phone).toBe("06 12 34 56 78");
  });

  it("refuses a number without any digit", () => {
    expect(() => buildOffer(withContact({ phones: [{ name: "Camille", number: "+ ( ) -" }] }))).toThrow(/config\/offer\.json.*chiffre/);
  });

  it("refuses a social link that does not start with https://", () => {
    for (const link of ["http://exemple.fr/a", "instagram.com/compte", "javascript:alert(1)"]) {
      expect(() => buildOffer(withContact({ social: [link] }))).toThrow(/config\/offer\.json.*https:\/\//);
    }
    expect(buildOffer(withContact({ social: ["https://exemple.fr/a"] })).contact.social).toEqual(["https://exemple.fr/a"]);
  });
});
