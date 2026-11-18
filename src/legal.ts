/**
 * L'identité légale de l'éditeur du site et vendeur des prestations, d'après l'extrait Kbis du 30 octobre 2026 et la
 * synthèse de la formalité de création (guichet unique) : une entreprise individuelle en micro-entreprise, en franchise
 * en base de TVA. Les pages légales la lisent ici ; à mettre à jour si l'adresse, la forme de l'entreprise ou son
 * régime de TVA change.
 */
export const BUSINESS = {
  tradeName: "Brotobooth",
  entrepreneur: "Nicolas Raze",
  registration: "RCS Toulon 132 103 151",
  siret: "132 103 151 00016",
  address: "18 rue de l'Aube, 83330 Le Castellet",
  vat: "TVA non applicable, art. 293 B du CGI",
} as const;

/**
 * Le médiateur de la consommation dont relève Brotobooth (adhésion du 19 novembre 2026), que les CGV doivent nommer avec
 * son adresse postale et celle de son site (art. L616-1 et R616-1 du Code de la consommation). Coordonnées lues sur
 * cm2c.net le 19 novembre 2026 ; à mettre à jour si l'adhésion change de médiateur ou si celui-ci déménage.
 */
export const MEDIATOR = {
  name: "Centre de la médiation de la consommation de conciliateurs de justice (CM2C)",
  address: "49 rue de Ponthieu, 75008 Paris",
  website: "https://www.cm2c.net",
} as const;
