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
  `getNutritionImpact` : croisement nutrition × séances affiché dans Forme).
- `import.js` + `fit-parser.js` : import de fichiers .fit / .gpx / .tcx.
- `auth-guard.js` : connexion Firebase, redirige vers `login.html` si personne
  n'est connecté.
- `style.css` : design system (variables sur `:root`).
- `sw.js` : service worker (réseau d'abord, cache en secours).
- Pages : `index.html` (Dashboard), `sessions.html`, `sport.html`,
  `competitions.html`, `nutrition.html`, `records.html`, `forme.html`,
  `profile.html`, `login.html`.

### Données

- Tout est dans **un seul objet** : `localStorage['triseason_data']`, copié
  dans Firestore sous `users/{uid}` (champ `data`). La copie Firestore fait foi :
  elle est relue à la connexion (`syncFromCloud`), puis chaque `saveData`
  la renvoie (`pushToCloud`).
- `pushToCloud` n'envoie rien tant que les données du compte n'ont pas été lues
  (`cloudLoaded`) : un navigateur vide ne doit jamais écraser le cloud.
- Les séances ne stockent que des résumés (pas de traces GPS).
- Le document `users/{uid}` contient aussi `activeDays` (jours d'ouverture de
  l'appli, via `markActiveToday`) et `lastActive`. `pushToCloud` écrit avec
  `mergeFields: ['data', 'updatedAt']` pour ne pas les effacer : ne jamais
  revenir à un `set()` qui remplace tout le document.
- Durées en **heures décimales**, à la seconde près (`Math.round(sec) / 3600`).
  Temps de course et records en texte `h:mm:ss`.
- Limite à garder en tête : un document Firestore fait **1 Mo maximum**. Avec
  beaucoup d'historique (surtout la nutrition), il faudra un jour découper les
  données (une collection par type), en particulier avant un usage commercial.
- Règles de sécurité Firestore (console Firebase, pas dans le dépôt) : seul
  le propriétaire peut lire/écrire `users/{userId}`. Elles ne couvrent **que ce
  document**, pas d'éventuelles sous-collections : si on découpe les données en
  `users/{uid}/sessions/...`, il faudra ajouter
  `match /users/{userId}/{document=**}` avec la même condition. Un accès
  nutritionniste demandera aussi de nouvelles règles.

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

## Rapport hebdomadaire

`tools/weekly-report/` : script Node en lecture seule (clé de compte de service
dans les variables d'environnement `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`,
clé Resend en secret réseau injecté par le proxy), lancé chaque lundi matin par
une tâche planifiée Claude qui affiche le rapport dans la conversation du
propriétaire et l'envoie par e-mail. Jamais visible dans l'appli. Voir son README. Tests : `npm test` dans ce
dossier.

## Vérifier un changement

Pas de tests automatisés. Servir le dossier (`python3 -m http.server`) et ouvrir
les pages dans Chromium (Playwright) en bloquant `gstatic.com` (Firebase) et le
service worker, avec des données de test dans `localStorage`. Vérifier qu'il
n'y a aucune erreur JavaScript sur chaque page touchée. Pour les dates, tester
avec le fuseau `Europe/Paris`.
