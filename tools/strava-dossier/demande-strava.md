# Texte de la demande à Strava (à copier-coller)

Strava lit les demandes en **anglais** : copie le texte anglais dans le formulaire.
La traduction française juste en dessous sert seulement à savoir ce que tu envoies.

Avant d'envoyer, **remplace** :
- `[APP_NAME]` par le nouveau nom de l'appli ;
- `[NB_CONNECTED]` par le nombre de comptes Strava connectés au moment de l'envoi
  (Claude peut le compter : 5 sur 14 comptes au 16 novembre 2026) ;
- `[NB_USERS]` par le nombre de comptes de l'appli (14 au 16 novembre 2026) ;
- l'adresse du site, si elle a changé avec le nouveau nom.

---

## En anglais (à envoyer)

**App name:** [APP_NAME]
**Client ID:** 287261
**Website:** https://nathansimon-gif.github.io/TriSeason/
**Privacy policy:** https://nathansimon-gif.github.io/TriSeason/confidentialite.html
**Contact:** tri.season.tracker@gmail.com
**Requested capacity:** 1,000 connected athletes

**What the app does**

[APP_NAME] is a free web app (installable on a phone) for amateur endurance athletes,
mostly triathletes, runners and cyclists, in France. It connects training with
nutrition: athletes log their meals, hydration and in-race fuelling (carbohydrates
per hour), and the app shows them how nutrition relates to their own sessions
(perceived effort, how they felt, speed compared with their usual pace), their
training load and fatigue. It also tracks races, personal records, training goals
and gear mileage (shoes, bikes).

**How we use Strava data**

- We only use the Strava data needed to build the athlete's own training log:
  the summary of their activities (date, sport type, duration, distance, elevation,
  heart rate, power, calories, activity name). We do not read GPS streams, photos,
  segments, clubs or followers.
- Scopes requested: `read` and `activity:read_all`. Read only: we never write or
  post anything to Strava.
- Strava data is shown **only to the athlete who connected their account**, never
  to other users, never shared, sold or published, and never used to train any
  AI or machine-learning model.
- Syncing happens when the athlete opens the app (at most once every 15 minutes
  per device), and calorie details are fetched for at most 15 recent activities
  per sync, so we stay far below the rate limits.
- Every activity coming from Strava has a "View on Strava" link back to the
  original activity, and the connection card shows "Powered by Strava".
- Athletes can disconnect at any time from their profile (we revoke the token
  with Strava) and choose to keep or delete the sessions imported from Strava.
  Deleting their account deletes everything.
- Tokens are stored in the athlete's own account (Google Firebase, EU region).
  The Strava client secret is never in the app: a small server (Cloudflare
  Workers) only exchanges and refreshes tokens and stores nothing.
- The privacy policy explains all of this to users (in French), and the app
  asks for explicit consent before storing any health-related data (GDPR).

**Why we need more capacity**

The app has [NB_USERS] accounts today and [NB_CONNECTED] of them use the Strava
connection, close to the 10-athlete limit. New testers keep joining by word of
mouth (friends, club members), and most of them record their sessions with a
Garmin, Coros, Polar or Apple Watch that already syncs to Strava: connecting
Strava is the simplest way for them to get their sessions into the app.
Without it, they have to export and import files by hand. We would like
capacity for 1,000 athletes, so that we can keep welcoming new users over the
coming year (club members, then a public launch) without asking again at each
step. The app already stays far below the rate limits (see above), and we will
keep the same usage as it grows.

**Screenshots** (attached): every place where Strava data or the Strava
connection appears in the app.

1. Dashboard: weekly summary and the card "Your session and your nutrition" (latest session next to the nutrition of that day)
2. Sessions list: each activity from Strava with its "View on Strava" link
3. Session details
4. Profile → Settings: Strava connected, last sync, "Disconnect Strava", "Powered by Strava"
5. Profile → Settings: "Connect with Strava" button
6. Welcome screen for new accounts: "Connect with Strava" button
7. Privacy policy: section about the Strava connection

---

## Traduction française (pour toi, à ne pas envoyer)

**Ce que fait l'appli** : appli web gratuite (installable sur téléphone) pour les
sportifs d'endurance amateurs, surtout triathlètes, coureurs et cyclistes, en France.
Elle relie l'entraînement à la nutrition : on note ses repas, son hydratation et ses
ravitaillements (glucides par heure), et l'appli montre le lien avec ses propres
séances (effort ressenti, ressenti, vitesse par rapport à d'habitude), la charge
d'entraînement et la fatigue. Elle suit aussi les courses, les records, les objectifs
et les kilomètres de l'équipement.

**Ce qu'on fait des données Strava** : seulement le résumé des activités (pas de GPS,
photos, segments, clubs, abonnés) ; lecture seule ; montré uniquement à la personne
qui a connecté son compte, jamais partagé, vendu, publié ni utilisé pour entraîner
une IA ; synchro à l'ouverture de l'appli (au plus toutes les 15 minutes) ; lien
« Voir sur Strava » sur chaque séance et mention « Powered by Strava » ; déconnexion
à tout moment (en gardant ou supprimant les séances) ; jetons dans le compte de la
personne (Firebase, UE), clé secrète jamais dans l'appli ; politique de
confidentialité et accord explicite (RGPD).

**Pourquoi plus de place** : [NB_USERS] comptes dont [NB_CONNECTED] avec Strava,
proche de la limite de 10 ; de nouveaux testeurs arrivent par le bouche-à-oreille,
et la plupart ont une montre qui envoie déjà tout à Strava. Demande : 1 000 sportifs,
pour accueillir les nouveaux pendant l'année qui vient (clubs, puis ouverture au public)
sans refaire de demande ; l'appli reste très en dessous des limites d'appels.
