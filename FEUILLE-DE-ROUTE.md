# Feuille de route TriSeason

Ce qui reste à faire, classé par échéance. Mise à jour à chaque pull request.
Les cases cochées passent dans « Fait » en bas de page.

**Légende** — 🧑 = à faire par Nathan (réglage, décision, démarche) · 🤖 = à faire par Claude (code)

---

## Maintenant (en cours)

- [ ] 🧑 Fusionner la PR #18 (connexion Strava prête, recherche d'aliments plus fiable) puis recharger le site
- [ ] 🧑 **Mettre en place Strava** en suivant `tools/server/README.md` (Claude guide pas à pas) : créer l'appli sur strava.com/settings/api, créer le serveur gratuit Cloudflare, y mettre le secret Strava. Puis envoyer à Claude l'**ID client** et l'adresse du serveur (jamais le secret)
- [ ] 🤖 Remplir `STRAVA_CLIENT_ID` et `TS_SERVER_URL` dans `app.js` ; la carte « Strava » apparaît alors dans Profil
- [ ] 🧑 Tester avec ton compte, puis jusqu'à 9 testeurs (limite Strava sans validation)
- [ ] 🧑 Tester sur ton téléphone la recherche et le scan de produits (Nutrition → Ajouter un repas)

## Bientôt (dans le mois)

- [ ] 🤖🧑 **Demande de validation Strava** (pour dépasser 10 utilisateurs, gratuite, délai non garanti) : avant, remplacer le bouton et la mention « Powered by Strava » par les images officielles de Strava (guide de marque sur developers.strava.com), puis captures d'écran + texte préparés par Claude
- [ ] 🤖 *Plus tard* : séances en temps réel avec les alertes Strava (« webhooks »), au lieu d'attendre l'ouverture de l'appli. Demande que le serveur puisse écrire dans Firestore
- [ ] 🤖 *Sans attendre Strava* : importer d'un coup **toute l'archive Strava** (le fichier .zip que Strava envoie quand on demande ses données) pour récupérer tout l'historique
- [ ] 🤖 *Facultatif* : lancer aussi les tests automatiques sur GitHub à chaque pull request (coche verte / croix rouge avant la fusion). Aujourd'hui ils tournent chaque lundi et à chaque modification faite par Claude
- [ ] 🧑 Répondre aux messages reçus sur tri.season.tracker@gmail.com via la page Aide (et noter ici les problèmes à corriger)
- [ ] 🤖 **Registre des traitements** (document interne demandé par la CNIL, données de santé) : brouillon à partir du modèle CNIL
- [ ] 🧑 Vérifier dans Firebase que *Authentication → Sign-in method → E-mail/Mot de passe* est activé (pour « Mot de passe oublié »), et tester un e-mail de réinitialisation
- [ ] 🧑 *Facultatif* : personnaliser l'e-mail de réinitialisation (*Authentication → Templates*) avec le nom TriSeason

## Dans 3 à 6 mois

- [ ] 🤖 **Comptes inactifs depuis 3 ans** : les lister dans le rapport du lundi (engagement de la politique de confidentialité ; suppression manuelle sur décision de Nathan). Premiers comptes concernés : pas avant 2029
- [ ] 🤖 **Préparer l'offre gratuite / payante dans le code** (savoir quelles pages sont gratuites ou payantes, sans rien faire payer encore)
- [ ] 🧑 Faire relire la page *Confidentialité et mentions légales* par une personne compétente

## Dans 1 an, ou quand l'appli grandit

- [ ] 🤖 **Découper le stockage des données** (une collection par type) avant d'approcher la limite de 1 Mo par compte — surveillé chaque lundi dans le rapport (plus gros compte : 19 % en octobre 2026). À faire aussi avant l'accès nutritionniste. Penser à étendre les règles Firestore aux sous-collections
- [ ] 🧑 **Analyse d'impact (AIPD)** si le nombre d'utilisateurs devient important (données de santé à grande échelle)
- [ ] 🧑 *Facultatif* : passer Firebase au forfait Blaze (avec alerte de budget à 1 €) pour avoir les lectures/écritures dans le rapport du lundi — à ton échelle ça reste à 0 €

## Quand l'appli devient payante

- [ ] 🧑 Choisir le découpage : **gratuit** (import des séances, Dashboard, sports, compétitions, records) / **payant** (Forme, Nutrition, IA) — un ou deux forfaits
- [ ] 🤖 Paiement par **Stripe** (gère lui-même les données bancaires) + **conditions générales de vente** avec droit de rétractation
- [ ] 🤖 **IA** (statistique descriptive sur les données de l'utilisateur, jamais de conseil), dans cet ordre :
  1. Saisie des repas en texte libre ou en photo → macros
  2. Bilan de la semaine en quelques phrases (Dashboard)
  3. Commentaire automatique après une séance importée
  - Conditions : fournisseur **payant qui ne réutilise pas les données** (ex. Mistral, hébergé en Europe), petit serveur intermédiaire (Cloudflare Workers gratuit ou Firebase Functions), limite d'usage par utilisateur, **accord de l'utilisateur** avant d'envoyer ses données, mise à jour de la politique de confidentialité
- [ ] 🤖 **Accès nutritionniste** : accord explicite du client, nouvelles règles Firestore, contrat entre l'éditeur et le nutritionniste

## Idées écartées (et pourquoi)

- ~~Connexion directe à Garmin Connect~~ — Garmin a suspendu les nouvelles inscriptions à son programme développeurs (2026). Passer par Strava, où la plupart des montres envoient déjà leurs séances
- ~~Espace coach, appli dans les stores~~ — reporté (pas écarté) : voir « Quand l'appli devient payante »

- ~~IA qui donne des conseils nutritionnels ou un plan de course~~ — pas de diplôme pour donner des avis médicaux ou nutritionnels
- ~~Chatbot « coach » sur toutes les pages~~ — même raison, et coûteux
- ~~Offres IA gratuites (Gemini, Mistral)~~ — elles réutilisent les données (données de santé des utilisateurs) et sont souvent interdites pour une appli utilisée en Europe

---

## Fait

| Date | PR | Quoi |
|---|---|---|
| 15/10/2026 | #18 | **Connexion Strava** prête (Profil → « Connecter avec Strava », séances ajoutées à l'ouverture de l'appli, doublons reliés, lien « Voir sur Strava », déconnexion) + petit serveur Cloudflare (`tools/server`) ; recherche d'aliments : 3 essais et passage par le serveur (Open Food Facts souvent saturé) |
| 14/10/2026 | #17 | Nutrition : recherche de produits du commerce et **scan du code-barres** (Open Food Facts) ; phrase « Strava et Garmin suivent tes séances, TriSeason les relie à ce que tu manges et à ta forme » (connexion + Aide) ; nouvelle simulation des 100 clients |
| 14/10/2026 | #16 | Tests automatiques (20 vérifications) chaque lundi à 6h53, résultat dans le rapport ; page « Aide et contact » (FAQ + e-mail) |
| 14/10/2026 | #15 | Repas habituels plus compacts : 2 affichés, « Voir tous les repas habituels » pour la liste complète |
| 14/10/2026 | #14 | Saisie rapide des repas (favoris, repas habituels, reprendre la veille), hydratation en un clic sur le Dashboard, ressenti demandé après un import, guide « Bien démarrer », identifiants uniques |
| 13/10/2026 | #13 | RGPD : bug de fuite entre comptes, suppression du compte, consentement aux données de santé, mot de passe oublié, page Confidentialité et mentions légales, polices et Chart.js hébergés sur le site |
| 13/10/2026 | #12 | Nutrition et performance : 4 éléments par liste + « Afficher plus » |
| 12/10/2026 | #9–#11 | Rapport hebdomadaire privé (conversation Claude + e-mail), suivi des jours actifs |
| 12/10/2026 | #8 | Nutrition et performance : correction du « 6 / 6 » sans résultat |
| 12/10/2026 | #7 | Direction artistique plus colorée |
| 12/10/2026 | #6 | Carte « Nutrition et performance » (page Forme) + `CLAUDE.md` |
| 12/10/2026 | #5 | Durées à la seconde, records exacts, tri des compétitions |
| 12/10/2026 | #3–#4 | Dashboard vide : connexion au compte rétablie, protection du cloud, ancien `app.js` en cache |
| 12/10/2026 | #1–#2 | Nouveau design sobre, correction du décalage d'un jour dans les semaines |
