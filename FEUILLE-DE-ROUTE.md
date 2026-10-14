# Feuille de route TriSeason

Ce qui reste à faire, classé par échéance. Mise à jour à chaque pull request.
Les cases cochées passent dans « Fait » en bas de page.

**Légende** — 🧑 = à faire par Nathan (réglage, décision, démarche) · 🤖 = à faire par Claude (code)

---

## Maintenant (en cours)

- [ ] 🧑 Fusionner la PR #24 (archive Strava, import groupé plus solide, phrase de la carte constat) puis recharger le site
- [ ] 🧑 Tester l'**archive Strava** : la demander sur strava.com (Paramètres → Mon compte → Télécharger ou supprimer votre compte → Demander une archive), puis Séances → « Choisir l'archive (.zip) »
- [ ] 🧑 Télécharger les **logos officiels Strava** (developers.strava.com → Guidelines → « Download all assets ») et les déposer dans un dossier `strava/` du dépôt GitHub (« Add files via upload »), pour la demande de validation

## Bientôt (dans le mois)

- [ ] 🤖🧑 **Demande de validation Strava** (pour dépasser 10 utilisateurs, gratuite, délai non garanti) : dès que les logos officiels sont dans le dépôt, Claude remplace le bouton et la mention « Powered by Strava », prépare les captures d'écran et le texte ; Nathan envoie la demande depuis strava.com/settings/api
- [ ] 🤖 *Plus tard* : séances en temps réel avec les alertes Strava (« webhooks »), au lieu d'attendre l'ouverture de l'appli. Demande que le serveur puisse écrire dans Firestore
- [ ] 🤖 *Facultatif* : lancer aussi les tests automatiques sur GitHub à chaque pull request (coche verte / croix rouge avant la fusion). Aujourd'hui ils tournent chaque lundi et à chaque modification faite par Claude
- [ ] 🧑 Répondre aux messages reçus sur tri.season.tracker@gmail.com via la page Aide (et noter ici les problèmes à corriger)
- [ ] 🤖 **Registre des traitements** (document interne demandé par la CNIL, données de santé) : brouillon à partir du modèle CNIL
- [ ] 🧑 Vérifier dans Firebase que *Authentication → Sign-in method → E-mail/Mot de passe* est activé (pour « Mot de passe oublié »), et tester un e-mail de réinitialisation
- [ ] 🧑 *Facultatif* : personnaliser l'e-mail de réinitialisation (*Authentication → Templates*) avec le nom TriSeason

## Dans 3 à 6 mois

- [ ] 🤖 **Comptes inactifs depuis 3 ans** : les lister dans le rapport du lundi (engagement de la politique de confidentialité ; suppression manuelle sur décision de Nathan). Premiers comptes concernés : pas avant 2029
- [ ] 🤖 **Préparer l'offre gratuite / payante dans le code** (savoir quelles pages sont gratuites ou payantes, sans rien faire payer encore)
- [ ] 🧑 Faire relire la page *Confidentialité et mentions légales* par une personne compétente

## Plus tard : idées pour rendre l'appli plus vivante

- [ ] 🤖 **Partage en story** (Instagram, WhatsApp…) : bouton « Partager » sur une séance, une compétition ou la semaine, qui crée une image verticale avec ce que Strava ne montre pas (glucides par heure, ressenti, repas notés 7/7). Image fabriquée sur le téléphone, rien envoyé à un service extérieur. Vérifier si Strava demande sa mention sur l'image pour les séances venues de Strava
- [ ] 🤖 **Parcours des sorties** : tracé simplifié fourni par Strava (ou tiré des fichiers .fit), dessiné sur la fiche de la séance et sur l'image story, sans fond de carte (une vraie carte = service extérieur, à ajouter à la politique de confidentialité). **Après** le découpage du stockage (sinon limite de 1 Mo par compte)
- [ ] 🤖 **Défis entre amis** : défi créé avec un code d'invitation, chacun accepte de partager **seulement son score**, classement simple ; plus tard des défis de club. Demande de nouvelles règles Firebase et une mise à jour de la confidentialité. **Règle Strava** : les séances venues de Strava ne peuvent pas être montrées à d'autres personnes, donc défis sur ce qui est propre à TriSeason (jours de repas notés, hydratation, ressenti) ou sur les séances importées par fichier
- [ ] 🧑 *Avec la version payante* : vraies récompenses avec des partenaires (ex. réductions sur la nutrition sportive)

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
- [ ] 🤖 **Espace coach / nutritionniste** : d'après la 3e simulation (15/10), c'est le plus gros levier restant pour les abonnements (+5 payants sur 100). Même chantier que l'accès nutritionniste ci-dessous
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
| 16/10/2026 | #24 | **Archive Strava** : tout l'historique d'un coup (seul le résumé activities.csv est lu, même pour une archive de plusieurs Go), sans doublon, avec limite de place par compte ; import de fichiers limité à 50 et enregistré en une fois (fin des plantages) ; un seul envoi au cloud à la fois ; phrase de la carte constat réécrite |
| 15/10/2026 | #23 | 3e simulation des 100 clients (de 18 à 26 payants avec la formule D depuis Strava, scan et badges) ; carte **« Ce que Strava ne te montre pas »** sur le Dashboard (ton constat nutrition × séances, ou ce qu'il manque pour l'obtenir) |
| 14/10/2026 | #22 | Heures au format **1h30** partout (Dashboard, Sports, objectifs, Profil, Séances) ; durées de séance, temps de course et records toujours en h:mm:ss |
| 14/10/2026 | #21 | **Défis de la semaine** (2 défis choisis d'après les 4 semaines précédentes : un sport, un nutrition ; série de semaines réussies) sur le Dashboard, et **18 badges** (Profil) : sports, régularité, nutrition, compétitions |
| 14/10/2026 | #20 | Bouton « Actualiser Strava » en haut de la page Séances (visible quand Strava est connecté) |
| 15/10/2026 | #19 | Connexion Strava activée (ID client 287261, serveur Cloudflare `triseason.tri-season-tracker.workers.dev`) ; recherche d'aliments par le serveur |
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
