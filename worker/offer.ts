import offerJson from "../config/offer.json";

export interface Plan {
  id: string;
  name: string;
  priceCents: number;
  includes: string[];
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
  plans: Plan[];
}

export const offer: Offer = offerJson;

export const planById = (id: string): Plan | undefined =>
  offer.plans.find(plan => plan.id === id);

/** `true` si l'offre donne un moyen de nous joindre : une phrase qui invite à le faire n'est écrite qu'à cette condition. */
export const hasContact = (): boolean => Boolean(offer.contact.phone || offer.contact.email);

/** « 30 % », une fois l'offre définitive ; `undefined` tant qu'elle est provisoire et que le pourcentage peut encore changer. */
export const finalDepositPercent = (): string | undefined => (offer.draft ? undefined : `${offer.depositPercent}\u00a0%`);
