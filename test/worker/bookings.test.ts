import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  addDays,
  bookingWindow,
  checkDate,
  depositCents,
  nextStatus,
  parisHour,
  parisInstant,
  parisToday,
  parisWeekday,
  type BookingAction,
  type BookingStatus,
} from "../../worker/bookings";
import { buildOffer, currentTier, isBookable, normalTier, offer, planById, plansOf, priceOf, pricesBody, socialLabel, socialName, telHref, type OfferConfig, type Tier } from "../../worker/offer";

describe("transitions de statut", () => {
  const transitions: [BookingStatus, BookingAction, BookingStatus | null][] = [
    ["pending_review", "validate", "awaiting_deposit"], ["pending_review", "refuse", "refused"],
    ["pending_review", "expire", "expired"], ["pending_review", "pay", null],
    ["awaiting_deposit", "pay", "confirmed"], ["awaiting_deposit", "expire", "expired"],
    ["awaiting_deposit", "cancel", "cancelled"], ["awaiting_deposit", "validate", null],
    ["confirmed", "cancel", "cancelled"], ["confirmed", "pay", null], ["confirmed", "expire", null],
    ["blocked", "cancel", "cancelled"], ["refused", "validate", null],
    ["expired", "pay", null], ["cancelled", "cancel", null],
  ];
  it.each(transitions)("%s + %s donne %s", (s, a, e) => expect(nextStatus(s, a)).toBe(e));

  it("ne sort jamais d'un état final", () => {
    const actions: BookingAction[] = ["validate", "refuse", "pay", "expire", "cancel"];
    for (const s of ["refused", "expired", "cancelled"] as const) {
      for (const a of actions) expect(nextStatus(s, a)).toBeNull();
    }
  });

  it("tient la date pour les quatre états actifs seulement", () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual(
      ["awaiting_deposit", "blocked", "confirmed", "pending_review"],
    );
  });
});

describe("jour et heure de Paris", () => {
  it("calcule le jour à Paris, pas en UTC", () => {
    expect(parisToday(new Date("2026-11-07T23:30:00Z"))).toBe("2026-11-08");
    expect(parisToday(new Date("2026-11-07T22:59:00Z"))).toBe("2026-11-07");
    expect(parisToday(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02");
  });
  it("donne l'heure de Paris selon la saison", () => {
    expect(parisHour(new Date("2026-11-07T08:00:00Z"))).toBe(9);
    expect(parisHour(new Date("2026-07-01T07:00:00Z"))).toBe(9);
    expect(parisHour(new Date("2026-11-07T23:30:00Z"))).toBe(0);
  });
  it("numérote le jour de la semaine à Paris, lundi = 1", () => {
    expect(parisWeekday(new Date("2026-11-09T08:00:00Z"))).toBe(1);
    expect(parisWeekday(new Date("2026-11-08T12:00:00Z"))).toBe(7);
    expect(parisWeekday(new Date("2026-11-08T23:30:00Z"))).toBe(1);
  });
  it("ajoute des jours en passant les fins de mois et d'année", () => {
    expect(addDays("2026-11-07", 7)).toBe("2026-11-14");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-11-07", -7)).toBe("2026-10-31");
  });
  it("place 9 h de Paris selon la saison", () => {
    expect(parisInstant("2026-11-07", 9).toISOString()).toBe("2026-11-07T08:00:00.000Z");
    expect(parisInstant("2026-07-01", 9).toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(parisInstant("2026-03-29", 9).toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(parisInstant("2026-10-25", 9).toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });
  it("place les heures avant le changement d'heure du même jour", () => {
    expect(parisInstant("2026-03-29", 0).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(parisInstant("2026-10-25", 0).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(parisInstant("2026-10-25", 1).toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });
});

describe("date de prestation", () => {
  it("applique le délai minimum et l'horizon en heure de Paris", () => {
    const now = new Date("2026-11-07T10:00:00Z");
    expect(checkDate("2026-11-13", now)).toBe("too_soon");
    expect(checkDate("2026-11-14", now)).toBe("ok");
    expect(checkDate("2028-11-07", now)).toBe("ok");
    expect(checkDate("2028-11-08", now)).toBe("too_far");
    expect(checkDate("2026-11-14", new Date("2026-11-07T23:30:00Z"))).toBe("too_soon");
  });
  it("donne la première et la dernière date réservables, d'après le jour de Paris", () => {
    expect(bookingWindow(new Date("2026-11-07T10:00:00Z"))).toEqual({ earliest: "2026-11-14", latest: "2028-11-07" });
    expect(bookingWindow(new Date("2026-11-07T23:30:00Z"))).toEqual({ earliest: "2026-11-15", latest: "2028-11-08" });
    expect(bookingWindow(new Date("2028-02-29T10:00:00Z"))).toEqual({ earliest: "2028-03-07", latest: "2030-02-28" });
  });
  it("refuse une date passée", () => {
    expect(checkDate("2026-11-06", new Date("2026-11-07T10:00:00Z"))).toBe("too_soon");
  });
  it("ramène l'horizon au dernier jour du mois quand le jour n'existe pas", () => {
    const leapDay = new Date("2028-02-29T10:00:00Z");
    expect(checkDate("2030-02-28", leapDay)).toBe("ok");
    expect(checkDate("2030-03-01", leapDay)).toBe("too_far");
  });
  it.each(["2026-02-30", "abc", "2026-13-01", "", "2026-1-01", "2026-11-07T10:00"])(
    "refuse la date %s",
    d => expect(checkDate(d, new Date("2026-11-07T10:00:00Z"))).toBe("invalid"),
  );
});

describe("acompte", () => {
  it("arrondit l'acompte à l'euro", () => {
    expect(depositCents(100000, 30)).toBe(30000);
    expect(depositCents(12345, 30)).toBe(3700);
    expect(depositCents(0, 30)).toBe(0);
  });
  it("arrondit à l'euro le plus proche, le demi-euro vers le haut", () => {
    expect(depositCents(12499, 30)).toBe(3700);
    expect(depositCents(12500, 30)).toBe(3800);
    expect(depositCents(125100, 30)).toBe(37500);
  });
});

describe("offre", () => {
  it("retrouve chaque formule par son identifiant", () => {
    for (const plan of offer.plans) expect(planById(plan.id)).toBe(plan);
    expect(planById("inconnue")).toBeUndefined();
  });
  // Les autres tests choisissent deux formules (`FIRST_PLAN`, `SECOND_PLAN`) : ce test dit pourquoi ils échouent si l'offre n'en a qu'une.
  it("propose au moins deux formules, chacune avec son identifiant et son nom", () => {
    expect(offer.plans.length).toBeGreaterThanOrEqual(2);
    expect(new Set(offer.plans.map((plan) => plan.id)).size).toBe(offer.plans.length);
    expect(new Set(offer.plans.map((plan) => plan.name)).size).toBe(offer.plans.length);
  });
  describe("les bornes et leurs formules", () => {
    // Une offre d'essai, pas celle du site : une borne réservable, et une autre encore sans formule.
    const config: OfferConfig = {
      ...offer,
      booths: [
        { id: "grande", name: "Grande borne", includes: ["Un fond au choix"] },
        { id: "petite", name: "Petite borne", includes: [] },
      ],
      plans: [
        { id: "grande-100", booth: "grande", prints: 100 },
        { id: "grande-300", booth: "grande", prints: 300 },
      ],
      tiers: [{ id: "normal", name: "Prix normal", refillCents: 1_000, prices: { "grande-100": 10_000, "grande-300": 20_000 } }],
    };
    const trial = buildOffer(config);

    it("nomme chaque formule par sa borne et son nombre de tirages, sans rien changer d'autre", () => {
      expect(trial.plans).toEqual([
        { id: "grande-100", name: "Grande borne · 100 tirages", booth: "grande", prints: 100 },
        { id: "grande-300", name: "Grande borne · 300 tirages", booth: "grande", prints: 300 },
      ]);
      expect(trial.booths).toEqual(config.booths);
      expect(trial.depositPercent).toBe(config.depositPercent);
    });

    it("donne les formules d'une borne, dans l'ordre de l'offre, et aucune à une borne à venir", () => {
      expect(plansOf(trial, "grande").map((plan) => plan.id)).toEqual(["grande-100", "grande-300"]);
      expect(plansOf(trial, "petite")).toEqual([]);
    });

    it("une borne n'est réservable qu'avec au moins une formule", () => {
      expect(isBookable(trial, "grande")).toBe(true);
      expect(isBookable(trial, "petite")).toBe(false);
    });

    // Une faute de frappe dans `config/offer.json` casse les tests au lieu d'afficher une formule sans borne.
    it("refuse une formule dont la borne n'existe pas, en nommant l'une et l'autre", () => {
      const orphan = { id: "geante-500", booth: "geante", prints: 500 };
      expect(() => buildOffer({ ...config, plans: [...config.plans, orphan] })).toThrow(/« geante-500 ».*« geante »/);
    });
  });


  describe("les paliers", () => {
    const tier = (id: string, places: number | undefined, a: number, b: number, refillCents = 1_000): Tier => ({
      id, name: id, ...(places === undefined ? {} : { places }), refillCents, prices: { a, b },
    });
    const t1 = tier("t1", 3, 100_00, 200_00, 500);
    const t2 = tier("t2", 2, 150_00, 250_00, 800);
    const last = tier("last", undefined, 200_00, 300_00);
    const config: OfferConfig = {
      ...offer,
      booths: [{ id: "x", name: "X", includes: [] }],
      plans: [{ id: "a", booth: "x", prints: 100 }, { id: "b", booth: "x", prints: 200 }],
      tiers: [t1, t2, last],
    };
    const trial = buildOffer(config);
    const refused = (tiers: Tier[]) => expect(() => buildOffer({ ...config, tiers })).toThrow(/config\/offer.json/);

    it("currentTier on an empty base is the first tier", () => {
      expect(currentTier(trial, {})).toEqual({ tier: t1, remaining: 3, launch: true });
    });
    it("currentTier skips full tiers", () => {
      expect(currentTier(trial, { t1: 3 })).toEqual({ tier: t2, remaining: 2, launch: true });
    });
    it("currentTier counts the last place", () => {
      expect(currentTier(trial, { t1: 2 })).toEqual({ tier: t1, remaining: 1, launch: true });
    });
    it("currentTier ends on the unlimited tier", () => {
      expect(currentTier(trial, { t1: 3, t2: 2 })).toEqual({ tier: last, remaining: null, launch: false });
    });
    it("currentTier ignores unknown tier ids", () => {
      expect(currentTier(trial, { inconnu: 99 }).tier).toBe(t1);
    });
    it("normalTier is the last tier and priceOf reads its price", () => {
      expect(normalTier(trial)).toBe(last);
      expect(priceOf(last, "b")).toBe(300_00);
    });
    it("pricesBody gives tier and normal prices", () => {
      expect(pricesBody(trial, currentTier(trial, {}))).toEqual({
        tier: "t1", launch: true, remaining: 3, refillCents: 500, normalRefillCents: 1_000,
        plans: { a: { priceCents: 100_00, normalCents: 200_00 }, b: { priceCents: 200_00, normalCents: 300_00 } },
      });
    });
    it("buildOffer refuses an offer without tiers", () => refused([]));
    it("buildOffer refuses duplicate tier ids", () => refused([t1, { ...t2, id: "t1" }, last]));
    it("buildOffer refuses a tier missing a plan price", () => refused([t1, { ...t2, prices: { a: 1 } }, last]));
    it("buildOffer refuses a price for an unknown plan", () => refused([t1, t2, { ...last, prices: { ...last.prices, z: 1 } }]));
    it("buildOffer refuses a non-final tier without places", () => refused([{ ...t1, places: undefined }, t2, last]));
    it("buildOffer refuses places of 0", () => refused([{ ...t1, places: 0 }, t2, last]));
    it("buildOffer refuses non-integer places", () => refused([{ ...t1, places: 1.5 }, t2, last]));
    it("buildOffer refuses places on the last tier", () => refused([t1, t2, { ...last, places: 5 }]));
    it.each([-1, 1.5, Number.NaN])("buildOffer refuses a price of %s", (price) => refused([t1, t2, { ...last, prices: { a: price, b: 1 } }]));
    it.each([-1, 2.5])("buildOffer refuses a refill price of %s", (refillCents) => refused([t1, { ...t2, refillCents }, last]));
  });

  it("porte les règles de réservation du plan", () => {
    expect(offer).toMatchObject({
      reviewHours: 72, paymentHours: 72,
      minLeadDays: 7, horizonMonths: 24, reminderHourParis: 9,
    });
  });
});

describe("contact phones", () => {
  const config = (phones: { name: string; number: string }[]): OfferConfig => ({
    ...offer,
    plans: offer.plans.map(({ name: _name, ...plan }) => plan),
    contact: { phones, email: "", whatsapp: "", social: [] },
  });

  it("contact.phone is the first number, or empty", () => {
    const two = buildOffer(config([{ name: "Ana", number: "06 00 00 00 01" }, { name: "Ben", number: "06 00 00 00 02" }]));
    expect(two.contact.phone).toBe("06 00 00 00 01");
    expect(two.contact.phones).toHaveLength(2);
    expect(buildOffer(config([])).contact.phone).toBe("");
  });

  it("buildOffer refuses a phone without a name", () => {
    expect(() => buildOffer(config([{ name: " ", number: "06 00 00 00 01" }]))).toThrow(/config\/offer.json/);
  });

  it("buildOffer refuses a name without a number", () => {
    expect(() => buildOffer(config([{ name: "Ana", number: "" }]))).toThrow(/config\/offer.json/);
  });

  it("telHref keeps digits and the plus sign", () => {
    expect(telHref("+33 6 12-34")).toBe("tel:+3361234");
  });
});

describe("social links", () => {
  it.each(["https://www.instagram.com/brotobooth/", "https://instagram.com/brotobooth", "https://www.instagram.com/brotobooth?igsh=abc"])(
    "socialLabel writes an Instagram profile %s as its account",
    (url) => expect(socialLabel(url)).toBe("@brotobooth"),
  );

  it.each([
    ["https://exemple.fr/page", "exemple.fr"],
    ["https://www.facebook.com/brotobooth", "facebook.com"],
    // Une publication, et non un compte : le domaine, comme pour tout autre lien.
    ["https://www.instagram.com/p/C0deX/", "instagram.com"],
  ])("socialLabel writes any other link %s as its domain", (url, label) => expect(socialLabel(url)).toBe(label));

  it("socialName also names the network of an Instagram account", () => {
    expect(socialName("https://www.instagram.com/brotobooth/")).toBe("@brotobooth sur Instagram");
    expect(socialName("https://exemple.fr/page")).toBe("exemple.fr");
  });
});
