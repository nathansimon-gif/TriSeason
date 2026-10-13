# Tests automatiques TriSeason

Ouvre le site dans un navigateur invisible (Chromium), avec un **faux Firebase**
et des **données de test** : aucune vraie donnée n'est lue ni modifiée.

```bash
cd tools/app-tests
npm install
node run.mjs        # résumé à l'écran + results.json ; code 0 = tout passe, 1 = échec
```

Lancés chaque **lundi à 6h53** (heure de Paris) par la tâche planifiée Claude,
juste avant le rapport hebdomadaire, qui affiche le résultat dans sa section
« Santé de l'appli » (`node report.mjs --tests ../app-tests/results.json`).

## Ce qui est vérifié

- Chaque page (Dashboard, Séances, Sports, Compétitions, Nutrition, Records,
  Forme, Profil, connexion, confidentialité, aide) s'affiche sans erreur.
- Aucun site extérieur n'est contacté à part Firebase (RGPD).
- Toutes les pages chargent la même version des fichiers (sinon : pages vides).
- Une séance du dimanche reste dans sa semaine (bug du décalage d'un jour).
- Durées à la seconde, allure arrondie à la seconde, records automatiques exacts.
- « Nutrition et performance » calcule bien sa comparaison.
- Un import groupé ne fait pas s'écraser des séances (identifiants uniques).
- Déconnexion : plus aucune donnée dans le navigateur ; un autre compte sur le
  même appareil ne récupère pas les données ; fenêtre d'accord sans consentement.

Pour ajouter un test : une fonction `test('nom lisible', async () => { … })`
dans `run.mjs`, qui lève une erreur avec un message clair en cas de problème.
