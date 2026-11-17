import { describe, expect, it } from "vitest";
import { useDeposit } from "../support";
import { buildOffer, contactLinks, hasDeposit, offer, whatsappHref, type OfferConfig } from "../../worker/offer";

/** `buildOffer` refuse un contact mal écrit dans `config/offer.json` et nettoie les prénoms et les numéros. */

const withContact = (contact: Partial<OfferConfig["contact"]>): OfferConfig => ({
  ...offer,
  plans: offer.plans.map(({ name: _name, ...plan }) => plan),
  contact: { phones: [], email: "", whatsapp: "", social: [], ...contact },
});

describe("buildOffer, draft", () => {
  const { draft: _draft, ...withoutDraft } = withContact({});

  it("treats an offer without a draft line as final", () => {
    expect(buildOffer(withoutDraft).draft).toBe(false);
  });

  it("keeps an offer marked draft provisional", () => {
    expect(buildOffer({ ...withoutDraft, draft: true }).draft).toBe(true);
  });
});

describe("hasDeposit et depositPercent", () => {
  it("n'y a pas d'acompte à 0 %, et il y en a un au-delà", () => {
    expect(hasDeposit({ depositPercent: 0 })).toBe(false);
    expect(hasDeposit({ depositPercent: 25 })).toBe(true);
  });

  describe("sans argument, suit l'offre de l'application", () => {
    describe("sans acompte", () => {
      useDeposit(0);
      it("est faux", () => expect(hasDeposit()).toBe(false));
    });
    describe("avec acompte", () => {
      useDeposit(25);
      it("est vrai", () => expect(hasDeposit()).toBe(true));
    });
  });

  it.each([-1, 101, 12.5, Number.NaN])("buildOffer refuse un acompte de %s %", (depositPercent) => {
    expect(() => buildOffer({ ...withContact({}), depositPercent })).toThrow(/config\/offer\.json.*depositPercent/);
  });

  it.each([0, 1, 25, 100])("buildOffer accepte un acompte de %s %", (depositPercent) => {
    expect(buildOffer({ ...withContact({}), depositPercent }).depositPercent).toBe(depositPercent);
  });
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

  it("trims the e-mail address: it is the recipient of the contact form", () => {
    expect(buildOffer(withContact({ email: "  contact@example.test \t" })).contact.email).toBe("contact@example.test");
  });

  it("trims the WhatsApp number and accepts only the international format, or none", () => {
    expect(buildOffer(withContact({ whatsapp: "  +33 6 00 00 00 03 " })).contact.whatsapp).toBe("+33 6 00 00 00 03");
    expect(buildOffer(withContact({ whatsapp: "  " })).contact.whatsapp).toBe("");
    for (const number of ["06 00 00 00 03", "+33 6", "+abc def ghij"]) {
      expect(() => buildOffer(withContact({ whatsapp: number })), number).toThrow(/config\/offer\.json.*WhatsApp/);
    }
  });
});

describe("whatsappHref", () => {
  it("keeps the digits only after wa.me", () => {
    expect(whatsappHref("+33 6 00 00 00 03")).toBe("https://wa.me/33600000003");
  });
});

describe("contactLinks", () => {
  const contact = {
    phones: [{ name: "Ana", number: "06 00 00 00 01" }],
    phone: "06 00 00 00 01",
    email: "bonjour@example.test",
    whatsapp: "+33 6 00 00 00 03",
    social: ["https://www.instagram.com/photomaton_test/", "https://exemple.fr/page"],
  };

  it("never gives the e-mail address, and marks Instagram and WhatsApp with their icon", () => {
    expect(contactLinks(contact, ({ name }) => `Appeler ${name}`)).toEqual([
      { href: "tel:0600000001", label: "Appeler Ana" },
      { href: "https://wa.me/33600000003", label: "WhatsApp", name: "Nous écrire sur WhatsApp", icon: "whatsapp" },
      { href: "https://www.instagram.com/photomaton_test/", label: "@photomaton_test", name: "@photomaton_test sur Instagram", icon: "instagram" },
      { href: "https://exemple.fr/page", label: "exemple.fr", name: "exemple.fr" },
    ]);
  });

  it("gives no WhatsApp link without a number", () => {
    expect(contactLinks({ ...contact, whatsapp: "" }, () => "").map(({ icon }) => icon)).toEqual([undefined, "instagram", undefined]);
  });
});

describe("buildOffer, zone", () => {
  const withBorder = (border: { name: string; department: string }[]): OfferConfig => ({
    ...withContact({}),
    zone: { border },
  });
  const commune = (name: string) => ({ name, department: "00" });

  it("refuses a border of fewer than three communes", () => {
    expect(() => buildOffer(withBorder([commune("A"), commune("B")]))).toThrow(/config\/offer\.json.*commune/);
  });

  it("refuses a border commune without a name or a department", () => {
    const ok = [commune("A"), commune("B"), commune("C")];
    for (const bad of [{ name: " ", department: "13" }, { name: "D", department: "" }]) {
      expect(() => buildOffer(withBorder([...ok, bad]))).toThrow(/config\/offer\.json.*zone\.border/);
    }
  });

  it("keeps the border in order", () => {
    const border = [commune("A"), commune("B"), commune("C")];
    expect(buildOffer(withBorder(border)).zone.border).toEqual(border);
  });
});
