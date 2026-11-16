# Dossier pour Strava : plus de 10 comptes connectés

Aujourd'hui, Strava limite l'appli à **10 sportifs connectés**. Au 16 novembre 2026,
5 des 14 comptes ont déjà connecté Strava. Pour aller au-delà, il faut demander
une augmentation à Strava, qui examine l'appli.

Dans ce dossier :
- `demande-strava.md` : le texte à copier dans le formulaire (en anglais), avec sa traduction ;
- `captures/` : les captures d'écran à joindre (tous les endroits où l'appli montre des données Strava) ;
- `captures.mjs` : refait les captures (Claude le relance après le changement de nom, de logo ou de boutons Strava).

## Ce qu'il manque encore

| Quoi | Qui | Pourquoi |
|---|---|---|
| **Le nouveau nom** | Nathan | Strava regarde que le nom de l'appli (réglé sur strava.com/settings/api) soit le même partout |
| **Le logo** de l'appli | Nathan | Il s'affiche sur la page Strava « Autoriser … ? » et dans la demande |
| **Les logos officiels Strava** : bouton « Connect with Strava » et mention « Powered by Strava » | Nathan les dépose dans un dossier `strava/` du dépôt (« Add files via upload ») | Strava demande ses images officielles. Aujourd'hui l'appli utilise un bouton maison : Claude le remplacera (Profil et questionnaire de bienvenue), puis refera les captures |
| Le nombre de comptes connectés au moment d'envoyer | Claude | Il le compte en lecture seule, comme pour le rapport du lundi |

## Pour envoyer (quand tout est prêt)

1. Sur **strava.com/settings/api** : vérifie que le **nom de l'application**, le
   **site web** et l'**icône** sont à jour (nouveau nom, nouveau logo).
2. Ouvre le formulaire de demande d'augmentation : sur la page de ton appli Strava
   (ou sur developers.strava.com, rubrique « Developer Program »), cherche la
   demande d'augmentation de la limite de sportifs (« athlete capacity »).
3. Copie le texte anglais de `demande-strava.md` (en remplaçant les `[...]`).
4. Joins les 7 captures du dossier `captures/`, dans l'ordre.
5. Envoie, puis note la date dans la feuille de route.

## À savoir

- **Rien n'est garanti** : Strava décide seul, sans délai promis. En 2026, beaucoup
  de développeurs disent attendre plusieurs semaines sans réponse, d'autres ont été
  acceptés en quelques jours, d'autres refusés avec un message type. Les demandes par
  e-mail ne sont pas lues : seulement le formulaire.
- **En attendant**, les testeurs au-delà de 10 peuvent importer leur **archive Strava**
  ou les fichiers de leur montre (page Séances → « Importer des séances »).
- **Abonnement Strava** : depuis juin 2026, Strava demande aux développeurs d'avoir un
  abonnement Strava. Nathan en a un (16 novembre 2026) : à garder tant que l'appli utilise Strava.
- La carte du Dashboard « Ce que Strava ne te montre pas » a été renommée « Ta séance et ta
  nutrition » avant la demande, pour ne pas froisser l'examinateur.
- Nombre demandé : **1 000 sportifs**, pour ne pas avoir à refaire de demande à chaque étape.
- La future idée « Partage en story » ne devra pas montrer de données venues de
  Strava à d'autres personnes sans vérifier les règles Strava (déjà noté dans la
  feuille de route).
