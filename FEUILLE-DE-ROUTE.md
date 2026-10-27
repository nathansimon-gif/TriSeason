# Feuille de route TriSeason

Ce qui reste à faire, classé par échéance. Mise à jour à chaque pull request.
Les cases cochées passent dans « Fait » en bas de page.

**Légende** — 🧑 = à faire par Nathan (réglage, décision, démarche) · 🤖 = à faire par Claude (code)

---

## Maintenant (en cours)

- [ ] 🧑 Fusionner la PR #52 (musculation dans Sports, défis, objectif d’eau) puis recharger le site
- [ ] 🧑 *Facultatif, plus tard* : pour avoir aussi les lectures / écritures Firebase dans le rapport et ses graphiques, il faut activer la facturation (forfait Blaze, gratuit en dessous des quotas) — à décider ensemble
- [ ] 🧑 Dans un mois environ (fin novembre 2026) : décider avec Claude de supprimer les **copies de secours** de l'ancien rangement (`users/{uid}/backup/v1`), une fois que tout fonctionne

## Bientôt (dans le mois)

**Prochaines tâches, dans cet ordre :**

- [x] 🤖🧑 **1. Ranger les données en plusieurs tiroirs** : fait (PR #43, en service depuis le 24 octobre 2026 : compte de Nathan vérifié, 841 séances et 56 repas identiques à la copie de secours, plus gros document 58 Ko au lieu de 182 Ko). Séances par année, repas et ravitaillements par mois, le reste dans le document principal ; en général **une seule lecture** par ouverture (seuls les tiroirs modifiés sont relus) et un seul envoi par enregistrement ; tout l'historique Strava tient (testé avec 9 000 séances). Plus tard : **parcours** (un tiroir par sortie, ouvert seulement quand on regarde la séance)
- [ ] 🤖🧑 **2. Tests automatiques sur GitHub avant chaque fusion** : à chaque pull request, GitHub lance les tests et affiche une coche verte (tout passe) ou une croix rouge (ne pas fusionner) à côté du bouton de fusion. Gratuit. Aujourd'hui ils tournent chaque lundi et à chaque modification faite par Claude
- [ ] 🤖 **3. Partage en story** (Instagram, WhatsApp…) : bouton « Partager » qui crée une image verticale des résultats, fabriquée sur le téléphone, rien envoyé à un service extérieur. **Le contenu des stories sera précisé ensemble plus tard**, avant de commencer (pistes : une séance, une compétition, le bilan de la semaine, avec ce que Strava ne montre pas : glucides par heure, ressenti, repas notés 7/7). Vérifier si Strava demande sa mention sur l'image pour les séances venues de Strava

**Forme : prendre en compte la santé** (tâches 4 et 5 ; deux options séparées, chacune activée par la personne elle-même dans Profil, désactivée au départ, avec son propre accord coché ; à écrire dans *Confidentialité* ; jamais partagées par défaut avec un futur coach ou nutritionniste ; effaçables d'un coup ; uniquement des faits tirés des données de la personne, **jamais de conseil médical**) :

- [x] 🤖 **4. Blessures, maladie, reprise, grossesse** : fait (PR #34). Reste à faire plus tard :
  - [ ] 🤖 Records : pouvoir marquer une séance faite pendant une blessure ou une grossesse pour ne pas fausser les comparaisons
  - [ ] 🤖 Si l'accès coach / nutritionniste arrive : case à part pour partager (ou non) ces informations, jamais par défaut
- [ ] 🧑 Avant la tâche 5 : demander à une ou deux testeuses ce qu'elles voudraient voir et ce qui les gênerait
- [ ] 🤖 **5. Cycle menstruel** :
  - bouton « Mes règles ont commencé » (jour au choix) ; l'appli calcule la durée moyenne du cycle et la phase du moment ; petits signes du jour à cocher (crampes, fatigue, sommeil…)
  - cas prévus : pilule ou stérilet hormonal, cycle irrégulier, grossesse, ménopause (pas de phases inventées)
  - Forme : phases en légère couleur de fond sur le graphique ; croisement comme pour la nutrition (« pendant tes règles, ressenti moyen 6/10 contre 7,5/10 le reste du mois »)
  - calendrier du Dashboard : petit repère sur les jours de règles prévus, pour placer une compétition ou une grosse séance

**Ensuite :**

- [x] 🧑🤖 **Écrans de chargement** : fait (PR #50)
- [ ] 🤖 **Import .fit automatique par paquets de 50** : l'import de 50 fichiers d'un coup a été testé par Nathan ; au-delà de 50, découper tout seul en paquets successifs au lieu de refuser
- [ ] 🧑🤖 **Choisir ses sports** (à discuter ensemble avant de commencer) : à la création du compte, une page s'ouvre pour cocher les sports qu'on veut suivre (course, vélo, natation, et musculation si on l'ajoute). L'appli n'affiche ensuite que ces sports : Dashboard, Sports, filtres, records, défis, graphiques. Pistes :
  - choix modifiable à tout moment dans Profil ; les comptes existants gardent les 3 sports par défaut
  - rien n'est supprimé : une séance d'un sport non coché (import Strava, montre) reste enregistrée, on demande simplement « Ajouter ce sport à tes sports ? »
  - à décider : un seul sport choisi = l'appli parle de « course à pied » et plus de « triathlon » (textes, compétitions, formats FFTri cachés)
- [ ] 🤖 **Musculation, plus tard** (idées) : objectifs par exercice (« 100 kg au squat »), minuteur de repos entre les séries, séries détaillées (charges différentes à chaque série)

- [ ] 🤖🧑 **Demande de validation Strava** (pour dépasser 10 utilisateurs, gratuite, délai non garanti), en 3 étapes :
  1. 🧑 Télécharger les **logos officiels Strava** (developers.strava.com → Guidelines → « Download all assets »), les déposer dans un dossier `strava/` du dépôt GitHub (« Add files via upload ») et prévenir Claude
  2. 🤖 Claude remplace le bouton « Connecter avec Strava » et la mention « Powered by Strava » par les logos officiels, prépare les captures d'écran et le texte de la demande
  3. 🧑 Envoyer la demande depuis strava.com/settings/api
- [ ] 🤖 *Plus tard* : séances en temps réel avec les alertes Strava (« webhooks »), au lieu d'attendre l'ouverture de l'appli. Demande que le serveur puisse écrire dans Firestore
- [ ] 🧑 Répondre aux messages reçus sur tri.season.tracker@gmail.com via la page Aide (et noter ici les problèmes à corriger)
- [ ] 🤖 **Registre des traitements** (document interne demandé par la CNIL, données de santé) : brouillon à partir du modèle CNIL
- [ ] 🧑 Vérifier dans Firebase que *Authentication → Sign-in method → E-mail/Mot de passe* est activé (pour « Mot de passe oublié »), et tester un e-mail de réinitialisation
- [ ] 🧑 *Facultatif* : personnaliser l'e-mail de réinitialisation (*Authentication → Templates*) avec le nom TriSeason

## Dans 3 à 6 mois

- [ ] 🤖 **Équipement, la suite** (si utile après essai) : choisir l'équipement séance par séance (plusieurs paires en alternance, vélo de route / VTT) ; reprendre automatiquement les chaussures et vélos déclarés dans Strava (champ « gear » des activités) ; seuil en heures pour la combinaison
- [ ] 🤖 **Comptes inactifs depuis 3 ans** : les lister dans le rapport du lundi (engagement de la politique de confidentialité ; suppression manuelle sur décision de Nathan). Premiers comptes concernés : pas avant 2029
- [ ] 🤖 **Préparer l'offre gratuite / payante dans le code** (savoir quelles pages sont gratuites ou payantes, sans rien faire payer encore)
- [ ] 🧑 Faire relire la page *Confidentialité et mentions légales* par une personne compétente

## Plus tard : idées pour rendre l'appli plus vivante

- [ ] 🤖 *Planification, ensuite* : répéter une séance chaque semaine (ex. natation tous les mardis), déplacer une séance prévue en la glissant dans le calendrier, voir les séances prévues de la semaine sur la page Séances

- [ ] 🤖 **Parcours des sorties** : tracé simplifié fourni par Strava (ou tiré des fichiers .fit), dessiné sur la fiche de la séance et sur l'image story, sans fond de carte (une vraie carte = service extérieur, à ajouter à la politique de confidentialité). **Après** le rangement en tiroirs (sinon limite de 1 Mo par compte)
- [ ] 🤖 **Défis entre amis** : défi créé avec un code d'invitation, chacun accepte de partager **seulement son score**, classement simple ; plus tard des défis de club. Demande de nouvelles règles Firebase et une mise à jour de la confidentialité. **Règle Strava** : les séances venues de Strava ne peuvent pas être montrées à d'autres personnes, donc défis sur ce qui est propre à TriSeason (jours de repas notés, hydratation, ressenti) ou sur les séances importées par fichier
- [ ] 🧑 *Avec la version payante* : vraies récompenses avec des partenaires (ex. réductions sur la nutrition sportive)

## Dans 1 an, ou quand l'appli grandit

- [ ] 🧑 **Analyse d'impact (AIPD)** si le nombre d'utilisateurs devient important (données de santé à grande échelle)
- [ ] 🧑 *Facultatif* : passer Firebase au forfait Blaze (avec alerte de budget à 1 €) pour avoir les lectures/écritures dans le rapport du lundi — à ton échelle ça reste à 0 €

## Quand l'appli devient payante

- [ ] 🧑 **Prix conseillés** (rapport du 18/10, à confirmer avec les testeurs) :
  - **Sportifs** : **gratuit** (séances, Strava, Dashboard, sports, compétitions, records, défis et badges) + **« Performance » 2,99 €/mois ou 24,99 €/an** (Nutrition, Forme, carte « Ce que Strava ne te montre pas »). Plus tard, quand l'IA existera : « Performance + IA » autour de 4,99 €/mois
  - **Pros** : **« Pro » 12 €/mois** (10 clients inclus, +1 € par client en plus) et **« Pro + IA » 24 €/mois** (10 clients inclus, +0,50 € par client en plus)
  - Simulateur pour tester d'autres prix : claude.ai/artifact/YbZgjx1DvaoPJkrxahaUzM · rapport : claude.ai/artifact/Cwp3rux55rdrj5FCVZSZTs
- [ ] 🧑 Avant de fixer les prix : poser 4 questions de prix aux testeurs (trop cher / cher / bon marché / trop bon marché), et montrer l'idée de l'espace pro à 3 ou 4 coachs ou nutritionnistes
- [ ] 🤖 Paiement par **Stripe** (gère lui-même les données bancaires) + **conditions générales de vente** avec droit de rétractation
- [ ] 🤖 **IA** (statistique descriptive sur les données de l'utilisateur, jamais de conseil), dans cet ordre :
  1. Saisie des repas en texte libre ou en photo → macros
  2. Bilan de la semaine en quelques phrases (Dashboard)
  3. Commentaire automatique après une séance importée
  - Conditions : fournisseur **payant qui ne réutilise pas les données** (ex. Mistral, hébergé en Europe), petit serveur intermédiaire (Cloudflare Workers gratuit ou Firebase Functions), limite d'usage par utilisateur, **accord de l'utilisateur** avant d'envoyer ses données, mise à jour de la politique de confidentialité
- [ ] 🤖🧑 **Espace pro (coachs et nutritionnistes)** — le plus gros levier pour les abonnements d'après les simulations (environ 7 fois plus que les sportifs, et des centaines de clients amenés dans l'appli). **Après** le rangement des données en tiroirs :
  - **Ce que le pro voit** de chaque client qui l'a accepté : séances, nutrition et hydratation, forme ; les compétitions en option (pas forcément). Jamais sans l'accord du client, qui peut le retirer à tout moment
  - **Son interface**, deux pistes à choisir : (a) l'appli normale, avec un sélecteur pour passer d'un client à l'autre ; (b) une **interface pro** à part, avec un Dashboard différent : liste de ses clients, et pour chacun ses séances, sa nutrition, son hydratation, sa forme
  - **Pour lui-même** : le suivi des séances offert avec tout forfait pro (pour découvrir l'appli comme ses clients), et une **option d'environ 1 à 2 €/mois** pour avoir aussi la nutrition et la forme pour lui (ou incluse dans « Pro + IA ») — à tester dans le simulateur
  - **Comptes clients offerts** : les clients d'un pro utilisent l'appli sans payer (inclus dans le forfait du pro)
  - **IA pour le pro seulement** au début (résumé de la semaine de chaque client, jamais de conseil : c'est le pro qui conseille) ; coût environ 0,30 € par client et par mois, d'où le supplément par client
  - Ce qui fait le plus hésiter les coachs : ne pas pouvoir **créer des séances pour leurs athlètes** (outil du coach, pas un conseil de TriSeason) — à envisager ensuite
  - À prévoir : accord explicite du client, nouvelles règles Firestore (le pro ne lit que les tiroirs autorisés), contrat entre l'éditeur et le pro, mise à jour de la politique de confidentialité

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
| 28/10/2026 | #52 | **Musculation dans Sports, Séances, défis ; eau 1,5 L** : page Sports → Muscu enrichie (charge par exercice, **volume par séance** avec liste déroulante des exercices, heures et séances par mois, effort ressenti, meilleures semaines, objectifs en séances, heures ou kg soulevés) ; Musculation dans « Moyennes par discipline » (Séances) ; **défi bonus de musculation** chaque semaine pour ceux qui en font (séances, kg soulevés, groupes de muscles ou record de charge, ne compte pas pour la série) et 2 badges (10 séances, les 6 groupes de muscles dans la semaine) ; **objectif d'eau 1,5 L par jour**, modifiable (Nutrition → Hydratation → Modifier), utilisé aussi par le défi, le badge et le graphique ; nombres des graphiques au format français |
| 27/10/2026 | #51 | **Musculation (partie 2)** : page Sports → Muscu (séances et kg soulevés par semaine, progression par exercice avec charge max et 1RM estimé, records par exercice) ; section Musculation dans Records ; **carte du corps** dans Forme (face et dos, 15 muscles, plus ou moins foncés selon les séries, répétitions ou kg soulevés, sur 7 jours à 12 mois ; touche une zone pour voir les exercices) ; **message de nouveauté** affiché une seule fois aux comptes qui ont déjà des séances. Corrigé au passage : plus aucun enregistrement possible juste après une déconnexion |
| 27/10/2026 | #51 | **Musculation : exercices sur machines et recherche** : liste passée à ~80 exercices (pec fly, presses, hack squat, Smith machine, poulies, abducteurs / adducteurs…) avec les muscles travaillés ; fenêtre de choix avec recherche (nom, muscle ou « machine », sans se soucier des accents) ; exercice libre rangé dans un groupe de muscles, puis proposé dans « Mes exercices ». **Téléphone** : plus de zoom automatique en touchant un champ ou une liste (le zoom à deux doigts reste possible), plus de fenêtre ou de page qui glisse de côté (sauf le grand tableau des séances, trop large pour l'écran) |
| 27/10/2026 | #50 | **Musculation (partie 1)** : nouveau sport violet ; séance avec exercices rangés par muscles (pectoraux, dos, épaules, bras, jambes, abdos et gainage) + exercices libres, séries × répétitions × kg, tonnage ; « Reprendre la dernière séance » ; comptée dans les heures, la charge et la forme ; séances Strava / montre / .fit de musculation importées (avant : ignorées) ; visible dans les filtres et le planning seulement si on en a fait une |
| 27/10/2026 | #50 | **Écrans de chargement** : écran de démarrage (logo + roue) au lieu d'une page vide pendant la connexion ; cartes « en cours de chargement » quand le compte est relu sur un nouvel appareil ; pastille « Synchronisation… / Enregistré » et message clair hors connexion ; roues de chargement pendant les imports, l'historique Strava, la recherche d'aliments et les boutons Strava |
| 26/10/2026 | #49 | Nutrition : le graphique « 7 derniers jours » montre au choix (liste déroulante, choix gardé) les **kcal consommées par jour avec le besoin du jour** (« Kcal consommées et besoins ») (trait pointillé, même calcul que « Besoins énergétiques », objectif manuel compris) ou le nombre de repas ; nombres au format français ; barres citron vert plus soutenues en mode clair |
| 26/10/2026 | #48 | Test « Archive Strava : date locale » corrigé : il supposait l'heure d'été (course à 22h30 UTC attendue le lendemain) ; course placée à 23h30 UTC, le lendemain à Paris toute l'année. L'appli n'avait pas de bug |
| 25/10/2026 | #47 | Rapport du lundi : **graphiques d'évolution sur 8 semaines** (comptes, utilisateurs actifs, séances, repas ; lectures / écritures Firebase quand Google les fournit), en barres lisibles dans la conversation et dans l'e-mail |
| 25/10/2026 | #46 | Séances : la fenêtre « Noter ressenti et effort » demande aussi l'**effort (RPE 1 à 10)** de chaque séance, à côté du ressenti (RPE déjà noté affiché) ; plus besoin de modifier la séance ensuite |
| 25/10/2026 | #45 | Strava : les **kcal** sont reprises automatiquement (lues dans le détail de chaque activité, car la liste Strava ne les donne pas ; à défaut, travail en kJ du capteur de puissance) ; séances Strava des 30 derniers jours sans kcal complétées, 15 au plus par synchro ; une kcal saisie à la main n'est jamais remplacée |
| 24/10/2026 | #44 | **Mode clair** (Profil → « Apparence » : Sombre, Clair ou Comme le téléphone ; réglage de l'appareil) : palette claire complète, couleurs de sport assombries pour le fond blanc et revérifiées (contraste, daltonisme), boutons citron vert, graphiques et couleurs générées convertis automatiquement ; page de connexion comprise |
| 23/10/2026 | #43 | **Rangement des données en tiroirs** (Firestore) : séances par année, repas et ravitaillements par mois, le reste dans le document principal avec un sommaire ; seuls les tiroirs modifiés sont relus ou réécrits ; déménagement automatique vérifié avec copie de secours ; repli sur l'ancien rangement si les règles Firebase ne sont pas à jour ; effacement et suppression du compte effacent aussi les tiroirs ; historique Strava complet (limite 3,5 Mo au lieu de 850 Ko) ; rapport du lundi adapté ; règles de référence `firestore.rules`. Feuille de route : tâches de Nathan de « Maintenant » cochées (option blessures essayée, nom, planification testée, limite Strava à 10 comptes, serveur Cloudflare, import de 50 fichiers .fit testé) |
| 21/10/2026 | #42 | **Suivi de l'équipement** (Profil → « Équipement ») : chaussures, vélo, combinaison avec date de première utilisation ; km, sorties, heures et D+ comptés à partir de cette date ; un nouvel équipement du même sport prend le relais (l'ancien s'arrête la veille) ; seuil d'alerte choisi (700 km proposé pour les chaussures) avec barre de progression et prévision de la date au rythme des 8 dernières semaines ; repères de durée de vie ; alerte sur le Dashboard à 90 % ; équipement affiché dans le détail du jour |
| 21/10/2026 | #41 | Appli installée sur le téléphone : **tirer vers le bas pour actualiser** (en haut de la page) : nouvelles séances Strava si connecté, puis page rechargée avec les données à jour du compte ; message « Relâche pour actualiser » pendant le geste. Rien ne change dans un navigateur (le geste y existe déjà) |
| 21/10/2026 | #40 | Hydratation : boutons +100, +250 et +500 ml sur le Dashboard et la page Nutrition (le +750 ml est retiré) ; ligne « ml / Ajouter / Réinitialiser » qui dépassait sur téléphone corrigée |
| 21/10/2026 | #39 | Rapport du lundi : nouvelle partie « Feuille de route » (fait la semaine précédente, à faire maintenant avec qui s'en occupe, ensuite dans le mois, nombre d'idées pour plus tard) ; dates du tableau « Fait » corrigées avec les vraies dates de fusion |
| 21/10/2026 | #38 | Feuille de route : « Choisir ses sports » à l'inscription et « Musculation comme sport » ajoutés (à discuter ensemble avant de commencer) |
| 19/10/2026 | #37 | Séances allégées (≈ 16 % de place en moins, plus gros compte ≈ 717 → 600 Ko) : plus de champs vides, durées à 6 décimales (toujours exactes à la seconde), plus de « · Strava » ni de nom automatique Strava (« Morning Run »…) dans les notes ; les noms écrits à la main sont gardés. Les séances déjà enregistrées sont allégées à la prochaine ouverture |
| 19/10/2026 | #36 | Calendrier du Dashboard : la bulle flottante qui cachait la fenêtre du jour est retirée (le détail est dans la fenêtre) |
| 18/10/2026 | #35 | Calendrier du Dashboard : un appui sur un jour montre le détail des séances faites (durée h:mm:ss, distance, allure, D+, FC, puissance, RPE, ressenti, notes, séance prévue reliée), la nutrition du jour, et un bouton « Modifier » qui ouvre la séance ; la planification reste accessible par « + Planifier une séance ce jour-là » |
| 18/10/2026 | #34 | Option **Blessures, maladie et reprise** (Forme) avec un accord à part : périodes (blessure avec zone et sports, maladie, grossesse, après l'accouchement, arrêt), reprise suivie semaine par semaine avec jalons par sport, douleur 0-10 sur les séances pendant une blessure (graphique douleur et volume), fond jaune sur le graphique de forme, défis adaptés et série en pause, retrait de l'accord = tout effacé (Profil). Politique de confidentialité (version 2), Aide et tests mis à jour |
| 17/10/2026 | #33 | Feuille de route : « blessures, reprise, grossesse » et « cycle menstruel » ajoutés dans les prochaines tâches (4 et 5) pour la page Forme |
| 16/10/2026 | #32 | Connexion : œil pour afficher le mot de passe (connexion, création de compte, suppression du compte), « Créer un compte » en grand bouton ; icônes calendrier et horloge des champs date/heure en clair sur toutes les pages |
| 16/10/2026 | #31 | Appli installée sur iPhone : la barre du haut (logo, menu) se place sous l'heure et la batterie au lieu d'être cachée dessous |
| 16/10/2026 | #30 | Appli installée sur le téléphone : page de démarrage et dossier corrects (`manifest.json`), fichiers gardés pour le hors-connexion au bon endroit (`sw.js`, cache v11) |
| 16/10/2026 | #29 | **Planification des séances** : clic sur un jour du calendrier du Dashboard → sport, distance et/ou durée, notes ; la séance faite ce jour-là est reconnue toute seule (« Réalisée », « En partie », « Pas faite »), liste des séances prévues sous le calendrier. Feuille de route : prix conseillés et espace pro |
| 14/10/2026 | #28 | Limite de comptes Strava atteinte : au lieu d'une erreur, message « la connexion à Strava n'est pas encore ouverte à tout le monde, elle arrive bientôt » + bouton vers l'import de l'archive Strava |
| 14/10/2026 | #27 | Ravitaillements : glucides (et protéines) par unité, en un clic — tailles génériques et produits courants (Maurten, SIS, GU, Decathlon, Overstims, Näak, Baouw, Meltonic, Clif, Atlet, Andros Sport, Isostar, Tailwind…), nouveau type « Compote / gourde », chiffre modifiable ; utilisés par la carte du Dashboard |
| 14/10/2026 | #26 | Feuille de route : prochaines tâches (rangement des données en tiroirs, tests GitHub avant chaque fusion, partage en story) ; carte **« Ce que Strava ne te montre pas »** refaite : ta dernière séance avec ce que tu as mangé et bu la veille, le jour même et pendant l'effort (≈ g de glucides par heure), et tes glucides les jours d'entraînement / de repos |
| 14/10/2026 | #25 | « Récupérer tout l'historique » (Profil) ouvre la page Séances avec un **aperçu** des séances à importer (période au choix, doublons écartés) : rien n'est importé avant validation. Bouton « Depuis mon compte Strava » à côté de l'archive. Archive Strava testée par Nathan : ça marche |
| 14/10/2026 | #24 | **Archive Strava** : tout l'historique d'un coup (seul le résumé activities.csv est lu, même pour une archive de plusieurs Go), sans doublon, avec limite de place par compte ; import de fichiers limité à 50 et enregistré en une fois (fin des plantages) ; un seul envoi au cloud à la fois ; phrase de la carte constat réécrite |
| 14/10/2026 | #23 | 3e simulation des 100 clients (de 18 à 26 payants avec la formule D depuis Strava, scan et badges) ; carte **« Ce que Strava ne te montre pas »** sur le Dashboard (ton constat nutrition × séances, ou ce qu'il manque pour l'obtenir) |
| 14/10/2026 | #22 | Heures au format **1h30** partout (Dashboard, Sports, objectifs, Profil, Séances) ; durées de séance, temps de course et records toujours en h:mm:ss |
| 14/10/2026 | #21 | **Défis de la semaine** (2 défis choisis d'après les 4 semaines précédentes : un sport, un nutrition ; série de semaines réussies) sur le Dashboard, et **18 badges** (Profil) : sports, régularité, nutrition, compétitions |
| 14/10/2026 | #20 | Bouton « Actualiser Strava » en haut de la page Séances (visible quand Strava est connecté) |
| 13/10/2026 | #19 | Connexion Strava activée (ID client 287261, serveur Cloudflare `triseason.tri-season-tracker.workers.dev`) ; recherche d'aliments par le serveur |
| 13/10/2026 | #18 | **Connexion Strava** prête (Profil → « Connecter avec Strava », séances ajoutées à l'ouverture de l'appli, doublons reliés, lien « Voir sur Strava », déconnexion) + petit serveur Cloudflare (`tools/server`) ; recherche d'aliments : 3 essais et passage par le serveur (Open Food Facts souvent saturé) |
| 13/10/2026 | #17 | Nutrition : recherche de produits du commerce et **scan du code-barres** (Open Food Facts) ; phrase « Strava et Garmin suivent tes séances, TriSeason les relie à ce que tu manges et à ta forme » (connexion + Aide) ; nouvelle simulation des 100 clients |
| 13/10/2026 | #16 | Tests automatiques (20 vérifications) chaque lundi à 6h53, résultat dans le rapport ; page « Aide et contact » (FAQ + e-mail) |
| 13/10/2026 | #15 | Repas habituels plus compacts : 2 affichés, « Voir tous les repas habituels » pour la liste complète |
| 13/10/2026 | #14 | Saisie rapide des repas (favoris, repas habituels, reprendre la veille), hydratation en un clic sur le Dashboard, ressenti demandé après un import, guide « Bien démarrer », identifiants uniques |
| 13/10/2026 | #13 | RGPD : bug de fuite entre comptes, suppression du compte, consentement aux données de santé, mot de passe oublié, page Confidentialité et mentions légales, polices et Chart.js hébergés sur le site |
| 13/10/2026 | #12 | Nutrition et performance : 4 éléments par liste + « Afficher plus » |
| 12/10/2026 | #9–#11 | Rapport hebdomadaire privé (conversation Claude + e-mail), suivi des jours actifs |
| 12/10/2026 | #8 | Nutrition et performance : correction du « 6 / 6 » sans résultat |
| 12/10/2026 | #7 | Direction artistique plus colorée |
| 12/10/2026 | #6 | Carte « Nutrition et performance » (page Forme) + `CLAUDE.md` |
| 12/10/2026 | #5 | Durées à la seconde, records exacts, tri des compétitions |
| 12/10/2026 | #3–#4 | Dashboard vide : connexion au compte rétablie, protection du cloud, ancien `app.js` en cache |
| 12/10/2026 | #1–#2 | Nouveau design sobre, correction du décalage d'un jour dans les semaines |
