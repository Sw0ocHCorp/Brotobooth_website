import { parisToday } from "./bookings";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Le texte prêt à être inséré dans du HTML, y compris dans la valeur d'un attribut entre guillemets. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (char) => ENTITIES[char]);

/** La mise en page des pages que le Worker écrit lui-même : les jetons de la charte, plus ce qui leur est propre. */
const PAGE_CSS = `
.page { max-width: 34rem; margin: 0 auto; padding: 40px 16px 56px; line-height: 1.5; }
.page p { margin-top: 12px; color: var(--text-soft); }
.page a { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
.page a.btn { text-decoration: none; }
.card { margin-top: 20px; padding: 20px; border: 1px solid var(--glass-border); border-radius: 22px; background: var(--glass); }
.recap { display: grid; grid-template-columns: max-content 1fr; gap: 10px 16px; }
.recap dt { color: var(--text-soft); }
.recap dd { font-weight: 600; overflow-wrap: anywhere; }
.amount { white-space: nowrap; }
.stack { display: grid; gap: 12px; margin-top: 20px; }
.notice { padding: 14px 16px; border: 1.5px solid var(--warn-line); border-radius: 16px; background: var(--warn-soft); }
.page p.notice { color: var(--text); }
.sim { padding: 24px 20px; border: 2px dashed var(--warn-line); border-radius: 22px; }
.sim h1 { font-size: 2.75rem; }
.contact { margin-top: 28px; font-size: .88rem; }
`;

/**
 * Une page complète, en français, sur la charte sombre du site. `bodyHtml` est du HTML déjà sûr : l'appelant
 * passe par `escapeHtml` pour tout ce qui vient d'un client. Aucune page n'est à indexer ni à garder. Sa feuille de
 * style est la seule chose écrite dans la page, ce que la politique de sécurité permet (`style-src 'unsafe-inline'`,
 * voir `CONTENT_SECURITY_POLICY`) : jamais un script, que cette politique refuse.
 */
export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/fonts.css">
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="page">
${bodyHtml}
</main>
</body>
</html>`;
}

const EUROS = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** « 450,00 € ». Le symbole suit une espace ordinaire : le montant se retrouve tel quel dans un texte. */
export const formatEuros = (cents: number): string => `${EUROS.format(cents / 100)} €`;

const DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** « samedi 19 décembre » pour un jour `AAAA-MM-JJ`. */
export const formatDay = (date: string): string => DAY.format(new Date(date));

const CLOCK = new Intl.DateTimeFormat("fr-FR", {
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Paris",
});

/** « mardi 10 novembre à 11 h », ou « à 11 h 25 » hors d'une heure pile : un instant, à l'heure de Paris. */
export function formatMoment(iso: string): string {
  const at = new Date(iso);
  const clock = Object.fromEntries(CLOCK.formatToParts(at).map((part) => [part.type, part.value]));
  const minutes = clock.minute === "00" ? "" : ` ${clock.minute}`;
  return `${formatDay(parisToday(at))} à ${Number(clock.hour)} h${minutes}`;
}
