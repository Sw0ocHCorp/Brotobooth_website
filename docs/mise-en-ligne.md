# Mettre le site en ligne

La procédure suit l'ordre ci-dessous. Chaque étape se termine par une vérification : ne passez à la suivante que si elle réussit.

**Aucun secret ne s'écrit dans le dépôt ni dans ce guide.** Les secrets se saisissent dans le terminal (`wrangler secret put`) ou dans le tableau de bord du fournisseur, jamais dans un fichier suivi par git.

**Sans acompte, aucun paiement en ligne n'est nécessaire.** Avec `depositPercent` à 0 dans `config/offer.json` (le réglage d'aujourd'hui), accepter une demande confirme la date, le client règle le jour de son événement, et le site n'a besoin ni de compte Stripe ni des étapes qui le concernent (le compte à l'étape 1, les secrets `STRIPE_*` à l'étape 3, l'étape 8).

**Avec un acompte, le vrai paiement vient en dernier.** Si vous remettez l'acompte (voir l'étape 10), tant que la tâche 20 (Stripe) n'est pas faite, et sans votre accord pour la lancer, le site ne peut pas encaisser : ne publiez pas avant. Le contrôle d'avant publication le sait et refuse (« Le paiement réel de l'acompte n'est pas encore branché »). Le paiement simulé et les fausses passerelles ne peuvent pas être publiés, le contrôle d'avant publication les refuse.

## 1. Les comptes

À créer par vous (le code ne manipule jamais vos identifiants personnels) :

- **Cloudflare**, avec l'offre Workers Paid ;
- **Stripe**, avec les informations de l'entreprise, seulement si vous remettez l'acompte ;
- **Resend**, avec la région européenne pour les données ;
- **le bot Telegram**, créé auprès de @BotFather ;
- les **identifiants des chats Telegram** qui recevront les alertes. Écrivez au bot depuis chaque chat, puis lisez `chat.id` dans la réponse de `read -rs TELEGRAM_BOT_TOKEN; curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"` (le jeton est saisi sans écho et ne va dans aucun fichier).

## 2. La base de données

```bash
npx wrangler d1 create brotobooth --jurisdiction=eu
```

Reportez l'identifiant affiché (`database_id`) dans `wrangler.jsonc`, à la place de la valeur nulle. Puis créez les tables :

```bash
npx wrangler d1 migrations apply DB --remote
```

Vérification : `npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table'"` liste `bookings`, `booking_history`, `notifications`, `system_state` et `contact_messages`.

**À contrôler une fois sur la vraie base** : que l'erreur « date déjà prise » de D1 est bien reconnue (les essais locaux n'utilisent pas la vraie base). Après le déploiement, dans `/admin/`, bloquez une date lointaine, puis bloquez-la une seconde fois : la page doit répondre « Cette date est déjà prise. », et non « L'opération a échoué ». Retirez ensuite le blocage.

## 3. Les secrets

Un `npx wrangler secret put NOM` par secret ; la valeur est demandée dans le terminal. Si Wrangler propose de créer le Worker `brotobooth`, répondez oui. Les secrets qui dépendent d'une étape suivante (`ACCESS_AUD`, `TURNSTILE_SECRET`, `STRIPE_*`) se saisissent à cette étape.

| Secret | D'où vient la valeur |
|---|---|
| `OWNER_EMAIL` | votre adresse, celle qui reçoit les alertes |
| `FROM_EMAIL` | l'adresse d'expédition, sur le domaine validé chez Resend |
| `ACCESS_AUD` | le public de l'application Access (étape 6) |
| `TURNSTILE_SECRET` | la clé secrète du widget (étape 7) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe (étape 8, seulement avec un acompte) |
| `RESEND_API_KEY` | Resend |
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | à générer (voir ci-dessous) |
| `TELEGRAM_CHAT_IDS` | les identifiants de l'étape 1, séparés par des virgules |
| `CALENDAR_TOKEN` | à générer (voir ci-dessous) |
| `IP_HASH_SALT` | à générer (voir ci-dessous) |

Les trois valeurs à générer le sont chacune avec :

```bash
openssl rand -hex 32
```

Notez la valeur de `CALENDAR_TOKEN` : elle fait le lien de l'agenda, `https://brotobooth.fr/agenda/<jeton>.ics`. Le jeton est comparé tel quel, sans décodage d'adresse : un jeton en hexadécimal n'a aucun caractère à échapper. Pour le changer, régénérez-le, remettez-le avec `wrangler secret put` et réabonnez le téléphone.

Vérification : `npx wrangler secret list` montre les noms saisis ; avec un acompte, à la fin de l'étape 8, les douze du tableau ; sans acompte, l'étape 8 est sautée et ce sont les dix du tableau hors `STRIPE_*`.

## 4. Le DNS de `brotobooth.fr`

1. Chez le fournisseur actuel, **relevez toutes les entrées** du domaine (copie d'écran ou export), dont l'entrée de messagerie (`mail.mymail.eu.com`).
2. Ajoutez le domaine à Cloudflare et **recréez chaque entrée**, la messagerie comprise.
3. Chez le bureau d'enregistrement, **changez les serveurs de noms** pour ceux que Cloudflare indique.
4. **Vérifiez que la messagerie fonctionne** : envoyez-vous un message depuis une autre adresse, et répondez-y.

Retour arrière : remettre les anciens serveurs de noms chez le bureau d'enregistrement.

`photos.brotobooth.fr` est réservé à la galerie de la borne : ne le modifiez pas.

## 5. Resend

Ajoutez le domaine chez Resend (région européenne), puis recréez chez Cloudflare les entrées SPF et DKIM qu'il demande, **sans toucher à l'entrée de messagerie**. Resend confirme quand le domaine est validé.

## 6. Cloudflare Access

Dans Cloudflare Zero Trust, créez une application Access auto-hébergée sur `brotobooth.fr` qui couvre ces trois chemins : `/admin`, `/admin/*` et `/api/admin/*`. Sa politique n'autorise que votre adresse e-mail (connexion par code). Reportez le public de l'application (« AUD ») dans `ACCESS_AUD`.

Vérification, dans une fenêtre de navigation privée : `/admin/` demande un code, `/api/admin/overview` ne répond rien sans connexion, et une fois connecté `/admin/` affiche vos réservations (et non « Connexion requise »).

## 7. Turnstile (anti-robots)

Créez le widget dans Cloudflare, pour `brotobooth.fr`. La clé secrète va dans `TURNSTILE_SECRET`. La clé publique n'est pas un secret, mais elle est lue au moment de la construction du site : écrivez-la dans un fichier `.env.production` à la racine (ignoré par git) :

```
PUBLIC_TURNSTILE_SITE_KEY=<la clé publique>
```

Sans cette clé, le widget n'apparaît pas et les demandes seraient refusées comme venant d'un robot : le contrôle d'avant publication refuse tant qu'elle manque (variable `PUBLIC_TURNSTILE_SITE_KEY` de l'environnement, ou ligne de `.env.production`).

**À contrôler une fois en ligne**, car les essais locaux n'appellent pas Cloudflare : ouvrez `/reserver` avec les outils du navigateur (onglet Console) ; le vrai widget doit se charger sans erreur de politique de sécurité (CSP), et envoyer une demande doit réussir, ce qui prouve qu'un jeton a été délivré.

## 8. Stripe (seulement si l'acompte est remis, après la tâche 20 et avec votre accord)

À passer tant que `depositPercent` vaut 0.

Dans Stripe, créez un point d'arrivée (webhook) sur `https://brotobooth.fr/api/stripe/webhook` pour l'événement `checkout.session.completed`, **d'abord en mode test**. Sa clé de signature va dans `STRIPE_WEBHOOK_SECRET`, la clé secrète dans `STRIPE_SECRET_KEY`. Le passage en mode réel se fait en dernier, après l'étape 12.

## 9. Telegram

Avec les mêmes valeurs que les secrets du Worker, saisies sans écho :

```bash
read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN
read -rs TELEGRAM_WEBHOOK_SECRET && export TELEGRAM_WEBHOOK_SECRET
BASE_URL=https://brotobooth.fr node scripts/set-telegram-webhook.mjs
```

À refaire après chaque changement d'adresse ou de secret.

### Les messages du formulaire de contact

- **Votre boîte de réception garde une copie de chaque message, et le site ne peut pas l'effacer.** Supprimez à la main chaque e-mail de contact **12 mois après sa réception** : le site efface sa propre copie (et ses coordonnées) au même moment, et la politique de confidentialité s'y engage.
- Si l'e-mail d'un message échoue trois fois de suite, vous recevez sur Telegram une alerte **sans aucune donnée** du visiteur : ouvrez la zone « Messages » de `/admin/` pour lire le message, qui y reste en attente d'envoi.

## 10. Les contenus

Tant qu'un contenu manque, `node scripts/check-launch.mjs` refuse la publication et liste ce qui reste. Il faut :

- vérifier `config/offer.json`, qui n'est plus marqué provisoire depuis le 17 novembre 2026 (formules, prix, contacts et choix de ne pas demander d'acompte sont ceux du propriétaire ; une ligne `"draft": true` le rendrait de nouveau provisoire : le pourcentage d'acompte ne s'afficherait plus et la publication serait refusée) : ce que comprend chaque borne (`includes` dans `booths`, facultatif : sans lui, la carte de la borne ne liste rien), `depositPercent` (0 : sans acompte, voir plus bas), e-mail (`contact.email` : il reçoit les messages du formulaire de contact, et ne s'affiche pas sur le site), `contact.whatsapp` (le numéro WhatsApp, au format international : `+33 6 12 34 56 78`), réseaux, et `contact.phones`, un numéro par fondateur, chacun écrit `{ "name": "Prénom", "number": "06 12 34 56 78" }` (le pied de page les liste tous ; le premier est celui que citent les phrases du site, les e-mails et la page d'acompte). Chaque formule (`plans`) désigne sa borne par son identifiant (`booth`), avec son nombre de tirages (`prints`), sans prix : les prix sont dans `tiers`, une liste de paliers où chacun donne son `id`, son `name` (vu du propriétaire seulement), ses `places` (absentes du dernier palier, le prix normal, qui est illimité), son `refillCents` (tarif de la recharge) et son `prices`, le prix en centimes de chaque formule par identifiant. Un palier sans prix pour une formule, ou avec un prix pour une formule inconnue, fait échouer les tests et le contrôle. Le nom d'une formule se déduit de sa borne et de ses tirages (« BrotoBooth · 200 tirages ») et ne s'écrit pas ; un palier a au contraire un `id`, enregistré dans chaque réservation, qui ne change plus une fois le site en ligne, et un `name` que vous écrivez. **Pour terminer l'offre de lancement plus tôt**, retirez de `tiers` les paliers de lancement (ne gardez que le prix normal) et relancez `npm run deploy` : les réservations déjà prises gardent leurs prix, et leur palier s'affiche dans l'administration par son `id`. Une borne sans formule s'affiche « Bientôt disponible » et ne se réserve pas : pour ouvrir BrotoBooth tiny, il suffit de lui ajouter ses formules. Une formule dont la borne n'existe pas fait échouer les tests et le contrôle d'avant publication. Les noms, les tirages et les prix se changent librement, et aucun test n'en dépend : `npm run deploy` ne s'arrête pas pour cela. Les identifiants des bornes servent aux liens « Choisir le … » de l'accueil, ceux des formules aux demandes déjà enregistrées : une fois le site en ligne, mieux vaut ne plus les changer ;
- renseigner chaque `[À compléter]` des pages légales (durée de conservation d'une réservation confirmée (qui ne concerne pas une réservation annulée : elle est effacée 12 mois après son annulation) et garanties des transferts hors de l'Union européenne dans la confidentialité) ; le médiateur de la consommation (CM2C, adhésion du 19 novembre 2026, à renouveler à son échéance : les CGV doivent toujours nommer un médiateur dont l'adhésion est en cours) et l'identité de l'entreprise (entreprise individuelle de Nicolas Raze, RCS, SIRET, adresse, franchise de TVA) sont dans `src/legal.ts` ; l'identité y est écrite d'après l'extrait Kbis et la synthèse de la formalité de création : à mettre à jour si l'adresse, la forme de l'entreprise ou le régime de TVA change (au-delà des seuils de la franchise, les prix deviennent TTC et les CGV doivent le dire) ;
- faire valider les trois pages légales par un professionnel, puis retirer le commentaire de brouillon de `src/layouts/Legal.astro` ; lui signaler en particulier le droit de rétractation écarté au titre de l'article L221-28, 12° ;
- confirmer la présentation des fondateurs : la citation « Une borne construite de nos mains, que nous venons installer chez vous. » et la phrase « Nous avons construit cette borne nous-mêmes, du meuble en bois au logiciel. Nous l'installons chez vous, sur le lieu de votre événement. » ;
- confirmer la zone de déplacement : la liste des communes retenues (Solliès-Pont, Riboux ?) et les îles, aujourd'hui hors de la zone ;
- si la zone de déplacement change : modifier `zone.border` dans `config/offer.json`, puis lancer `npm run zone` (réseau nécessaire : il relit les contours officiels sur geo.api.gouv.fr, réécrit `src/generated/zone.json` et liste les communes retenues) et committer le fichier ; ni le build, ni le déploiement, ni les tests ne lancent ce script, et `npm test` échoue tant qu'il n'a pas été relancé. Restent à modifier à la main : l'`aria-label` de la carte dans `src/components/TravelZone.astro`, la ligne de zone des CGV (`src/pages/cgv.astro`, et `termsVersion` une fois le site ouvert), `LANDMARKS` dans `scripts/build-zone.mjs` (les noms écrits sur la carte, leur côté), et les textes cités par `test/components/travel-zone.test.ts` et `e2e/quality.spec.ts` ;
- **sans acompte** (`depositPercent` à 0) : les CGV disent qu'aucun acompte n'est demandé et que le client règle le jour de l'événement, et la politique de confidentialité ne mentionne plus Stripe ; l'administration n'a plus de champ « Acompte (€) » ; accepter une demande la confirme aussitôt ; le contrôle d'avant publication n'exige pas le vrai paiement. Une réservation qui attendait déjà son acompte au moment du changement garde son parcours : le client peut encore la payer, ou elle expire ;
- **remettre l'acompte**, si des annulations gênent : (1) répondre d'abord aux demandes en attente : une demande acceptée après le changement recevrait un lien d'acompte alors que les conditions qu'elle a acceptées n'en prévoyaient pas ; (2) mettre `depositPercent` à 25 dans `config/offer.json` ; (3) ouvrir le compte Stripe (étape 1), saisir les deux secrets `STRIPE_*` (étape 3), faire l'étape 8 et brancher le vrai paiement (tâche 20) ; (4) relire les CGV, qui reprennent alors leur texte d'acompte, dont un choix à faire valider par un professionnel : l'acompte gardé quand le client annule, sans indemnité du même montant quand Brotobooth annule (clause présumée abusive par l'article R212-2, 2° du Code de la consommation, choix du propriétaire du 2026-11-17), **et la politique de confidentialité**, où Stripe redevient un cinquième prestataire ; (5) changer `termsVersion` (nouvelle date `AAAA-MM-JJ`), puisque les conditions ne sont plus les mêmes ; (6) `npm run deploy` ;
- retirer de `wrangler.jsonc` les réglages d'essai `PAYMENT_MODE` et `FAKE_GATEWAYS`, s'ils y figurent.

## 11. La publication

**Une fois, avant la première publication**, sur une machine où WebKit (le moteur de Safari) démarre, lancez toute la suite de tests, Chromium et WebKit :

```bash
npx playwright install webkit
npx playwright test
```

`npm run deploy` ne lance que Chromium, car WebKit ne démarre pas partout. Ce passage unique est donc la seule vérification automatique sur le moteur de Safari ; l'essai à la main sur Safari (étape 12) reste à faire.

Puis, sur votre machine :

```bash
npm run deploy
```

Elle commence par le contrôle d'avant publication (elle s'arrête là, en listant ce qui manque), puis lance les tests, les parcours de bout en bout sur Chromium, la construction du site et enfin `wrangler deploy`. Elle s'arrête au premier échec.

Il reste à rattacher le domaine au Worker : dans Cloudflare, Workers puis `brotobooth`, Réglages, Domaines et routes, **Domaine personnalisé** `brotobooth.fr`. Si Cloudflare signale une entrée existante pour `brotobooth.fr` (l'ancien site), retirez seulement celle-là, jamais l'entrée de messagerie.

N'activez jamais, dans Cloudflare, **Rocket Loader** ni l'insertion automatique de **Web Analytics** : la politique de sécurité du site refuse tout script écrit dans les pages, ils casseraient l'affichage ou seraient bloqués.

## 12. Avant d'ouvrir au public

Chaque point se vérifie sur le site publié.

**Avant de commencer, retirez de `config/offer.json` les paliers de lancement** : `tiers` ne garde que le prix normal, puis `npm run deploy`. Chaque demande, essai compris, prend définitivement une place du palier en cours (une annulation ne la rend pas) ; les places étant comptées par `id` de palier, les réservations d'essai restent au palier normal et ne comptent jamais contre les paliers de lancement. **Une fois tous les essais faits, remettez les deux paliers de lancement dans `tiers` et relancez `npm run deploy`, juste avant d'ouvrir.**

- [ ] **Avec un acompte seulement : un vrai paiement de faible montant**, puis son remboursement depuis Stripe. La réservation passe en « Confirmée ». Sans acompte, acceptez une demande d'essai : elle passe directement en « Confirmée ».
- [ ] **Un e-mail reçu sur une boîte Gmail**, dans la boîte de réception et non dans les courriers indésirables.
- [ ] **Les boutons du bot** sur le téléphone : une demande arrive, ses boutons répondent.
- [ ] **L'agenda abonné** sur le téléphone, avec ses alertes réglées puis testées : créez une prestation pour demain et vérifiez que l'alerte sonne. La mise à jour peut prendre plusieurs heures.
- [ ] **Un essai complet sur un vrai téléphone et sur Safari** : demande, validation (et paiement, avec un acompte).
- [ ] **Le point du lundi** reçu un lundi matin.
- [ ] **Une restauration Time Travel répétée à blanc** : notez le repère actuel (`npx wrangler d1 time-travel info DB`), restaurez la base à un instant récent (`npx wrangler d1 time-travel restore DB --timestamp=<horodatage>`), vérifiez, puis revenez au repère noté avec `--bookmark`. La restauration remonte jusqu'à 30 jours.
- [ ] **Le widget Turnstile** et **l'erreur « date déjà prise »** contrôlés en ligne (étapes 7 et 2).
- [ ] **Une vraie demande** faite comme un client le ferait, de bout en bout, puis annulée : elle reste une réservation annulée, sa place reste comptée au palier normal et elle est sans effet sur l'offre de lancement.
- [ ] **Les paliers de lancement remis** dans `config/offer.json`, puis `npm run deploy` : la carte de l'accueil annonce « Offre de lancement » et ses places.

## Après l'ouverture

Pendant la première heure : `/api/availability` répond, la zone « Santé » de `/admin/` montre un « Dernier passage » de moins de 15 minutes et aucun envoi en échec, et la première vraie demande arrive bien sur Telegram. Ne faites plus d'essai sur le site ouvert : chacun prendrait une place de l'offre de lancement.

## Revenir en arrière

- **Le site** : `npx wrangler rollback` remet la version précédente du Worker.
- **Les données** : Time Travel, avec le repère noté avant l'opération.
- **Le DNS** : remettre les anciens serveurs de noms chez le bureau d'enregistrement.
