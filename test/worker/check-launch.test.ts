import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { findLaunchBlockers, parseJsonc, siteKeyFrom } from "../../scripts/check-launch.mjs";
import { buildOffer, offer as realOffer, type Offer } from "../../worker/offer";

/** Le contrôle d'avant publication (spec, sections 13 et 14) : il refuse tant qu'un contenu manque ou qu'un réglage d'essai reste. */

const REAL_DATABASE_ID = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const ZERO_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const DRAFT_COMMENT = "<!-- Brouillon à faire valider par un professionnel avant la mise en ligne. -->";

// Construite comme le contrôle lit `config/offer.json` : chaque formule nommée par sa borne et ses tirages.
const completeOffer: Offer = buildOffer({
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
  booths: [{ id: "borne", name: "La borne", includes: ["Un fond au choix"] }],
  plans: [
    { id: "borne-100", booth: "borne", prints: 100 },
    { id: "borne-300", booth: "borne", prints: 300 },
  ],
  tiers: [
    { id: "normal", name: "Prix normal", refillCents: 10_000, prices: { "borne-100": 90_000, "borne-300": 120_000 } },
  ],
});
const draftOffer: Offer = { ...completeOffer, draft: true, contact: { phone: "", email: "", social: [] } };

const complete = {
  offer: completeOffer,
  legalPages: {
    "src/pages/cgv.astro": '<Fact value="30 %" /> du prix, taxes : <Fact value={vat} />.',
    "src/pages/confidentialite.astro": "Écrivez-nous.",
  },
  databaseId: REAL_DATABASE_ID,
  vars: { BASE_URL: "https://brotobooth.fr" } as Record<string, string>,
  siteKey: "cle-publique-de-test",
  realPaymentWired: true,
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

  it("signale chaque prix à 0 € d'un palier, par son nom", () => {
    const [normal] = completeOffer.tiers;
    const tiers = [{ ...normal, prices: { "borne-100": 0, "borne-300": 0 } }];
    const blockers = findLaunchBlockers({ ...complete, offer: { ...completeOffer, tiers } });
    expect(blockers).toEqual([
      "Le palier « Prix normal » : le prix de « La borne · 100 tirages » est encore à 0 € dans config/offer.json.",
      "Le palier « Prix normal » : le prix de « La borne · 300 tirages » est encore à 0 € dans config/offer.json.",
    ]);
  });

  it("signale un tarif de recharge à 0 €", () => {
    const tiers = [{ ...completeOffer.tiers[0], refillCents: 0 }];
    expect(findLaunchBlockers({ ...complete, offer: { ...completeOffer, tiers } })).toEqual([
      "Le palier « Prix normal » : le tarif de la recharge est encore à 0 € dans config/offer.json.",
    ]);
  });

  it("ne bloque pas sur l'offre réelle", () => {
    const blockers = findLaunchBlockers({ ...complete, offer: { ...realOffer, draft: false, contact: completeOffer.contact } });
    expect(blockers.filter((blocker) => blocker.includes("0 €"))).toEqual([]);
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

  it("refuse une clé publique Turnstile absente ou vide : toutes les demandes seraient prises pour des robots", () => {
    for (const siteKey of ["", "  ", "\n"]) {
      expect(findLaunchBlockers({ ...complete, siteKey }), JSON.stringify(siteKey)).toEqual([expect.stringMatching(/anti-robots.*PUBLIC_TURNSTILE_SITE_KEY/)]);
    }
  });

  it("ne contrôle la clé et le paiement réel que lorsque l'appelant les fournit", () => {
    const { siteKey, realPaymentWired, ...withoutThem } = complete;
    expect(findLaunchBlockers(withoutThem)).toEqual([]);
  });

  it("bloque tant que le paiement réel de l'acompte n'est pas branché", () => {
    expect(findLaunchBlockers({ ...complete, realPaymentWired: false })).toEqual(["Le paiement réel de l'acompte n'est pas encore branché."]);
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
      offer: { ...draftOffer, tiers: [{ ...completeOffer.tiers[0], refillCents: 0 }] },
      legalPages: { "src/pages/cgv.astro": `[À compléter] ${DRAFT_COMMENT}` },
      databaseId: ZERO_DATABASE_ID,
      vars: { PAYMENT_MODE: "simulated", FAKE_GATEWAYS: "1" },
      siteKey: "",
      realPaymentWired: false,
    });
    expect(blockers.length).toBeGreaterThanOrEqual(10);
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

describe("siteKeyFrom", () => {
  const NAME = "PUBLIC_TURNSTILE_SITE_KEY";
  const key = (file: string, processEnv: Record<string, string> = {}) => siteKeyFrom(processEnv, file, parseEnv);

  it("lit la clé comme la construction (Vite), sans guillemets ni espaces", () => {
    const file = `# la clé du widget
PUBLIC_OTHER=non
export ${NAME} = "cle-entre-guillemets"
`;
    expect(key(file)).toBe("cle-entre-guillemets");
    expect(key(`${NAME}=abc\r\n`)).toBe("abc");
    expect(key(`${NAME}='abc'`)).toBe("abc");
  });

  // `parseEnv` retire le commentaire de fin de ligne, comme la construction : « NOM= # à compléter » est une clé vide.
  it("ignore un commentaire en fin de ligne", () => {
    expect(key(`${NAME}= # à compléter`)).toBe("");
    expect(key(`${NAME}=0x4AAAAAAA # clé de production`)).toBe("0x4AAAAAAA");
    expect(key(`${NAME}="0x4AAAAAAA" # clé de production`)).toBe("0x4AAAAAAA");
  });

  it("refuse la publication quand la clé n'est qu'un commentaire, et la laisse passer quand elle est écrite", () => {
    expect(findLaunchBlockers({ ...complete, siteKey: key(`${NAME}=0x4AAAAAAA # clé de production`) })).toEqual([]);
    expect(findLaunchBlockers({ ...complete, siteKey: key(`${NAME}= # à compléter`) })).toEqual([
      expect.stringMatching(/anti-robots.*PUBLIC_TURNSTILE_SITE_KEY/),
    ]);
  });

  it("donne une clé vide pour une ligne vide, une variable absente ou mise en commentaire", () => {
    for (const file of [`${NAME}=\n`, `# ${NAME}=abc`, `X${NAME}=abc`, ""]) expect(key(file), file).toBe("");
  });

  it("laisse une variable de l'environnement, même vide, l'emporter sur le fichier", () => {
    expect(key(`${NAME}=du-fichier`, { [NAME]: "de-l-environnement" })).toBe("de-l-environnement");
    expect(key(`${NAME}=du-fichier`, { [NAME]: "" })).toBe("");
  });
});
