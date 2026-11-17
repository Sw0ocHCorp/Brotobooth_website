# Réserver sans acompte : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** avec `depositPercent: 0` dans `config/offer.json`, accepter une demande confirme la date sans paiement, et plus rien ne parle d'acompte au client ; remettre 25 rend tout le parcours d'acompte.

**Architecture :** le réglage existant `depositPercent` devient l'interrupteur (`hasDeposit()`). La machine d'états envoie `validate` vers `confirmed` quand il vaut 0. Les messages d'une réservation dépendent de son propre `deposit_cents`, les pages et le message « demande reçue » du réglage. Les tests fixent eux-mêmes le mode ; ils ne dépendent plus de l'offre réelle.

**Tech Stack :** Astro 7, Worker Cloudflare en TypeScript, D1, Vitest (projets `worker` et `components`), Playwright (Chromium).

**Spec :** `docs/superpowers/specs/2026-11-17-sans-acompte-design.md` (textes au mot près en section 4).

## Global Constraints

- Textes visibles au mot près, ceux de la spec ; chaque phrase s'adresse au client ; rien d'inventé.
- Avec `depositPercent` supérieur à 0, comportement et textes d'aujourd'hui inchangés : aucun test existant du parcours d'acompte n'est supprimé, il est placé en mode « avec acompte ».
- Les tests ne lisent jamais le mode dans l'offre réelle : ils le fixent (`useDeposit`). Seuls les e2e suivent l'offre réelle, et ignorent l'autre mode avec une raison écrite.
- Code factorisé : une seule définition de « l'acompte est actif » (`hasDeposit`) et de « cette réservation a un acompte » (`hasBookingDeposit`) ; pas de comparaison à 0 recopiée.
- Aucune donnée personnelle dans les journaux ; Telegram reste réservé au propriétaire ; aucune nouvelle dépendance ; pas de vrai paiement Stripe.
- Branche `feat/offre-definitive` ; ne jamais committer `.claude/` ni `.superpowers/` ; chaque commit se termine par `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Ne jamais lancer `npm run build`, `npm run dev` ni `npm run demo` (ils réécrivent `dist/`, que la démo du propriétaire peut servir sur le port 8790). Les e2e construisent dans `.wrangler/e2e/dist`.
- Commandes : `npm test`, `npm run typecheck`, e2e `npx playwright test --project=chromium-telephone --project=chromium-ordinateur` (≈ 7 min, port 8798).

## Review Focus

1. **Une demande reçue quand l'acompte était actif** (`deposit_cents` > 0, `pending_review`) puis acceptée avec `depositPercent: 0` : confirmée, `deposit_cents` à 0, e-mail de confirmation sans le mot « acompte ». → Task 1, test `a request made with a deposit is confirmed without one`.
2. **Une réservation déjà `awaiting_deposit` quand le réglage passe à 0** : elle peut toujours être payée (→ `confirmed`) et expirer. → Task 1, test `a booking already awaiting its deposit keeps its path`.
3. **Deux validations de la même demande** (Telegram et administration en même temps) sans acompte : la seconde répond `stale`, un seul e-mail de confirmation est planifié. → Task 1, test `validating twice confirms once`.
4. **Sans acompte, aucun message au client ne dit « acompte », « Stripe » ni ne porte de lien `/acompte/`** : tous les modèles client rendus pour une réservation sans acompte. → Task 1, test `no client message mentions a deposit without one` ; pages : Task 2, e2e `aucune page ne parle d'acompte`.
5. **Le contrôle d'avant publication** n'exige le vrai paiement que si l'acompte est actif. → Task 1, test `real payment is required only with a deposit`.

---

### Task 1 : Le Worker confirme sans acompte

**Files :**
- Modify : `worker/offer.ts`, `worker/bookings.ts`, `worker/operations.ts`, `worker/notifications.ts`, `worker/templates.ts`, `worker/telegram.ts`, `scripts/check-launch.mjs`, `test/support.ts`
- Test : `test/worker/offer.test.ts`, `bookings.test.ts`, `operations.test.ts`, `notifications-plan.test.ts`, `templates.test.ts`, `telegram.test.ts`, `check-launch.test.ts`, et tout test du parcours d'acompte qui lisait l'offre réelle (`api.test.ts`, `admin.test.ts`, `payments.test.ts`, `cron.test.ts`, `delivery.test.ts`…)

**Interfaces :**
- Produces :
  - `hasDeposit(from: Pick<Offer, "depositPercent"> = offer): boolean` dans `worker/offer.ts` (`depositPercent > 0`) ; `buildOffer` refuse un `depositPercent` qui n'est pas un entier de 0 à 100 (erreur `config/offer.json`).
  - `hasBookingDeposit(b: Pick<Booking, "deposit_cents">): boolean` (`(deposit_cents ?? 0) > 0`), exporté d'un module que `src/scripts/admin.ts` peut importer (là où vit déjà `depositCents`).
  - `nextStatus("pending_review", "validate")` → `"awaiting_deposit"` si `hasDeposit()`, sinon `"confirmed"`. Les autres transitions ne changent pas.
  - `PlanEvent` gagne `"confirmed"` (accord sans acompte) : planifie `client_confirmed` (e-mail, tout de suite) et les rappels de l'événement (`eventReminders`), rien d'autre ; c'est aussi le nom de la ligne d'historique.
  - `validate` sans acompte écrit `{ hold_until: null, deposit_cents: 0 }` et annonce `confirmed` ; avec acompte, inchangé (`validated`).
  - `useDeposit(percent: number): void` dans `test/support.ts` : fixe `offer.depositPercent` avant chaque test du `describe` courant et le rétablit après.
- Les modèles (`worker/templates.ts`) : `client_received` suit `hasDeposit()` ; tout modèle qui porte sur une réservation suit `hasBookingDeposit(b)`. Sans acompte : textes de la spec (section 4) ; `client_confirmed` a une seule ligne de prix « Prix, à régler le jour de votre événement » ; aucun modèle ne montre de ligne « Acompte ». Telegram : statut d'une réservation confirmée sans acompte « Confirmée ».
- `findLaunchBlockers` : « Le paiement réel de l'acompte n'est pas encore branché. » seulement si `hasDeposit(offer)`.

- [ ] **Step 1 : rendre les tests existants indépendants de l'offre réelle.** Ajouter `useDeposit` ; chaque `describe` qui exerce le parcours d'acompte appelle `useDeposit(25)`. `npm test` passe sans autre changement.
- [ ] **Step 2 : tests qui échouent** (mode sans acompte, `useDeposit(0)`)
  - `hasDeposit` : 0 → `false`, 25 → `true` ; `buildOffer` refuse `-1`, `101`, `12.5`.
  - `nextStatus` : `validate` → `confirmed` sans acompte, `awaiting_deposit` avec.
  - opération : accepter une demande → `confirmed`, `hold_until` nul, `deposit_cents` 0 ; file : `client_confirmed` par e-mail, `owner_d7`, `client_d7`, `owner_d1` ; ni `client_deposit_link`, ni `client_deposit_reminder`, ni `owner_deposit_paid`.
  - les cinq tests du Review Focus, sous leurs noms.
  - une demande créée sans acompte a `deposit_cents` à 0.
  - `client_received` et `client_confirmed` portent les phrases exactes de la spec.
- [ ] **Step 3 : lancer** les tests concernés → échecs attendus.
- [ ] **Step 4 : implémenter.** Si la base limite les noms d'événements d'historique (contrainte `CHECK` dans `migrations/`), ajouter une migration ; sinon aucune.
- [ ] **Step 5 : lancer** `npm test`, `npm run typecheck` → tout passe.
- [ ] **Step 6 : commit** `feat: accepter une demande confirme la date quand l'acompte est à 0`

### Task 2 : Le site, les pages légales et le réglage à 0

**Files :**
- Modify : `config/offer.json` (`depositPercent: 0`), `src/pages/reserver.astro`, `src/pages/cgv.astro`, `src/pages/confidentialite.astro`, `src/pages/admin.astro`, `src/scripts/admin.ts`, `docs/mise-en-ligne.md`, `docs/essai-local.md`, `e2e/seed.ts` et les specs e2e du parcours (`reservation`, `admin`, `quality`, paiement)
- Test : `test/components/` si un rendu de page s'y prête, `test/worker/docs.test.ts`, e2e

**Interfaces :**
- Consumes : Task 1 (`hasDeposit`, `hasBookingDeposit`, événement `confirmed`).

- [ ] **Step 1 : tests qui échouent**
  - e2e sans acompte (ignorés si l'acompte est actif) : la note de la page de réservation est la phrase de la spec ; une demande envoyée puis acceptée dans l'administration passe à « Confirmée » sans étape d'acompte ; `aucune page ne parle d'acompte` : `/reserver`, `/confidentialite` ne contiennent ni « acompte » ni « Stripe », et `/cgv` ne contient « acompte » que dans « Aucun acompte ne vous est demandé. » ; les CGV portent les phrases de la spec (réservation, prix, paiement, deux annulations) ; la politique de confidentialité annonce « quatre prestataires ».
  - e2e existants du parcours d'acompte : `test.skip(!hasDeposit(offer), "l'acompte est désactivé dans l'offre")`, jamais supprimés.
  - administration : pas de champ « Acompte (€) » sans acompte ; la fiche d'une réservation sans acompte n'a pas de ligne « Acompte » ; la colonne « Acompte attendu » absente quand l'acompte est inactif et qu'elle est vide ; l'historique dit « Confirmée ».
- [ ] **Step 2 : lancer** les tests concernés → échecs attendus.
- [ ] **Step 3 : implémenter.** Chaque page garde ses deux variantes selon `hasDeposit()` (textes actuels avec acompte, textes de la spec sans). L'aide du champ « Formule » de l'ajout manuel devient, sans acompte : « Propose le prix du palier en cours ; vous pouvez le modifier. » Le nombre de prestataires de la politique se déduit de la liste. Guides : étape 8 (Stripe) seulement si l'acompte est remis ; étape 10 : `depositPercent` à 0 = sans acompte, et la marche pour le remettre (mettre 25, brancher Stripe, relire les CGV, nouvelle `termsVersion`) ; `docs/essai-local.md` décrit l'essai sans acompte.
- [ ] **Step 4 : passer** `depositPercent` à 0, puis lancer `npm test`, `npm run typecheck`, `node scripts/check-launch.mjs` (le paiement réel ne doit plus figurer parmi les blocages) et l'e2e Chromium complet → tout passe.
- [ ] **Step 5 : commit** `feat: le site réserve sans acompte`
