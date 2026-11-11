# Site Brotobooth : vitrine et réservations

Date : 2026-11-07. Maquette validée : [2026-11-07-maquette-site.html](2026-11-07-maquette-site.html) (les textes et la mise en page font référence ; elle ne s'ouvre avec ses médias que depuis le compagnon visuel, et la réservation y est une ancre, là où le site aura une vraie page).

## 1. Intention

Brotobooth loue un seul photobooth, construit et programmé par ses fondateurs. Le site doit donner envie de le réserver et gérer le calendrier des prestations.

### Critères de réussite

1. **Réservation à tout moment.** Un client peut demander une date et la bloquer à toute heure, sans action du propriétaire.
2. **Jamais deux prestations le même jour.** La base de données refuse une deuxième réservation active sur une date, même si deux demandes arrivent à la même seconde.
3. **Jamais de prestation ratée.** Chaque demande et chaque prestation à venir atteint le propriétaire par plusieurs canaux indépendants.
4. **Moins d'annulations de dernière minute.** Une prestation n'est confirmée qu'après le paiement d'un acompte.
5. **Un site organique.** Il réutilise les supports réellement tournés et l'identité de la borne. Aucune image de banque ni rendu générique.
6. **Des textes pour le client.** Chaque phrase s'adresse à la personne qui organise l'événement et réserve. Les invités sont à la troisième personne. Aucun vocabulaire interne.
7. **Sobre et simple.** Des animations modernes mais peu nombreuses, et une navigation à trois liens.

### Hors périmètre de cette version

- Remboursements automatiques : ils se font depuis le tableau de bord Stripe.
- Paiement du solde en ligne et factures : ils restent hors du site.
- Page de réglages : formules, prix et délais tiennent dans un fichier versionné.
- Plusieurs bornes : la contrainte reste une prestation par date. Passer à plusieurs bornes demandera d'ajouter la borne à la contrainte d'unicité.
- Lien avec la borne : préconfigurer une prestation sur la borne depuis une réservation est une évolution possible, dont rien ne dépend.
- Thème clair : le site est en thème sombre uniquement, à cause du mur de tirages et de la vidéo.
- Le spot vertical n'est pas utilisé sur le site.

La borne, son projet Supabase, son bot Telegram et sa page de monitoring sur Netlify ne sont pas modifiés.

## 2. Architecture

| Bloc | Rôle | Outil |
|---|---|---|
| Pages publiques | Accueil, réservation, pages légales | Astro, généré en fichiers statiques |
| Logique | API publique, paiement, administration, flux d'agenda, bot | Worker Cloudflare en TypeScript |
| Données | Réservations, historique, file de notifications | Cloudflare D1, créée avec `--jurisdiction=eu` |
| Tâche automatique | Toutes les 5 minutes : libère les dates expirées, envoie les notifications dues | Cron Trigger `*/5 * * * *` |
| Paiement | Page d'acompte hébergée | Stripe Checkout |
| E-mails | Messages aux clients et au propriétaire | Resend, dans un seul module pour pouvoir changer de service |
| Alertes et validation sur téléphone | Messages à boutons | Un second bot Telegram, dédié aux réservations |
| Accès à l'administration | Connexion par code reçu par e-mail | Cloudflare Access |
| Anti-robots | Protection du formulaire | Cloudflare Turnstile |

**Offre Cloudflare :** Workers Paid dès le lancement (environ 5 $/mois). L'offre gratuite plafonne à 100 000 appels au Worker par jour, ce qu'un robot pourrait épuiser, et à 10 ms de calcul par exécution.

**Bot Telegram séparé :** le bot de la borne lit ses commandes par `getUpdates`, méthode que Telegram bloque dès qu'un webhook est actif sur le même bot. Un seul bot casserait `/pause`, `/etat` et `/nouvelle`.

**Coûts prévus :** environ 5 $/mois fixes, environ 1,5 % + 0,25 € par acompte (grille Stripe à confirmer à l'ouverture du compte). Resend reste gratuit jusqu'à 3 000 e-mails par mois et 100 par jour.

### Règles de disponibilité

1. **La date passe avant tout le reste.** Enregistrer une demande ne dépend que du Worker et de D1. Les notifications partent ensuite, et une panne de Resend, de Telegram ou de Stripe ne fait jamais échouer une demande.
2. **La vitrine reste indépendante.** Les fichiers statiques sont servis sans appeler le Worker (`run_worker_first` limité aux routes dynamiques). Si l'API ne répond pas, la page de réservation affiche le téléphone et l'e-mail.
3. **Limite assumée :** une panne générale de Cloudflare rend le site inaccessible le temps de la panne.

### Routes

| Route | Rôle | Accès |
|---|---|---|
| `/`, `/reserver`, `/mentions-legales`, `/cgv`, `/confidentialite` | Pages statiques | Public |
| `GET /api/availability` | Liste des dates indisponibles, sans aucune donnée client | Public |
| `POST /api/requests` | Crée une demande | Public, Turnstile et limites |
| `GET` et `POST /acompte/<jeton>` | Récapitulatif et création de la session de paiement | Jeton du client |
| `POST /api/stripe/webhook` | Confirme les paiements | Signature Stripe |
| `POST /api/telegram/webhook` | Boutons du bot | En-tête secret et liste de chats autorisés |
| `GET /agenda/<jeton>.ics` | Flux d'agenda privé | Jeton long |
| `/acompte/<jeton>/simulation` | Paiement factice | Uniquement en mode simulé |
| `GET /demo` | Lecture des messages qui auraient été envoyés | Uniquement avec les fausses passerelles |
| `/admin` et `/api/admin/*` | Administration | Cloudflare Access, vérifié aussi par le Worker via `ctx.access` et le public attendu |

### Organisation du code

```
src/                 pages et composants Astro, styles, scripts d'animation
worker/
  index.ts           routage et tâche automatique
  bookings.ts        machine à états pure, sans accès réseau ni base
  repository.ts      accès à D1
  api.ts             routes publiques
  admin.ts           administration
  payments.ts        sessions Checkout et webhook Stripe
  notifications.ts   file d'attente et planification
  email.ts           envoi par Resend
  telegram.ts        envoi et boutons du bot
  calendar.ts        génération du flux .ics
config/offer.json    formules, prix, pourcentage d'acompte, délais
migrations/          schéma D1
```

`config/offer.json` est lu à la fois par Astro à la génération des pages et par le Worker, pour qu'un prix n'existe qu'à un seul endroit.

## 3. Données

```sql
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,           -- au moins 128 bits aléatoires, pour /acompte
  event_date TEXT NOT NULL,             -- AAAA-MM-JJ, heure de Paris
  status TEXT NOT NULL,                 -- voir la section 4
  source TEXT NOT NULL,                 -- site, manual
  plan TEXT,
  price_cents INTEGER,
  deposit_cents INTEGER,
  client_name TEXT, client_email TEXT, client_phone TEXT,
  event_type TEXT, venue TEXT, event_hours TEXT, message TEXT,
  ip_hash TEXT,                         -- empreinte salée, pour les limites uniquement
  terms_version TEXT,                   -- version des CGV acceptée, à la date created_at
  hold_until TEXT,                      -- échéance en UTC, nulle si pas d'échéance
  stripe_session TEXT,
  stripe_session_expires TEXT,
  deposit_paid_at TEXT,
  balance_paid_at TEXT,
  notes TEXT,
  anonymized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_booking_per_day ON bookings(event_date)
  WHERE status IN ('pending_review', 'awaiting_deposit', 'confirmed', 'blocked');

CREATE TABLE booking_history (
  id INTEGER PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,                  -- client, owner, system, stripe
  event TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id),
  dedupe_key TEXT NOT NULL UNIQUE,      -- ex. b42:d-7:telegram, évite tout doublon
  channel TEXT NOT NULL,                -- email, telegram
  recipient TEXT NOT NULL,              -- owner, client
  template TEXT NOT NULL,
  due_at TEXT NOT NULL,
  sent_at TEXT,
  cancelled_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,  -- un essai est compté quand un passage réserve l'envoi
  last_error TEXT,
  claimed_until TEXT                    -- envoi réservé par un passage jusqu'à cet instant (UTC), migration 0002
);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,                 -- ex. last_cron_run
  value TEXT NOT NULL
);
```

L'index unique est la seule garantie contre la double réservation. Le calendrier affiché n'est qu'une aide : s'il est en retard, l'insertion échoue et le client voit « Cette date vient d'être prise », avec le calendrier à jour.

**Sauvegarde :** Time Travel permet de restaurer D1 à n'importe quelle minute des 30 derniers jours. Le point du lundi garde en plus une copie de la liste des prestations à venir dans les e-mails du propriétaire.

## 4. Parcours de réservation

### États

| État | Date bloquée | Échéance | Sorties |
|---|---|---|---|
| `pending_review` | Oui | 72 h | Validation : `awaiting_deposit`. Refus : `refused`. Sans réponse : `expired` |
| `awaiting_deposit` | Oui | 72 h après la validation | Paiement : `confirmed`. Non-paiement : `expired`. Annulation : `cancelled` |
| `confirmed` | Oui | Aucune | Annulation par le propriétaire : `cancelled` |
| `blocked` | Oui | Aucune | Le propriétaire peut la retirer (`cancelled`) |
| `refused`, `expired`, `cancelled` | Non | Aucune | États finaux |

Une date passée reste dans son état : « terminée » n'est pas un état, mais une lecture de la date.

### Réglages (`config/offer.json`)

| Réglage | Valeur |
|---|---|
| Délai de validation | 72 h, rappels au propriétaire à 24 h et à 48 h |
| Délai de paiement | 72 h, rappel au client 24 h avant la fin |
| Délai minimum avant l'événement | 7 jours, pour que les deux délais tiennent toujours avant la date |
| Horizon de réservation | 24 mois |
| Acompte | Pourcentage du prix, arrondi à l'euro, modifiable à la validation |
| Limites anti-abus | 2 demandes actives par e-mail (à valider ou en attente d'acompte), 5 demandes par adresse IP sur 24 h |

### Demande du client

La page `/reserver` enchaîne trois étapes dans une carte en verre dépoli, sur la vidéo de la borne : date, formule, coordonnées (type d'événement, horaires, lieu, nom, téléphone, e-mail, acceptation des CGV). La formule se choisit en deux temps : la borne, puis le nombre de tirages ; une borne sans formule est montrée « Bientôt disponible », sans pouvoir être choisie. Le lien « Choisir le … » d'une borne de l'accueil ouvre `/reserver?borne=<id>` avec la borne présélectionnée.

Le calendrier désactive les dates avant le délai minimum et au-delà de l'horizon, et barre les dates indisponibles. Il ne montre jamais pourquoi une date est prise.

À l'envoi, le Worker vérifie Turnstile, les limites et les champs, puis insère la réservation en `pending_review` avec une échéance à 72 h. Une violation de l'index renvoie une réponse 409. Les notifications sont mises en file dans la même opération.

### Validation

Le propriétaire valide ou refuse depuis Telegram ou l'administration. Le refus demande une confirmation, pour qu'un geste malheureux ne libère pas une date. Valider depuis Telegram garde le prix de la formule ; « Ajuster le prix » ouvre la fiche dans l'administration. La validation fait passer en `awaiting_deposit`, fixe l'échéance à 72 h et envoie le lien de paiement au client.

Le prix reste modifiable tant que l'acompte n'est pas payé. Si une session Stripe est ouverte à ce moment-là, elle est expirée, et le client paie le nouveau montant par le même lien.

### Acompte

Une session Stripe Checkout dure 24 h au plus. Le lien envoyé au client pointe donc vers `/acompte/<jeton>`, qui affiche le récapitulatif et crée une session au clic :

1. Si une session encore ouverte existe, le client y est renvoyé.
2. Sinon, une session est créée avec `expires_at` à 30 minutes, et `hold_until` passe à la plus tardive de sa valeur actuelle et de la fin de session plus 5 minutes.
3. Le webhook `checkout.session.completed`, de signature vérifiée et sans effet s'il est rejoué, fait passer en `confirmed`.
4. Si un paiement arrive pour une réservation qui n'est plus en `awaiting_deposit`, rien n'est écrasé : le propriétaire reçoit une alerte Telegram et un e-mail pour rembourser depuis Stripe.

Après l'échéance, `/acompte/<jeton>` indique au client que la date n'est plus réservée et l'invite à refaire une demande ou à appeler.

### Libération des dates

À chaque passage, la tâche automatique traite les réservations dont l'échéance est dépassée. Si une session Stripe existe, elle la consulte d'abord : payée, la réservation est confirmée ; ouverte, la session est expirée par l'API avant de libérer la date. Le client paie donc toujours pendant que sa date est tenue.

### Ajout manuel et annulation

- **Réservation manuelle :** le propriétaire crée une réservation `confirmed` pour un client qui appelle, sans paiement en ligne, avec le prix et l'acompte saisis à la main. Elle obéit au même index unique et aux mêmes rappels. L'e-mail du client y est facultatif : sans e-mail, seul le propriétaire est prévenu. Le délai minimum ne s'applique pas.
- **Date bloquée :** le propriétaire peut réserver une date pour lui-même (congés, par exemple).
- **Annulation :** seul le propriétaire annule, ce qui libère la date, annule les notifications à venir et prévient le client. Le remboursement éventuel se fait dans Stripe, selon les CGV.

## 5. Notifications

Toutes les notifications passent par la table `notifications`. Elles partent aussitôt quand c'est possible, puis la tâche automatique reprend ce qui reste. Une clé unique empêche tout doublon, et l'état de la réservation est revérifié juste avant chaque envoi.

### Pour le propriétaire

| Moment | Telegram | E-mail | Agenda |
|---|---|---|---|
| Nouvelle demande | Oui, avec Valider, Refuser, Ajuster le prix | Oui | Apparaît comme « À valider » |
| Sans réponse à 24 h, puis 48 h | Oui | | |
| Acompte payé | Oui | Oui | Devient une prestation confirmée |
| Date libérée automatiquement | Oui | Oui | Disparaît |
| J-7, avec le solde restant dû | Oui | Oui | |
| J-1 | Oui | Oui | Alerte du téléphone |
| Chaque lundi : les prestations à venir | Oui | Oui | |

Les rappels datés partent à 9 h, heure de Paris. Un rappel dont l'heure est déjà passée au moment de la confirmation n'est pas créé.

### Pour le client

Accusé de réception, refus éventuel, lien de paiement, rappel 24 h avant la fin du délai, confirmation, avis de libération si le délai est dépassé, avis d'annulation, rappel à J-7.

### Agenda

`/agenda/<jeton>.ics` liste les prestations confirmées et les demandes à valider. Le lien est privé et le jeton peut être remplacé. Une fois abonné, le téléphone garde sa copie et ses alertes même si le site est en panne. La mise à jour peut prendre plusieurs heures, et les alertes dépendent de l'application d'agenda : elles se règlent et se testent une fois sur le téléphone du propriétaire.

### Détection des pannes

- Après 3 échecs d'envoi d'un e-mail au client, le propriétaire reçoit une alerte Telegram.
- Si Telegram échoue, un e-mail part au propriétaire.
- La tâche automatique écrit son dernier passage dans `system_state`, et l'administration l'affiche.
- **Limite assumée :** une panne de la tâche automatique ne peut pas se signaler elle-même. Elle se voit dans l'administration, ou par l'absence du point du lundi, donc jusqu'à une semaine plus tard au pire.

## 6. Administration

Pensée d'abord pour le téléphone, en thème sombre.

- **À traiter :** demandes à valider et acomptes attendus, avec le temps restant.
- **Calendrier :** une vue par mois, avec une couleur par état.
- **Fiche :** coordonnées avec appel en un geste, formule, prix, acompte, solde à marquer « réglé », notes, historique de chaque changement.
- **Actions :** valider, refuser, ajuster le prix, renvoyer le lien de paiement, annuler, ajouter une réservation, bloquer une date.
- **Santé :** heure du dernier passage de la tâche automatique et notifications en échec.

## 7. Vitrine

### Identité

La référence est la DA « Sunset » de la borne (`templates/_theme.css`, `ui/styles/Theme.py` du dépôt `BrotoBooth`). Le PDF « Nuit électrique » est une ancienne piste, à ne pas utiliser. Les jetons de couleur sont repris de `_theme.css` dans un fichier de styles du site ; les pages de galerie de `templates/` ne sont pas réutilisées.

- **Couleurs :** noir nuit `#0B0B0F`, rose `#F2559B` pour l'action, au plus un bouton plein par écran. Orange `#FF8A3D` pour le choix fait, en anneau, jamais en fond portant du texte. Texte blanc partout, jamais de couleur de marque en texte.
- **Polices :** Unbounded 800 pour les titres, 700 pour les boutons d'action, Outfit 400 et 600 pour le reste. Fichiers du dossier `fonts/`, convertis en WOFF2.
- **Surfaces :** cartes en verre dépoli avec un vrai flou d'arrière-plan. Pas de relief en dehors de l'animation du logo.

### Pages

**Accueil (`/`), dans cet ordre, avec les textes de la maquette :**

1. Ouverture : animation du logo, mur de tirages, « Réservez votre photobooth », boutons « Choisir une date » et « Voir la borne ».
2. « Ce que vivent vos invités » : quatre étapes avec les vrais écrans de la borne et une photo des tirages en main.
3. « Un combiné sur le côté ? » : le message audio-vidéo, puis le cadre à votre image, les filtres et le dessin, la boîte à questions annoncée pour bientôt.
4. « Les formules » : une carte par borne de `config/offer.json`, avec ses nombres de tirages et leurs prix, ou « Bientôt disponible. » tant qu'elle n'a pas de formule.
5. La présentation des fondateurs : « On lance notre premier photobooth ! », avec leur vraie photo.
6. « Une date en tête ? » et le dernier bouton de réservation.
7. Pied de page : téléphone, e-mail, réseaux, pages légales.

**Navigation :** logo vers l'accueil, puis La borne, Formules, Réserver. La barre reste visible au défilement et tient sur un téléphone sans menu déroulant. Sur `/reserver`, elle se réduit au logo et à un lien « Accueil ».

**Réservation (`/reserver`) :** la vidéo de la borne en plein écran, sous un voile, et la carte du parcours. Sur ordinateur, la carte se place à droite pour laisser voir la borne.

### Animations

Il n'y en a que trois. Toutes sont désactivées si le visiteur a demandé de réduire les animations.

1. **Le logo coupé, une fois par visite.** Mêmes formes et même minutage que `ui/widgets/BrandLogo.py` : logo grand et centré avec BOOTH ouvert (0,3 s), les moitiés se referment (jusqu'à 0,8 s), rebond et traits d'impact (jusqu'à 1,3 s), départ vers l'en-tête (de 1,4 à 2 s), apparition du contenu (de 1,6 à 2 s). Un clic, un toucher ou un défilement la termine aussitôt. Le contenu est présent dans le HTML dès le départ, et sans JavaScript la page s'affiche directement.
2. **Les tirages lancés.** Au mur, avec les réglages de `ui/widgets/PhotoWall.py` : pas de fondu, vol de 560 ms avec léger rebond, inclinaison de 14° au plus, 9 tirages sur ordinateur et 8 sur téléphone, un tirage renouvelé toutes les 3 secondes environ, à l'arrêt quand le mur n'est plus visible. Les images des sections de l'accueil arrivent de la même façon, une seule fois.
3. **La vidéo de la réservation.** Muette, en boucle aller-retour, en deux versions : 960 px et 3 Mo au plus pour les téléphones ; 1920 px et 8 Mo au plus pour les écrans d'au moins 1024 px, où la version légère, agrandie, paraîtrait floue. Le navigateur ne charge que celle qui convient à l'écran. Elle ne démarre pas si le visiteur a activé l'économie de données : une image fixe la remplace.

### Médias

Tous viennent de `/home/sw0och/Spot_pub_Brotobooth` et du dossier `brand/` :

- **Écrans de la borne :** extraits de `spot_reseau_brotobooth.mp4`.
- **Tirages du mur :** la vraie photo dos à dos et des images des rushs, jusqu'à ce que des photos de vraies soirées les remplacent, avec l'accord des personnes visibles. Remplacer ces images ne touche pas au code.
- **Logo animé :** les morceaux sont générés par un petit script à partir de `logo-blanc.svg`, qui ne se retouche pas à la main.
- **Formats :** images en AVIF ou WebP, de taille adaptée à l'écran.

### Qualité

- **Performance :** le titre est le plus grand élément affiché au chargement, avec un objectif de LCP sous 2,5 s en 4G. Les images du mur se chargent à part et ne bloquent rien.
- **Accessibilité :** cibles tactiles de 44 px au moins, calendrier utilisable au clavier, focus visible, textes alternatifs, contraste vérifié au-dessus du mur et de la vidéo.
- **Référencement :** titres et descriptions, données structurées d'entreprise locale, plan du site. `/admin`, `/acompte` et `/agenda` sont exclus de l'indexation.
- **Sans cookie de mesure :** la v1 ne dépose aucun cookie de suivi et n'a donc pas de bandeau.

## 8. Gestion des erreurs

| Panne | Ce que voit le client | Ce qui se passe |
|---|---|---|
| Date prise entre-temps | « Cette date vient d'être prise », calendrier à jour | Réponse 409, rien d'autre n'est créé |
| API ou D1 indisponible | Le téléphone et l'e-mail à la place du calendrier | Rien n'est perdu, car rien n'a été enregistré |
| Resend ou Telegram indisponible | Rien, la demande est enregistrée | Nouvelles tentatives à chaque passage, alerte après 3 échecs |
| Stripe indisponible sur `/acompte` | Message avec téléphone, date toujours tenue | Le client peut réessayer jusqu'à l'échéance |
| Webhook Stripe perdu ou en retard | Page de confirmation après paiement | La tâche automatique consulte Stripe avant toute libération |
| Paiement sur une réservation expirée | Message de contact | Alerte au propriétaire pour rembourser |

## 9. Sécurité et données personnelles

- **Secrets :** clés Stripe, Resend, jeton Telegram et jeton d'agenda en `wrangler secret`, jamais dans le dépôt.
- **Entrées :** validation côté Worker de chaque champ, avec une longueur maximale. Échappement dans les e-mails, dans Telegram et dans le flux d'agenda.
- **Authentification :** signature Stripe, en-tête secret et liste de chats pour Telegram, Cloudflare Access revérifié par le Worker (`ctx.access` et public attendu). Pas de mot de passe à gérer.
- **En-têtes :** politique de sécurité du contenu sur les pages statiques et dynamiques.
- **Journaux :** aucune donnée personnelle dans les journaux.
- **Minimisation :** seules les données utiles à la prestation sont demandées. L'adresse IP n'est conservée que sous forme d'empreinte salée, et seulement pour les limites.
- **Conservation :** les demandes refusées, expirées ou annulées avant tout acompte sont anonymisées automatiquement au bout de 12 mois. La durée exacte figure dans la politique de confidentialité.
- **Hébergement des données :** D1 dans l'Union européenne, Resend en région européenne. Cloudflare, Stripe, Resend et Telegram sont cités dans la politique de confidentialité, Telegram recevant le nom du client et le lieu.

## 10. Points juridiques à faire valider

Ces points sont à valider par un professionnel avant la mise en ligne.

- **Acompte ou arrhes :** sauf mention contraire, une somme versée d'avance vaut arrhes (article L214-1 du Code de la consommation), et le client peut renoncer en la perdant. Pour un engagement ferme, les CGV parlent explicitement d'acompte.
- **Rétractation de 14 jours :** l'article L221-28, 12°, exclut les activités de loisirs fournies à une date précise. Il reste à déterminer si la location d'un photobooth en relève. Sinon, le parcours et les CGV doivent en tenir compte.
- **Pages obligatoires :** mentions légales, CGV, politique de confidentialité. L'acceptation des CGV est enregistrée avec sa version et sa date.
- **Photos d'invités :** aucune photo d'événement n'est publiée sans l'accord des personnes visibles.

## 11. Tests

- **Machine à états :** tests unitaires purs de `bookings.ts`, avec une horloge injectée pour les échéances.
- **Base réelle :** Vitest avec le pool Workers et D1 local, dont deux insertions simultanées sur une même date et la réutilisation d'une date libérée.
- **Paiement :** Stripe en mode test avec sa CLI : paiement normal, paiement en limite d'échéance, webhook rejoué, webhook perdu, paiement sur réservation expirée.
- **Notifications :** absence de doublons, annulation avec la réservation, reprise après échec, passage à 9 h heure de Paris, changements d'heure.
- **Parcours complet :** Playwright sur Chromium et WebKit, à la taille d'un téléphone et d'un ordinateur, sans animation et avec.
- **Avant l'ouverture :** contrôle d'accessibilité automatique, mesure de performance, un vrai paiement de faible montant remboursé, un e-mail reçu sur une boîte Gmail, le bot sur le téléphone, le flux d'agenda sur le téléphone, un essai sur un vrai téléphone.

## 12. Mise en ligne

1. **Comptes à créer par le propriétaire :** Cloudflare, Stripe (avec les informations de l'entreprise), Resend, et le nouveau bot via @BotFather. Le code ne manipule jamais les identifiants personnels.
2. **DNS de `brotobooth.fr` :** relever toutes les entrées actuelles chez le fournisseur en place, les recréer chez Cloudflare, dont l'entrée de messagerie (`mail.mymail.eu.com`), puis changer les serveurs de noms chez le bureau d'enregistrement. Revenir en arrière consiste à remettre les anciens serveurs de noms.
3. **`photos.brotobooth.fr` :** ce nom est réservé à la galerie de la borne (`deploy/HTTPS.md`) et reste disponible pour elle.
4. **E-mail :** ajouter les entrées SPF et DKIM de Resend sans toucher à l'entrée de messagerie existante.
5. **Publication :** `astro build`, puis `wrangler deploy` après passage des tests.

## 13. Contenus à fournir avant la mise en ligne

- Ce que comprend chaque borne (les formules, nombres de tirages et prix, sont fournies).
- Pourcentage d'acompte.
- Confirmation de la phrase sur l'histoire : « Nous avons construit cette borne nous-mêmes, du meuble en bois au logiciel. C'est notre première, et nous venons l'installer chez vous. »
- Téléphone, e-mail de contact, réseaux.
- Zone de déplacement et règle des frais de déplacement.
- Informations légales de l'entreprise, CGV validées.

Tant que ces contenus manquent, le site peut être développé et testé, mais pas publié.

## 14. Découpage suggéré pour l'implémentation

1. Socle : dépôt git (le dossier n'en est pas encore un, avec `.superpowers/`, `node_modules/`, `.wrangler/` et `.dev.vars` ignorés), projet, D1, machine à états, routes de demande et de disponibilité.
2. Paiement en simulation : `/acompte`, sessions, webhook, libération des dates.
3. Notifications : file d'attente, e-mails, bot Telegram, agenda.
4. Administration.
5. Vitrine : identité, accueil, animations, page de réservation branchée à l'API.
6. Pages légales, contrôles qualité, procédure de mise en ligne.
7. Vrai paiement Stripe, en dernier.

**Paiement réel en dernier (demande du propriétaire, 2026-11-07) :** le propriétaire veut vérifier le fonctionnement du site avant de brancher le vrai système de règlement. Jusque-là, le paiement est simulé : tout le parcours est identique, sans Stripe ni argent réel, et la page de simulation l'indique clairement. Après l'étape 6, l'implémentation s'arrête pour que le propriétaire essaie le site en local. L'étape 7 ne démarre qu'avec son accord. Le mode simulé et les fausses passerelles ne peuvent pas être publiés : le contrôle d'avant publication les refuse.

## Sources

- [Limites de Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits)
- [Routage des fichiers statiques des Workers](https://developers.cloudflare.com/workers/static-assets)
- [Emplacement des données D1](https://developers.cloudflare.com/d1/configuration/data-location/)
- [Time Travel de D1](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Durée d'une session Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create)
- [Faire expirer une session Stripe](https://docs.stripe.com/api/checkout/sessions/expire)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Tarifs Resend](https://resend.com/pricing)
- [Article L214-1 du Code de la consommation](https://french-business-law.com/rench-legislation-art/article-l214-1-of-the-french-consumer-code)
- [Article L221-28 du Code de la consommation](https://french-business-law.com/french-legislation-art/article-l221-28-of-the-french-consumer-code)
