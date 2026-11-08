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
import { offer, planById } from "../../worker/offer";

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
  it("porte les règles de réservation du plan", () => {
    expect(offer).toMatchObject({
      reviewHours: 72, paymentHours: 72,
      minLeadDays: 7, horizonMonths: 24, reminderHourParis: 9,
    });
  });
});
