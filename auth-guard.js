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

  // Cache le contenu tant qu'on ne sait pas si la personne est connectée, et
  // affiche à la place un écran de démarrage (logo + roue), qui n'apparaît que
  // si l'attente dépasse ~0,3 s (style.css : html.ts-boot, #tsSplash).
  var root = document.documentElement;
  root.classList.add('ts-boot');
  function showSplash() {
    if (!root.classList.contains('ts-boot') || document.getElementById('tsSplash') || !document.body) return;
    var sp = document.createElement('div');
    sp.id = 'tsSplash';
    sp.setAttribute('role', 'status');
    sp.innerHTML = '<div class="ts-splash__logo"><span class="nav__logo-icon" aria-hidden="true"><i></i></span> TriSeason</div>'
      + '<span class="spinner spinner--lg" aria-hidden="true"></span><div class="ts-splash__txt">Ouverture…</div>';
    document.body.appendChild(sp);
  }
  if (document.body) showSplash(); else document.addEventListener('DOMContentLoaded', showSplash);
  function reveal() {
    root.classList.remove('ts-boot');
    root.style.visibility = 'visible';
    var sp = document.getElementById('tsSplash');
    if (sp) sp.remove();
  }

  // Filet de sécurité : si Firebase ne répond jamais (coupure réseau au tout
  // premier chargement, service non joignable...), on affiche quand même la
  // page plutôt que de la laisser cachée indéfiniment sans explication.
  var settled = false;
  var failSafeTimer = setTimeout(function () {
    if (settled) return;
    console.warn('[TriSeason] Connexion au service de compte trop lente ou indisponible — affichage sans confirmation.');
    reveal();
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
    reveal();
    document.dispatchEvent(new CustomEvent('triseason:auth-ready', { detail: user }));
  });

  // Petite aide réutilisable pour un bouton "Se déconnecter" sur n'importe quelle page.
  // Les données locales sont effacées : sur un appareil partagé, la personne
  // suivante ne doit ni les voir ni pouvoir les récupérer.
  window.TS_logout = function () {
    ['triseason_data', 'triseason_owner', 'triseason_active_day', 'triseason_pending_consent'].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
    });
    firebase.auth().signOut().then(function () {
      location.replace('login.html');
    });
  };
})();
