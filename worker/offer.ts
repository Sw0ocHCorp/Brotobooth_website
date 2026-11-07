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
