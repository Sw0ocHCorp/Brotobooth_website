// L'attribut de type laisse aussi Node (`scripts/check-launch.mjs`) et Playwright (`e2e/seed.ts`) lire ce module.
import offerJson from "../config/offer.json" with { type: "json" };

/** Une borne. Sans aucune formule, elle est à venir : le site la montre sans qu'on puisse la choisir. */
export interface Booth {
  id: string;
  name: string;
  includes: string[];
}

/** Une formule : une borne et un nombre de tirages, à un prix. */
export interface Plan {
  id: string;
  /** « BrotoBooth · 200 tirages », déduit de la borne et des tirages (`buildOffer`), jamais écrit dans `config/offer.json`. */
  name: string;
  booth: string;
  prints: number;
  priceCents: number;
}

export interface Offer {
  /** `true` tant que les contenus sont provisoires : la publication est refusée. */
  draft: boolean;
  depositPercent: number;
  reviewHours: number;
  paymentHours: number;
  minLeadDays: number;
  horizonMonths: number;
  maxActivePerEmail: number;
  maxPerIpPer24h: number;
  reminderHourParis: number;
  termsVersion: string;
  eventTypes: string[];
  contact: { phone: string; email: string; social: string[] };
  booths: Booth[];
  plans: Plan[];
}

/** L'offre telle que `config/offer.json` l'écrit : les formules sans leur nom. */
export type OfferConfig = Omit<Offer, "plans"> & { plans: Omit<Plan, "name">[] };

/**
 * L'offre complète : chaque formule reçoit son nom, celui de sa borne suivi de ses tirages. Une formule dont la borne
 * n'existe pas arrête tout, pour qu'une faute de frappe dans `config/offer.json` casse les tests au lieu d'afficher une
 * formule orpheline.
 */
export function buildOffer(config: OfferConfig): Offer {
  const plans = config.plans.map((plan) => {
    const booth = config.booths.find(({ id }) => id === plan.booth);
    if (!booth) throw new Error(`config/offer.json : la formule « ${plan.id} » désigne la borne « ${plan.booth} », qui n'existe pas`);
    return { ...plan, name: `${booth.name} · ${plan.prints} tirages` };
  });
  return { ...config, plans };
}

export const offer: Offer = buildOffer(offerJson);

export const planById = (id: string): Plan | undefined =>
  offer.plans.find(plan => plan.id === id);

/** Les formules de la borne `booth`, dans l'ordre de l'offre. */
export const plansOf = ({ plans }: Offer, booth: string): Plan[] => plans.filter((plan) => plan.booth === booth);

/** `true` si la borne a au moins une formule ; sinon elle est à venir. */
export const isBookable = (from: Offer, booth: string): boolean => plansOf(from, booth).length > 0;

/** `true` si l'offre donne un moyen de nous joindre : une phrase qui invite à le faire n'est écrite qu'à cette condition. */
export const hasContact = (): boolean => Boolean(offer.contact.phone || offer.contact.email);

/** « 30 % », une fois l'offre définitive ; `undefined` tant qu'elle est provisoire et que le pourcentage peut encore changer. */
export const finalDepositPercent = (): string | undefined => (offer.draft ? undefined : `${offer.depositPercent} %`);
