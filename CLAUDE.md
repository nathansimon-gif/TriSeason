# TriSeason — notes pour Claude

## Le produit

TriSeason sert à suivre son entraînement et sa nutrition pour améliorer ses
performances sportives (triathlon : natation, vélo, course à pied).

- **Aujourd'hui** : suivre ses séances, performances, records et compétitions,
  comme Strava / Coros / Garmin, **en plus** d'un suivi nutritionnel et d'un
  suivi de forme (charge d'entraînement, fatigue). L'idée qui le distingue :
  **corréler** nutrition, forme et performances, pour voir si la nutrition a un
  impact sur les entraînements.
- **Utilisateurs** : l'appli est déjà testée par plusieurs personnes. Chacun suit
  **sa propre** performance (compte personnel). Les textes s'adressent à
  l'utilisateur (« tes séances »), pas au créateur de l'appli.
- **Plus tard (pas maintenant)** : commercialisation, et un accès pour des
  nutritionnistes qui suivraient la nutrition et les entraînements de leurs
  clients. Ne pas construire ça sans demande, mais éviter les choix qui le
  rendraient difficile.
- **Priorités** : simple à utiliser pour quelqu'un qui découvre l'appli, chiffres
  justes (dates, durées à la seconde, records), données jamais perdues.

## Feuille de route

`FEUILLE-DE-ROUTE.md` (racine) est la to-do list partagée avec le propriétaire,
classée par échéance. **La lire au début de chaque demande** pour situer le
travail, et **la mettre à jour dans chaque pull request** : cocher / déplacer
ce qui est fait dans « Fait » (date + n° de PR), ajouter ce qui est décidé ou
reporté, noter les idées écartées avec leur raison.

## Le propriétaire

Il n'est pas développeur et pousse souvent des fichiers via « Add files via
upload » sur GitHub. Expliquer en français simple, sans jargon. Après une
fusion, lui rappeler de recharger le site.

## Architecture

Site statique (HTML + JS sans framework ni build), installable en PWA. Une page
HTML par écran, chacune avec son `<style>` et son `<script>` en ligne.

- `app.js` : couche de données partagée, exposée via `window.TS` (séances,
  compétitions, records, poids, profil, saisons, synchro des compétitions et
  records automatiques, formats FFTri, helpers de dates et d'allure,
  `getNutritionImpact` : croisement nutrition × séances affiché dans Forme ;
  `FUEL_PRESETS` / `fuelCarbs` : glucides des ravitaillements (valeurs indicatives
  des fabricants, octobre 2026, à mettre à jour si les formules changent) ;
  `getPlans` / `savePlan` / `planStatuses` : séances prévues (`data.plans`), reconnues
  toutes seules quand une séance du même sport existe le même jour ;
  `weeklyChallenges` / `challengeHistory` / `getAchievements` : défis de la
  semaine et badges, calculés à partir des données, seuls les badges déjà
  annoncés sont gardés dans `data.achievements_seen`) ;
  équipement (`data.gear`, `gearRanges` / `gearStats`) : une séance compte pour
  l'équipement de son sport en service ce jour-là (de sa première utilisation à la
  veille du suivant, ou à son retrait), rien n'est stocké sur les séances ;
  option santé « Blessures, maladie et reprise » : `data.health = {consent, periods}`
  et `pain` (0-10) sur les séances, voir RGPD ci-dessous).
- `import.js` + `fit-parser.js` : import de fichiers .fit / .gpx / .tcx (50 au
  plus, enregistrés en une fois avec `TS.saveSessions`) et de l'**archive
  Strava** (`readStravaArchive` : lit seulement `activities.csv` dans le .zip,
  par morceaux ; `TS.planStravaArchive` / `applyStravaArchive` : doublons
  écartés, place limitée à `DATA_MAX_BYTES` en gardant les plus récentes).
- **Strava** (dans `app.js`) : connexion depuis Profil, puis à chaque ouverture
  de l'appli (au plus toutes les 15 min par appareil) le navigateur lit les
  nouvelles activités chez Strava et crée les séances (`strava_id` sur la
  séance, doublons avec un import .fit reliés). Réglages publics
  `STRAVA_CLIENT_ID` et `TS_SERVER_URL` en haut du bloc Strava : vides = carte
  Strava cachée. Jetons dans `data.strava` (retirés de l'export).
- `tools/server/` : petit serveur Cloudflare Workers (gratuit) qui garde la clé
  secrète Strava (échange et renouvellement des jetons, déconnexion) et relaie
  la recherche Open Food Facts. N'enregistre rien. Mise en place : son README.
- `auth-guard.js` : connexion Firebase, redirige vers `login.html` si personne
  n'est connecté.
- `style.css` : design system (variables sur `:root`).
- `sw.js` : service worker (réseau d'abord, cache en secours).
- **Tirer pour actualiser** (`initPullToRefresh`, app.js) : seulement dans l'appli
  installée (`navigator.standalone` ou `display-mode: standalone`) ; en haut de
  page, hors fenêtre ouverte : synchro Strava forcée (10 s max) puis rechargement.
- Pages : `index.html` (Dashboard), `sessions.html`, `sport.html`,
  `competitions.html`, `nutrition.html`, `records.html`, `forme.html`,
  `profile.html`, `login.html`, et deux pages publiques sans connexion :
  `confidentialite.html` et `aide.html` (FAQ + contact par e-mail vers
  tri.season.tracker@gmail.com, sans aucune donnée de santé jointe).

### Données

- Dans l'appli, tout est dans **un seul objet** : `localStorage['triseason_data']`
  (`getData` / `saveData`, les pages ne voient que lui). Dans Firestore, il est
  **rangé en tiroirs** (`splitData` / `assembleData`) :
  `users/{uid}` (champ `data` = tout sauf séances, repas et ravitaillements,
  `layout: 2`, `drawers` = sommaire `{ clé: empreinte }`),
  `users/{uid}/drawers/sessions-AAAA` (séances de l'année, ou `sessions-AAAA-MM`
  si l'année dépasse ~900 Ko), `users/{uid}/drawers/nutrition-AAAA-MM` (repas et
  ravitaillements du mois) ; chaque tiroir = `{ json, n, at }` (texte JSON, pour
  une empreinte exacte). La copie Firestore fait foi : relue à la connexion
  (`syncFromCloud` → `readDrawers`, seuls les tiroirs dont l'empreinte diffère de
  la copie locale sont relus), puis chaque `saveData` la renvoie (`pushToCloud` →
  `writeDrawers` : tiroirs modifiés + sommaire, en un seul lot).
- **Déménagement** (`migrateToDrawers`, une fois par compte, à l'ouverture) :
  copie de secours complète dans `users/{uid}/backup/v1` (gardée, supprimée
  seulement sur décision de Nathan, et avec le compte), tiroirs écrits, relus et
  comparés, puis seulement document principal allégé. Si les règles Firebase
  refusent les sous-documents (`drawersBlocked`), l'ancien rangement (tout dans
  `data`) continue de fonctionner. Si `data.sessions` existe dans le document
  principal (appareil resté sur une ancienne version), il fait foi et il est
  rangé à nouveau. Règles de référence : `firestore.rules` (à coller dans la console).
- `pushToCloud` n'envoie rien tant que les données du compte n'ont pas été lues
  (`cloudLoaded`) : un navigateur vide ne doit jamais écraser le cloud.
  Un seul envoi à la fois : pendant un envoi, seule la dernière version attend
  (jamais d'enregistrement séance par séance dans une boucle : `saveSessions`).
- Les séances ne stockent que des résumés (pas de traces GPS).
- Le document `users/{uid}` contient aussi `activeDays` (jours d'ouverture de
  l'appli, via `markActiveToday`) et `lastActive`. `pushToCloud` écrit avec
  `mergeFields: ['data', 'updatedAt']` pour ne pas les effacer : ne jamais
  revenir à un `set()` qui remplace tout le document.
- Durées en **heures décimales**, à la seconde près (`Math.round(sec) / 3600`),
  enregistrées arrondies à 6 décimales (`compactSession`) : relire les secondes avec
  `Math.round(h * 3600)`, jamais par comparaison exacte.
- **Séances compactes** (`compactSession`, appliqué à chaque enregistrement et une
  fois aux séances existantes, `data._compact`) : aucun champ vide, pas de
  « · Strava » dans les notes (`strava_id` suffit), pas de nom automatique Strava
  (« Morning Run », « Course à pied le matin »… : `STRAVA_DEFAULT_NAME`).
  Temps de course et records en texte `h:mm:ss`. **Affichage** : durées de
  séance, temps de course et records en `h:mm:ss` ; tous les totaux et moyennes
  d'heures au format `1h30` avec `TS.formatHours` (jamais « 7,5 h »).
- Limites : un document Firestore fait **1 Mo maximum** (d'où les tiroirs) ;
  la copie locale du navigateur ~5 Mo (`dataMaxBytes` : 3,5 Mo avec les tiroirs,
  850 Ko si l'ancien rangement est encore utilisé). Un accès nutritionniste
  demandera de nouvelles règles.
- Règles de sécurité Firestore (console Firebase ; copie dans `firestore.rules`) :
  seul le propriétaire peut lire/écrire `users/{userId}` **et ses sous-documents**
  (`match /users/{userId}/{document=**}`).

## Règles à respecter

1. **Dates** : une date de séance est un jour local `YYYY-MM-DD`. Ne jamais
   utiliser `toISOString()` pour produire une date (passage en UTC, donc un jour
   de décalage en France). Utiliser `TS.localDateStr(date)` et
   `TS.parseLocalDate('YYYY-MM-DD')`.
2. **Version des fichiers** : chaque page charge `app.js`, `import.js`,
   `auth-guard.js`, `fit-parser.js` et `style.css` avec `?v=…`. **À chaque
   modification d'un de ces fichiers, changer ce numéro dans toutes les pages**,
   sinon un navigateur peut mélanger une page récente et un ancien `app.js`
   (pages vides). En cas de grosse modification, passer aussi le cache de
   `sw.js` à la version suivante.
3. **Firebase sur chaque page** (sauf exceptions voulues) : les 3 scripts
   `firebase-*-compat.js` puis `auth-guard.js`, dans le `<head>`, avant
   `app.js`. Sans eux, la page ne lit plus les données du compte.
4. **Design** : pro mais coloré sans excès. Fond ardoise légèrement bleuté,
   IBM Plex, accent citron vert (`--accent`) pour les boutons principaux et
   l'élément actif, couleurs de sport vives (natation bleu, vélo orange, course
   framboise) en touches : barres, fonds teintés `--*-dim`. Pas de dégradés,
   de halos ni d'emojis décoratifs. Utiliser les variables de `style.css` (`--nat`, `--velo`,
   `--run`, `--text-2`…) et le repère `.sport-dot` plutôt que des emojis de sport.
   Les 3 couleurs de sport ont été validées (daltonisme compris) sur le fond
   sombre : ne pas les modifier sans revérifier qu'elles restent distinguables.
5. **Records automatiques** : créés depuis les compétitions (`compRefreshRecordsInData`),
   marqués `auto` + `comp_id`. Ne jamais toucher aux records saisis à la main.

## RGPD et données personnelles

Les données de santé (poids, FC, puissance, ressenti, repas, hydratation) sont
des données sensibles (art. 9) : ne rien ajouter qui les envoie à un tiers sans
le dire dans `confidentialite.html` et sans accord explicite.

- **Copie locale liée à un compte** : `triseason_owner` dans le localStorage.
  `claimLocalData` efface la copie si un autre compte se connecte ;
  `TS_logout` (auth-guard.js) efface les données locales à la déconnexion.
- **Consentement** : `users/{uid}.consent = {healthData, version, at}`. Sans
  consentement à jour, `showConsentGate` bloque l'appli. Augmenter
  `CONSENT_VERSION` (app.js) redemande l'accord à tous, par ex. après une
  modification importante de la politique de confidentialité.
- **Option « Blessures, maladie et reprise »** (page Forme) : accord **séparé**,
  stocké dans `data.health.consent` (`HEALTH_CONSENT_VERSION`). Sans lui, rien
  n'est enregistré (`saveHealthPeriod` refuse, case douleur cachée). Retirer
  l'accord (`TS.disableHealth`) efface `data.health` et tous les `pain`. Pendant
  un arrêt ou une reprise, les défis s'adaptent et la série est en pause
  (`healthWeekPhase`). Uniquement des faits, aucun conseil médical. Un futur accès
  coach/nutritionniste ne doit **jamais** montrer ces informations par défaut.
- **Effacement** : `TS.resetAllData()` (données à zéro, compte gardé) et
  `TS.deleteAccount(password)` (réauthentification, suppression du document
  Firestore puis du compte Auth). Profil → « Supprimer mon compte ».
- **Mot de passe oublié** : `sendPasswordResetEmail` sur login.html (message
  identique que le compte existe ou non).
- `confidentialite.html` : politique de confidentialité, mentions légales,
  conditions d'utilisation. Page publique : **ne pas** y inclure auth-guard.js.
  Éditeur : Nathan SIMON (particulier) ; site sur GitHub Pages ; Firestore en
  région eur3 (UE) ; comptes inactifs supprimés après 3 ans (engagement écrit
  dans la politique, pas encore automatisé).
- **Pas de ressource tierce inutile** : polices IBM Plex servies depuis
  `fonts/` (pas de Google Fonts), Chart.js et ZXing (scan de code-barres, chargé
  seulement au scan) depuis `vendor/` (pas de CDN). Seuls les scripts Firebase
  (gstatic.com) restent externes. Exception voulue : la recherche de produits
  (Nutrition) appelle Open Food Facts, uniquement quand l'utilisateur cherche,
  avec seulement le texte tapé ou le code-barres (écrit dans `confidentialite.html`).
  Même chose pour Strava (api.strava.com, seulement si l'utilisateur l'a connecté)
  et le serveur TriSeason sur Cloudflare.

## Rapport hebdomadaire

`tools/weekly-report/` : script Node en lecture seule (clé de compte de service
dans les variables d'environnement `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`,
clé Resend en secret réseau injecté par le proxy), lancé chaque lundi matin par
une tâche planifiée Claude qui affiche le rapport dans la conversation du
propriétaire et l'envoie par e-mail. Il reprend aussi la feuille de route (fait
la semaine, à faire maintenant, ensuite) : dans le tableau « Fait », mettre la
**vraie date de fusion**. Jamais visible dans l'appli. Voir son README. Tests : `npm test` dans ce
dossier.

## Vérifier un changement

Lancer les tests automatiques avant chaque pull request :
`cd tools/app-tests && npm install && node run.mjs` (navigateur invisible,
Firebase simulé, données de test). Tout doit passer. Ajouter un test dans
`run.mjs` pour chaque bug corrigé ou chaque règle importante (voir son README).
Les mêmes tests tournent chaque lundi à 6h53 et leur résultat figure dans le
rapport hebdomadaire.

Pour un changement visuel, faire aussi une capture d'écran (Playwright) et la
regarder. Pour les dates, tester avec le fuseau `Europe/Paris`.
