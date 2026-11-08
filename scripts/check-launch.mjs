// Contrôle d'avant publication : refuse de publier tant qu'un contenu manque ou qu'un réglage d'essai reste.
//   node scripts/check-launch.mjs
// Liste ce qui bloque, une phrase par point, et sort avec le code 1 ; sans blocage, sort avec le code 0.
// `npm run deploy` le lance avant toute construction : il lit les fichiers sources, jamais `dist/`.

const ZERO_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
/** Le marqueur qu'un fait d'entreprise encore inconnu porte à l'écran (`Fact.astro`, seul fichier à l'écrire). */
const TODO_MARKER = "[À compléter]";
/** Un `<Fact>` sans `value` s'affiche avec le marqueur : il est à compléter même si la source ne l'écrit pas. */
const UNFILLED_FACT = /<Fact\b(?![^>]*\bvalue=)/;
/** Le commentaire HTML que `Legal.astro` écrit en tête de chaque page légale tant qu'un professionnel ne l'a pas validée. */
const DRAFT_COMMENT = "<!-- Brouillon";
/** Les réglages d'essai : leur seule présence dans `vars` suffit à refuser (le vrai paiement n'en demande aucun). */
const TRIAL_SETTINGS = {
  PAYMENT_MODE: "le paiement serait simulé et aucun acompte ne serait réellement encaissé",
  FAKE_GATEWAYS: "les e-mails et les messages Telegram ne partiraient pas, et l'anti-robots laisserait tout passer",
};

/** La variable que `astro build` lit pour poser la clé du widget (`src/pages/reserver.astro`). */
const SITE_KEY_NAME = "PUBLIC_TURNSTILE_SITE_KEY";

const isBlank = (text) => !text || text.trim() === "";

/**
 * Ce qui empêche de publier le site, une phrase française par point ; une liste vide veut dire « prêt ».
 * Fonction pure : le script la nourrit après avoir lu les fichiers (voir le bas de ce fichier).
 *
 * @param {object} input
 * @param {import("../worker/offer").Offer} input.offer `config/offer.json`
 * @param {Record<string, string>} input.legalPages le texte des fichiers sources, par chemin (`src/pages/cgv.astro`)
 * @param {string} input.databaseId le `database_id` de la base D1 dans `wrangler.jsonc`
 * @param {Record<string, string>} input.vars les `vars` de `wrangler.jsonc`
 * @param {string} [input.siteKey] la clé publique du widget anti-robots que la construction de la publication utilisera ; non contrôlée si elle n'est pas fournie
 * @param {boolean} [input.realPaymentWired] `true` une fois le vrai paiement branché ; non contrôlé s'il n'est pas fourni
 * @returns {string[]}
 */
export function findLaunchBlockers({ offer, legalPages, databaseId, vars, siteKey, realPaymentWired }) {
  const blockers = [];
  if (offer.draft) {
    blockers.push("Les contenus de config/offer.json sont encore provisoires : une fois formules, prix et contacts renseignés, retirez la ligne « draft ».");
  }
  if (isBlank(offer.contact.phone)) blockers.push("Le numéro de téléphone de contact manque dans config/offer.json.");
  if (isBlank(offer.contact.email)) blockers.push("L'adresse e-mail de contact manque dans config/offer.json.");
  for (const plan of offer.plans) {
    if (!(plan.priceCents > 0)) blockers.push(`La formule « ${plan.name} » est encore à 0 € : indiquez son prix dans config/offer.json.`);
  }

  const pages = Object.entries(legalPages);
  for (const [file, text] of pages) {
    if (text.includes(TODO_MARKER) || UNFILLED_FACT.test(text)) {
      blockers.push(`Il reste un passage « ${TODO_MARKER} » dans ${file} : renseignez ce fait de l'entreprise avant de publier.`);
    }
  }
  if (pages.some(([, text]) => text.includes(DRAFT_COMMENT))) {
    blockers.push("Les pages légales portent encore leur commentaire de brouillon : une fois les textes validés par un professionnel, retirez-le de src/layouts/Legal.astro.");
  }

  if (isBlank(databaseId) || databaseId === ZERO_DATABASE_ID) {
    blockers.push("La base D1 n'est pas créée : reportez son identifiant dans wrangler.jsonc (étape 2 de docs/mise-en-ligne.md).");
  }
  for (const [name, consequence] of Object.entries(TRIAL_SETTINGS)) {
    if (name in vars) blockers.push(`Le réglage d'essai « ${name} » est encore dans wrangler.jsonc, et ${consequence} : retirez-le de « vars ».`);
  }
  if (siteKey !== undefined && isBlank(siteKey)) {
    blockers.push(`La clé publique du widget anti-robots manque, et toutes les demandes seraient refusées comme venant d'un robot : écrivez ${SITE_KEY_NAME} dans .env.production (étape 7 de docs/mise-en-ligne.md).`);
  }
  if (realPaymentWired === false) blockers.push("Le paiement réel de l'acompte n'est pas encore branché.");
  return blockers;
}

/**
 * La clé publique du widget que la construction de la publication posera, `""` si elle n'est écrite nulle part. Comme Vite,
 * une variable de l'environnement, même vide, l'emporte sur `.env.production`, que `parseEnv` de `node:util` lit (Vite
 * emploie le même) : guillemets, `export` et commentaires de fin de ligne compris. `NOM= # à compléter` est une clé vide.
 *
 * @param {Record<string, string | undefined>} processEnv les variables de l'environnement du processus
 * @param {string} envFile le texte de `.env.production`
 * @param {(text: string) => Record<string, string>} parseEnv `parseEnv` de `node:util`, que `readLaunchInput` importe à son appel
 */
export const siteKeyFrom = (processEnv, envFile, parseEnv) => processEnv[SITE_KEY_NAME] ?? parseEnv(envFile)[SITE_KEY_NAME] ?? "";

const STRINGS_OR_COMMENTS = /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const STRINGS_OR_TRAILING_COMMAS = /("(?:\\.|[^"\\])*")|,(\s*[}\]])/g;

/** Lit du JSON avec commentaires et virgules finales, comme `wrangler.jsonc`. Les `//` d'une chaîne sont gardés. */
export const parseJsonc = (text) =>
  JSON.parse(text.replace(STRINGS_OR_COMMENTS, (_, string) => string ?? "").replace(STRINGS_OR_TRAILING_COMMAS, (_, string, tail) => string ?? tail));

// ---------- le bloc principal : seul endroit qui lit les fichiers ----------

/** Les fichiers sources dont on cherche les passages à compléter. `Fact.astro` écrit le marqueur : il n'en est jamais un reste. */
const SOURCE_FILE = /\.(astro|ts)$/;
const MARKER_SOURCE = "src/components/Fact.astro";

/** Le fichier dont l'existence dit que le vrai paiement est branché : la tâche 20 le crée. */
const REAL_PAYMENT_FILE = "worker/stripe.ts";

async function readLaunchInput(root) {
  const { access, readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const read = (file) => readFile(join(root, file), "utf8");

  const wrangler = parseJsonc(await read("wrangler.jsonc"));
  const database = (wrangler.d1_databases ?? []).find((d1) => d1.binding === "DB");

  const legalPages = {};
  for (const file of await readdir(join(root, "src"), { recursive: true })) {
    const path = `src/${file.replaceAll("\\", "/")}`;
    if (SOURCE_FILE.test(path) && path !== MARKER_SOURCE) legalPages[path] = await read(path);
  }
  // Importé ici et non en tête de fichier : Vitest charge ce module dans workerd, qui n'a pas besoin de `node:util` pour le reste.
  const { parseEnv } = await import("node:util");
  const siteKey = siteKeyFrom(process.env, await read(".env.production").catch(() => ""), parseEnv);
  const realPaymentWired = await access(join(root, REAL_PAYMENT_FILE)).then(() => true, () => false);
  return {
    offer: JSON.parse(await read("config/offer.json")),
    legalPages,
    databaseId: database?.database_id ?? "",
    vars: wrangler.vars ?? {},
    siteKey,
    realPaymentWired,
  };
}

async function main(root) {
  const blockers = findLaunchBlockers(await readLaunchInput(root));
  if (blockers.length === 0) {
    console.log("Contrôle d'avant publication : rien ne s'oppose à la publication.");
    return;
  }
  console.error(`Publication refusée : ${blockers.length} point${blockers.length > 1 ? "s" : ""} à régler d'abord.`);
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exitCode = 1;
}

/**
 * Lancé par `node` (`process.argv[1]` existe), le script contrôle, sans autre condition : aucune comparaison de chemin ne peut
 * le faire taire, et une panne de lecture sort en erreur plutôt qu'en « tout est bon ». Importé par un test, il n'exporte que
 * les fonctions : Vitest tourne dans workerd, où `process.argv` n'a pas de deuxième élément.
 */
if (typeof process !== "undefined" && process.argv[1]) {
  const { fileURLToPath } = await import("node:url");
  await main(fileURLToPath(new URL("..", import.meta.url))).catch((error) => {
    console.error(`Contrôle impossible : ${error instanceof Error ? error.message : "erreur inconnue"}.`);
    process.exitCode = 1;
  });
}
