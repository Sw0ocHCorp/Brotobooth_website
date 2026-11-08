import { describe, expect, it } from "vitest";
import { findLaunchBlockers, parseJsonc } from "../../scripts/check-launch.mjs";
import type { Offer } from "../../worker/offer";

/** Le contrôle d'avant publication (spec, sections 13 et 14) : il refuse tant qu'un contenu manque ou qu'un réglage d'essai reste. */

const REAL_DATABASE_ID = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const ZERO_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const DRAFT_COMMENT = "<!-- Brouillon à faire valider par un professionnel avant la mise en ligne. -->";

const completeOffer: Offer = {
  draft: false,
  depositPercent: 30,
  reviewHours: 72,
  paymentHours: 72,
  minLeadDays: 7,
  horizonMonths: 24,
  maxActivePerEmail: 2,
  maxPerIpPer24h: 5,
  reminderHourParis: 9,
  termsVersion: "2026-11-07",
  eventTypes: ["Mariage"],
  contact: { phone: "06 12 34 56 78", email: "contact@example.test", social: [] },
  plans: [
    { id: "formule-1", name: "Formule 1", priceCents: 90_000, includes: ["La borne"] },
    { id: "formule-2", name: "Formule 2", priceCents: 120_000, includes: ["La borne", "Un fond au choix"] },
  ],
};
const draftOffer: Offer = { ...completeOffer, draft: true, contact: { phone: "", email: "", social: [] } };

const complete = {
  offer: completeOffer,
  legalPages: {
    "src/pages/cgv.astro": '<Fact value="30 %" /> du prix, taxes : <Fact value={vat} />.',
    "src/pages/confidentialite.astro": "Écrivez-nous.",
  },
  databaseId: REAL_DATABASE_ID,
  vars: { BASE_URL: "https://brotobooth.fr" } as Record<string, string>,
};

describe("findLaunchBlockers", () => {
  it("laisse passer un contenu complet", () => {
    expect(findLaunchBlockers(complete)).toEqual([]);
  });

  it("bloque tant que les contenus manquent", () => {
    const blockers = findLaunchBlockers({
      ...complete,
      offer: draftOffer,
      legalPages: { "src/pages/cgv.astro": "Médiation : [À compléter]" },
      databaseId: ZERO_DATABASE_ID,
    });
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/provisoire/),
        expect.stringMatching(/téléphone/),
        expect.stringMatching(/e-mail/),
        expect.stringMatching(/cgv/),
        expect.stringMatching(/D1/),
      ]),
    );
    expect(blockers).toHaveLength(5);
  });

  it("signale chaque formule à 0 €, par son nom", () => {
    const plans = [
      { ...completeOffer.plans[0], priceCents: 0 },
      completeOffer.plans[1],
      { id: "formule-3", name: "Formule 3", priceCents: 0, includes: [] },
    ];
    const blockers = findLaunchBlockers({ ...complete, offer: { ...completeOffer, plans } });
    expect(blockers).toEqual([expect.stringContaining("Formule 1"), expect.stringContaining("Formule 3")]);
    expect(blockers.every((blocker) => blocker.includes("0 €"))).toBe(true);
  });

  it("refuse de publier avec le paiement simulé ou les fausses passerelles", () => {
    expect(findLaunchBlockers({ ...complete, vars: { PAYMENT_MODE: "simulated" } })).toEqual([expect.stringContaining("PAYMENT_MODE")]);
    expect(findLaunchBlockers({ ...complete, vars: { FAKE_GATEWAYS: "1" } })).toEqual([expect.stringContaining("FAKE_GATEWAYS")]);
    expect(findLaunchBlockers({ ...complete, vars: { PAYMENT_MODE: "simulated", FAKE_GATEWAYS: "1" } })).toHaveLength(2);
  });

  it("refuse un téléphone ou une adresse e-mail faits d'espaces", () => {
    const contact = { phone: "  ", email: "\t", social: [] };
    const blockers = findLaunchBlockers({ ...complete, offer: { ...completeOffer, contact } });
    expect(blockers).toEqual([expect.stringMatching(/téléphone/), expect.stringMatching(/e-mail/)]);
  });

  it("refuse une adresse de base D1 vide ou nulle", () => {
    for (const databaseId of [ZERO_DATABASE_ID, ""]) {
      expect(findLaunchBlockers({ ...complete, databaseId }), databaseId).toEqual([expect.stringMatching(/D1/)]);
    }
  });

  describe("les pages à compléter", () => {
    it("reconnaît le marqueur écrit tel quel", () => {
      const blockers = findLaunchBlockers({ ...complete, legalPages: { "src/pages/cgv.astro": "Médiation : [À compléter]." } });
      expect(blockers).toEqual([expect.stringContaining("src/pages/cgv.astro")]);
    });

    it("reconnaît un fait posé sans valeur, que la page rendrait avec le marqueur", () => {
      for (const unfilled of ["<Fact />", "<Fact/>", '<Fact href="tel:0612345678" />', "<Fact\n/>"]) {
        const blockers = findLaunchBlockers({ ...complete, legalPages: { "src/pages/mentions-legales.astro": `<dd>${unfilled}</dd>` } });
        expect(blockers, unfilled).toEqual([expect.stringContaining("mentions-legales")]);
      }
    });

    it("laisse passer un fait renseigné", () => {
      for (const filled of ['<Fact value="Lyon" />', "<Fact value={email} href={`mailto:${email}`} />", '<Fact href="tel:0612345678" value={phone} />']) {
        expect(findLaunchBlockers({ ...complete, legalPages: { "src/pages/cgv.astro": filled } }), filled).toEqual([]);
      }
    });

    it("nomme chaque page concernée, une phrase par page", () => {
      const legalPages = { "src/pages/cgv.astro": "[À compléter]", "src/pages/confidentialite.astro": "<Fact />", "src/pages/index.astro": "Bonjour" };
      expect(findLaunchBlockers({ ...complete, legalPages })).toEqual([expect.stringContaining("cgv"), expect.stringContaining("confidentialite")]);
    });

    it("bloque tant que le commentaire de brouillon des pages légales est là, en une seule phrase", () => {
      const legalPages = { "src/layouts/Legal.astro": `const DRAFT = "${DRAFT_COMMENT}";`, "src/other/Legal.astro": DRAFT_COMMENT };
      expect(findLaunchBlockers({ ...complete, legalPages })).toEqual([expect.stringMatching(/brouillon/)]);
    });
  });

  it("écrit chaque blocage en une phrase complète, sur une seule ligne", () => {
    const blockers = findLaunchBlockers({
      offer: { ...draftOffer, plans: [{ id: "formule-1", name: "Formule 1", priceCents: 0, includes: [] }] },
      legalPages: { "src/pages/cgv.astro": `[À compléter] ${DRAFT_COMMENT}` },
      databaseId: ZERO_DATABASE_ID,
      vars: { PAYMENT_MODE: "simulated", FAKE_GATEWAYS: "1" },
    });
    expect(blockers.length).toBeGreaterThanOrEqual(8);
    for (const blocker of blockers) {
      expect(blocker, blocker).toMatch(/^[A-ZÀ-Ý«].*\.$/);
      expect(blocker, blocker).not.toContain("\n");
    }
    expect(new Set(blockers).size).toBe(blockers.length);
  });
});

describe("parseJsonc", () => {
  it("lit le JSON avec commentaires et virgules finales, comme le fait wrangler", () => {
    const text = `{
      // la base
      "d1_databases": [{ "database_id": "http://exemple.test/a//b", /* garde les // des chaînes */ },],
      "vars": { "BASE_URL": "https://brotobooth.fr", }, // fin
    }`;
    expect(parseJsonc(text)).toEqual({
      d1_databases: [{ database_id: "http://exemple.test/a//b" }],
      vars: { BASE_URL: "https://brotobooth.fr" },
    });
  });
});
