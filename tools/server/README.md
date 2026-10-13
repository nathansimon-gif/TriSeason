# Serveur TriSeason (Cloudflare Workers)

Un tout petit programme en ligne, gratuit, qui fait deux choses :

1. **Strava** : garder la *clé secrète* de l'appli Strava. Le site ne peut pas
   la contenir (tout le monde peut lire le code d'un site). Le serveur s'en sert
   pour obtenir les clés d'accès d'un utilisateur, les renouveler (toutes les
   6 heures) et retirer l'accès à la déconnexion.
2. **Open Food Facts** : relayer la recherche d'aliments vers leur nouvelle
   recherche, plus rapide, qui refuse les appels venant directement d'un site.

Il n'enregistre rien et ne lit aucune séance : ce sont les navigateurs des
utilisateurs qui lisent leurs séances chez Strava.

Fichier à copier : `worker.js`. Test automatique : dans `tools/app-tests`
(« Serveur TriSeason… »).

## Mise en place (une seule fois, environ 10 minutes)

### 1. Créer l'appli Strava
Sur un ordinateur : <https://www.strava.com/settings/api>

| Champ | Valeur |
|---|---|
| Nom de l'application | TriSeason |
| Catégorie | Analyse des performances |
| Site web | l'adresse complète de TriSeason |
| Description | Suivi d'entraînement triathlon et nutrition : TriSeason importe tes séances pour les relier à ce que tu manges et à ta forme. |
| Domaine du rappel d'autorisation | le nom du site seul, ex. `nathansimon-gif.github.io` |
| Icône | `icon-512.png` (racine du dépôt) |

Strava affiche ensuite l'**ID client** (pas secret) et le **secret client**
(secret : ne le colle que dans Cloudflare, étape 3).

### 2. Créer le serveur
1. Créer un compte gratuit sur <https://dash.cloudflare.com/sign-up>.
2. Menu **Compute (Workers)** → **Workers & Pages** → **Create** → **Start with Hello World!**
   (ou « Create Worker »). Nom : `triseason`. **Deploy**.
3. **Edit code** : tout effacer, coller le contenu de `worker.js`, **Deploy**.
4. Noter l'adresse affichée, du type `https://triseason.<ton-nom>.workers.dev`.

### 3. Donner les réglages au serveur
Dans le Worker → **Settings** → **Variables and Secrets** → **Add** :

| Type | Nom | Valeur |
|---|---|---|
| Text | `STRAVA_CLIENT_ID` | l'ID client Strava |
| **Secret** | `STRAVA_CLIENT_SECRET` | le secret client Strava |
| Text | `ALLOWED_ORIGIN` | l'adresse du site sans rien après le nom, ex. `https://nathansimon-gif.github.io` |

Puis **Deploy**.

### 4. Brancher le site
Dans `app.js`, remplir les deux réglages publics (Claude le fait) :

```js
const STRAVA_CLIENT_ID = '12345';
const TS_SERVER_URL = 'https://triseason.<ton-nom>.workers.dev';
```

Tant qu'ils sont vides, la carte Strava n'apparaît pas dans Profil et la
recherche d'aliments interroge directement Open Food Facts.

## Limites à connaître
- **Strava** : 10 utilisateurs connectés possibles tout de suite. Au-delà, faire
  la demande de validation sur la page de l'appli Strava (gratuite, délai non
  garanti). L'abonnement Strava du compte qui a créé l'appli doit rester actif.
- **Cloudflare (gratuit)** : 100 000 appels par jour, très au-delà des besoins.
- Les séances arrivent quand l'utilisateur ouvre TriSeason (au plus une
  vérification toutes les 15 minutes par appareil), pas en temps réel.
