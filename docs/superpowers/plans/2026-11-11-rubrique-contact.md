# Rubrique de contact : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** une section « Contact » en bas de l'accueil (numéros des fondateurs, e-mail, Instagram, formulaire) dont chaque message est enregistré, envoyé par e-mail au propriétaire seul, lisible et effaçable dans l'administration, et supprimé au bout de 12 mois.

**Architecture :** le message est inséré dans une nouvelle table D1 `contact_messages` avec son envoi dans la file `notifications` existante (nouvelle colonne `contact_id`) ; la file le rend par le modèle `owner_contact`, avec relance et alerte de panne sans données ; la tâche automatique supprime les messages à 12 mois et efface les empreintes IP à 24 h. Le front ajoute un composant Astro et un petit script de formulaire ; l'administration gagne une zone « Messages ».

**Tech Stack :** Astro 7, Worker Cloudflare en TypeScript sans framework, D1, Turnstile, Resend, Vitest (`@cloudflare/vitest-plugin`), Playwright (Chromium).

**Spec :** `docs/superpowers/specs/2026-11-11-rubrique-contact-design.md` (à lire avant chaque tâche : elle fixe les textes exacts et les règles RGPD).

## Global Constraints

- RGPD, sans exception : seuls nom, e-mail, téléphone (facultatif), message et une empreinte salée de l'IP ; message et coordonnées supprimés 12 mois après réception ; empreinte IP effacée 24 h après ; aucune autre utilisation ; aucune case pré-cochée.
- Telegram reste l'outil du propriétaire : aucun lien ni compte Telegram sur le site, aucun nom, adresse ni texte de message ne part chez Telegram ; seule l'alerte de panne `owner_contact_failed` y va, sans donnée.
- Aucun e-mail au visiteur (ni accusé, ni copie) ; le seul e-mail part vers le propriétaire, avec `reply_to` = l'adresse du visiteur.
- Turnstile se charge au premier focus d'un champ du formulaire, jamais au chargement de l'accueil.
- Chaque numéro, adresse ou lien n'apparaît que s'il est renseigné dans `config/offer.json` ; rien n'est inventé.
- Textes : ceux de la spec, au mot près ; chaque phrase s'adresse au visiteur (« vous ») ; aucun délai de réponse promis.
- Aucune donnée personnelle dans les journaux. Aucune nouvelle dépendance. DA « Sunset », cibles de 44 px, `prefers-reduced-motion`.
- Les tests ne citent ni numéro, ni adresse, ni prénom de l'offre réelle : ils lisent `offer` ou posent une offre de test.
- Commandes : `npm test`, `npm run typecheck`, `npm run build`, e2e `npx playwright test --project=chromium-telephone --project=chromium-ordinateur` (≈ 6 min, port 8798, construit dans `.wrangler/e2e/dist` ; ne jamais lancer `npm run build` pendant qu'il tourne).
- Ne jamais committer `.claude/` ; chaque commit se termine par la ligne d'attribution de l'environnement.

## Review Focus

1. **Un message qui contient du HTML, des guillemets ou plusieurs lignes** : l'e-mail au propriétaire l'échappe et garde ses retours à la ligne. → Task 3, test `owner_contact escapes the message and keeps its lines`.
2. **Une adresse e-mail saisie avec majuscules ou espaces** : enregistrée normalisée, comme à la réservation. → Task 2, test `createContact stores the normalized email`.
3. **Un message effacé (administration ou 12 mois) alors que son e-mail attend** : l'envoi est annulé, jamais un e-mail vide ou une erreur en boucle. → Task 3, test `a deleted message cancels its pending email`.
4. **Une visite de l'accueil sans toucher au formulaire** : aucune requête vers `challenges.cloudflare.com`. → Task 5, e2e `l'anti-robots ne se charge qu'au premier champ touché`.
5. **Aucun numéro, ou un seul fondateur renseigné** : aucun lien « Appeler » vide, et les phrases du site retombent sur l'e-mail. → Task 1, test `contact.phone is the first number, or empty`, et Task 5, e2e sur une offre de test.

---

### Task 1 : Les numéros des fondateurs dans l'offre

**Files :**
- Modify : `config/offer.json` (`contact.phone` → `contact.phones: []`), `worker/offer.ts`, `src/components/Footer.astro`, `src/components/ContactLine.astro`, `docs/mise-en-ligne.md` (étape 10)
- Test : `test/worker/bookings.test.ts` (à côté des tests de `buildOffer`), `test/worker/check-launch.test.ts`, `e2e/home.spec.ts` (test du pied de page)

**Interfaces :**
- Produces (dans `worker/offer.ts`) :
  - `interface Phone { name: string; number: string }`
  - `Offer.contact = { phones: Phone[]; phone: string; email: string; social: string[] }`, où `phone` est **calculé** par `buildOffer` : le numéro du premier fondateur, ou `""`. `OfferConfig.contact` n'a pas `phone`.
  - `telHref(number: string): string` → `tel:` suivi des seuls chiffres et `+` (la règle de `ContactLine` aujourd'hui).
  - Tous les lecteurs actuels de `offer.contact.phone` restent inchangés (phrases, e-mails, `/acompte`, mentions légales, garde de publication).

- [ ] **Step 1 : tests qui échouent**
  - `contact.phone is the first number, or empty` : offre de test à deux numéros → `phone` = le premier ; sans numéro → `""`.
  - `buildOffer refuses a phone without a name` et `… a name without a number` → `toThrow(/config\/offer.json/)`.
  - `telHref` garde les chiffres et le `+` : `"+33 6 12-34"` → `"tel:+3361234"`.
  - `check-launch.test.ts` : son offre complète s'écrit avec `phones` ; sans numéro, le blocage « Le numéro de téléphone de contact manque » reste.
  - e2e pied de page : un lien par numéro, intitulé « {prénom} · {numéro} », vers `telHref(number)`.
- [ ] **Step 2 : lancer** les tests unitaires ciblés → échecs.
- [ ] **Step 3 : implémenter.** `Footer.astro` liste tous les numéros (« {prénom} · {numéro} ») ; `ContactLine.astro` utilise `telHref`. `docs/mise-en-ligne.md` étape 10 : la forme de `contact.phones`, et que le premier numéro est celui que citent les phrases.
- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck`, `npm run build`, e2e `home.spec.ts` → tout passe.
- [ ] **Step 5 : commit** `feat: un numéro de contact par fondateur`

### Task 2 : Enregistrer un message

**Files :**
- Create : `migrations/0004_contact.sql`, `worker/contact.ts`
- Modify : `worker/repository.ts`, `worker/operations.ts` (exporter `checkTurnstile`), `worker/api.ts`, `worker/router.ts`
- Test : `test/worker/contact.test.ts` (nouveau), `test/worker/api.test.ts`, `test/worker/repository.test.ts`

**Interfaces :**
- Consumes : `PARSERS` (`name`, `email`, `phone`) de `worker/operations.ts`, `hashIp`, `sendSoon`, `offer.maxPerIpPer24h`.
- Produces :
  - Migration : table `contact_messages (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, message TEXT NOT NULL, ip_hash TEXT, created_at TEXT NOT NULL)`, index `contact_messages_created_at`, colonne `notifications.contact_id TEXT REFERENCES contact_messages(id)`.
  - `repository.ts` : `interface ContactMessage { id: string; name: string; email: string; phone: string | null; message: string; ip_hash: string | null; created_at: string }` ; `NotificationSpec.contact_id?: string | null` (écrit par `notificationStmt`, `null` par défaut) ; `insertContactMessage(db, m: ContactMessage, specs: NotificationSpec[]): Promise<void>` (un seul lot) ; `getContactMessage(db, id): Promise<ContactMessage | null>` ; `countRecentContactByIp(db, ipHash, sinceIso): Promise<number>`.
  - `worker/contact.ts` : `type ContactInput = { name: string; email: string; phone: string | null; message: string; turnstile_token: string }` ; `parseContact(raw: unknown, now: Date): { ok: true; value: ContactInput } | { ok: false; fields: string[] }` ; `type CreateContactResult = { kind: "sent" } | { kind: "invalid"; fields: string[] } | { kind: "bot" } | { kind: "too_many" }` ; `createContact(deps: Deps, input: unknown, ip: string | null): Promise<CreateContactResult>`. Le message planifie un seul envoi : `{ booking_id: null, contact_id: id, dedupe_key: "contact:<id>:email", channel: "email", recipient: "owner", template: "owner_contact", due_at: now }`.
  - `POST /api/contact` (`postContact` dans `api.ts`) : `201 { status: "sent" }` (et `sendSoon`), `422 { error: "invalid", fields }`, `403 { error: "bot" }`, `429 { error: "too_many" }` ; corps JSON uniquement, comme `/api/requests`.

- [ ] **Step 1 : tests qui échouent** (`contact.test.ts`, D1 local)
  - `parseContact` : nom vide ou de plus de 120 caractères, e-mail invalide, message vide ou de plus de 2 000 caractères, téléphone invalide → chaque champ dans `fields` ; téléphone absent → `null`.
  - `createContact stores the normalized email` : `" Camille@Example.TEST "` → `"camille@example.test"`.
  - `createContact stores the message and its email together` : une ligne `contact_messages` et une notification `owner_contact` de même `contact_id`, due maintenant, destinataire `owner`.
  - Turnstile `fail` → `bot`, rien d'écrit ; Turnstile en panne → message enregistré.
  - Sixième message en 24 h depuis la même empreinte → `too_many`, rien d'écrit ; sans sel (`IP_HASH_SALT` absent) → aucune empreinte, pas de limite.
  - API : 201 et `sendSoon` appelé ; 422 avec les champs ; corps non JSON → 415.
- [ ] **Step 2 : lancer** `npx vitest run test/worker/contact.test.ts test/worker/api.test.ts` → échecs.
- [ ] **Step 3 : implémenter.** Ordre de `createContact` : champs, Turnstile, limite, insertion. Message : 1 à 2 000 caractères après suppression des espaces de bord.
- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck` → tout passe.
- [ ] **Step 5 : commit** `feat: les messages de contact sont enregistrés avec leur e-mail`

### Task 3 : L'e-mail au propriétaire, sa relance, l'effacement automatique

**Files :**
- Modify : `worker/notifications.ts` (`ALL_TEMPLATES`, `deliver`, `settleFailure`), `worker/templates.ts`, `worker/deps.ts` (`EmailMessage.replyTo?`), `worker/email.ts`, `worker/repository.ts`, `worker/cron.ts`
- Test : `test/worker/templates.test.ts`, `test/worker/delivery.test.ts`, `test/worker/cron.test.ts`

**Interfaces :**
- Consumes : Task 2 (`ContactMessage`, `getContactMessage`, `contact_id`).
- Produces :
  - `MessageContext.contact?: ContactMessage` ; modèles `owner_contact` et `owner_contact_failed` (hors `BOOKING_MESSAGES`, comme `owner_digest`) ; `renderEmail(...)` rend aussi `replyTo?: string` ; `EmailMessage.replyTo?: string`, que `resendGateway` préfère à l'adresse de contact.
  - `purgeContactMessages(db, messagesBeforeIso: string, ipBeforeIso: string): Promise<{ deleted: number; cleared: number }>` : supprime les messages créés avant `messagesBeforeIso` avec leurs notifications, et efface `ip_hash` des messages créés avant `ipBeforeIso`.

- [ ] **Step 1 : tests qui échouent**
  - `owner_contact` : objet `Message de {nom}` ; le message d'abord, puis nom, e-mail, téléphone (absent s'il est nul) et date de réception ; la phrase exacte de la spec sur l'effacement à 12 mois ; `replyTo` = l'e-mail du visiteur.
  - `owner_contact escapes the message and keeps its lines` : `<script>`, guillemets et deux lignes → échappés en HTML, deux lignes gardées.
  - `owner_contact_failed` : le texte exact de la spec ; aucun nom, e-mail, téléphone ni extrait du message (`not.toContain` de chaque valeur).
  - Envoi : l'e-mail part vers le propriétaire avec `replyTo` du visiteur ; Resend en panne → l'envoi reste en file et repart au passage suivant ; au troisième échec → une alerte Telegram `owner_contact_failed`, une seule.
  - `a deleted message cancels its pending email` : message supprimé avant le passage → notification annulée, rien d'envoyé, aucune erreur.
  - Tâche automatique : message de plus de 12 mois supprimé avec ses notifications ; message d'il y a 11 mois gardé ; empreinte de plus de 24 h effacée, celle d'il y a 23 h gardée.
- [ ] **Step 2 : lancer** les trois fichiers de test → échecs.
- [ ] **Step 3 : implémenter.** `deliver` lit le message quand `contact_id` est posé et annule l'envoi s'il a disparu ; `settleFailure` alerte aussi pour un envoi qui porte un `contact_id`, au troisième échec, avec `owner_contact_failed`. La tâche automatique appelle `purgeContactMessages` là où elle appelle `anonymizeOld`.
- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck` → tout passe.
- [ ] **Step 5 : commit** `feat: l'e-mail de chaque message au propriétaire, relancé, puis effacé à 12 mois`

### Task 4 : La zone « Messages » de l'administration

**Files :**
- Modify : `worker/repository.ts`, `worker/admin.ts` (routes et tableau de la doc), `src/pages/admin.astro`, `src/scripts/admin.ts`
- Test : `test/worker/admin.test.ts`, `e2e/admin.spec.ts`

**Interfaces :**
- Consumes : Task 2 (`ContactMessage`), Task 3 (envois).
- Produces : `listContactMessages(db, sinceIso): Promise<(Omit<ContactMessage, "ip_hash"> & { sent_at: string | null })[]>` (plus récents d'abord) ; `deleteContactMessage(db, id): Promise<boolean>` (le message et ses notifications) ; `GET /api/admin/contact` → `{ messages }` (12 derniers mois, sans `ip_hash`) ; `DELETE /api/admin/contact/:id` → `204`, ou `404`.

- [ ] **Step 1 : tests qui échouent**
  - API : la liste n'a jamais `ip_hash` ; `sent_at` posé pour un message envoyé, `null` en attente ; `DELETE` supprime message et notifications puis `GET` ne le rend plus ; `DELETE` d'un inconnu → 404 ; `DELETE` sans `Origin` du site → 403 (garde existante des écritures).
  - e2e : la zone « Messages » liste un message envoyé par l'API publique (date, nom, e-mail, téléphone, message, « Envoyé par e-mail » ou « En attente d'envoi ») ; « Effacer » demande « Effacer définitivement ce message ? Cela ne se défait pas. », puis le retire ; « Annuler » le garde.
- [ ] **Step 2 : lancer** les tests → échecs.
- [ ] **Step 3 : implémenter.** Zone « Messages » après « À traiter », avec le même style de zone ; le texte du message s'affiche par `textContent`, ses retours à la ligne gardés ; la confirmation réutilise `confirmed()`.
- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck`, e2e `admin.spec.ts` → tout passe.
- [ ] **Step 5 : commit** `feat: lire et effacer les messages de contact dans l'administration`

### Task 5 : La section « Contact » de l'accueil et la politique de confidentialité

**Files :**
- Create : `src/components/Contact.astro`, `src/scripts/contact.ts`
- Modify : `src/pages/index.astro` (section avant le pied de page, script), `src/components/TopBar.astro` (« Contact » → `/#contact`, après « Formules »), `src/styles/site.css`, `src/pages/confidentialite.astro`
- Test : `e2e/home.spec.ts` (ou `e2e/contact.spec.ts`, nouveau), `e2e/a11y-perf.spec.ts` si l'accueil y est listé

**Interfaces :**
- Consumes : Task 1 (`contact.phones`, `telHref`), Task 2 (`POST /api/contact`).
- Produces : `socialLabel(url: string): string` dans `worker/offer.ts` → `"@brotobooth"` pour `https://www.instagram.com/brotobooth/` (avec ou sans `www.` ni `/` final), sinon le domaine ; utilisé par la section Contact **et** par `Footer.astro`, avec le nom accessible « @compte sur Instagram » pour un compte Instagram.

- [ ] **Step 1 : tests qui échouent** (e2e, offre réelle lue dans `offer`, ou offre de test servie par `page.route` quand une donnée y est vide)
  - La section `#contact` et le lien « Contact » du menu ; un lien « Appeler {prénom} » par numéro, l'e-mail, « @compte » (nom accessible « @compte sur Instagram ») pour un lien `instagram.com/compte`, dans la section comme dans le pied de page ; rien pour une donnée vide.
  - Test unitaire de `socialLabel` : `https://www.instagram.com/brotobooth/`, `https://instagram.com/brotobooth` → `@brotobooth` ; `https://exemple.fr/page` → `exemple.fr`.
  - `l'anti-robots ne se charge qu'au premier champ touché` : aucune requête vers `challenges.cloudflare.com` après le chargement de l'accueil et un défilement jusqu'à la section ; une requête après le focus du champ « Votre nom » (clé de test servie comme dans `reservation.spec.ts`).
  - Envoi réussi : le texte exact de la spec remplace le formulaire ; le serveur a enregistré le message (zone « Messages » ou API d'administration).
  - Erreurs : chaque champ refusé, son message sous lui ; `403 bot`, `429` et panne réseau (`page.route`) → les textes exacts de la spec, champs gardés.
  - L'information RGPD sous le formulaire, avec son lien vers `/confidentialite#contact` ; la section `#contact` de la politique (données, finalité, base légale, durées 12 mois et 24 h, destinataires, Telegram ne reçoit rien).
  - Accessibilité automatique de l'accueil et de la politique ; aucun débordement sur téléphone.
- [ ] **Step 2 : lancer** les e2e concernés → échecs.
- [ ] **Step 3 : implémenter.** Le bouton « Envoyer le message » est le seul bouton plein de la section ; libellés et messages d'erreur comme le formulaire de réservation ; sans JavaScript, la phrase de repli vers l'adresse e-mail. Politique : nouvelle section `#contact` et ajustements listés en spec §4.
- [ ] **Step 4 : lancer** la suite complète : `npm test`, `npm run typecheck`, `npm run build`, puis l'e2e Chromium seul → tout passe.
- [ ] **Step 5 : commit** `feat: la rubrique de contact de l'accueil, et ce que la politique de confidentialité en dit`
