# Essayer le site chez vous

Ce guide fait parcourir tout le site sur votre ordinateur, sans rien publier ni dépenser. Rien ne sort de la machine : ni e-mail, ni message, ni paiement.

## Lancer l'essai

Dans le dossier du projet :

```bash
npm run demo
```

Après une minute environ (le temps de construire le site), le terminal affiche « Le site d'essai est prêt » avec les adresses utiles. Pour arrêter : `Ctrl+C`.

- Au premier lancement, quatre réservations d'exemple sont posées : une demande à valider, une demande validée qui attend son acompte, une prestation confirmée et une date bloquée.
- La base d'essai est gardée d'un lancement à l'autre, et les exemples vieillissent avec elle : leurs dates se rapprochent et leurs délais de 72 h finissent par passer. Pour repartir d'une base neuve, avec des exemples à jour : `npm run demo:reset`, puis `npm run demo`.

## Quoi essayer, dans l'ordre

**1. L'accueil et son ouverture** : http://localhost:8790/. Le logo s'anime pendant deux secondes ; un clic ou un défilement la termine, et elle ne rejoue pas pendant la même visite (fermez l'onglet pour la revoir). Descendez la page : les images arrivent une à une. Si votre système demande de réduire les animations, rien ne bouge.

**2. Une demande, sur téléphone puis sur ordinateur.** Cliquez sur « Choisir une date » : la date, la formule, puis vos coordonnées. Pour voir la page à la taille d'un téléphone, ouvrez les outils du navigateur (`F12`) puis la vue mobile (`Ctrl+Maj+M`). Faites une demande dans chaque taille, avec une adresse e-mail différente à chaque fois (deux demandes en cours au plus par adresse).

**3. L'administration** : http://localhost:8790/admin/. Aucune connexion n'est demandée en essai. Vos demandes sont dans « À traiter ».

**4. Valider une demande.** Ouvrez-la, puis « Ajuster le prix » : les formules sont encore à 0 € tant que vous n'avez pas choisi leurs prix, et l'acompte se calcule à partir du prix. Enregistrez, puis « Valider ». La demande passe en « Attente d'acompte ».

**5. Le lien de paiement.** La fiche le montre (« Copier le lien »). Le client le reçoit aussi par e-mail : sur http://localhost:8790/demo, le message « Votre acompte pour le … » contient ce lien.

**6. Le paiement simulé.** Ouvrez le lien, cliquez sur « Payer l'acompte », puis « Simuler un paiement réussi » (ou « Abandonner » pour voir ce qui se passe quand le client renonce). La page annonce « Votre date est confirmée ». Dans l'administration, la prestation est « Confirmée », et sur la page de réservation la date est barrée.

**7. Les messages** : http://localhost:8790/demo. Rechargez la page après chaque étape : vous y lisez, du plus récent au plus ancien, les e-mails du client et les messages Telegram que vous auriez reçus, avec leurs boutons.

**8. La tâche automatique.** En vrai, elle passe toutes les 5 minutes : elle libère les dates dont le délai est dépassé, envoie les rappels de 9 h et le point du lundi. Ici, vous la déclenchez en ouvrant http://localhost:8790/cdn-cgi/handler/scheduled (la page répond « ok »). Dans « Santé », en bas de l'administration, « Dernier passage » indique alors « à l'instant ». Tant qu'aucun délai n'est dépassé, elle n'a rien à faire et rien d'autre ne change.

**9. L'agenda.** Le terminal affiche « Le lien de l'agenda ». Ouvrez-le : le navigateur télécharge un fichier d'agenda qui liste les dates tenues (à valider, acompte attendu, prestations, dates bloquées). C'est ce lien que votre téléphone suivra une fois le site en ligne. Il change à chaque lancement de l'essai.

## Ce qui est simulé

| Ce qui est simulé | Ce qui se passe en essai |
|---|---|
| Le paiement | Aucune carte, aucun argent : une page « Simulation » remplace la page de paiement. Le vrai paiement sera branché en dernier, avec votre accord. |
| Les e-mails | Aucun ne part : ils se lisent sur `/demo`. |
| Telegram | Aucun message ne part : ils se lisent aussi sur `/demo`. Les boutons du bot n'agissent pas ; ceux qui ouvrent une fiche fonctionnent. |
| L'anti-robots | Il laisse tout passer et n'appelle aucun service extérieur. |
| La connexion à l'administration | Aucune en essai. En ligne, un code reçu par e-mail sera demandé. |

Les contenus sont encore provisoires : formules à 0 €, contact vide, pages légales avec des passages « [À compléter] ». C'est normal, et c'est ce qui empêche de publier par erreur.
