// L'attribut de type laisse aussi Node (`scripts/check-launch.mjs`) et Playwright (`e2e/seed.ts`) lire ce module.
import offerJson from "../config/offer.json" with { type: "json" };

/** Une borne. Sans aucune formule, elle est à venir : le site la montre sans qu'on puisse la choisir. */
export interface Booth {
  id: string;
  name: string;
  includes: string[];
}

/** Une formule : une borne et un nombre de tirages. Son prix dépend du palier en cours (`priceOf`). */
export interface Plan {
  id: string;
  /** « BrotoBooth · 200 tirages », déduit de la borne et des tirages (`buildOffer`), jamais écrit dans `config/offer.json`. */
  name: string;
  booth: string;
  prints: number;
}

/** Un palier de prix. Seul le dernier, sans `places`, est illimité : c'est le prix normal. */
export interface Tier {
  /** La clé enregistrée dans chaque réservation : elle ne change plus une fois le site en ligne. */
  id: string;
  /** Montré au propriétaire seulement. */
  name: string;
  places?: number;
  refillCents: number;
  /** Le prix en centimes de chaque formule, par identifiant de formule. */
  prices: Record<string, number>;
}

/** Un fondateur qu'on peut appeler. */
export interface Phone {
  name: string;
  number: string;
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
  contact: {
    phones: Phone[];
    /** Calculé par `buildOffer` : le numéro du premier fondateur, ou `""`. C'est celui que citent les phrases du site et les e-mails. */
    phone: string;
    email: string;
    social: string[];
  };
  booths: Booth[];
  plans: Plan[];
  tiers: Tier[];
}

/** L'offre telle que `config/offer.json` l'écrit : les formules sans leur nom. */
export type OfferConfig = Omit<Offer, "plans" | "contact"> & {
  plans: Omit<Plan, "name">[];
  contact: Omit<Offer["contact"], "phone">;
};

/** Le lien `tel:` d'un numéro écrit à la française : seuls les chiffres et le `+` restent. */
export const telHref = (number: string): string => `tel:${number.replace(/[^\d+]/g, "")}`;

/** Le domaine d'un lien, sans `www.`. */
const domainOf = (url: URL): string => url.hostname.replace(/^www\./, "");

/** Le compte d'un lien vers un profil Instagram (`instagram.com/compte`, avec ou sans `www.`, `/` final ou paramètres) ; sinon `undefined`. */
const instagramAccount = (url: URL): string | undefined =>
  domainOf(url) === "instagram.com" ? /^\/([\w.]+)\/?$/.exec(url.pathname)?.[1] : undefined;

/** Un lien de `contact.social` écrit court : « @compte » pour un compte Instagram, sinon son domaine (« exemple.fr »). */
export function socialLabel(link: string): string {
  const url = new URL(link);
  const account = instagramAccount(url);
  return account ? `@${account}` : domainOf(url);
}

/** Le nom accessible d'un lien de `contact.social` : son libellé court, avec le réseau pour un compte Instagram (« @compte sur Instagram »). */
export const socialName = (link: string): string =>
  instagramAccount(new URL(link)) ? `${socialLabel(link)} sur Instagram` : socialLabel(link);

/** Un moyen de nous joindre : sa cible, son texte, et pour un réseau son nom accessible (`aria-label`), qui peut en dire plus. */
export interface ContactLink {
  href: string;
  label: string;
  name?: string;
}

/**
 * Les moyens de nous joindre que `contact` renseigne, dans l'ordre : chaque fondateur (écrit par `phoneLabel`), l'adresse
 * e-mail, puis chaque réseau écrit court. Un moyen vide n'en donne aucun. La section « Contact » et le pied de page les
 * écrivent ainsi.
 */
export const contactLinks = (contact: Offer["contact"], phoneLabel: (phone: Phone) => string): ContactLink[] => [
  ...contact.phones.map((phone) => ({ href: telHref(phone.number), label: phoneLabel(phone) })),
  ...(contact.email ? [{ href: `mailto:${contact.email}`, label: contact.email }] : []),
  ...contact.social.map((url) => ({ href: url, label: socialLabel(url), name: socialName(url) })),
];

const isCents = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;

/** Le libellé de la recharge, le même pour le client et le propriétaire : site, e-mails, agenda et administration. */
export const REFILL_LABEL = "Recharge de 100 tirages";

/** Refuse des paliers mal formés, pour qu'une faute dans `config/offer.json` casse les tests au lieu du site. */
function checkTiers({ plans, tiers }: OfferConfig): void {
  const fail = (reason: string): never => {
    throw new Error(`config/offer.json : ${reason}`);
  };
  if (tiers.length === 0) fail("l'offre n'a aucun palier");
  const ids = new Set<string>();
  tiers.forEach((tier, index) => {
    if (ids.has(tier.id)) fail(`le palier « ${tier.id} » apparaît deux fois`);
    ids.add(tier.id);
    if (!isCents(tier.refillCents)) fail(`le palier « ${tier.id} » a un prix de recharge qui n'est pas un montant en centimes entier, positif ou nul`);
    for (const plan of plans) {
      if (!(plan.id in tier.prices)) fail(`le palier « ${tier.id} » n'a pas de prix pour la formule « ${plan.id} »`);
    }
    for (const [planId, price] of Object.entries(tier.prices)) {
      if (!isCents(price)) fail(`le palier « ${tier.id} » a un prix pour la formule « ${planId} » qui n'est pas un montant en centimes entier, positif ou nul`);
      if (!plans.some(({ id }) => id === planId)) fail(`le palier « ${tier.id} » a un prix pour la formule « ${planId} », qui n'existe pas`);
    }
    if (index < tiers.length - 1) {
      if (!Number.isInteger(tier.places) || tier.places! <= 0) fail(`le palier « ${tier.id} » doit avoir un nombre de places entier, supérieur à 0`);
    } else if (tier.places !== undefined) {
      fail(`le dernier palier « ${tier.id} » ne doit pas avoir de places : il est illimité`);
    }
  });
}

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
  checkTiers(config);
  for (const { name, number } of config.contact.phones) {
    if (!name.trim() || !number.trim()) throw new Error("config/offer.json : chaque numéro de contact doit avoir un prénom et un numéro");
  }
  return { ...config, plans, contact: { ...config.contact, phone: config.contact.phones[0]?.number ?? "" } };
}

export const offer: Offer = buildOffer(offerJson);

export const planById = (id: string): Plan | undefined =>
  offer.plans.find(plan => plan.id === id);

/** Les formules de la borne `booth`, dans l'ordre de l'offre. */
export const plansOf = (from: Offer, booth: string): Plan[] => from.plans.filter((plan) => plan.booth === booth);

/** `true` si la borne a au moins une formule ; sinon elle est à venir. */
export const isBookable = (from: Offer, booth: string): boolean => plansOf(from, booth).length > 0;

/** `true` si l'offre donne un moyen de nous joindre : une phrase qui invite à le faire n'est écrite qu'à cette condition. */
export const hasContact = (): boolean => Boolean(offer.contact.phone || offer.contact.email);

/** « 30 % », une fois l'offre définitive ; `undefined` tant qu'elle est provisoire et que le pourcentage peut encore changer. */
export const finalDepositPercent = (): string | undefined => (offer.draft ? undefined : `${offer.depositPercent}\u00a0%`);

/** Le palier en cours, avec ses places restantes (`null` s'il est illimité) ; `launch` vaut `true` tant qu'il est limité. */
export interface CurrentTier {
  tier: Tier;
  remaining: number | null;
  launch: boolean;
}

/** Le palier en cours : le premier qui n'est pas plein, d'après les réservations déjà prises par palier. */
export function currentTier(from: Offer, taken: Readonly<Record<string, number>>): CurrentTier {
  for (const tier of from.tiers) {
    if (tier.places === undefined) break;
    const remaining = tier.places - (taken[tier.id] ?? 0);
    if (remaining > 0) return { tier, remaining, launch: true };
  }
  return { tier: normalTier(from), remaining: null, launch: false };
}

/** Le prix normal : celui du dernier palier. */
export const normalTier = (from: Offer): Tier => from.tiers[from.tiers.length - 1];

export const priceOf = (tier: Tier, planId: string): number => tier.prices[planId];

export const tierById = (id: string): Tier | undefined => offer.tiers.find((tier) => tier.id === id);

/** Le corps de `GET /api/prices` : le palier en cours, et pour chaque formule comme pour la recharge, son prix et son prix normal. */
export interface PricesBody {
  tier: string;
  launch: boolean;
  remaining: number | null;
  refillCents: number;
  normalRefillCents: number;
  plans: Record<string, { priceCents: number; normalCents: number }>;
}

export function pricesBody(from: Offer, current: CurrentTier): PricesBody {
  const normal = normalTier(from);
  return {
    tier: current.tier.id,
    launch: current.launch,
    remaining: current.remaining,
    refillCents: current.tier.refillCents,
    normalRefillCents: normal.refillCents,
    plans: Object.fromEntries(
      from.plans.map((plan) => [plan.id, { priceCents: priceOf(current.tier, plan.id), normalCents: priceOf(normal, plan.id) }]),
    ),
  };
}
