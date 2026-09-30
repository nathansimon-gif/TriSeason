// TriSeason Tracker — Garde d'authentification Firebase
// Inclus sur CHAQUE page, après les 3 scripts Firebase compat (app/auth/firestore).
// - Redirige vers login.html si personne n'est connecté.
// - Redirige loin de login.html si quelqu'un est déjà connecté.
// - Cache la page (visibility:hidden) le temps que l'état de connexion soit connu,
//   pour éviter un flash du contenu avant une redirection éventuelle.
// - Expose window.TS_USER et l'événement 'triseason:auth-ready' pour les pages
//   qui veulent afficher le prénom/email de la personne connectée.
(function () {
  var firebaseConfig = {
    apiKey: "AIzaSyDTTwkZGQG59zLTksNxUcPGjUHOgJ5VYq8",
    authDomain: "triseason-3c80c.firebaseapp.com",
    projectId: "triseason-3c80c",
    storageBucket: "triseason-3c80c.firebasestorage.app",
    messagingSenderId: "852009234217",
    appId: "1:852009234217:web:0b78f59c0d916d32bf1138"
  };

  if (!window.firebase || !firebase.apps) {
    console.error('[TriSeason] SDK Firebase non chargé — vérifie les balises <script> compat.');
    return;
  }
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

  var path = location.pathname;
  var isLoginPage = /\/login\.html$/.test(path) || path.endsWith('login.html');

  // Cache le contenu tant qu'on ne sait pas si la personne est connectée.
  document.documentElement.style.visibility = 'hidden';

  // Filet de sécurité : si Firebase ne répond jamais (coupure réseau au tout
  // premier chargement, service non joignable...), on affiche quand même la
  // page plutôt que de la laisser cachée indéfiniment sans explication.
  var settled = false;
  var failSafeTimer = setTimeout(function () {
    if (settled) return;
    console.warn('[TriSeason] Connexion au service de compte trop lente ou indisponible — affichage sans confirmation.');
    document.documentElement.style.visibility = 'visible';
  }, 8000);

  firebase.auth().onAuthStateChanged(function (user) {
    settled = true;
    clearTimeout(failSafeTimer);
    if (!user && !isLoginPage) {
      location.replace('login.html');
      return;
    }
    if (user && isLoginPage) {
      location.replace('index.html');
      return;
    }
    window.TS_USER = user || null;
    document.documentElement.style.visibility = 'visible';
    document.dispatchEvent(new CustomEvent('triseason:auth-ready', { detail: user }));
  });

  // Petite aide réutilisable pour un bouton "Se déconnecter" sur n'importe quelle page.
  window.TS_logout = function () {
    firebase.auth().signOut().then(function () {
      location.replace('login.html');
    });
  };
})();
