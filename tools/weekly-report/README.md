# Rapport hebdomadaire TriSeason

Script en **lecture seule** qui résume l'activité de la semaine écoulée (lundi →
dimanche, heure de Paris) : comptes et nouveaux inscrits, utilisateurs actifs par
jour, lectures/écritures Firestore, séances et repas saisis, taille du plus gros
compte. Il n'est jamais servi par le site.

## Mise en place (une seule fois)

1. **Créer un compte de service** dans la console Google Cloud du projet
   `triseason-3c80c` : *IAM et administration → Comptes de service → Créer*.
   Nom : `rapport-hebdo`. Lui donner **uniquement** ces rôles :
   - *Lecteur Firebase Authentication* (`roles/firebaseauth.viewer`)
   - *Lecteur Cloud Datastore* (`roles/datastore.viewer`)
   - *Lecteur Monitoring* (`roles/monitoring.viewer`)
2. Sur ce compte : *Clés → Ajouter une clé → JSON*. Un fichier se télécharge.
3. Dans les réglages de l'environnement Claude Code (menu de l'environnement
   cloud → *Modifier*), ajouter une variable **`FIREBASE_SA_KEY`** dont la valeur
   est **tout le contenu** du fichier JSON. Ne jamais coller cette clé dans une
   conversation ni dans le dépôt.
4. Supprimer le fichier téléchargé de ton ordinateur une fois ajouté.

Pour couper l'accès à tout moment : supprimer la clé (ou le compte de service)
dans la console Google Cloud.

## Recevoir le rapport par e-mail (facultatif)

L'environnement Claude ne peut pas envoyer d'e-mail directement (le port d'envoi
de Gmail est bloqué) : le script passe par **Resend**, un service d'envoi gratuit
qui fonctionne par le web.

1. Créer un compte sur resend.com **avec l'adresse qui doit recevoir le
   rapport** (ex. tri.season.tracker@gmail.com). Sans domaine à soi, Resend
   n'envoie qu'à l'adresse du compte : c'est exactement ce qu'on veut.
2. Dans Resend : *API Keys → Create API Key*, permission **Sending access**.
3. Dans les réglages de l'environnement Claude Code :
   - *Accès réseau* : ajouter `api.resend.com` aux domaines autorisés ;
   - variables : `RESEND_API_KEY` = la clé, `REPORT_EMAIL_TO` = l'adresse.
4. Le rapport part alors avec `node report.mjs --email`.

## Lancer à la main

```bash
cd tools/weekly-report
npm install
node report.mjs                 # dernière semaine complète
node report.mjs --email         # idem + envoi par e-mail
node report.mjs --week 2026-10-05   # semaine commençant ce lundi
npm test                        # tests du calcul, sans accès à Firebase
```

## D'où viennent les chiffres

- **Comptes, nouveaux inscrits** : Firebase Authentication.
- **Actifs par jour** : champ `activeDays` du document `users/{uid}`, rempli par
  l'appli une fois par jour à l'ouverture (depuis le 13/10/2026 : pas
  d'historique avant).
- **Lectures / écritures** : API Cloud Monitoring (métriques
  `firestore.googleapis.com/document/read_count`, `write_count`, `delete_count`).
- **Séances, repas, compétitions** : comptés par date dans les données de chaque
  utilisateur.
