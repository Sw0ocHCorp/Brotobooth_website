# Rubrique de contact

Date : 2026-11-11. Complète la spec [2026-11-07-site-reservations-design.md](2026-11-07-site-reservations-design.md), dont les règles restent valables (textes pour le client, DA « Sunset », aucune donnée personnelle dans les journaux, rien d'inventé).

## 1. Intention

Un visiteur qui a une question, sans vouloir réserver tout de suite, doit pouvoir joindre Brotobooth simplement : appeler l'un des fondateurs, écrire à l'adresse e-mail, aller sur Instagram, ou envoyer un message par un formulaire. Le propriétaire reçoit chaque message par e-mail et y répond directement.

### Critères de réussite

1. **Aucun message perdu.** Un message envoyé est enregistré avant toute autre chose ; une panne du service d'e-mails retarde l'e-mail, ne le perd pas.
2. **RGPD respecté, sans exception** (exigence du propriétaire) : données minimales, information au moment de la collecte, durée de conservation limitée et appliquée automatiquement, aucun transfert inutile, droits exerçables (section 4).
3. **Rien d'inventé.** Chaque numéro, adresse ou lien n'apparaît que s'il est renseigné dans `config/offer.json`.
4. **Pas un outil de spam.** Le formulaire n'envoie jamais d'e-mail au visiteur ni à une adresse qu'il saisit.
5. **Telegram reste l'outil du propriétaire.** Il sert uniquement au site et à la borne pour prévenir le propriétaire et lui permettre d'agir. Aucun visiteur ne peut le joindre par Telegram : ni lien, ni compte, ni numéro Telegram sur le site, et aucun message de visiteur n'y est transmis.

## 2. Ce que voit le visiteur

- **Emplacement** : une section `#contact` en bas de l'accueil, juste avant le pied de page. Le menu du haut gagne « Contact » (`/#contact`), après « Formules ».
- **Titre et accroche** : « Contact », puis « Une question sur la borne ou sur votre événement ? Écrivez-nous, nous vous répondons par e-mail. »
- **Les moyens directs**, chacun seulement s'il est renseigné :
  - un lien « Appeler {prénom} » (`tel:`) par numéro de `contact.phones` ;
  - une icône WhatsApp (`contact.whatsapp`, lien `https://wa.me/…`), nom accessible « Nous écrire sur WhatsApp » ;
  - chaque lien de `contact.social` : une icône Instagram pour un compte `instagram.com/compte` (le lien ouvre le profil, dans l'application Instagram sur téléphone), nom accessible « @compte sur Instagram » ; un autre réseau garde son texte court (le domaine).
  - Une icône s'affiche seule (SVG inline blanc, caché aux lecteurs d'écran, cible de 44 px au moins), son nom accessible en `aria-label` et en info-bulle. **Aucun lien e-mail** : l'adresse `contact.email` ne s'affiche ni dans la rubrique ni dans le pied de page, qui écrivent les moyens de la même façon.
- **Le formulaire** : « Votre nom » (obligatoire, 120 caractères au plus), « Votre e-mail » (obligatoire), « Votre téléphone (facultatif) », « Votre message » (obligatoire, 2 000 caractères au plus), puis le bouton « Envoyer le message ». Aucun autre champ, aucune case pré-cochée, aucun abonnement.
- **L'information sous le formulaire** (premier niveau, art. 13 RGPD) : « Brotobooth utilise votre nom, votre e-mail, votre téléphone et votre message uniquement pour vous répondre, et les efface au bout de 12 mois. Vos droits et le détail : politique de confidentialité. » (lien vers `/confidentialite#contact`).
- **L'anti-robots** : le même widget Turnstile que la réservation, chargé seulement quand le visiteur commence à remplir le formulaire (premier focus d'un champ), jamais au chargement de l'accueil.
- **Après l'envoi** : le formulaire laisse la place à « Merci, votre message est bien parti. Nous vous répondons par e-mail. » Aucun délai n'est promis.
- **Les erreurs**, chacune à côté de ce qu'elle concerne :
  - un champ refusé : son message sous le champ, comme à la réservation (« Indiquez votre nom. », « Vérifiez votre adresse e-mail. », « Écrivez votre message. ») ;
  - anti-robots refusé : « La vérification anti-robots n'a pas abouti. Réessayez. » ;
  - trop de messages depuis la même connexion (5 en 24 h, la même limite que les demandes) : « Beaucoup de messages sont partis de cette connexion aujourd'hui. Réessayez demain » suivi de `ContactLine` ;
  - réseau ou serveur : « Votre message n'est pas parti. Vérifiez votre connexion, puis réessayez. » suivi de `ContactLine`. Les champs gardent leur contenu.
- Sans JavaScript, la section montre les moyens directs et le formulaire indique d'écrire à l'adresse e-mail.

## 3. Ce que reçoit le propriétaire

- **Un e-mail** (modèle `owner_contact`), envoyé à l'adresse de contact de l'offre (`contact.email`), à `OWNER_EMAIL` si elle est vide ; les autres messages au propriétaire restent sur `OWNER_EMAIL` : objet « Message de {nom} », le message en premier, puis nom, e-mail, téléphone et date de réception. « Répondre » écrit au visiteur (`reply_to` = son adresse). En bas : « Ce message est effacé du site au bout de 12 mois : supprimez cet e-mail à la même échéance. »
- **Pas de Telegram** pour les messages (critère 5). Si l'e-mail échoue trois fois, le bot Telegram du site prévient le propriétaire, par l'alerte de panne qui existe déjà pour les réservations, avec pour seul contenu : « Un message de contact n'a pas pu vous être envoyé par e-mail. Lisez-le dans l'administration, zone Messages. » Aucun nom, adresse ni texte du message ne part chez Telegram.
- **Aucun e-mail au visiteur**, ni accusé de réception ni copie (critère 4).
- **Administration, zone « Messages »** : les messages des 12 derniers mois, du plus récent au plus ancien (date, nom, e-mail, téléphone, message, « Envoyé par e-mail » ou « En attente d'envoi »), chacun avec « Effacer », qui supprime le message et ses envois en attente après confirmation (« Effacer définitivement ce message ? Cela ne se défait pas. »). C'est ainsi que le propriétaire répond à une demande d'accès ou d'effacement.

## 4. RGPD

- **Responsable de traitement** : Brotobooth (mentions légales).
- **Données** : nom, e-mail, téléphone (facultatif), message ; et une empreinte salée de l'adresse IP, seulement pour la limite de 5 messages par 24 h.
- **Finalité** : répondre au message. Aucune autre utilisation : ni prospection, ni lettre d'information, ni publicité, ni transmission à des tiers.
- **Base légale** : l'intérêt légitime de Brotobooth à répondre aux personnes qui le sollicitent, et, quand le message porte sur une réservation, les démarches précontractuelles faites à la demande de la personne (art. 6.1.f et 6.1.b). Pas de consentement à recueillir, donc pas de case à cocher.
- **Durées** :
  - le message et ses coordonnées : **supprimés** (et non anonymisés) 12 mois après leur réception, par la tâche automatique qui anonymise déjà les vieilles demandes, avec leurs envois ;
  - l'empreinte de l'adresse IP : effacée **24 h** après la réception, quand elle ne sert plus à la limite.
- **Destinataires** : le propriétaire seul. Sous-traitants : Cloudflare (hébergement, base D1 dans l'Union européenne, vérification Turnstile) et Resend (envoi de l'e-mail au propriétaire, région européenne). Telegram ne reçoit rien (section 3).
- **Sécurité** : HTTPS, corps JSON uniquement comme pour `POST /api/requests` (un autre site ne peut pas l'envoyer sans autorisation CORS), anti-robots, limite par connexion, aucune donnée personnelle dans les journaux, administration derrière Cloudflare Access.
- **Droits** : accès, rectification, effacement, limitation, opposition, portabilité, par e-mail à l'adresse de contact, réponse sous un mois ; réclamation auprès de la CNIL. Le propriétaire les exerce depuis la zone « Messages ».
- **Politique de confidentialité** : nouvelle section `#contact` « Le formulaire de contact » (données, finalité, base légale, durées, destinataires) ; la description de la page et son introduction parlent aussi des messages ; la liste des prestataires précise que Resend envoie aussi les messages de contact au propriétaire et que Telegram n'en reçoit aucun.
- La politique reste soumise à la validation d'un professionnel avant publication (le commentaire de brouillon de `Legal.astro` bloque déjà la mise en ligne).

## 5. Configuration (`config/offer.json`)

`contact.phone` devient `contact.phones`, une liste ordonnée :

```json
"contact": {
  "phones": [{ "name": "Prénom", "number": "06 00 00 00 00" }],
  "email": "adresse@exemple.fr",
  "whatsapp": "+33 6 00 00 00 00",
  "social": ["https://www.instagram.com/compte"]
}
```

- Le **premier** numéro est celui que citent les phrases du site et des e-mails (`ContactLine`, « Appelez-nous au … ») ; la section Contact et le pied de page montrent tous les numéros avec leur prénom.
- `contact.email` reçoit les messages du formulaire (sans s'afficher sur le site). `contact.whatsapp` est le numéro WhatsApp au format international (« + », au moins 8 chiffres) ; vide, il n'y a pas d'icône WhatsApp.
- `buildOffer` refuse un numéro sans prénom ou un prénom sans numéro, et un numéro WhatsApp qui n'est pas au format international (erreur explicite `config/offer.json`).
- `scripts/check-launch.mjs` bloque la publication sans aucun numéro de contact, ni d'appel (`contact.phones`) ni WhatsApp.
- Les valeurs restent vides tant que le propriétaire ne les a pas fournies (offre provisoire).

## 6. Données et serveur

- **Migration `0004_contact.sql`** : une table `contact_messages` (`id`, `name`, `email`, `phone`, `message`, `ip_hash`, `created_at`) avec un index sur `created_at`, et une colonne nullable `contact_id` sur `notifications`.
- **`POST /api/contact`** : lecture des champs (mêmes règles que la demande pour le nom, l'e-mail et le téléphone ; message obligatoire), Turnstile (une panne du service laisse passer, comme pour les demandes), limite par connexion, puis insertion du message et de son envoi dans un seul lot D1. Réponses : `201 { status: "sent" }`, `422 { error: "invalid", fields }`, `403 { error: "bot" }`, `429 { error: "too_many" }`. L'e-mail part aussitôt (`sendSoon`), sinon à la tâche suivante.
- **La file d'envoi** traite un envoi qui porte un `contact_id` en lisant le message ; un message effacé entre-temps annule l'envoi.
- **La tâche automatique** (celle qui appelle déjà `anonymizeOld`) supprime les messages de plus de 12 mois avec leurs envois, et efface les empreintes IP de plus de 24 h.
- **Administration** : `GET /api/admin/contact` (les messages, avec leur état d'envoi) et `DELETE /api/admin/contact/:id` (contrôle de l'`Origin`, comme les autres écritures de l'administration).

## 7. Tests

- Unitaires : champs refusés ; enregistrement du message et de son envoi ensemble ; aucune écriture sur un robot ou au-delà de la limite ; l'e-mail au propriétaire (objet, contenu, `reply_to` du visiteur, rappel d'effacement) ; aucune donnée du message dans l'alerte Telegram de panne ; nouvel essai après une panne de l'e-mail ; suppression à 12 mois et empreinte effacée à 24 h ; effacement depuis l'administration ; `buildOffer` et la garde de publication pour `contact.phones`.
- e2e Chromium : section et lien du menu ; liens présents seulement s'ils sont renseignés (offre de test) ; Turnstile absent avant le premier focus ; envoi réussi ; chaque erreur à sa place, champs gardés ; zone « Messages » de l'administration et son effacement ; accessibilité automatique de l'accueil.
- Le test de vocabulaire des textes client couvre les nouveaux textes.

## 8. Hors périmètre, à signaler au propriétaire

- **Réservations** : l'empreinte IP d'une demande est gardée jusqu'à l'anonymisation à 12 mois, alors qu'elle ne sert qu'à la limite de 24 h. La raccourcir à 24 h, comme ici, serait plus conforme au principe de minimisation.
- **Réservations** : les alertes Telegram contiennent le nom, le téléphone et le lieu du client (déjà annoncé dans la politique, au titre des transferts hors Union européenne). Le propriétaire peut préférer des alertes sans données personnelles.
- Ces deux points demandent leur propre décision ; ils ne changent pas avec cette rubrique.
