# Feuille de route TriSeason

Ce qui reste à faire, classé par échéance. Mise à jour à chaque pull request.
Les cases cochées passent dans « Fait » en bas de page.

**Légende** — 🧑 = à faire par Nathan (réglage, décision, démarche) · 🤖 = à faire par Claude (code)

---

## Maintenant (en cours)

- [ ] 🧑 Fusionner la PR « Repas habituels plus compacts » puis recharger le site

## Bientôt (dans le mois)

- [ ] 🤖 **Tests automatiques sur GitHub** : à chaque pull request, ouvrir toutes les pages et vérifier qu'elles marchent avant la fusion (gratuit avec GitHub Actions)
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

- ~~IA qui donne des conseils nutritionnels ou un plan de course~~ — pas de diplôme pour donner des avis médicaux ou nutritionnels
- ~~Chatbot « coach » sur toutes les pages~~ — même raison, et coûteux
- ~~Offres IA gratuites (Gemini, Mistral)~~ — elles réutilisent les données (données de santé des utilisateurs) et sont souvent interdites pour une appli utilisée en Europe

---

## Fait

| Date | PR | Quoi |
|---|---|---|
| 14/10/2026 | à venir | Repas habituels plus compacts : 2 affichés, « Voir tous les repas habituels » pour la liste complète |
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
