# Réserver sans acompte

Date : 2026-11-17. Complète la spec [2026-11-07-site-reservations-design.md](2026-11-07-site-reservations-design.md) ; ses règles restent valables (textes pour le client, rien d'inventé, RGPD, Telegram réservé au propriétaire).

## 1. Intention

Le propriétaire veut ouvrir le site au plus vite, dans les règles, sans démarches lourdes. Il renonce à l'acompte « dans un premier temps » : plus de compte Stripe, plus de paiement en ligne, plus de clause d'acompte gardé. S'il constate des annulations gênantes sur ses premières prestations, il le remettra.

### Critères de réussite

1. **Sans acompte, accepter une demande confirme la date** : le client n'a rien à payer en ligne, il règle le jour de l'événement.
2. **Rien ne parle plus d'acompte au client** : ni la page de réservation, ni les e-mails, ni les CGV (sauf pour dire qu'aucun n'est demandé), ni la politique de confidentialité (plus de Stripe).
3. **Remettre l'acompte tient à un réglage** : `depositPercent` à 25 dans `config/offer.json` rend tout le parcours d'acompte, ses textes et ses contrôles.
4. **Aucune réservation en cours n'est cassée** par le changement de réglage, dans un sens ou dans l'autre.

### Ce que ce n'est pas

- Supprimer le code de l'acompte, la page `/acompte/…` ou le paiement simulé.
- Brancher le vrai paiement Stripe (tâche 20) : il n'est plus nécessaire tant que l'acompte est à 0.
- Changer la validation par le propriétaire, les alertes, les rappels avant l'événement.

## 2. Approches

- **A. Un réglage (retenue).** `depositPercent: 0` signifie « sans acompte ». Le code de l'acompte reste, testé dans les deux modes. Coût : chaque texte existe en deux variantes.
- **B. Supprimer l'acompte du code.** Plus simple aujourd'hui, mais tout serait à refaire le jour où le propriétaire en voudra un : contraire à son intention (« j'en demanderai un si besoin »).
- **C. Garder une étape « je confirme » sans paiement.** Le client cliquerait pour confirmer après l'accord. Une étape de plus pour lui, sans engagement réel : écartée.

Le propriétaire a approuvé le parcours de l'approche A le 2026-11-17 ; le choix technique du réglage est celui de l'assistant.

## 3. Le parcours sans acompte

1. Le client envoie sa demande (inchangé) ; la date est gardée 72 h, le temps de la réponse.
2. Le propriétaire accepte (Telegram ou administration) : la réservation passe **directement à « confirmée »**, sans échéance de paiement. L'acompte enregistré est 0.
3. Le client reçoit l'e-mail de confirmation ; les rappels à 7 jours et à 1 jour sont planifiés comme après un acompte payé.
4. Refus, absence de réponse sous 72 h, annulation : inchangés.

Une réservation est « avec acompte » quand son `deposit_cents` est supérieur à 0 ; c'est elle, et non le réglage du jour, qui décide de ce que disent ses messages. Une demande reçue quand l'acompte était actif et acceptée après son retrait est confirmée sans acompte (acompte remis à 0). Une réservation qui attendait déjà son acompte au moment du changement garde son parcours : elle peut encore être payée ou expirer.

## 4. Les textes sans acompte (au mot près)

- **Page de réservation**, note sous le calendrier : « Rien à payer maintenant. Une fois votre demande envoyée, nous gardons cette date pour vous et nous vous répondons sous 72 h. Si nous pouvons être là, nous vous confirmons votre date par e-mail. Vous réglez le jour de votre événement. »
- **E-mail « demande reçue »**, deuxième paragraphe : « Nous gardons cette date pour vous et nous vous répondons sous 72 h. Rien à payer pour l'instant : si nous pouvons être là, nous vous confirmons votre date par e-mail. »
- **E-mail de confirmation** (objet inchangé : « C'est confirmé pour le … ») : « Bonne nouvelle : nous serons présents à votre événement le … Votre date est confirmée. », puis le récapitulatif de l'événement avec une seule ligne de prix, « Prix, à régler le jour de votre événement », puis la fin habituelle.
- **CGV** :
  - « Votre réservation », dernier paragraphe : « Si nous acceptons, vous recevez un e-mail qui confirme votre date et le prix de votre prestation. Votre réservation est alors conclue. »
  - « Le prix » : « Le prix de votre prestation est celui de la formule choisie, confirmé dans l'e-mail de confirmation. TVA non applicable, art. 293 B du CGI. » ; les recharges « se règlent avec le prix de la prestation ».
  - « Le paiement » (remplace « L'acompte ») : « Aucun acompte ne vous est demandé. Le prix se règle le jour de votre événement, à la fin de la prestation, avec les recharges éventuelles, en espèces, par virement ou par carte bancaire. »
  - « Annulation par vous » : « Vous pouvez annuler votre réservation sans frais. Prévenez-nous dès que possible, pour que la date puisse être proposée à quelqu'un d'autre. »
  - « Annulation par Brotobooth » : « Si nous refusons votre demande, vous n'avez rien à faire. » puis « Si, après avoir confirmé votre date, nous ne pouvons plus être présents à votre événement, nous vous prévenons dès que possible. Vous n'avez rien à régler. »
  - La description de la page dit « paiement » à la place d'« acompte ». La rétractation ne change pas.
- **Politique de confidentialité** : plus de phrase sur le paiement chez Stripe, plus de Stripe parmi les prestataires (« quatre prestataires ») ; Resend envoie « le récapitulatif de votre demande, la confirmation de votre date et les rappels » ; nous utilisons vos données pour « répondre à votre demande, vous envoyer la confirmation de votre date et les rappels » ; une demande reste sans suite « faute de réponse ».

Avec `depositPercent` supérieur à 0, tous ces textes restent ceux d'aujourd'hui.

## 5. Pour le propriétaire

- Administration : le champ « Acompte (€) » et la ligne « Acompte » d'une fiche n'apparaissent que s'il y a un acompte ; la colonne « Acompte attendu » ne s'affiche que si l'acompte est actif ou si une réservation s'y trouve ; l'historique dit « Confirmée ».
- Telegram : une réservation confirmée sans acompte s'annonce « Confirmée » (et non « Validée, acompte reçu »).
- Contrôle d'avant publication : le paiement réel n'est exigé que si `depositPercent` est supérieur à 0.
- Guides : comment remettre l'acompte (réglage, Stripe, relecture des CGV, nouvelle `termsVersion`).

## 6. Tests

- Unitaires dans les deux modes, fixés par le test lui-même (jamais par l'offre réelle) : accepter confirme et planifie les rappels ; acompte actif inchangé ; demande d'avant le changement ; réservation en attente d'acompte toujours payable ; double validation ; aucun message au client ne dit « acompte », « Stripe » ou « payer » sans acompte ; contrôle de publication.
- e2e : le parcours du mode de l'offre réelle ; les tests de l'autre mode sont ignorés avec leur raison.
