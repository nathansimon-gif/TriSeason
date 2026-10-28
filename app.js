// TriSeason Tracker — Core Data Layer
// localStorage + export/import JSON

const DB_KEY = 'triseason_data';

const DEFAULT_DATA = {
  profile: { name: '', weight: [], height: null, ftp: null, fcmax: null },
  weeks: {},       // { 'YYYY-WW': { nat: {dur,dist,rpe,sessions}, velo: {dur,dist,rpe,sessions}, run: {dur,dist,rpe,sessions}, notes: '' } }
  sessions: [],    // [ { id, date, sport, fc_avg, fc_max, fc_rest, power_avg, power_max, np, duration, distance, rpe, notes } ]
  competitions: [], // [ { id, date, name, type, distance, goal_time, actual_time, notes } ]
  weight: [],      // [ { date, value } ]
};

// ── Storage ──────────────────────────────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return structuredClone(DEFAULT_DATA);
    const parsed = JSON.parse(raw);
    // Merge with defaults to handle missing keys from old versions
    return { ...structuredClone(DEFAULT_DATA), ...parsed };
  } catch { return structuredClone(DEFAULT_DATA); }
}


// ── Migration: data.weeks → data.sessions ────────────────────────────────────
// Converts old manually-entered weekly data into individual sessions
// so the whole site reads from a single source of truth.
function migrateWeeksToSessions() {
  const data = getData();
  if (!data.weeks || Object.keys(data.weeks).length === 0) return;
  if (data._migrated) return; // already done

  const existing = new Set((data.sessions || []).map(s => s._fromWeek));
  let added = 0;

  for (const [weekKey, wk] of Object.entries(data.weeks)) {
    const monday = getWeekMonday(weekKey);
    const dateStr = localDateStr(monday);

    for (const sport of ['nat', 'velo', 'run']) {
      const d = wk[sport];
      if (!d || (!d.dur && !d.dist)) continue;
      const legacyId = `week_${weekKey}_${sport}`;
      if (existing.has(legacyId)) continue;

      const session = {
        id:        legacyId,
        _fromWeek: legacyId,
        date:      dateStr,
        sport:     sport,
        duration:  d.dur      || null,
        distance:  d.dist     || null,
        rpe:       d.rpe      || null,
        fc_avg:    null, fc_max: null, fc_rest: null,
        power_avg: null, power_max: null, np: null,
        notes:     `Importé depuis saisie hebdomadaire S${weekKey}`,
      };
      data.sessions = data.sessions || [];
      data.sessions.push(session);
      added++;
    }
  }

  if (added > 0) {
    data._migrated = true;
    localStorage.setItem('triseason_data', JSON.stringify(data));
    console.log(`[TriSeason] Migration: ${added} séances importées depuis la saisie hebdomadaire.`);
  }
}

// ── Synchronisation cloud (Firestore) par compte ────────────────────────────────
// Le localStorage reste la copie locale rapide et synchrone que tout le reste de
// l'appli continue de lire/écrire sans aucun changement. Cette section ajoute :
//  - un envoi vers Firestore à chaque sauvegarde (saveData), en tâche de fond
//  - une récupération unique depuis Firestore juste après la connexion
let cloudSyncing = false;
// Tant que les données du compte n'ont pas été lues depuis Firestore, on n'envoie
// rien : sinon un appareil au localStorage vide pourrait écraser la saison
// enregistrée dans le cloud avec des données vides.
let cloudLoaded = false;

function getUserDocRef(uid) {
  if (!window.firebase || !firebase.firestore) return null;
  return firebase.firestore().collection('users').doc(uid);
}

function pushToCloud(data) {
  const user = window.TS_USER;
  if (!user) return; // pas connecté (ou pas encore su) : rien à envoyer
  if (!cloudLoaded) return; // données cloud pas encore récupérées : ne pas les écraser
  const ref = getUserDocRef(user.uid);
  if (!ref) return;
  // Un seul envoi à la fois : si des enregistrements arrivent pendant un envoi
  // (import de nombreuses séances), seule la dernière version est envoyée
  // ensuite. Évite des dizaines d'envois complets d'affilée qui saturent la page.
  cloudPending = data;
  if (!cloudSending) sendToCloud(ref);
}
let cloudSending = false, cloudPending = null;

// ── Pastille d'état (sous la barre du haut) : synchronisation, enregistré,
// hors connexion, chargement des données. Discrète, ne bloque rien.
let syncPillTimer = null;
function syncPill(state, text) {
  if (!document.body) return;
  let el = document.getElementById('tsSync');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tsSync'; el.className = 'ts-sync'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  clearTimeout(syncPillTimer);
  if (!state) { el.className = 'ts-sync'; return; }
  // Hors connexion : le message reste affiché tant que le réseau n'est pas revenu
  if (!navigator.onLine && state !== 'offline') state = 'offline';
  const labels = {
    loading: '<span class="spinner"></span>Chargement de tes données…',
    sending: '<span class="spinner"></span>Synchronisation…',
    saved: 'Enregistré',
    error: 'Pas encore enregistré dans le cloud : nouvel essai au prochain enregistrement',
    offline: cloudLoaded ? 'Pas de réseau : tes saisies seront envoyées au retour du réseau'
      : 'Pas de réseau : données de cet appareil affichées. Reconnecte-toi avant de saisir.',
  };
  el.innerHTML = text || labels[state];
  el.className = 'ts-sync ts-sync--on ts-sync--' + state;
  if (state === 'saved') syncPillTimer = setTimeout(() => syncPill(null), 1400);
  if (state === 'error') syncPillTimer = setTimeout(() => syncPill(null), 4500);
}
window.addEventListener('offline', () => syncPill('offline'));
window.addEventListener('online', () => syncPill(cloudSending ? 'sending' : null));
document.addEventListener('DOMContentLoaded', () => {
  if (!navigator.onLine) syncPill('offline');
  else if (document.documentElement.classList.contains('ts-loading-data')) syncPill('loading');
});

async function sendToCloud(ref) {
  cloudSending = true;
  try {
    while (cloudPending || cloudMigrateWanted) {
      if (cloudMigrateWanted) {
        cloudMigrateWanted = false;
        await migrateToDrawers(ref, cloudPending || getData());
        if (!cloudPending) continue;
      }
      const data = cloudPending;
      cloudPending = null;
      syncPill('sending');
      try {
        if (cloudLayout === 2) await writeDrawers(ref, data);
        else await writeSingleDoc(ref, data);
        if (!cloudPending) syncPill(navigator.onLine ? 'saved' : 'offline');
      } catch (err) {
        console.warn('[TriSeason] Échec de la synchronisation cloud :', err.message);
        syncPill('error');
      }
    }
  } finally { cloudSending = false; }
}
// Ancien rangement : tout dans users/{uid}.data. mergeFields : remplace data et
// updatedAt sans toucher aux autres champs (activeDays, consent…).
function writeSingleDoc(ref, data) {
  return ref.set({ data: data, updatedAt: Date.now() }, { mergeFields: ['data', 'updatedAt'] });
}

// ── Rangement en tiroirs (Firestore) ────────────────────────────────────────
// Un document Firestore fait 1 Mo au plus : les données sont réparties en
//  - users/{uid}                     data = tout sauf séances, repas et ravitaillements,
//                                    layout: 2, drawers: { clé: empreinte } (sommaire)
//  - users/{uid}/drawers/{clé}       { json, n, at } : 'sessions-AAAA' (séances de l'année,
//                                    ou 'sessions-AAAA-MM' si l'année dépasse ~900 Ko),
//                                    'nutrition-AAAA-MM' (repas + ravitaillements du mois)
//  - users/{uid}/backup/v1           copie complète de l'ancien rangement (secours,
//                                    supprimée seulement sur décision de Nathan)
// Le contenu d'un tiroir est un texte JSON : son empreinte est exacte d'un appareil
// à l'autre. À l'ouverture, seuls les tiroirs dont l'empreinte a changé sont relus
// (1 lecture en général) ; à l'enregistrement, seuls les tiroirs modifiés sont écrits.
// Dans l'appli (localStorage, pages), rien ne change : un seul objet de données.
let cloudLayout = 2;            // 1 = ancien rangement (un seul document), 2 = tiroirs
let cloudIndex = {};            // sommaire des tiroirs tel qu'il est dans le cloud
let cloudMigrateWanted = false; // déménagement à faire au prochain envoi
let drawersBlocked = false;     // règles Firebase pas encore à jour : on reste sur l'ancien rangement
const DRAWER_MAX_CHARS = 900000;

// Empreinte d'un texte (deux hachages 32 bits + longueur) : sert seulement à
// savoir si un tiroir a changé.
function drawerHash(str) {
  let a = 0x811c9dc5, b = 5381;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return a.toString(36) + b.toString(36) + '-' + str.length.toString(36);
}

// Données de l'appli → { main, drawers: { clé: texte JSON } }
function splitData(data) {
  const main = { ...data };
  delete main.sessions;
  const groups = {};
  const add = (key, field, item) => { const g = groups[key] = groups[key] || {}; (g[field] = g[field] || []).push(item); };
  const ym = (d, n) => (typeof d === 'string' && /^\d{4}-\d{2}/.test(d) ? d.slice(0, n) : 'sans-date');
  const byYear = {};
  (data.sessions || []).forEach(x => { const y = ym(x.date, 4); (byYear[y] = byYear[y] || []).push(x); });
  Object.keys(byYear).forEach(y => {
    // Année trop lourde pour un seul document : un tiroir par mois
    if (JSON.stringify({ sessions: byYear[y] }).length > DRAWER_MAX_CHARS) byYear[y].forEach(x => add('sessions-' + ym(x.date, 7), 'sessions', x));
    else groups['sessions-' + y] = { sessions: byYear[y] };
  });
  if (data.nutrition) {
    const n = { ...data.nutrition };
    (n.meals || []).forEach(m => add('nutrition-' + ym(m.date, 7), 'meals', m));
    (n.fuel || []).forEach(f => add('nutrition-' + ym(f.date, 7), 'fuel', f));
    delete n.meals; delete n.fuel;
    main.nutrition = n;
  }
  const drawers = {};
  Object.keys(groups).sort().forEach(k => { drawers[k] = JSON.stringify(groups[k]); });
  return { main, drawers };
}

// Tiroirs → données de l'appli
function assembleData(main, drawers) {
  const data = { ...main, sessions: [] };
  const meals = [], fuel = [];
  Object.keys(drawers).sort().forEach(k => {
    const g = JSON.parse(drawers[k]);
    if (g.sessions) data.sessions.push(...g.sessions);
    if (g.meals) meals.push(...g.meals);
    if (g.fuel) fuel.push(...g.fuel);
  });
  if (main.nutrition || meals.length || fuel.length) data.nutrition = { ...(main.nutrition || {}), meals, fuel };
  return data;
}

function drawersCol(ref) { return ref.collection('drawers'); }
function drawerDoc(key, json) { return { json, n: (json.match(/"date":/g) || []).length, at: Date.now() }; }
function isPermissionError(err) { return err && (err.code === 'permission-denied' || /permission|insufficient/i.test(err.message || '')); }

// Lecture : document principal déjà lu (v). Seuls les tiroirs dont l'empreinte
// diffère de la copie locale sont relus. Tiroir manquant ou différent du sommaire
// (enregistrement en cours sur un autre appareil) : document principal relu et
// nouvel essai, puis erreur (rien n'est alors envoyé : le cloud n'est jamais écrasé).
// Renvoie { data, index } ; index = null si les données ne sont pas en tiroirs.
async function readDrawers(ref, v, local) {
  const mine = {};
  if (local) { const d = splitData(local).drawers; Object.keys(d).forEach(k => { mine[drawerHash(d[k])] = d[k]; }); }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(v.layout === 2 && v.data && !Array.isArray(v.data.sessions))) return { data: v.data, index: null };
    const index = v.drawers || {};
    const out = {};
    const need = Object.keys(index).filter(k => { if (mine[index[k]]) { out[k] = mine[index[k]]; return false; } return true; });
    const got = await Promise.all(need.map(k => drawersCol(ref).doc(k).get()));
    let ok = true, missing = false;
    const actual = { ...index };
    got.forEach((d, i) => {
      const k = need[i], json = d.exists ? d.data().json : null;
      if (typeof json !== 'string') { ok = false; missing = true; return; }
      if (drawerHash(json) === index[k]) { out[k] = json; mine[index[k]] = json; return; }
      ok = false;
      // Dernier essai : contenu présent mais différent du sommaire (deux appareils au
      // même moment) → on prend le tiroir tel qu'il est ; le sommaire sera réparé au
      // prochain envoi. Un tiroir absent, lui, bloque (rien n'est écrasé).
      if (attempt === 2) { out[k] = json; actual[k] = drawerHash(json); }
    });
    if (ok || (attempt === 2 && !missing)) return { data: assembleData(v.data, out), index: actual };
    if (attempt === 2) break;
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    v = (await ref.get()).data() || {};
  }
  throw new Error('tiroirs incomplets (enregistrement en cours sur un autre appareil ?)');
}

// Envoi : tiroirs modifiés, tiroirs vidés supprimés, puis sommaire dans le document
// principal. Tout dans un seul lot (tout ou rien) quand c'est possible.
async function writeDrawers(ref, data) {
  const { main, drawers } = splitData(data);
  const index = {};
  Object.keys(drawers).forEach(k => { index[k] = drawerHash(drawers[k]); });
  // Sommaire actuel du cloud (un autre appareil a pu enregistrer depuis) : les tiroirs
  // et le sommaire envoyés restent ainsi toujours d'accord (le dernier envoi fait foi,
  // comme avant les tiroirs).
  let remote = cloudIndex;
  try {
    const cur = (await ref.get()).data();
    if (cur && cur.layout === 2 && cur.data && !Array.isArray(cur.data.sessions)) remote = cur.drawers || {};
  } catch (err) { if (!isPermissionError(err)) throw err; }
  const ops = [];
  Object.keys(drawers).forEach(k => { if (remote[k] !== index[k]) ops.push(['set', k]); });
  Object.keys(remote).forEach(k => { if (!(k in drawers)) ops.push(['delete', k]); });
  const mainDoc = [{ data: main, layout: 2, drawers: index, updatedAt: Date.now() }, { mergeFields: ['data', 'layout', 'drawers', 'updatedAt'] }];
  const db = firebase.firestore();
  try {
    for (let i = 0; i < ops.length || i === 0; i += 400) {
      const batch = db.batch();
      ops.slice(i, i + 400).forEach(([op, k]) => op === 'set' ? batch.set(drawersCol(ref).doc(k), drawerDoc(k, drawers[k])) : batch.delete(drawersCol(ref).doc(k)));
      if (i + 400 >= ops.length) batch.set(ref, ...mainDoc); // sommaire en dernier
      await batch.commit();
    }
    cloudIndex = index;
  } catch (err) {
    if (!isPermissionError(err)) throw err;
    // Règles Firebase pas encore à jour : retour à l'ancien rangement, rien n'est perdu.
    drawersBlocked = true; cloudLayout = 1;
    console.warn('[TriSeason] Tiroirs refusés par les règles Firebase : ancien rangement gardé.');
    await writeSingleDoc(ref, data);
  }
}

// Déménagement depuis l'ancien rangement, une seule fois par compte :
// 1. copie de secours complète ; 2. tiroirs écrits sans toucher au document principal ;
// 3. relecture et comparaison ; 4. seulement alors, document principal allégé.
// En cas d'échec, l'ancien rangement reste en place et l'appli continue avec.
async function migrateToDrawers(ref, data) {
  if (drawersBlocked || cloudLayout === 2) return;
  try {
    const backup = ref.collection('backup').doc('v1');
    const b = await backup.get();
    if (!b.exists) await backup.set({ data, at: Date.now() });
    const { drawers } = splitData(data);
    const existing = await drawersCol(ref).get();
    const keys = Object.keys(drawers);
    const db = firebase.firestore();
    const stale = existing.docs.map(d => d.id).filter(k => !(k in drawers));
    const ops = keys.map(k => ['set', k]).concat(stale.map(k => ['delete', k]));
    for (let i = 0; i < ops.length; i += 400) {
      const batch = db.batch();
      ops.slice(i, i + 400).forEach(([op, k]) => op === 'set' ? batch.set(drawersCol(ref).doc(k), drawerDoc(k, drawers[k])) : batch.delete(drawersCol(ref).doc(k)));
      await batch.commit();
    }
    const check = await drawersCol(ref).get();
    const back = {};
    check.docs.forEach(d => { back[d.id] = d.data().json; });
    const same = Object.keys(back).length === keys.length && keys.every(k => back[k] === drawers[k]);
    if (!same) throw new Error('vérification des tiroirs : contenu différent, déménagement annulé');
    cloudIndex = {};                      // les tiroirs sont là ; le sommaire part avec le document principal
    keys.forEach(k => { cloudIndex[k] = drawerHash(drawers[k]); });
    const { main } = splitData(data);
    await ref.set({ data: main, layout: 2, drawers: { ...cloudIndex }, updatedAt: Date.now() },
      { mergeFields: ['data', 'layout', 'drawers', 'updatedAt'] });
    cloudLayout = 2;
    console.info('[TriSeason] Données rangées en tiroirs.');
  } catch (err) {
    if (isPermissionError(err)) drawersBlocked = true;
    console.warn('[TriSeason] Rangement en tiroirs reporté :', err.message);
  }
}

// Effacement : tiroirs et copie de secours (avant le document principal).
async function deleteCloudDrawers(ref, { backupToo = true } = {}) {
  try {
    const db = firebase.firestore();
    const list = (await drawersCol(ref).get()).docs.map(d => drawersCol(ref).doc(d.id));
    if (backupToo) list.push(ref.collection('backup').doc('v1'));
    for (let i = 0; i < list.length; i += 400) {
      const batch = db.batch();
      list.slice(i, i + 400).forEach(r => batch.delete(r));
      await batch.commit();
    }
  } catch (err) {
    if (!isPermissionError(err)) throw err; // règles pas à jour : il n'y a pas de tiroirs
  }
}

// Place disponible pour l'historique : un document (ancien rangement) ou la copie
// locale du navigateur (tiroirs ; ~5 Mo de stockage local, on garde une marge).
function dataMaxBytes() { return cloudLayout === 2 && !drawersBlocked ? 3500 * 1024 : DATA_MAX_BYTES; }

// Note le jour où l'utilisateur ouvre l'appli (une écriture par jour et par
// appareil au plus). Sert uniquement au rapport d'activité : utilisateurs
// actifs par jour (~4 Ko par an et par utilisateur).
const ACTIVE_KEY = 'triseason_active_day';
function markActiveToday(uid) {
  const today = localDateStr();
  try { if (localStorage.getItem(ACTIVE_KEY) === uid + ':' + today) return; } catch {}
  const ref = getUserDocRef(uid);
  if (!ref || !firebase.firestore.FieldValue) return;
  ref.set({
    activeDays: firebase.firestore.FieldValue.arrayUnion(today),
    lastActive: Date.now(),
  }, { merge: true }).then(() => {
    try { localStorage.setItem(ACTIVE_KEY, uid + ':' + today); } catch {}
  }).catch(err => {
    console.warn('[TriSeason] Suivi d’activité non enregistré :', err.message);
  });
}

// ── Données locales liées à un compte ───────────────────────────────────────
// La copie locale porte l'identifiant du compte à qui elle appartient. Si un
// autre compte se connecte sur le même appareil, elle est effacée avant toute
// synchronisation : sinon un nouveau compte « hériterait » des données de la
// personne précédente (et les enverrait dans son propre cloud).
const OWNER_KEY = 'triseason_owner';
const LOCAL_USER_KEYS = [DB_KEY, OWNER_KEY, 'triseason_active_day'];

function clearLocalUserData() {
  LOCAL_USER_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch {} });
}

function claimLocalData(uid) {
  let owner = null;
  try { owner = localStorage.getItem(OWNER_KEY); } catch {}
  try { localStorage.setItem(OWNER_KEY, uid); } catch {}
  if (owner && owner !== uid) {
    clearLocalUserData();
    try { localStorage.setItem(OWNER_KEY, uid); } catch {}
    window.dispatchEvent(new CustomEvent('triseason:update', { detail: getData() }));
  }
}

// ── Consentement (données de santé, RGPD art. 9) ────────────────────────────
// Enregistré dans users/{uid}.consent. Sans consentement à jour, une fenêtre
// bloque l'appli tant que la personne n'a pas accepté (ou s'est déconnectée /
// a supprimé son compte). Changer CONSENT_VERSION redemande le consentement à
// tout le monde (ex. après une modification importante de la politique).
const CONSENT_VERSION = 1;
const PENDING_CONSENT_KEY = 'triseason_pending_consent';

function saveConsent(uid) {
  const ref = getUserDocRef(uid);
  if (!ref) return Promise.resolve();
  return ref.set({ consent: { healthData: true, version: CONSENT_VERSION, at: Date.now() } }, { merge: true });
}

function showConsentGate(uid) {
  if (document.getElementById('consentGate')) return;
  const gate = document.createElement('div');
  gate.id = 'consentGate';
  gate.className = 'consent-gate';
  gate.innerHTML = `
    <div class="consent-gate__box" role="dialog" aria-modal="true" aria-labelledby="consentTitle">
      <div class="consent-gate__title" id="consentTitle">Tes données, ton accord</div>
      <p>TriSeason enregistre des informations liées à ta santé : poids, taille, fréquence cardiaque,
      puissance, ressenti, repas et hydratation. Elles servent uniquement à te fournir ton suivi,
      sont stockées sur ton compte (Google Firebase) et ne sont ni vendues ni partagées.</p>
      <p>Tu peux exporter ou supprimer tes données et ton compte à tout moment depuis ta page Profil.
      <a href="confidentialite.html" target="_blank" rel="noopener">Lire la politique de confidentialité</a></p>
      <label class="consent-gate__check">
        <input type="checkbox" id="consentCheck">
        <span>J'accepte que TriSeason enregistre et utilise mes données de santé pour me fournir le suivi de mon entraînement et de ma nutrition.</span>
      </label>
      <div class="consent-gate__actions">
        <button class="btn btn--ghost btn--sm" id="consentRefuse">Refuser et me déconnecter</button>
        <button class="btn btn--primary" id="consentAccept" disabled>Accepter et continuer</button>
      </div>
      <div class="consent-gate__note">Sans cet accord, l'appli ne peut pas fonctionner. Tu pourras retirer ton accord à tout moment en supprimant ton compte.</div>
    </div>`;
  document.body.appendChild(gate);
  const check = gate.querySelector('#consentCheck');
  const accept = gate.querySelector('#consentAccept');
  check.addEventListener('change', () => { accept.disabled = !check.checked; });
  accept.addEventListener('click', () => {
    accept.disabled = true;
    saveConsent(uid).then(() => gate.remove()).catch(err => {
      accept.disabled = false;
      toast('Accord non enregistré : ' + err.message, 'error');
    });
  });
  gate.querySelector('#consentRefuse').addEventListener('click', () => {
    if (window.TS_logout) window.TS_logout();
  });
}

function checkConsent(uid, doc) {
  const consent = doc && doc.exists ? doc.data().consent : null;
  if (consent && consent.healthData && consent.version >= CONSENT_VERSION) return;
  // Case cochée à l'inscription : on l'enregistre maintenant (le compte existe).
  // Valable 10 minutes : une case cochée lors d'une inscription abandonnée ne
  // doit pas servir d'accord à la personne suivante sur le même appareil.
  let pending = null;
  try { pending = Number(localStorage.getItem(PENDING_CONSENT_KEY)); localStorage.removeItem(PENDING_CONSENT_KEY); } catch {}
  if (pending && Date.now() - pending < 10 * 60 * 1000) {
    saveConsent(uid).catch(() => showConsentGate(uid));
    return;
  }
  const show = () => showConsentGate(uid);
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
}

// ── Effacer ses données / supprimer son compte ──────────────────────────────
// Garde le compte mais remet les données à zéro (cloud compris).
function resetAllData() {
  const fresh = structuredClone(DEFAULT_DATA);
  const st = getData().strava;  // la connexion Strava reste, sans réimporter l'ancien historique
  if (st) fresh.strava = { ...st, after: Math.floor(Date.now() / 1000) };
  saveData(fresh); // les tiroirs vidés sont supprimés à l'envoi
  const user = window.TS_USER, ref = user && getUserDocRef(user.uid);
  if (ref) ref.collection('backup').doc('v1').delete().catch(() => {}); // copie de secours aussi
}

// Supprime définitivement les données cloud puis le compte de connexion.
// Firebase exige une connexion récente : on redemande donc l'identité avant
// (mot de passe, ou fenêtre Google), puis on supprime.
async function deleteAccount(password) {
  const user = firebase.auth().currentUser;
  if (!user) throw new Error('Personne n’est connecté.');
  const providers = user.providerData.map(p => p.providerId);
  if (providers.includes('password')) {
    if (!password) throw Object.assign(new Error('Mot de passe requis.'), { code: 'password-required' });
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, password);
    await user.reauthenticateWithCredential(cred);
  } else if (providers.includes('google.com')) {
    await user.reauthenticateWithPopup(new firebase.auth.GoogleAuthProvider());
  }
  await deleteCloudDrawers(getUserDocRef(user.uid)); // tiroirs et copie de secours d'abord
  await getUserDocRef(user.uid).delete();
  await user.delete();
  clearLocalUserData();
}

function syncFromCloud(uid) {
  if (cloudSyncing) return;
  cloudSyncing = true;
  const ref = getUserDocRef(uid);
  if (!ref) { cloudSyncing = false; return; }
  claimLocalData(uid);
  // Pas de copie locale (nouvel appareil, après une déconnexion) : cartes « en
  // cours de chargement » le temps de lire le compte, plutôt que des pages vides.
  let hadLocal = true;
  try { hadLocal = !!localStorage.getItem(DB_KEY); } catch {}
  if (!hadLocal) { document.documentElement.classList.add('ts-loading-data'); syncPill('loading'); }
  const doneLoading = () => {
    if (!document.documentElement.classList.contains('ts-loading-data')) return;
    document.documentElement.classList.remove('ts-loading-data');
    syncPill(navigator.onLine ? null : 'offline');
  };

  ref.get().then(async doc => {
    checkConsent(uid, doc);
    const v = doc.exists ? doc.data() : null;
    if (v && v.data) {
      // Un compte cloud existe déjà : ses données font foi sur cet appareil.
      // Tiroirs, sauf si un appareil resté sur une ancienne version a réécrit
      // toutes les données dans le document principal (elles font alors foi).
      let localData = null;
      try { localData = localStorage.getItem(DB_KEY) ? getData() : null; } catch {}
      const read = await readDrawers(ref, v, localData);
      const cloudData = read.data, inDrawers = !!read.index;
      cloudLayout = inDrawers ? 2 : 1;
      cloudIndex = inDrawers ? { ...read.index } : {};
      cloudLoaded = true;
      if (compactStoredSessions(cloudData)) saveData(cloudData); // allégée une fois, renvoyée au cloud
      else {
        localStorage.setItem(DB_KEY, JSON.stringify(cloudData));
        window.dispatchEvent(new CustomEvent('triseason:update', { detail: cloudData }));
      }
      if (!inDrawers) { cloudMigrateWanted = true; pushToCloudSoon(ref); }
      setTimeout(showNews, 700);
    } else {
      // Premier login : on envoie ce qu'il y avait déjà en local (saison déjà
      // saisie avant la mise en place des comptes) pour l'attacher au compte.
      cloudLoaded = true;
      cloudLayout = 2; cloudIndex = {};
      const localData = getData();
      if (compactStoredSessions(localData)) localStorage.setItem(DB_KEY, JSON.stringify(localData));
      pushToCloud(localData);
    }
    markActiveToday(uid);
    setTimeout(stravaAutoSync, 1500);
  }).catch(err => {
    // cloudLoaded reste à false : pas d'envoi vers le cloud pour ne pas l'écraser.
    console.warn('[TriSeason] Impossible de récupérer les données cloud :', err.message);
    if (!hadLocal) setTimeout(() => syncPill(navigator.onLine ? 'error' : 'offline',
      navigator.onLine ? 'Données du compte pas encore chargées : recharge la page' : null), 50);
  }).finally(() => {
    cloudSyncing = false;
    doneLoading();
  });
}
// Lance le déménagement (file d'envoi : jamais en même temps qu'un enregistrement).
function pushToCloudSoon(ref) { if (!cloudSending) sendToCloud(ref); }

// Déclenché par auth-guard.js une fois la connexion confirmée. On gère aussi
// le cas où cet événement serait déjà passé avant que ce script ne s'exécute.
document.addEventListener('triseason:auth-ready', e => {
  if (e.detail) syncFromCloud(e.detail.uid);
});
if (window.TS_USER) syncFromCloud(window.TS_USER.uid);

// Graphiques : nombres au format français (« 5 000 », « 1,5 ») sur toutes les pages
if (window.Chart) Chart.defaults.locale = 'fr-FR';

function saveData(data) {
  // Déconnexion en cours : une minuterie en retard ne doit pas réécrire les données effacées
  if (window.TS_LOGGED_OUT) return;
  localStorage.setItem(DB_KEY, JSON.stringify(data));
  window.dispatchEvent(new CustomEvent('triseason:update', { detail: data }));
  pushToCloud(data);
}

function getData() { return loadData(); }

// ── Date helpers ─────────────────────────────────────────────────────────────
// Les dates de séance sont stockées en 'YYYY-MM-DD' (jour local). Ne jamais
// passer par toISOString() pour les produire : il convertit en UTC et, en France,
// le lundi 00:00 devient le dimanche 22:00/23:00 → décalage d'un jour.
function localDateStr(date = new Date()) {
  const d = parseLocalDate(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' → minuit local (new Date('YYYY-MM-DD') le lit comme minuit UTC).
function parseLocalDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(date);
}

// ── Week helpers ─────────────────────────────────────────────────────────────
function getISOWeek(date) {
  const d = parseLocalDate(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function getWeekMonday(weekKey) {
  const [year, w] = weekKey.split('-W').map(Number);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + (w - 1) * 7);
  return monday;
}

function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateInput(date) {
  return localDateStr(date);
}

function getLast12Weeks() {
  const weeks = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    weeks.push(getISOWeek(d));
  }
  return weeks;
}

function getCurrentWeek() { return getISOWeek(new Date()); }

function getLast52Weeks() {
  const weeks = [];
  const now = new Date();
  for (let i = 51; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    weeks.push(getISOWeek(d));
  }
  return weeks;
}

// ── Week CRUD ────────────────────────────────────────────────────────────────
function getWeek(weekKey) {
  const data = getData();
  // Aggregate from individual sessions (source of truth)
  const monday = getWeekMonday(weekKey);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const from = localDateStr(monday);
  const to   = localDateStr(sunday);
  const sessions = (data.sessions || []).filter(s => s.date >= from && s.date <= to);

  const result = {
    nat:  { dur: 0, dist: 0, rpe: 0, sessions: 0, rpeSum: 0, elevation: 0 },
    velo: { dur: 0, dist: 0, rpe: 0, sessions: 0, rpeSum: 0, elevation: 0 },
    run:  { dur: 0, dist: 0, rpe: 0, sessions: 0, rpeSum: 0, elevation: 0 },
    muscu: { dur: 0, dist: 0, rpe: 0, sessions: 0, rpeSum: 0, elevation: 0 },
    notes: data.weeks[weekKey]?.notes || ''
  };

  for (const s of sessions) {
    const sport = s.sport;
    if (!result[sport]) continue;
    result[sport].dur       += s.duration  || 0;
    result[sport].dist      += s.distance  || 0;
    result[sport].rpeSum    += s.rpe       || 0;
    result[sport].elevation += s.elevation || 0;
    result[sport].sessions  += 1;
  }

  // Average RPE per sport
  for (const sp of ['nat','velo','run','muscu']) {
    result[sp].rpe = result[sp].sessions > 0
      ? result[sp].rpeSum / result[sp].sessions
      : 0;
    delete result[sp].rpeSum;
  }

  return result;
}

function saveWeek(weekKey, weekData) {
  const data = getData();
  data.weeks[weekKey] = weekData;
  saveData(data);
}

// ── Sessions CRUD ────────────────────────────────────────────────────────────
function getSessions(filters = {}) {
  const data = getData();
  let sessions = data.sessions || [];
  if (filters.sport) sessions = sessions.filter(s => s.sport === filters.sport);
  if (filters.from)  sessions = sessions.filter(s => s.date >= filters.from);
  if (filters.to)    sessions = sessions.filter(s => s.date <= filters.to);
  return sessions.sort((a, b) => b.date.localeCompare(a.date));
}

// Identifiant unique : l'heure seule (Date.now) peut se répéter quand plusieurs
// éléments sont créés dans la même milliseconde (import groupé, copie de repas).
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Séances compactes : moins de place dans le document du compte (1 Mo max) ─
// - aucun champ vide enregistré (null, '') ;
// - durée arrondie à 6 décimales d'heure : reste exacte à la seconde (écart < 0,002 s) ;
// - séance Strava : pas de « · Strava » dans les notes (strava_id le dit déjà),
//   et pas de nom automatique (« Morning Run », « Course à pied le matin »…).
const STRAVA_DEFAULT_NAME = /^(?:(?:morning|lunch|afternoon|evening|night) (?:run|ride|swim|walk|hike|activity|workout|trail run|virtual ride|virtual run|mountain bike ride|gravel ride|e-bike ride|weight training)|(?:course à pied|course|trail|sortie (?:à )?vélo|vélo|natation|activité|randonnée|marche|musculation|entraînement aux poids) (?:(?:le|du|de|en) |dans l['’]|à l['’]heure du |l['’])?(?:matin|matinale|midi|soir|soirée|nuit|nocturne|après-midi|déjeuner))$/i;
function compactSession(s) {
  Object.keys(s).forEach(k => { if (s[k] == null || s[k] === '') delete s[k]; });
  if (typeof s.duration === 'number') s.duration = Math.round(s.duration * 1e6) / 1e6;
  if (s.strava_id && typeof s.notes === 'string') {
    const name = s.notes.replace(/(^| · )Strava$/, '').trim();
    if (!name || STRAVA_DEFAULT_NAME.test(name)) delete s.notes; else s.notes = name;
  }
  return s;
}
// Séances déjà enregistrées : allégées une fois, à l'ouverture de l'appli.
const COMPACT_VERSION = 1;
function compactStoredSessions(data) {
  if ((data._compact || 0) >= COMPACT_VERSION) return false;
  (data.sessions || []).forEach(compactSession);
  data._compact = COMPACT_VERSION;
  return true;
}

function saveSession(session) {
  compactSession(session);
  const data = getData();
  if (!session.id) session.id = newId();
  const idx = data.sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) data.sessions[idx] = session;
  else data.sessions.push(session);
  saveData(data);
  return session;
}

// Plusieurs séances en un seul enregistrement (import groupé).
function saveSessions(list) {
  const data = getData();
  const saved = list.map(session => {
    compactSession(session);
    if (!session.id) session.id = newId();
    const idx = data.sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) data.sessions[idx] = session; else data.sessions.push(session);
    return session;
  });
  saveData(data);
  return saved;
}

function deleteSession(id) {
  const data = getData();
  data.sessions = data.sessions.filter(s => s.id !== id);
  saveData(data);
}


// ── Saisons ──────────────────────────────────────────────────────────────────
// Une "saison" = une année calendaire (2026, 2025, ...), déduite des dates
// réellement présentes dans les séances, compétitions et records. Persistée
// séparément de la donnée principale, pour ne pas toucher au schéma existant.
const SEASON_KEY = 'triseason_season_filter';

function getSeasonsAvailable() {
  const data = getData();
  const years = new Set();
  (data.sessions || []).forEach(s => { if (s.date) years.add(s.date.slice(0, 4)); });
  (data.competitions || []).forEach(c => { if (c.date) years.add(c.date.slice(0, 4)); });
  (data.records || []).forEach(r => { if (r.date) years.add(r.date.slice(0, 4)); });
  const current = String(new Date().getFullYear());
  years.add(current);
  return Array.from(years).sort((a, b) => b.localeCompare(a)); // plus récente d'abord
}

function getSeasonFilter() {
  try { return localStorage.getItem(SEASON_KEY) || 'all'; } catch { return 'all'; }
}

function setSeasonFilter(value) {
  try { localStorage.setItem(SEASON_KEY, value); } catch {}
}

// { from, to } au format YYYY-MM-DD pour une saison donnée, ou null pour "Toutes"
function getSeasonRange(value) {
  if (!value || value === 'all') return null;
  return { from: value + '-01-01', to: value + '-12-31' };
}

// ── Competitions CRUD ────────────────────────────────────────────────────────
function getCompetitions(filters = {}) {
  const data = getData();
  let comps = data.competitions || [];
  if (filters.from) comps = comps.filter(c => c.date >= filters.from);
  if (filters.to)   comps = comps.filter(c => c.date <= filters.to);
  return comps.sort((a, b) => a.date.localeCompare(b.date));
}

function saveCompetition(comp) {
  const data = getData();
  if (!comp.id) comp.id = newId();
  const idx = data.competitions.findIndex(c => c.id === comp.id);
  if (idx >= 0) data.competitions[idx] = comp;
  else data.competitions.push(comp);
  saveData(data);
  return comp;
}

function deleteCompetition(id) {
  const data = getData();
  data.competitions = data.competitions.filter(c => c.id !== id);
  // Les records créés automatiquement par cette course disparaissent avec elle,
  // et ses séances redeviennent libres (records saisis à la main : jamais touchés).
  data.records = (data.records || []).filter(r => !(r.auto && r.comp_id === id));
  (data.sessions || []).forEach(s => { if (s.comp_id === id) s.comp_id = null; });
  saveData(data);
}

// ── Compétitions : temps total multisport + records automatiques ─────────────
// Une compétition multisport (triathlon, duathlon, aquathlon) peut être reliée à
// plusieurs séances (une par discipline, via leur champ comp_id).
//  - Son temps total = somme des séances reliées, calculé quand toutes les
//    disciplines requises sont présentes. Un temps saisi à la main n'est jamais
//    écrasé (la somme ne contient pas les transitions) : voir auto_time.
//  - Les records sont DÉDUITS de la course et de ses séances : ils sont
//    recalculés à chaque changement (marqués auto + comp_id, donc sans doublon).
//    Un record n'est ajouté que s'il bat le meilleur temps de la saison pour la
//    même discipline et la même distance (ce qui inclut le cas d'un PB).
const COMP_MULTISPORT_LEGS = {
  TRI:   { nat: 1, velo: 1, run: 1 },
  AQUA:  { nat: 1, run: 1 },
  DUATH: { velo: 1, run: 2 },   // course à pied / vélo / course à pied
};
const COMP_SINGLE_SPORT = { RUN: 'run', BIKE: 'velo', VELO: 'velo', NAT: 'nat' };
const COMP_LEG_LABELS   = { nat: 'Natation', velo: 'Vélo', run: 'Course' };
const COMP_MULTI_NAMES  = { TRI: 'Triathlon', AQUA: 'Aquathlon', DUATH: 'Duathlon' };

// Mêmes libellés de distance que ceux proposés sur la page Records, pour que les
// records créés automatiquement se regroupent avec ceux saisis à la main.
const COMP_STD_DISTANCES = {
  nat:  [['50m', 0.05], ['100m', 0.1], ['200m', 0.2], ['400m', 0.4], ['800m', 0.8], ['1500m', 1.5], ['1km', 1], ['3,8km (Ironman)', 3.8]],
  velo: [['10km', 10], ['20km', 20], ['40km', 40], ['50km', 50], ['100km', 100], ['180km (Ironman)', 180]],
  run:  [['1km', 1], ['1 mile', 1.609], ['3km', 3], ['5km', 5], ['10km', 10], ['Semi-marathon (21,1km)', 21.1], ['Marathon (42,2km)', 42.195]],
  tri:  [['Sprint (750m/20km/5km)', 25.75], ['Olympique (1,5km/40km/10km)', 51.5], ['70.3 / Half (1,9km/90km/21km)', 113], ['Ironman (3,8km/180km/42km)', 226]],
};

// Formats officiels FFTri des courses multisports. La distance totale est la somme
// des disciplines (ex : sprint = 0,75 + 20 + 5 = 25,75 km). 'rec' est le libellé de
// distance utilisé sur la page Records (les anciens libellés sont conservés pour que
// les records déjà saisis à la main restent regroupés avec ceux créés automatiquement).
const COMP_FORMATS = {
  TRI: [
    { key: 'XS',      km: 12.9,  rec: 'XS - Découverte (400m/10km/2,5km)' },
    { key: 'S',       km: 25.75, rec: 'Sprint (750m/20km/5km)' },
    { key: 'M',       km: 51.5,  rec: 'Olympique (1,5km/40km/10km)' },
    { key: 'L',       km: 113,   rec: '70.3 / Half (1,9km/90km/21km)' },
    { key: 'Ironman', km: 226,   rec: 'Ironman (3,8km/180km/42km)' },
  ],
  DUATH: [
    { key: 'XS',  km: 13.75, rec: 'Duathlon XS (2,5km/10km/1,25km)' },
    { key: 'S',   km: 27.5,  rec: 'Duathlon S (5km/20km/2,5km)' },
    { key: 'M',   km: 55,    rec: 'Duathlon M (10km/40km/5km)' },
    { key: 'L',   km: 100,   rec: 'Duathlon L (10km/80km/10km)' },
    { key: 'XL',  km: 150,   rec: 'Duathlon XL (20km/120km/10km)' },
    { key: 'XXL', km: 220,   rec: 'Duathlon XXL (20km/180km/20km)' },
  ],
  AQUA: [
    { key: 'XS', km: 3,  rec: 'Aquathlon XS (500m/2,5km)' },
    { key: 'S',  km: 6,  rec: 'Aquathlon S (1km/5km)' },
    { key: 'M',  km: 12, rec: 'Aquathlon M (2km/10km)' },
    { key: 'L',  km: 18, rec: 'Aquathlon L (3km/15km)' },
    { key: 'XL', km: 24, rec: 'Aquathlon XL (4km/20km)' },
  ],
};
COMP_STD_DISTANCES.tri = COMP_FORMATS.TRI.map(function (f) { return [f.rec, f.km]; });

// Format dont la distance totale est la plus proche de km (pas de tolérance : la somme
// des séances n'a pas besoin d'être exacte). Renvoie null si le type n'est pas multisport.
function compClosestFormat(type, km) {
  var list = COMP_FORMATS[type];
  km = parseFloat(km);
  if (!list || !(km > 0)) return null;
  var best = list[0], bestDiff = Math.abs(km - list[0].km);
  for (var i = 1; i < list.length; i++) {
    var d = Math.abs(km - list[i].km);
    if (d < bestDiff) { bestDiff = d; best = list[i]; }
  }
  return best;
}

function compFmtKm(km) {
  return String(Math.round(km * 10) / 10).replace('.', ',') + ' km';
}

// Même lecture des temps que les pages Compétitions et Records :
// "1:57:30" = h:mm:ss ; "45:10" = mm:ss ; "2:05" = 2h05.
function compTimeToSec(str) {
  if (!str) return 0;
  var parts = String(str).trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] >= 10 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60;
  return 0;
}

// Écrit toujours un temps sans ambiguïté : moins de 10 min => "0:08:30" (jamais "8:30").
function compSecToTime(sec) {
  sec = Math.round(sec);
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  var pad = function (n) { return String(n).padStart(2, '0'); };
  if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
  if (m >= 10) return m + ':' + pad(s);
  return '0:' + pad(m) + ':' + pad(s);
}

// Heures décimales → « 1h30 » (« 45min » sous une heure, « 2h » pile, « 0h »), à la minute.
// Format de tous les totaux et moyennes d'heures. Les durées de séance, temps de
// course et records restent en h:mm:ss (à la seconde).
function formatHours(h) {
  const total = Math.round((h || 0) * 60);
  const hrs = Math.floor(total / 60), mins = total % 60;
  if (!total) return '0h';
  if (!hrs) return mins + 'min';
  return mins ? hrs + 'h' + String(mins).padStart(2, '0') : hrs + 'h';
}

function compFormatHM(sec) {
  var h = Math.floor(sec / 3600);
  var m = Math.round((sec % 3600) / 60);
  if (m === 60) { h += 1; m = 0; }
  if (h === 0) return m + 'min';
  return m === 0 ? h + 'h' : h + 'h' + String(m).padStart(2, '0');
}

function compUnique(arr) {
  return arr.filter(function (v, i) { return arr.indexOf(v) === i; });
}

// kind : 'nat' | 'velo' | 'run' | 'tri'. Rapproche une distance (km) d'un libellé
// standard de la page Records si l'écart est faible, sinon construit un libellé libre.
function compDistanceLabel(kind, km, multiType) {
  var canSnap = kind !== 'tri' || multiType === 'TRI'; // un duathlon/aquathlon n'est jamais un "Sprint" de triathlon
  if (canSnap) {
    var tol = kind === 'tri' ? 0.08 : 0.06;
    var list = COMP_STD_DISTANCES[kind] || [];
    var best = null, bestDiff = Infinity;
    list.forEach(function (it) {
      var diff = Math.abs(km - it[1]) / it[1];
      if (diff < bestDiff) { bestDiff = diff; best = it; }
    });
    if (best && bestDiff <= tol) return best[0];
  }
  var rounded = Math.round(km * 10) / 10;
  if (kind === 'tri') return (COMP_MULTI_NAMES[multiType] || 'Triathlon') + ' ' + rounded + ' km';
  if (kind === 'nat' && km < 1) return Math.round(km * 1000) + ' m';
  return rounded + ' km';
}

// Vérifie que les séances reliées couvrent toutes les disciplines requises.
function compCheckLegs(linked, needs) {
  var counts = {};
  linked.forEach(function (s) {
    if (s.duration > 0) counts[s.sport] = (counts[s.sport] || 0) + 1;
  });
  var missing = [];
  Object.keys(needs).forEach(function (sp) {
    var have = counts[sp] || 0;
    if (have < needs[sp]) {
      var label = COMP_LEG_LABELS[sp];
      if (needs[sp] > 1) label += have === 0 ? ' (×' + needs[sp] + ')' : ' (' + (have + 1) + 'e)';
      missing.push(label);
    }
  });
  return { complete: missing.length === 0, missing: missing };
}

// Pour l'interface (aperçu en direct dans la fenêtre d'association).
function checkCompetitionLegs(type, sessions) {
  var total = Math.round(sessions.reduce(function (a, s) { return a + (s.duration || 0) * 3600; }, 0));
  var km = Math.round(sessions.reduce(function (a, s) { return a + (parseFloat(s.distance) || 0); }, 0) * 10) / 10;
  var missingDist = compUnique(sessions
    .filter(function (s) { return s.duration > 0 && !(s.distance > 0); })
    .map(function (s) { return COMP_LEG_LABELS[s.sport] || s.sport; }));
  var needs = COMP_MULTISPORT_LEGS[type];
  if (!needs) return { multisport: false, complete: sessions.length > 0, missing: [], totalSec: total, totalKm: km, missingDist: missingDist, format: null };
  var c = compCheckLegs(sessions, needs);
  var fmt = (c.complete && missingDist.length === 0 && km > 0) ? compClosestFormat(type, km) : null;
  return { multisport: true, complete: c.complete, missing: c.missing, totalSec: total, totalKm: km, missingDist: missingDist, format: fmt ? fmt.key : null };
}

// Records "candidats" déduits d'une course : un pour la course entière (distance et
// temps de la course) + un par discipline pour les courses multisports (distance
// et temps de chaque séance reliée).
function compBuildRecordCandidates(comp, linked) {
  var out = [], notes = [];
  var multi = COMP_MULTISPORT_LEGS[comp.type];
  var compSec = compTimeToSec(comp.actual_time);
  var compKm = parseFloat(comp.distance) || 0;

  if (multi) {
    if (compSec > 0) {
      var fmt = compKm > 0 ? compClosestFormat(comp.type, compKm) : null;
      if (fmt) {
        out.push({ sport: 'tri', label: COMP_MULTI_NAMES[comp.type] + ' ' + fmt.key, dist: fmt.rec, sec: compSec });
      } else {
        notes.push('Renseigne la distance de la course pour créer son record.');
      }
    }
    var noDist = [];
    linked.forEach(function (s) {
      var sec = Math.round((s.duration || 0) * 3600);
      if (!COMP_LEG_LABELS[s.sport] || sec <= 0) return;
      if (!(s.distance > 0)) { noDist.push(COMP_LEG_LABELS[s.sport]); return; }
      out.push({ sport: s.sport, label: COMP_LEG_LABELS[s.sport], dist: compDistanceLabel(s.sport, s.distance), sec: sec });
    });
    if (noDist.length) notes.push('Distance manquante (pas de record) : ' + compUnique(noDist).join(', ') + '.');
  } else if (COMP_SINGLE_SPORT[comp.type] && compSec > 0) {
    var sport = COMP_SINGLE_SPORT[comp.type];
    if (compKm > 0) out.push({ sport: sport, label: COMP_LEG_LABELS[sport], dist: compDistanceLabel(sport, compKm), sec: compSec });
    else notes.push('Renseigne la distance de la course pour créer son record.');
  }
  return { candidates: out, notes: notes };
}

// Retire les anciens records automatiques de la course, puis recrée ceux qui battent
// le meilleur temps de la saison (même discipline, même distance, même année).
function compRefreshRecordsInData(data, comp, linked) {
  if (!data.records) data.records = [];
  var records = data.records;
  var before = records.length;
  for (var i = records.length - 1; i >= 0; i--) {
    if (records[i].auto && records[i].comp_id === comp.id) records.splice(i, 1);
  }
  var removed = before - records.length;

  var built = compBuildRecordCandidates(comp, linked);
  var year = (comp.date || '').slice(0, 4);
  var added = [];
  built.candidates.forEach(function (c) {
    if (!(c.sec > 0)) return;
    var bestSeason = Infinity, bestAll = Infinity;
    records.forEach(function (r) {
      if (r.sport !== c.sport || r.dist !== c.dist) return;
      var rs = compTimeToSec(r.time);
      if (!(rs > 0)) return;
      if (rs < bestAll) bestAll = rs;
      if ((r.date || '').slice(0, 4) === year && rs < bestSeason) bestSeason = rs;
    });
    if (c.sec < bestSeason) {
      // Battre le meilleur temps de toute l'histoire = PB (ce qui bat forcément aussi la saison)
      var isPB = c.sec < bestAll;
      records.push({
        id: 'auto-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        sport: c.sport,
        dist: c.dist,
        time: compSecToTime(c.sec),
        date: comp.date,
        location: comp.name || '',
        notes: (isPB ? 'Nouveau record personnel (PB)' : 'Record de la saison') + ' · ajouté automatiquement depuis la course',
        auto: true,
        comp_id: comp.id,
      });
      added.push({ sport: c.sport, dist: c.dist, label: c.label, pb: isPB });
    }
  });
  return { added: added, notes: built.notes, changed: removed > 0 || added.length > 0 };
}

// Cœur de la synchronisation : met à jour le temps de la course, puis ses records.
// opts.session : séance qui vient d'être enregistrée (course à une seule discipline).
function compSyncInData(data, compId, opts) {
  opts = opts || {};
  var res = { status: 'none', missing: [], notes: [], recordsAdded: [], changed: false, totalSec: 0 };
  var distNotes = [];
  var comp = (data.competitions || []).filter(function (c) { return c.id === compId; })[0];
  if (!comp) return res;

  var linked = (data.sessions || []).filter(function (s) { return s.comp_id === compId; });
  var needs = COMP_MULTISPORT_LEGS[comp.type];

  if (needs) {
    var check = compCheckLegs(linked, needs);
    var sum = Math.round(linked.reduce(function (a, s) { return a + (s.duration || 0) * 3600; }, 0));
    // Un temps vide, ou égal à celui calculé précédemment, peut être recalculé.
    // Un temps différent a été saisi à la main : on le conserve.
    var isAuto = !comp.actual_time || comp.actual_time === comp.auto_time;
    if (check.complete) {
      res.totalSec = sum;
      var t = compSecToTime(sum);
      if (isAuto) {
        res.status = 'complete';
        if (comp.actual_time !== t || comp.auto_time !== t) { comp.actual_time = t; comp.auto_time = t; res.changed = true; }
      } else {
        res.status = 'manual';
        if (comp.auto_time !== t) { comp.auto_time = t; res.changed = true; }
      }
    } else {
      res.missing = check.missing;
      if (isAuto) {
        res.status = 'incomplete';
        if (comp.actual_time) { comp.actual_time = null; comp.auto_time = null; res.changed = true; }
      } else {
        res.status = 'manual';
      }
    }

    // Distance de la course = somme des distances des séances reliées (quand toutes les
    // disciplines sont là et ont une distance), puis format FFTri le plus proche.
    var sumKm = linked.reduce(function (a, s) { return a + (parseFloat(s.distance) || 0); }, 0);
    var missingDist = linked
      .filter(function (s) { return s.duration > 0 && !(s.distance > 0); })
      .map(function (s) { return COMP_LEG_LABELS[s.sport] || s.sport; });
    var distIsAuto = comp.auto_distance != null && comp.distance === comp.auto_distance;
    if (check.complete && missingDist.length === 0 && sumKm > 0) {
      var km = Math.round(sumKm * 10) / 10;
      if (comp.distance !== km || comp.auto_distance !== km) { comp.distance = km; comp.auto_distance = km; res.changed = true; }
    } else {
      if (check.complete && missingDist.length) {
        distNotes.push('Distance manquante : ' + compUnique(missingDist).join(', ') + ' — le format et le record de la course ne peuvent pas être calculés.');
      }
      // La somme n'est plus valable : on retire la distance qu'elle avait remplie.
      // Une distance saisie à la main n'est jamais touchée.
      if (distIsAuto) { comp.distance = null; comp.auto_distance = null; res.changed = true; }
    }
    var fmtNow = comp.distance > 0 ? compClosestFormat(comp.type, comp.distance) : null;
    var fmtKey = fmtNow ? fmtNow.key : null;
    if ((comp.format || null) !== fmtKey) { comp.format = fmtKey; res.changed = true; }
    res.format = fmtKey;
    res.totalKm = comp.distance > 0 ? comp.distance : 0;
  } else {
    var withDur = linked.filter(function (s) { return s.duration > 0; });
    var src = (opts.session && opts.session.duration > 0) ? opts.session : (withDur.length === 1 ? withDur[0] : null);
    if (src) {
      var t2 = compSecToTime(Math.round(src.duration * 3600));
      if (comp.actual_time !== t2) { comp.actual_time = t2; res.changed = true; }
      res.status = 'single';
    }
    // Le format XS/S/M/L ne concerne que les courses multisports (ex : type changé depuis TRI)
    if (comp.format) { comp.format = null; res.changed = true; }
    if (comp.auto_distance != null) { comp.auto_distance = null; res.changed = true; }
  }

  var rr = compRefreshRecordsInData(data, comp, linked);
  res.recordsAdded = rr.added;
  // Si la distance manquante explique déjà l'absence de record, on n'empile pas deux notes redondantes
  var recNotes = rr.notes;
  if (distNotes.length) {
    recNotes = recNotes.filter(function (t) {
      return t.indexOf('Renseigne la distance de la course') !== 0 && t.indexOf('Distance manquante (pas de record)') !== 0;
    });
  }
  res.notes = distNotes.concat(recNotes);
  if (rr.changed) res.changed = true;
  return res;
}

function syncCompetition(compId, opts) {
  var data = getData();
  var res = compSyncInData(data, compId, opts);
  if (res.changed) saveData(data);
  return res;
}

// Recalcule uniquement les records (ex : après modification manuelle de la course).
function refreshCompetitionRecords(compId) {
  var data = getData();
  var comp = (data.competitions || []).filter(function (c) { return c.id === compId; })[0];
  if (!comp) return null;
  var linked = (data.sessions || []).filter(function (s) { return s.comp_id === compId; });
  var rr = compRefreshRecordsInData(data, comp, linked);
  if (rr.changed) saveData(data);
  return { recordsAdded: rr.added, notes: rr.notes };
}

// Associe exactement ces séances à la course (les autres séances qui lui étaient
// reliées sont détachées), puis resynchronise le tout en une seule sauvegarde.
function linkSessionsToCompetition(compId, sessionIds) {
  var data = getData();
  var chosen = {};
  (sessionIds || []).forEach(function (id) { chosen[id] = true; });
  (data.sessions || []).forEach(function (s) {
    if (chosen[s.id]) s.comp_id = compId;
    else if (s.comp_id === compId) s.comp_id = null;
  });
  var res = compSyncInData(data, compId, {});
  saveData(data);
  return res;
}

// Partie "records" du message : "2 records ajoutés (Triathlon S, Course) dont un PB 🏆".
function describeCompRecords(res) {
  if (!res || !res.recordsAdded || !res.recordsAdded.length) return '';
  var n = res.recordsAdded.length;
  var names = compUnique(res.recordsAdded.map(function (r) { return r.label; }));
  var hasPB = res.recordsAdded.some(function (r) { return r.pb; });
  return n + ' record' + (n > 1 ? 's' : '') + ' ajouté' + (n > 1 ? 's' : '') + ' (' + names.join(', ') + ')' + (hasPB ? ' dont un PB 🏆' : '');
}

// Phrase de retour pour l'utilisateur à partir du résultat d'une synchronisation.
function describeCompSync(res) {
  if (!res) return '';
  var parts = [];
  if (res.status === 'complete')        parts.push('Temps total : ' + compFormatHM(res.totalSec));
  else if (res.status === 'manual')     parts.push('Temps saisi à la main conservé');
  else if (res.status === 'incomplete') parts.push('Il manque encore : ' + res.missing.join(', ') + ' pour calculer le temps total');
  else if (res.status === 'single')     parts.push('Temps de la course mis à jour');
  if (res.format && res.totalKm) parts.push('Format ' + res.format + ' (' + compFmtKm(res.totalKm) + ')');
  var rm = describeCompRecords(res);
  if (rm) parts.push(rm);
  (res.notes || []).forEach(function (t) { parts.push(t); });
  return parts.join(' · ');
}

// ── Weight ────────────────────────────────────────────────────────────────────
function getWeight() {
  const data = getData();
  return (data.weight || []).sort((a, b) => a.date.localeCompare(b.date));
}

function saveWeight(entry) {
  const data = getData();
  if (!data.weight) data.weight = [];
  const idx = data.weight.findIndex(w => w.date === entry.date);
  if (idx >= 0) data.weight[idx] = entry;
  else data.weight.push(entry);
  saveData(data);
}

function deleteWeight(date) {
  const data = getData();
  data.weight = (data.weight || []).filter(w => w.date !== date);
  saveData(data);
}

function getLatestWeight(beforeDate = null) {
  const weights = getWeight().filter(w => w.value > 0);
  if (!weights.length) return null;
  if (!beforeDate) return weights[weights.length - 1].value;
  const filtered = weights.filter(w => w.date <= beforeDate);
  return filtered.length ? filtered[filtered.length - 1].value : weights[0].value;
}

// ── Profile ───────────────────────────────────────────────────────────────────
function getProfile() {
  const data = getData();
  return data.profile || {};
}

function saveProfile(profile) {
  const data = getData();
  data.profile = { ...(data.profile || {}), ...profile };
  saveData(data);
}

// ── Calculations ──────────────────────────────────────────────────────────────
function calcPace(durH, distKm, sport) {
  if (!durH || !distKm) return null;
  // Arrondi à la seconde AVANT de séparer minutes et secondes (sinon 3'59,7" → 3'60")
  const fmtMinSec = (totalSec) => {
    const sec = Math.round(totalSec);
    return `${Math.floor(sec / 60)}'${String(sec % 60).padStart(2, '0')}"`;
  };
  if (sport === 'run') return fmtMinSec(durH * 3600 / distKm);
  if (sport === 'nat') return fmtMinSec(durH * 3600 / (distKm * 10));
  if (sport === 'velo') {
    return `${(distKm / durH).toFixed(1)} km/h`;
  }
  return null;
}

function calcTSS(durH, rpe) {
  if (!durH || !rpe) return 0;
  return Math.round(durH * rpe * rpe / 100 * 10) / 10;
}

function calcWkg(powerW, date = null) {
  const w = getLatestWeight(date);
  if (!w || !powerW) return null;
  return Math.round(powerW / w * 100) / 100;
}

function wkgLevel(wkg) {
  if (!wkg) return null;
  if (wkg < 2)   return { label: 'Débutant',          color: '#a3abb9' };
  if (wkg < 2.5) return { label: 'Amateur débutant',   color: '#34c48b' };
  if (wkg < 3)   return { label: 'Amateur régulier',   color: '#34c48b' };
  if (wkg < 3.5) return { label: 'Bon niveau',         color: '#f0b941' };
  if (wkg < 4)   return { label: 'Très bon amateur',   color: '#dc3d6a' };
  if (wkg < 5)   return { label: 'Élite amateur',      color: '#ef5350' };
  return              { label: 'Professionnel',        color: '#a48be0' };
}

function tssLevel(tss) {
  if (tss < 50)  return { label: '🟢 Récupération', color: '#34c48b' };
  if (tss < 150) return { label: '🟡 Normal',        color: '#f0b941' };
  if (tss < 300) return { label: '🟠 Élevé',         color: '#dc3d6a' };
  return              { label: '🔴 Très élevé',    color: '#ef5350' };
}

// ── Season stats ──────────────────────────────────────────────────────────────
function getSeasonStats() {
  const data = getData();
  const sessions = data.sessions || [];
  const stats = {
    nat:  { km: 0, h: 0, sessions: 0 },
    velo: { km: 0, h: 0, sessions: 0 },
    run:  { km: 0, h: 0, sessions: 0 },
    muscu: { km: 0, h: 0, sessions: 0 },
    total: { h: 0, sessions: 0, tss: 0 },
    rpe: [],
  };
  for (const s of sessions) {
    const sp = s.sport;
    if (!stats[sp]) continue;
    stats[sp].km       += s.distance || 0;
    stats[sp].h        += s.duration || 0;
    stats[sp].sessions += 1;
    if (s.rpe) {
      stats.rpe.push(s.rpe);
      stats.total.tss += calcTSS(s.duration || 0, s.rpe);
    }
    stats.total.h        += s.duration || 0;
    stats.total.sessions += 1;
  }
  stats.total.rpe = stats.rpe.length
    ? (stats.rpe.reduce((a,b)=>a+b,0)/stats.rpe.length).toFixed(1)
    : null;
  return stats;
}

// ── Nutrition × performance ──────────────────────────────────────────────────
// Rapproche chaque séance de la nutrition qui l'entoure, pour voir si certains
// facteurs (glucides la veille, hydratation…) vont avec de meilleures séances.
// Ce sont des tendances observées sur les données de l'utilisateur, pas une
// preuve : le type de séance, le sommeil, la météo… comptent aussi.
const NUTRI_FACTORS = {
  carbs_prev: { label: 'Glucides la veille',      unit: 'g',    short: 'glucides la veille' },
  carbs_day:  { label: 'Glucides le jour même',   unit: 'g',    short: 'glucides le jour même' },
  kcal_prev:  { label: 'Calories la veille',      unit: 'kcal', short: 'calories la veille' },
  hydration:  { label: 'Hydratation le jour même', unit: 'ml',  short: 'hydratation le jour même' },
};
const NUTRI_OUTCOMES = {
  sensation: { label: 'Ressenti', unit: '/5' },
  perf:      { label: 'Vitesse vs ton habitude', unit: '%' },
};
const NUTRI_MIN_GROUP = 3;      // séances minimum de chaque côté pour comparer
const NUTRI_MIN_SPORT_REF = 5;  // séances minimum d'un sport pour calculer "ton habitude"

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Seuil qui coupe les valeurs en deux groupes les plus équilibrés possible
// ("≤ seuil" / "> seuil"). Une simple médiane ne suffit pas : plusieurs séances
// après la même journée ont exactement la même valeur et tomberaient toutes du
// même côté. Renvoie null si toutes les valeurs sont identiques.
function balancedThreshold(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const distinct = [...new Set(sorted)];
  if (distinct.length < 2) return null;
  const mid = median(sorted);
  let best = null, bestMin = -1;
  for (let i = 0; i < distinct.length - 1; i++) {
    const t = distinct[i];
    const low = sorted.filter(v => v <= t).length;
    const smaller = Math.min(low, sorted.length - low);
    if (smaller > bestMin || (smaller === bestMin && Math.abs(t - mid) < Math.abs(best - mid))) {
      best = t; bestMin = smaller;
    }
  }
  return best;
}

function shiftDay(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

// Vitesse d'une séance (km/h), quel que soit le sport : plus haut = plus rapide.
function sessionSpeed(s) {
  return s.distance > 0 && s.duration > 0 ? s.distance / s.duration : null;
}

function getNutritionImpact(filters = {}) {
  const data = getData();
  const nutri = data.nutrition || {};
  const meals = nutri.meals || [];
  const hydration = nutri.hydration || {};

  // Totaux par jour (seulement les jours où au moins un repas est saisi)
  const daily = {};
  meals.forEach(m => {
    if (!m.date) return;
    const d = daily[m.date] || (daily[m.date] = { carbs: 0, kcal: 0, meals: 0 });
    d.carbs += m.glucides || 0;
    d.kcal  += m.kcal || ((m.glucides || 0) * 4 + (m.proteines || 0) * 4 + (m.lipides || 0) * 9);
    d.meals += 1;
  });

  let sessions = data.sessions || [];
  if (filters.from) sessions = sessions.filter(s => s.date >= filters.from);
  if (filters.to)   sessions = sessions.filter(s => s.date <= filters.to);
  if (filters.sport) sessions = sessions.filter(s => s.sport === filters.sport);

  // "Ton habitude" = vitesse médiane par sport, sur toutes les séances du sport
  const refSpeed = {};
  ['nat', 'velo', 'run'].forEach(sp => {
    const speeds = (data.sessions || []).filter(s => s.sport === sp).map(sessionSpeed).filter(v => v);
    refSpeed[sp] = speeds.length >= NUTRI_MIN_SPORT_REF ? median(speeds) : null;
  });

  const points = sessions.map(s => {
    const prev = daily[shiftDay(s.date, -1)];
    const day  = daily[s.date];
    const speed = sessionSpeed(s);
    const ref = refSpeed[s.sport];
    return {
      id: s.id, date: s.date, sport: s.sport,
      factors: {
        carbs_prev: prev && prev.carbs > 0 ? prev.carbs : null,
        carbs_day:  day && day.carbs > 0 ? day.carbs : null,
        kcal_prev:  prev && prev.kcal > 0 ? Math.round(prev.kcal) : null,
        hydration:  hydration[s.date] > 0 ? hydration[s.date] : null,
      },
      outcomes: {
        sensation: s.sensation >= 1 && s.sensation <= 5 ? s.sensation : null,
        perf: speed && ref ? Math.round((speed / ref - 1) * 1000) / 10 : null,
      },
    };
  });

  // Pour chaque facteur × résultat : séances "au-dessus" vs "en dessous" de la
  // médiane du facteur (seuil propre à l'utilisateur, pas une norme générale).
  const comparisons = {};
  Object.keys(NUTRI_FACTORS).forEach(f => {
    comparisons[f] = {};
    Object.keys(NUTRI_OUTCOMES).forEach(o => {
      const pts = points.filter(p => p.factors[f] !== null && p.outcomes[o] !== null);
      const threshold = balancedThreshold(pts.map(p => p.factors[f]));
      const high = threshold === null ? [] : pts.filter(p => p.factors[f] > threshold);
      const low  = threshold === null ? pts : pts.filter(p => p.factors[f] <= threshold);
      const avg = arr => arr.length ? arr.reduce((a, p) => a + p.outcomes[o], 0) / arr.length : null;
      comparisons[f][o] = {
        n: pts.length, threshold,
        distinctValues: new Set(pts.map(p => p.factors[f])).size,
        high: { n: high.length, avg: avg(high) },
        low:  { n: low.length,  avg: avg(low) },
        enough: high.length >= NUTRI_MIN_GROUP && low.length >= NUTRI_MIN_GROUP,
      };
    });
  });

  return {
    points, comparisons, refSpeed,
    counts: {
      sessions: sessions.length,
      daysWithMeals: Object.keys(daily).length,
      withNutrition: points.filter(p => Object.values(p.factors).some(v => v !== null)).length,
    },
  };
}

// ── Export / Import ───────────────────────────────────────────────────────────
function exportData() {
  const data = getData();
  if (data.strava) data.strava = { name: data.strava.name, connected_at: data.strava.connected_at }; // pas les clés d'accès
  data._exported = new Date().toISOString();
  data._version = '1.0';
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `triseason-backup-${localDateStr()}.json`;
  a.click();
}

function importData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        delete data.strava;  // la connexion Strava de ce compte est gardée telle quelle
        const current = getData().strava;
        saveData({ ...structuredClone(DEFAULT_DATA), ...data, ...(current ? { strava: current } : {}) });
        resolve(data);
      } catch { reject(new Error('Fichier invalide')); }
    };
    reader.readAsText(file);
  });
}

// ── Ravitaillements : glucides par unité ────────────────────────────────────
// Valeurs indicatives relevées chez les fabricants et revendeurs (octobre 2026) ;
// les formules changent : l'utilisateur peut toujours corriger le chiffre.
// g = glucides, p = protéines, par unité (gel, barre, pâte, gourde, bidon de 500 ml).
const FUEL_PRESETS = {
  gel: { unit: 'par gel', generic: [['Petit gel', 20], ['Gel standard', 25], ['Gros gel', 40]], brands: [
    ['Maurten Gel 100', 25], ['Maurten Gel 160', 40], ['SIS GO Isotonic', 22], ['SIS Beta Fuel', 40], ['GU Energy Gel', 22],
    ['Decathlon Energy Gel 32 g', 23], ['Overstims Coup de fouet', 26], ['Näak Ultra Energy', 27], ['Baouw', 30], ['Meltonic', 15], ['Meltonic XL', 30]] },
  barre: { unit: 'par barre', generic: [['Barre de céréales', 15], ['Barre énergétique', 35], ['Grosse barre', 45]], brands: [
    ['Clif Bar', 43, 10]] },
  'pâte-de-fruit': { unit: 'par pâte', generic: [['Pâte de fruits 25 g', 20]], brands: [
    ['Decathlon 25 g', 21], ['Overstims Fruit’n Perf', 20], ['Punch Power', 21]] },
  compote: { unit: 'par gourde', generic: [['Compote classique 90 g', 12], ['Compote énergétique', 30]], brands: [
    ['Atlet énergétique', 30], ['Endur’activ 70 g', 27], ['Atlet protéinée', 23, 10], ['Andros Sport Whey & Fruits', 11, 10]] },
  'boisson-iso': { unit: 'par bidon de 500 ml', generic: [['Boisson légère', 20], ['Boisson isotonique', 35], ['Boisson très dosée', 80]], brands: [
    ['Maurten Drink Mix 160', 40], ['Maurten Drink Mix 320', 80], ['Isostar Hydrate & Perform', 35], ['Tailwind 1 dose', 25], ['Tailwind 2 doses', 50]] },
  flasque: { unit: 'par flasque', generic: [['Flasque légère', 30], ['Flasque moyenne', 50], ['Flasque chargée', 80]], brands: [] },
  banane: { unit: 'par fruit', generic: [['Banane', 25]], brands: [] },
  autre: { unit: 'par unité', generic: [], brands: [] },
};
const FUEL_DEFAULT_CARBS = { gel: 25, barre: 30, banane: 25, 'boisson-iso': 30, flasque: 40, 'pâte-de-fruit': 20, compote: 25, autre: 20 };
// Glucides d'un ravitaillement (quantité comprise). estimated = valeur par défaut du type.
function fuelCarbs(f) {
  const per = f.carbs != null && f.carbs !== '' ? Number(f.carbs) : null;
  const unit = per != null && isFinite(per) ? per : (FUEL_DEFAULT_CARBS[f.type] || 20);
  return { carbs: unit * (f.qty || 1), prot: (Number(f.prot) || 0) * (f.qty || 1), estimated: per == null };
}

// ── Séances prévues (planification) ────────────────────────────────────────
// data.plans = [{ id, date 'YYYY-MM-DD', sport, distance (km|null), duration (h|null), notes }]
// Une séance prévue est « réalisée » dès qu'une séance du même sport existe le
// même jour (rien à cocher). Chaque séance ne compte que pour une seule prévue.
function getPlans() { return (getData().plans || []).slice().sort((a, b) => a.date.localeCompare(b.date)); }
function savePlan(plan) {
  const data = getData();
  data.plans = data.plans || [];
  if (!plan.id) plan.id = newId();
  const i = data.plans.findIndex(p => p.id === plan.id);
  if (i >= 0) data.plans[i] = plan; else data.plans.push(plan);
  saveData(data);
  return plan;
}
function deletePlan(id) {
  const data = getData();
  data.plans = (data.plans || []).filter(p => p.id !== id);
  saveData(data);
}

// Durée saisie (« 1h30 », « 45min », « 1:30:00 », « 1.5 ») → heures décimales.
function parseDuration(val) {
  if (!val) return null;
  val = String(val).trim().toLowerCase().replace(/\s+/g, '').replace(',', '.');
  const toH = (h, m, s) => Math.round((+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0)) / 3600;
  let r;
  if ((r = val.match(/^(\d+):(\d{1,2}):(\d{1,2})$/))) return toH(r[1], r[2], r[3]);
  if ((r = val.match(/^(\d+):(\d{2})$/))) return toH(r[1], r[2], 0);
  if ((r = val.match(/^(\d+)h(\d{1,2})?$/))) return toH(r[1], r[2], 0);
  if ((r = val.match(/^(?:(\d+)h)?(\d{1,3})(?:min|mn|m|')$/))) return toH(r[1], r[2], 0);
  if (/^\d+(\.\d+)?$/.test(val)) return toH(parseFloat(val), 0, 0);
  return null;
}

// Part de l'objectif atteinte (distance et/ou durée), null si pas d'objectif chiffré.
function planRatio(plan, s) {
  const parts = [];
  if (plan.distance) parts.push((s.distance || 0) / plan.distance);
  if (plan.duration) parts.push((s.duration || 0) / plan.duration);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

// Statut de chaque séance prévue : 'done' (objectif atteint à 90 % ou plus, ou sans
// objectif chiffré), 'partial', 'missed' (jour passé sans séance), 'today', 'upcoming'.
function planStatuses(data = getData()) {
  const today = localDateStr();
  const plans = (data.plans || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const used = new Set();
  const out = {};
  plans.forEach(plan => {
    const cands = (data.sessions || []).filter(s => s.date === plan.date && s.sport === plan.sport && !used.has(s.id));
    let best = null, bestGap = Infinity;
    cands.forEach(s => { const r = planRatio(plan, s); const gap = r == null ? 0 : Math.abs(1 - r); if (gap < bestGap) { bestGap = gap; best = s; } });
    if (best) {
      used.add(best.id);
      const ratio = planRatio(plan, best);
      out[plan.id] = { state: ratio == null || ratio >= 0.9 ? 'done' : 'partial', session: best, ratio };
    } else out[plan.id] = { state: plan.date < today ? 'missed' : plan.date === today ? 'today' : 'upcoming', session: null, ratio: null };
  });
  return out;
}

// Séances prévues réalisées depuis la dernière fois (pour un message unique).
function takeDonePlans() {
  if (!cloudLoaded) return [];
  const data = getData();
  const st = planStatuses(data);
  const fresh = (data.plans || []).filter(p => st[p.id] && st[p.id].session && !p.announced);
  if (!fresh.length) return [];
  fresh.forEach(p => { p.announced = true; });
  saveData(data);
  return fresh.map(p => ({ plan: p, ...st[p.id] }));
}

// ── Santé : blessures, maladie, grossesse, reprise (option) ────────────────
// Option facultative, activée par la personne elle-même avec un accord à part
// (en plus de l'accord général) : data.health = { consent: { version, at }, periods }.
// periods = [{ id, type, zone, sports: [], start, end (reprise du sport, facultatif),
//   status: 'en_cours' | 'reprise' | 'guerie', healed (jour où elle est marquée terminée), notes }]
// Séances : champ facultatif pain (douleur 0 à 10), seulement avec l'option.
// Désactiver = retirer son accord : tout ce que l'option a enregistré est effacé.
// Jamais montré à quelqu'un d'autre ; uniquement des faits, aucun conseil médical.
const HEALTH_CONSENT_VERSION = 1;
const HEALTH_TYPES = { blessure: 'Blessure', maladie: 'Maladie', grossesse: 'Grossesse',
  post_partum: 'Après l’accouchement', arret: 'Arrêt (autre raison)' };
const HEALTH_STATUS = { en_cours: 'En cours', reprise: 'En reprise', guerie: 'Terminée' };
const HEALTH_ZONES = ['Pied', 'Cheville', 'Tendon d’Achille', 'Mollet', 'Tibia', 'Genou', 'Cuisse', 'Ischios',
  'Hanche', 'Dos', 'Épaule', 'Coude', 'Poignet', 'Cou', 'Autre'];

function healthEnabled(data = getData()) {
  const c = data.health && data.health.consent;
  return !!(c && c.version >= HEALTH_CONSENT_VERSION);
}
function enableHealth() {
  const data = getData();
  data.health = { periods: [], ...(data.health || {}), consent: { version: HEALTH_CONSENT_VERSION, at: Date.now() } };
  saveData(data);
}
function disableHealth() {
  const data = getData();
  delete data.health;
  (data.sessions || []).forEach(s => { delete s.pain; });
  saveData(data);
}
function getHealthPeriods(data = getData()) {
  if (!healthEnabled(data)) return [];
  return (data.health.periods || []).slice().sort((a, b) => b.start.localeCompare(a.start));
}
function saveHealthPeriod(p) {
  const data = getData();
  if (!healthEnabled(data)) throw new Error('Option « Blessures et reprise » non activée');
  const list = data.health.periods = data.health.periods || [];
  if (!p.id) p.id = newId();
  const old = list.find(x => x.id === p.id);
  if (p.status === 'guerie') {
    // Jour de fin gardé tel quel ensuite : l'historique des défis ne bouge plus.
    p.healed = old && old.status === 'guerie' && old.healed ? old.healed
      : old ? localDateStr() : (p.end || p.start);
    if (p.healed < p.start) p.healed = p.start;
  } else delete p.healed;
  const i = list.indexOf(old);
  if (i >= 0) list[i] = p; else list.push(p);
  saveData(data);
  return p;
}
function deleteHealthPeriod(id) {
  const data = getData();
  if (!data.health) return;
  data.health.periods = (data.health.periods || []).filter(p => p.id !== id);
  saveData(data);
}
// Phase d'une période un jour donné : 'arret' (avant la reprise du sport),
// 'reprise' (après), ou null (hors période).
function healthPhase(p, day) {
  const to = p.status === 'guerie' ? (p.healed || p.end || p.start) : '9999-12-31';
  if (day < p.start || day > to) return null;
  const back = p.end || (p.status === 'en_cours' ? null : p.start);
  return back && day >= back ? 'reprise' : 'arret';
}
function healthPeriodsOn(day, data = getData()) {
  return getHealthPeriods(data).filter(p => healthPhase(p, day));
}
// Phase d'une semaine : 'arret' si un jour est en arrêt, sinon 'reprise', sinon null.
function healthWeekPhase(weekKey, data = getData()) {
  const periods = getHealthPeriods(data);
  if (!periods.length) return null;
  const phases = new Set();
  weekDays(weekKey).forEach(d => periods.forEach(p => { const ph = healthPhase(p, d); if (ph) phases.add(ph); }));
  return phases.has('arret') ? 'arret' : phases.has('reprise') ? 'reprise' : null;
}

// ── Défis de la semaine et badges ───────────────────────────────────────────
// Tout est calculé à partir des données (rien n'est stocké, sauf la liste des
// badges déjà annoncés : data.achievements_seen). Visible seulement par
// l'utilisateur lui-même (règle Strava : pas de partage des séances Strava).
// Objectif d'eau par jour : 1,5 L par défaut, modifiable (Nutrition → Hydratation),
// enregistré dans data.profile.hydro_goal (ml). Utilisé par la Nutrition, les défis et les badges.
const HYDRO_GOAL_DEFAULT = 1500;
function hydroGoal(data = getData()) {
  const g = +((data.profile || {}).hydro_goal);
  return g >= 250 && g <= 10000 ? g : HYDRO_GOAL_DEFAULT;
}
function setHydroGoal(ml) {
  const data = getData();
  data.profile = data.profile || {};
  if (ml == null) delete data.profile.hydro_goal; else data.profile.hydro_goal = Math.round(ml);
  saveData(data);
}
const formatLiters = ml => (Math.round(ml / 100) / 10).toLocaleString('fr-FR') + ' L';
const SPORT_WORDS = { nat: 'natation', velo: 'vélo', run: 'course à pied' };

function addDaysStr(day, n) { const d = parseLocalDate(day); d.setDate(d.getDate() + n); return localDateStr(d); }
function weekDays(weekKey) { const m = localDateStr(getWeekMonday(weekKey)); return [0, 1, 2, 3, 4, 5, 6].map(i => addDaysStr(m, i)); }
function prevWeekKey(weekKey, n = 1) { return getISOWeek(addDaysStr(localDateStr(getWeekMonday(weekKey)), -7 * n)); }

// Index par jour : séances, repas, hydratation (calculé une fois par appel)
function activityIndex(data) {
  const byWeek = {}, mealDays = new Set(), hydro = {};
  (data.sessions || []).forEach(s => {
    if (!s.date) return;
    const wk = getISOWeek(s.date);
    (byWeek[wk] = byWeek[wk] || []).push(s);
  });
  const nutri = data.nutrition || {};
  (nutri.meals || []).forEach(m => { if (m.date) mealDays.add(m.date); });
  Object.entries(nutri.hydration || {}).forEach(([d, v]) => { hydro[d] = v || 0; });
  return { byWeek, mealDays, hydro };
}

// Deux défis par semaine, choisis selon les 4 semaines précédentes :
// un d'entraînement (le sport le moins pratiqué) et un de nutrition.
function weeklyChallenges(weekKey, data = getData(), idx = activityIndex(data)) {
  const prev = [1, 2, 3, 4].map(n => prevWeekKey(weekKey, n));
  const recent = [].concat(...[1, 2, 3, 4, 5, 6, 7, 8].map(n => idx.byWeek[prevWeekKey(weekKey, n)] || []));
  const practiced = ['nat', 'velo', 'run'].filter(sp => recent.some(s => s.sport === sp));
  const avg = (fn) => prev.reduce((a, wk) => a + fn(wk), 0) / prev.length;
  const days = weekDays(weekKey);
  const inWeek = idx.byWeek[weekKey] || [];
  const list = [];
  const health = healthWeekPhase(weekKey, data);

  if (health === 'arret') {
    // Pendant un arrêt : pas de défi d'entraînement, seulement celui de nutrition.
  } else if (health === 'reprise') {
    // En reprise : la régularité plutôt que le volume.
    const a = [1, 2].reduce((t, n) => t + (idx.byWeek[prevWeekKey(weekKey, n)] || []).length, 0) / 2;
    const target = Math.min(3, Math.max(1, Math.round(a) + 1));
    list.push({ id: 'regular', kind: 'all', label: `${target} séance${target > 1 ? 's' : ''}, même courte${target > 1 ? 's' : ''}`,
      target, value: inWeek.length });
  } else if (practiced.length >= 2) {
    const counts = practiced.map(sp => ({ sp, a: avg(wk => (idx.byWeek[wk] || []).filter(s => s.sport === sp).length) }));
    counts.sort((x, y) => x.a - y.a);
    const { sp, a } = counts[0];
    const target = Math.min(3, Math.max(1, Math.round(a) + 1));
    list.push({ id: 'sport', kind: sp, label: `${target} séance${target > 1 ? 's' : ''} de ${SPORT_WORDS[sp]}`,
      target, value: inWeek.filter(s => s.sport === sp).length });
  } else {
    const a = avg(wk => (idx.byWeek[wk] || []).length);
    const target = Math.min(6, Math.max(2, Math.round(a) + 1));
    list.push({ id: 'sessions', kind: practiced[0] || 'all', label: `${target} séances dans la semaine`, target, value: inWeek.length });
  }

  const muscu = health ? null : muscuChallenge(weekKey, data, idx, prev, recent);
  if (muscu) list.push(muscu);

  const mealAvg = avg(wk => weekDays(wk).filter(d => idx.mealDays.has(d)).length);
  if (mealAvg < 5) {
    const target = Math.min(7, Math.max(3, Math.ceil(mealAvg) + 2));
    list.push({ id: 'meals', kind: 'nutri', label: `Repas notés ${target} jours`, target, value: days.filter(d => idx.mealDays.has(d)).length });
  } else {
    const goal = hydroGoal(data);
    const hAvg = avg(wk => weekDays(wk).filter(d => (idx.hydro[d] || 0) >= goal).length);
    const target = Math.min(7, Math.max(3, Math.ceil(hAvg) + 1));
    list.push({ id: 'hydro', kind: 'nutri', label: `${formatLiters(goal)} d’eau ${target} jours`, target, value: days.filter(d => (idx.hydro[d] || 0) >= goal).length });
  }
  list.forEach(c => { c.done = c.value >= c.target; });
  list.health = health;
  return list;
}

// Défi bonus de musculation (si l'utilisateur en a fait ces 8 dernières semaines).
// En plus des deux défis : il ne compte pas pour la série, pour ne pas la rendre
// plus difficile à ceux qui font de la musculation. Un seul par semaine, choisi en
// alternance parmi ceux qui ont du sens d'après les 4 semaines précédentes.
function muscuChallenge(weekKey, data, idx, prev, recent) {
  if (!recent.some(s => s.sport === 'muscu')) return null;
  const mu = wk => (idx.byWeek[wk] || []).filter(s => s.sport === 'muscu');
  const avg = fn => prev.reduce((a, wk) => a + fn(mu(wk)), 0) / prev.length;
  const groupsOf = list => new Set([].concat(...list.map(s => (s.exercises || []).map(e => e.group || MUSCU_GROUP_OF[e.name]).filter(Boolean)))).size;
  const inWeek = mu(weekKey);
  const options = [];
  { const a = avg(l => l.length);
    const target = Math.min(3, Math.max(1, Math.round(a) + 1));
    options.push({ id: 'muscu_sessions', label: `${target} séance${target > 1 ? 's' : ''} de musculation`, target, value: inWeek.length }); }
  const kgAvg = avg(l => l.reduce((a, s) => a + muscuVolume(s), 0));
  if (kgAvg >= 500) {
    const target = Math.ceil(kgAvg * 1.1 / 100) * 100;
    options.push({ id: 'muscu_kg', label: `${target.toLocaleString('fr-FR')} kg soulevés`, target,
      value: inWeek.reduce((a, s) => a + muscuVolume(s), 0) }); }
  const gAvg = prev.filter(wk => mu(wk).length).reduce((a, wk, i, arr) => a + groupsOf(mu(wk)) / arr.length, 0);
  if (gAvg >= 1) {
    const target = Math.min(6, Math.round(gAvg) + 1);
    options.push({ id: 'muscu_groups', label: `${target} groupes de muscles travaillés`, target, value: groupsOf(inWeek) }); }
  // Record de charge : un exercice fait au moins deux fois avec une charge avant cette semaine
  const start = weekDays(weekKey)[0];
  const before = {}, count = {};
  (data.sessions || []).filter(s => s.sport === 'muscu' && s.date < start).forEach(s => (s.exercises || []).forEach(e => {
    const kg = exMaxKg(e);
    if (!kg) return;
    before[e.name] = Math.max(before[e.name] || 0, kg);
    count[e.name] = (count[e.name] || 0) + 1;
  }));
  if (Object.values(count).some(n => n >= 2)) {
    const beaten = inWeek.some(s => (s.exercises || []).some(e => count[e.name] >= 2 && exMaxKg(e) > before[e.name]));
    options.push({ id: 'muscu_record', label: 'Battre un de tes records de charge', target: 1, value: beaten ? 1 : 0 }); }
  const pick = options[parseInt(weekKey.split('-W')[1], 10) % options.length];
  return Object.assign(pick, { kind: 'muscu', bonus: true });
}

// Semaines d'affilée avec les deux défis réussis (le défi bonus de musculation ne compte pas) (la semaine en cours compte si elle est déjà réussie).
function challengeHistory(data = getData(), idx = activityIndex(data)) {
  const today = localDateStr();
  const current = getISOWeek(today);
  const firstDay = [...(data.sessions || []).map(s => s.date), ...idx.mealDays].filter(Boolean).sort()[0];
  const out = { current: weeklyChallenges(current, data, idx), streak: 0, best: 0, doneWeeks: [] };
  out.paused = out.current.health;
  if (!firstDay) return out;
  const firstWeek = getISOWeek(firstDay);
  const weeks = [];
  for (let wk = prevWeekKey(current), i = 0; wk >= firstWeek && i < 260; wk = prevWeekKey(wk), i++) weeks.push(wk);
  weeks.reverse();
  let run = 0;
  weeks.forEach(wk => {
    const list = weeklyChallenges(wk, data, idx);
    const ok = list.filter(c => !c.bonus).every(c => c.done);
    // Semaine d'arrêt ou de reprise ratée : la série est en pause, pas perdue.
    if (ok) { out.doneWeeks.push(wk); run++; out.best = Math.max(out.best, run); } else if (!list.health) run = 0;
  });
  const curOk = out.current.filter(c => !c.bonus).every(c => c.done);
  out.streak = run + (curOk ? 1 : 0);
  if (curOk) { out.doneWeeks.push(current); out.best = Math.max(out.best, out.streak); }
  return out;
}

// Badges : { id, label, desc, kind, earned, date, value, target }
function getAchievements(data = getData()) {
  const idx = activityIndex(data);
  const sessions = (data.sessions || []).filter(s => s.date).slice().sort((a, b) => a.date.localeCompare(b.date));
  const badges = [];
  const add = (id, label, desc, kind, date, value, target) =>
    badges.push({ id, label, desc, kind, earned: !!date, date: date || null, value: Math.min(value || 0, target), target });

  // Nombre de séances
  [[1, 'first', 'Premier pas', 'Ta première séance enregistrée'], [50, 's50', '50 séances', '50 séances enregistrées'],
   [100, 's100', '100 séances', '100 séances enregistrées']].forEach(([n, id, label, desc]) =>
    add(id, label, desc, 'all', sessions[n - 1] && sessions[n - 1].date, sessions.length, n));

  // Par semaine : trois sports, 100 km de vélo, 10 h d'entraînement, 3 séances
  const weekKeys = Object.keys(idx.byWeek).sort();
  let triDate = null, veloDate = null, hoursDate = null, bestVelo = 0, bestHours = 0, bestSports = 0;
  weekKeys.forEach(wk => {
    const list = idx.byWeek[wk].slice().sort((a, b) => a.date.localeCompare(b.date));
    const seen = new Set(); let km = 0, h = 0;
    list.forEach(s => {
      seen.add(s.sport);
      if (!triDate && seen.has('nat') && seen.has('velo') && seen.has('run')) triDate = s.date;
      if (s.sport === 'velo') km += s.distance || 0;
      h += s.duration || 0;
      if (!veloDate && km >= 100) veloDate = s.date;
      if (!hoursDate && h >= 10) hoursDate = s.date;
    });
    bestVelo = Math.max(bestVelo, km); bestHours = Math.max(bestHours, h); bestSports = Math.max(bestSports, seen.size);
  });
  add('tri_week', 'Triathlète', 'Les 3 sports dans la même semaine', 'all', triDate, bestSports, 3);
  add('velo100', '100 km de vélo', '100 km de vélo en une semaine', 'velo', veloDate, Math.round(bestVelo), 100);
  add('hours10', '10 heures', '10h d’entraînement en une semaine', 'all', hoursDate, Math.round(bestHours * 10) / 10, 10);

  // Enchaînement vélo puis course le même jour
  const byDay = {};
  sessions.forEach(s => { (byDay[s.date] = byDay[s.date] || new Set()).add(s.sport); });
  const brick = Object.keys(byDay).sort().find(d => byDay[d].has('velo') && byDay[d].has('run'));
  add('brick', 'Enchaînement', 'Vélo et course à pied le même jour', 'run', brick, brick ? 1 : 0, 1);

  // Longues distances
  const firstOver = (sport, km) => (sessions.find(s => s.sport === sport && (s.distance || 0) >= km) || {}).date;
  const maxDist = (sport) => Math.max(0, ...sessions.filter(s => s.sport === sport).map(s => s.distance || 0));
  add('swim2k', 'Nageur', '2 km de natation en une séance', 'nat', firstOver('nat', 2), Math.round(maxDist('nat') * 10) / 10, 2);
  add('half', 'Semi-marathon', '21,1 km de course en une séance', 'run', firstOver('run', 21.0975), Math.round(maxDist('run') * 10) / 10, 21.1);

  // Régularité : 4 semaines d'affilée avec au moins 3 séances
  let regDate = null, run = 0, bestRun = 0, prevWk = null;
  weekKeys.forEach(wk => {
    const ok = idx.byWeek[wk].length >= 3;
    run = ok ? (prevWk && prevWeekKey(wk) === prevWk && run ? run + 1 : 1) : 0;
    if (ok) prevWk = wk;
    bestRun = Math.max(bestRun, run);
    if (!regDate && run >= 4) regDate = idx.byWeek[wk].map(s => s.date).sort().pop();
  });
  add('regular4', 'Régulier', '4 semaines d’affilée avec au moins 3 séances', 'all', regDate, bestRun, 4);

  // Nutrition : jours d'affilée avec repas notés, 30 jours notés, hydratation tenue 5 jours
  const streakDate = (okDay, n) => {
    const daysList = Object.keys(okDay).sort();
    let best = 0, cur = 0, prev = null, date = null;
    daysList.forEach(d => {
      cur = prev && addDaysStr(prev, 1) === d ? cur + 1 : 1;
      prev = d; best = Math.max(best, cur);
      if (!date && cur >= n) date = d;
    });
    return { date, best };
  };
  const mealObj = {}; idx.mealDays.forEach(d => { mealObj[d] = 1; });
  const m7 = streakDate(mealObj, 7);
  add('meals7', 'Semaine notée', 'Repas notés 7 jours d’affilée', 'nutri', m7.date, m7.best, 7);
  const mealSorted = [...idx.mealDays].sort();
  add('meals30', 'Carnet tenu', 'Repas notés sur 30 jours', 'nutri', mealSorted[29], mealSorted.length, 30);
  const hGoal = hydroGoal(data);
  const hydObj = {}; Object.entries(idx.hydro).forEach(([d, v]) => { if (v >= hGoal) hydObj[d] = 1; });
  const h5 = streakDate(hydObj, 5);
  add('hydro5', 'Bien hydraté', formatLiters(hGoal) + ' d’eau (ton objectif) 5 jours d’affilée', 'nutri', h5.date, h5.best, 5);

  // Ressenti noté sur 10 séances d'affilée
  let fRun = 0, fBest = 0, fDate = null;
  sessions.forEach(s => { fRun = s.sensation ? fRun + 1 : 0; fBest = Math.max(fBest, fRun); if (!fDate && fRun >= 10) fDate = s.date; });
  add('feel10', 'À l’écoute', 'Ressenti noté sur 10 séances d’affilée', 'nutri', fDate, fBest, 10);

  // Musculation : seulement pour ceux qui en font (sinon rien ne change)
  if (hasMuscu(data)) {
    const mus = sessions.filter(s => s.sport === 'muscu');
    add('muscu10', 'Assidu en salle', '10 séances de musculation', 'muscu', mus[9] && mus[9].date, mus.length, 10);
    let fullDate = null, bestG = 0;
    weekKeys.forEach(wk => {
      const g = new Set();
      idx.byWeek[wk].filter(s => s.sport === 'muscu').sort((a, b) => a.date.localeCompare(b.date)).forEach(s => {
        (s.exercises || []).forEach(e => { const gr = e.group || MUSCU_GROUP_OF[e.name]; if (gr) g.add(gr); });
        if (!fullDate && g.size >= MUSCU_CATALOG.length) fullDate = s.date;
      });
      bestG = Math.max(bestG, g.size);
    });
    add('muscu_full', 'Corps complet', 'Les 6 groupes de muscles travaillés dans la même semaine', 'muscu', fullDate, bestG, MUSCU_CATALOG.length);
  }

  // Compétitions
  const today = localDateStr();
  const comps = (data.competitions || []).filter(c => c.date && c.date <= today && c.actual_time).sort((a, b) => a.date.localeCompare(b.date));
  add('finisher', 'Finisher', 'Une compétition terminée', 'all', comps[0] && comps[0].date, comps.length, 1);
  const goal = comps.find(c => c.goal_time && compTimeToSec(c.actual_time) && compTimeToSec(c.actual_time) <= compTimeToSec(c.goal_time));
  add('goal', 'Objectif atteint', 'Temps visé atteint en compétition', 'all', goal && goal.date, goal ? 1 : 0, 1);

  // Défis de la semaine
  const hist = challengeHistory(data, idx);
  const w = hist.doneWeeks;
  const weekEnd = (wk) => { const ds = weekDays(wk); return ds[6] > today ? today : ds[6]; };
  add('challenge1', 'Défi relevé', 'Les deux défis d’une semaine réussis', 'all', w[0] && weekEnd(w[0]), w.length, 1);
  add('challenge4', 'Série de 4', 'Défis réussis 4 semaines d’affilée', 'all', hist.best >= 4 ? weekEnd(w[w.length - 1]) : null, hist.best, 4);
  return badges;
}

// Affichage d'un badge (Dashboard et Profil) : médaille avec un repère court, pas d'emoji.
const BADGE_MARKS = { first: '1', s50: '50', s100: '100', tri_week: '3', velo100: 'km', hours10: '10h', brick: 'V+C',
  swim2k: '2k', half: '21', regular4: '4×3', meals7: '7j', meals30: '30j', hydro5: 'H2O', feel10: '10',
  finisher: 'F', goal: 'OK', challenge1: '1', challenge4: '4', muscu10: '10', muscu_full: '6' };
function badgeTileHtml(b) {
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = b.earned ? 'Obtenu le ' + parseLocalDate(b.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const pct = b.target ? Math.round(b.value / b.target * 100) : 0;
  return `<div class="badge-tile${b.earned ? '' : ' locked'}" title="${esc(b.desc)}">
    <div class="badge-tile__medal badge-kind--${b.kind}">${BADGE_MARKS[b.id] || '★'}</div>
    <div style="min-width:0">
      <div class="badge-tile__name">${esc(b.label)}</div>
      <div class="badge-tile__desc">${esc(b.earned ? when : b.desc)}</div>
      ${b.earned ? '' : `<div class="badge-tile__prog"><b style="width:${pct}%"></b></div>`}
    </div>
  </div>`;
}

// Badges obtenus mais pas encore annoncés ; les marque comme vus.
// Première fois : tout est marqué vu, et on renvoie seulement le nombre.
function takeNewAchievements() {
  if (!cloudLoaded) return null;
  const data = getData();
  const earned = getAchievements(data).filter(b => b.earned);
  const seen = data.achievements_seen;
  const fresh = seen ? earned.filter(b => !seen.includes(b.id)) : [];
  if (seen && !fresh.length) return { fresh: [], first: false };
  data.achievements_seen = earned.map(b => b.id);
  saveData(data);
  return { fresh, first: !seen, count: earned.length };
}

// ── Nouveautés : un message une seule fois par compte (data.news_seen) ───────
// Seulement pour les comptes qui avaient déjà des séances : un nouveau compte
// découvre tout avec le guide de démarrage, l'annonce est marquée vue sans s'afficher.
const NEWS = [{
  id: 'muscu',
  skip: data => hasMuscu(data),   // déjà adopté : rien à annoncer
  title: 'Nouveau : la musculation',
  html: '<p>Tu peux maintenant noter tes séances de <b>musculation</b> : tes exercices (plus de 80 au choix, machines comprises, avec une recherche), tes séries, répétitions et charges.</p>'
    + '<ul><li>Elles comptent dans tes heures, ta charge d’entraînement et ta forme.</li>'
    + '<li>Tes records et ta progression par exercice se calculent tout seuls (Sports → Muscu).</li>'
    + '<li>Une carte du corps montre les zones travaillées (page Forme).</li>'
    + '<li>Les séances de musculation de Strava ou de ta montre sont maintenant importées.</li></ul>'
    + '<p class="news__note">Tu n’en fais pas ? Rien ne change : la musculation n’apparaît qu’à partir de ta première séance.</p>',
  action: { label: 'Ajouter une séance de musculation', href: 'sessions.html?nouvelle=muscu' },
}];
function showNews() {
  if (!cloudLoaded || window.TS_LOGGED_OUT || document.getElementById('consentGate') || document.getElementById('newsModal')) return;
  const data = getData();
  const seen = data.news_seen || [];
  const todo = NEWS.filter(n => !seen.includes(n.id));
  if (!todo.length) return;
  data.news_seen = seen.concat(todo.map(n => n.id));
  saveData(data);
  const n = todo.find(x => (data.sessions || []).length && !x.skip(data));
  if (!n) return;
  const box = document.createElement('div');
  box.className = 'modal-overlay';
  box.id = 'newsModal';
  box.innerHTML = `<div class="modal news" role="dialog" aria-modal="true" aria-labelledby="newsTitle" style="max-width:460px">
    <div class="modal__header"><div class="modal__title" id="newsTitle"><span class="sport-dot sport-dot--muscu"></span>${n.title}</div>
      <button class="modal__close" type="button" data-close aria-label="Fermer">×</button></div>
    <div class="news__body">${n.html}</div>
    <div class="form-actions"><button class="btn btn--ghost" type="button" data-close>Plus tard</button>
      <a class="btn btn--primary" href="${n.action.href}">${n.action.label}</a></div></div>`;
  document.body.appendChild(box);
  requestAnimationFrame(() => box.classList.add('open'));
  box.addEventListener('click', e => {
    if (e.target === box || e.target.closest('[data-close]')) { box.classList.remove('open'); setTimeout(() => box.remove(), 250); }
  });
}

// ── Strava : les séances arrivent toutes seules ─────────────────────────────
// Réglages publics (ils ne sont pas secrets). La clé secrète de l'appli Strava
// est gardée par le petit serveur TriSeason (tools/server, Cloudflare), jamais
// dans le site : il échange le code d'autorisation et renouvelle les jetons.
// Les séances sont lues directement chez Strava par le navigateur, à
// l'ouverture de l'appli (au plus toutes les 15 minutes par appareil).
const STRAVA_CLIENT_ID = '287261';
const TS_SERVER_URL = 'https://triseason.tri-season-tracker.workers.dev';
const STRAVA_API = 'https://www.strava.com/api/v3';
const STRAVA_CHECK_KEY = 'triseason_strava_check';
const STRAVA_STATE_KEY = 'triseason_strava_state';
const STRAVA_EVERY_MS = 15 * 60 * 1000;
const STRAVA_FIRST_DAYS = 30;
const STRAVA_LIMIT_MSG = 'La connexion à Strava n’est pas encore ouverte à tout le monde : elle arrive bientôt. '
  + 'En attendant, tu peux récupérer tout ton historique avec ton archive Strava (page Séances) ou importer tes fichiers de montre.';  // à la connexion : les 30 derniers jours
LOCAL_USER_KEYS.push(STRAVA_CHECK_KEY);

const STRAVA_SPORTS = {
  Run: 'run', TrailRun: 'run', VirtualRun: 'run',
  Ride: 'velo', VirtualRide: 'velo', GravelRide: 'velo', MountainBikeRide: 'velo',
  EBikeRide: 'velo', EMountainBikeRide: 'velo', Velomobile: 'velo', Handcycle: 'velo',
  Swim: 'nat',
  WeightTraining: 'muscu', Crossfit: 'muscu',
};

function stravaAvailable() { return !!(STRAVA_CLIENT_ID && TS_SERVER_URL); }
function getStrava() { return getData().strava || null; }

async function serverPost(path, body) {
  const res = await fetch(TS_SERVER_URL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || ('Serveur TriSeason : erreur ' + res.status)), { code: json.code || null, status: res.status });
  return json;
}

// Ouvre la page Strava « Autoriser TriSeason ? » ; Strava renvoie ensuite vers
// la page Profil avec un code (domaine autorisé réglé dans l'appli Strava).
function stravaConnect() {
  const state = newId();
  try { sessionStorage.setItem(STRAVA_STATE_KEY, state); } catch {}
  const back = location.origin + location.pathname.replace(/[^/]*$/, '') + 'profile.html';
  location.href = 'https://www.strava.com/oauth/authorize?' + new URLSearchParams({
    client_id: STRAVA_CLIENT_ID, redirect_uri: back, response_type: 'code',
    approval_prompt: 'auto', scope: 'read,activity:read_all', state,
  });
}

// Attend que les données du compte soient lues (sinon une écriture locale
// serait remplacée par la copie du cloud).
function whenCloudLoaded(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (cloudLoaded) return resolve();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cloudLoaded) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('Données du compte pas encore chargées. Recharge la page.')); }
    }, 100);
  });
}

// Retour de Strava sur la page Profil (?code=…&state=…&scope=…).
// Renvoie null s'il n'y a rien à traiter, sinon un message pour l'utilisateur.
async function stravaHandleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return null;
  history.replaceState(null, '', location.pathname);
  let expected = null;
  try { expected = sessionStorage.getItem(STRAVA_STATE_KEY); sessionStorage.removeItem(STRAVA_STATE_KEY); } catch {}
  if (q.get('error')) return { ok: false, msg: 'Connexion à Strava annulée.' };
  if (!expected || q.get('state') !== expected) return { ok: false, msg: 'Connexion à Strava refusée (lien expiré). Réessaie.' };
  if (!/activity:read/.test(q.get('scope') || '')) {
    return { ok: false, msg: 'Pour importer tes séances, laisse cochée la case « Voir les données de vos activités » sur la page Strava.' };
  }
  let tok;
  try {
    tok = await serverPost('/strava/token', { code: q.get('code') });
  } catch (err) {
    // Strava limite le nombre de comptes connectés tant que l'appli n'est pas validée.
    // (« (403) » : même cas avec une ancienne version du serveur TriSeason)
    if (err.code === 'athlete_limit' || /\(403\)/.test(err.message)) return { ok: false, limit: true, msg: STRAVA_LIMIT_MSG };
    throw err;
  }
  await whenCloudLoaded();
  const data = getData();
  const a = tok.athlete || {};
  data.strava = {
    athlete_id: a.id || null, name: [a.firstname, a.lastname].filter(Boolean).join(' '),
    access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: tok.expires_at,
    connected_at: Date.now(), after: Math.floor(Date.now() / 1000) - STRAVA_FIRST_DAYS * 86400,
  };
  saveData(data);
  const r = await stravaSync({ force: true });
  return { ok: true, msg: 'Strava connecté. ' + stravaSyncMessage(r, true) };
}

async function stravaAccessToken() {
  const st = getStrava();
  if (!st) throw new Error('Strava n’est pas connecté.');
  if (st.expires_at && st.expires_at - 120 > Date.now() / 1000) return st.access_token;
  const tok = await serverPost('/strava/refresh', { refresh_token: st.refresh_token });
  const data = getData();
  if (!data.strava) throw new Error('Strava n’est pas connecté.');
  Object.assign(data.strava, { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: tok.expires_at });
  saveData(data);
  return tok.access_token;
}

// Activité Strava (résumé) → séance TriSeason. null si le sport n'est pas suivi.
// La date vient de start_date_local (heure locale de la séance) : pas de
// passage par l'UTC. Durée totale (comme l'import .fit), à la seconde.
function stravaToSession(a) {
  const sport = STRAVA_SPORTS[a.sport_type] || STRAVA_SPORTS[a.type];
  if (!sport || !a.start_date_local) return null;
  const r = (v) => (v == null || isNaN(v) ? null : Math.round(v));
  const sec = a.elapsed_time || a.moving_time || 0;
  return compactSession({
    date: String(a.start_date_local).slice(0, 10),
    sport,
    duration: sec ? Math.round(sec) / 3600 : null,
    distance: a.distance ? Math.round(a.distance / 10) / 100 : null,
    elevation: r(a.total_elevation_gain) || null,
    fc_avg: r(a.average_heartrate), fc_max: r(a.max_heartrate),
    power_avg: a.device_watts ? r(a.average_watts) : null,
    power_max: a.device_watts ? r(a.max_watts) : null,
    np: a.device_watts ? r(a.weighted_average_watts) : null,
    // La liste Strava ne donne pas les calories (seulement le détail d'une activité) ;
    // pour le vélo avec capteur de puissance, le travail en kJ ≈ les kcal dépensées.
    kcal: r(a.calories) || r(a.kilojoules) || null,
    notes: a.name || null,
    strava_id: a.id,
  });
}

// Même jour, même sport, distance et durée proches : déjà importée (fichier .fit…)
function stravaFindSimilar(sessions, c) {
  return sessions.find(s => {
    if (s.strava_id || s.date !== c.date || s.sport !== c.sport) return false;
    const distOk = !c.distance || !s.distance || Math.abs(c.distance - s.distance) <= Math.max(0.3, s.distance * 0.1);
    const durOk = !c.duration || !s.duration || Math.abs(c.duration - s.duration) <= Math.max(0.08, s.duration * 0.1);
    return distOk && durOk;
  });
}

// ── Archive Strava (fichier .zip / activities.csv) ──────────────────────────
// Prépare l'import : séances à ajouter, séances déjà présentes (même activité
// Strava, ou même séance importée par fichier), activités ignorées (marche…).
// Limite de taille : un compte est un seul document Firestore (1 Mo max). On
// garde une marge et, si besoin, on n'ajoute que les séances les plus récentes.
const DATA_MAX_BYTES = 850 * 1024;
function dataBytes(data) { return new TextEncoder().encode(JSON.stringify(data)).length; }

function archiveToSession(a) {
  const sec = a.elapsed || 0;
  const s = {
    date: a.localDate || localDateStr(a.start), sport: a.sport,
    duration: sec ? Math.round(sec) / 3600 : null,
    distance: a.distance_m ? Math.round(a.distance_m / 10) / 100 : null,
    elevation: a.elevation ? Math.round(a.elevation) : null,
    fc_avg: a.hrAvg ? Math.round(a.hrAvg) : null, fc_max: a.hrMax ? Math.round(a.hrMax) : null,
    power_avg: a.watts ? Math.round(a.watts) : null, power_max: a.wattsMax ? Math.round(a.wattsMax) : null,
    np: a.np ? Math.round(a.np) : null, kcal: a.kcal ? Math.round(a.kcal) : null,
    notes: a.name ? a.name.slice(0, 80) : null, strava_id: a.id,
  };
  return compactSession(s);
}

function planStravaArchive(acts, { since = null } = {}) {
  const data = getData();
  const known = new Set(data.sessions.map(s => s.strava_id).filter(Boolean).map(Number));
  const plan = { add: [], link: [], already: 0, ignored: 0, before: 0, dropped: 0, oldestKept: null };
  const sessions = data.sessions.slice();
  acts.slice().sort((x, y) => y.start - x.start).forEach(a => {   // les plus récentes d'abord
    if (known.has(Number(a.id))) { plan.already++; return; }
    if (!a.sport) { plan.ignored++; return; }
    const s = archiveToSession(a);
    if (since && s.date < since) { plan.before++; return; }
    const twin = stravaFindSimilar(sessions, s);
    if (twin) { plan.link.push({ id: twin.id, strava_id: a.id }); twin.strava_id = a.id; return; }
    plan.add.push(s);
  });
  // Taille : on retire les plus anciennes si on dépasse la limite
  const base = dataBytes(data);
  let total = base;
  const kept = [];
  for (const s of plan.add) {
    const size = new TextEncoder().encode(JSON.stringify({ ...s, id: 'x'.repeat(16) })).length + 1; // id réel : 14 caractères
    if (total + size > dataMaxBytes()) { plan.dropped = plan.add.length - kept.length; break; }
    total += size; kept.push(s);
  }
  plan.add = kept;
  plan.oldestKept = kept.length ? kept[kept.length - 1].date : null;
  plan.bytesAfter = total; plan.bytesBefore = base;
  return plan;
}

// Tout l'historique depuis le compte Strava connecté, SANS rien enregistrer :
// renvoie des activités au même format que l'archive, pour l'aperçu de la page
// Séances (planStravaArchive puis applyStravaArchive après validation).
async function stravaFetchHistory(onProgress) {
  await whenCloudLoaded();
  const token = await stravaAccessToken();
  const list = [];
  for (let page = 1; page <= 40; page++) {
    if (onProgress) onProgress(list.length);
    const res = await fetch(STRAVA_API + '/athlete/activities?per_page=200&page=' + page, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) throw new Error('Strava a refusé l’accès : déconnecte puis reconnecte Strava dans Profil.');
    if (res.status === 429) throw new Error('Strava est très sollicité : réessaie dans un quart d’heure.');
    if (!res.ok) throw new Error('Strava ne répond pas (erreur ' + res.status + ').');
    const batch = await res.json();
    list.push(...batch);
    if (batch.length < 200) break;
  }
  return list.map(a => {
    const s = stravaToSession(a);
    return { id: a.id, start: new Date(a.start_date), localDate: String(a.start_date_local || '').slice(0, 10) || null,
      name: a.name || '', type: a.sport_type || a.type || '', sport: s ? s.sport : null,
      elapsed: a.elapsed_time || a.moving_time || null, distance_m: a.distance || null, elevation: a.total_elevation_gain || null,
      hrAvg: a.average_heartrate || null, hrMax: a.max_heartrate || null,
      watts: a.device_watts ? a.average_watts : null, wattsMax: a.device_watts ? a.max_watts : null,
      np: a.device_watts ? a.weighted_average_watts : null, kcal: a.calories || null };
  });
}

// Un seul enregistrement pour toute l'archive.
function applyStravaArchive(plan) {
  const data = getData();
  plan.link.forEach(l => { const s = data.sessions.find(x => x.id === l.id); if (s) s.strava_id = l.strava_id; });
  plan.add.forEach(s => { data.sessions.push({ ...s, id: newId() }); });
  saveData(data);
  return { added: plan.add.length, linked: plan.link.length };
}

let stravaRunning = null;
// Va chercher les nouvelles activités Strava. { force } : ignore le délai de 15 min ;
// { full } : reprend tout l'historique. Renvoie { added, linked, ignored }.
function stravaSync(opts = {}) {
  if (stravaRunning) return stravaRunning;
  stravaRunning = stravaSyncRun(opts).finally(() => { stravaRunning = null; });
  return stravaRunning;
}

async function stravaSyncRun({ force = false, full = false } = {}) {
  if (!stravaAvailable() || !getStrava()) return null;
  if (!force) {
    let last = 0;
    try { last = +localStorage.getItem(STRAVA_CHECK_KEY) || 0; } catch {}
    if (Date.now() - last < STRAVA_EVERY_MS) return null;
  }
  await whenCloudLoaded();
  try { localStorage.setItem(STRAVA_CHECK_KEY, String(Date.now())); } catch {}
  const token = await stravaAccessToken();
  // 3 jours de marge : une montre synchronisée en retard envoie parfois une
  // séance plus ancienne que la dernière reçue (les doublons sont écartés).
  const after = full ? 0 : Math.max(0, (getStrava().after || 0) - 3 * 86400);
  const acts = [];
  for (let page = 1; page <= (full ? 30 : 3); page++) {
    const res = await fetch(STRAVA_API + '/athlete/activities?per_page=100&page=' + page + '&after=' + after,
      { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) throw new Error('Strava a refusé l’accès : déconnecte puis reconnecte Strava dans Profil.');
    if (res.status === 429) throw new Error('Strava est très sollicité : nouvel essai automatique plus tard.');
    if (!res.ok) throw new Error('Strava ne répond pas (erreur ' + res.status + ').');
    const list = await res.json();
    acts.push(...list);
    if (list.length < 100) break;
  }
  const data = getData();
  if (!data.strava) return null;
  const known = new Set(data.sessions.map(s => s.strava_id).filter(Boolean));
  let added = 0, linked = 0, ignored = 0, newest = data.strava.after || 0;
  acts.forEach(a => {
    const start = Math.floor(Date.parse(a.start_date) / 1000);
    if (start > newest) newest = start;
    if (known.has(a.id)) return;
    const s = stravaToSession(a);
    if (!s) { ignored++; return; }
    const twin = stravaFindSimilar(data.sessions, s);
    if (twin) { twin.strava_id = a.id; linked++; }
    else { s.id = newId(); data.sessions.push(s); added++; }
    known.add(a.id);
  });
  await stravaFillCalories(token, data);
  data.strava.after = newest;
  data.strava.last_sync = Date.now();
  saveData(data);
  return { added, linked, ignored };
}

// Calories : la liste des activités Strava ne les contient pas, il faut lire le
// détail de chaque activité (1 requête chacune). Séances Strava des 30 derniers
// jours sans kcal, 15 au plus par synchro (limite Strava : 100 requêtes / 15 min
// pour l'appli entière). Une activité sans calories chez Strava (ni fréquence
// cardiaque, ni puissance, ni poids) n'est demandée qu'une fois par appareil.
const STRAVA_KCAL_KEY = 'triseason_strava_kcal_checked';
async function stravaFillCalories(token, data) {
  let checked = [];
  try { checked = JSON.parse(localStorage.getItem(STRAVA_KCAL_KEY) || '[]'); } catch {}
  const since = addDaysStr(localDateStr(), -30);
  const todo = data.sessions.filter(s => s.strava_id && !s.kcal && s.date >= since && !checked.includes(s.strava_id))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
  for (const s of todo) {
    let res;
    try { res = await fetch(STRAVA_API + '/activities/' + s.strava_id, { headers: { Authorization: 'Bearer ' + token } }); }
    catch { break; } // pas de réseau : on réessaiera à la prochaine synchro
    if (res.status === 429) break;
    if (!res.ok) { if (res.status === 404) checked.push(s.strava_id); continue; }
    const a = await res.json();
    const kcal = Math.round(a.calories || 0) || Math.round(a.kilojoules || 0);
    if (kcal > 0) s.kcal = kcal; else checked.push(s.strava_id);
  }
  try { localStorage.setItem(STRAVA_KCAL_KEY, JSON.stringify(checked.slice(-500))); } catch {}
}

function stravaSyncMessage(r, always) {
  if (!r) return always ? 'Aucune nouvelle séance.' : '';
  if (!r.added) return always ? 'Aucune nouvelle séance' + (r.linked ? ' (' + r.linked + ' déjà présente' + (r.linked > 1 ? 's' : '') + ')' : '') + '.' : '';
  return r.added + ' séance' + (r.added > 1 ? 's' : '') + ' ajoutée' + (r.added > 1 ? 's' : '') + ' depuis Strava.';
}

// Synchro silencieuse à l'ouverture de l'appli (message seulement s'il y a du nouveau).
function stravaAutoSync() {
  if (!stravaAvailable() || !getStrava()) return;
  stravaSync().then(r => { const m = stravaSyncMessage(r, false); if (m) toast(m); })
    .catch(err => console.warn('[TriSeason] Synchro Strava :', err.message));
}

// Déconnexion : Strava retire l'autorisation ; les séances venues de Strava
// sont gardées ou supprimées selon le choix de l'utilisateur.
async function stravaDisconnect({ deleteSessions = false } = {}) {
  const st = getStrava();
  if (st) {
    try { await serverPost('/strava/deauthorize', { access_token: await stravaAccessToken() }); }
    catch (err) { console.warn('[TriSeason] Déconnexion Strava :', err.message); }
  }
  const data = getData();
  delete data.strava;
  if (deleteSessions) data.sessions = data.sessions.filter(s => !s.strava_id);
  else data.sessions.forEach(s => { delete s.strava_id; });
  saveData(data);
  try { localStorage.removeItem(STRAVA_CHECK_KEY); } catch {}
}

// Annonce « séance prévue réalisée » sur n'importe quelle page (import, Strava…).
let planAnnounceTimer = null;
window.addEventListener('triseason:update', () => {
  clearTimeout(planAnnounceTimer);
  planAnnounceTimer = setTimeout(() => {
    takeDonePlans().forEach((d, i) => setTimeout(() => {
      const sp = (SPORTS[d.plan.sport] || {}).label || '';
      toast(d.state === 'done' ? 'Séance prévue réalisée : ' + sp.toLowerCase() + ' du ' + parseLocalDate(d.plan.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
        : 'Séance prévue faite en partie (' + Math.round(d.ratio * 100) + ' % de l’objectif) : ' + sp.toLowerCase() + ' du ' + parseLocalDate(d.plan.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }));
    }, i * 3000));
  }, 400);
});

// ── Toast notifications ───────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('toast--show'), 10);
  const duration = Math.min(9000, 2800 + Math.max(0, msg.length - 40) * 60); // phrase longue = plus de temps de lecture
  setTimeout(() => { t.classList.remove('toast--show'); setTimeout(() => t.remove(), 300); }, duration);
}

// ── Tooltip helper ────────────────────────────────────────────────────────────
// Infobulles : un seul écouteur global (délégation d'événements).
// - fonctionne aussi pour le contenu généré dynamiquement après le chargement
// - idempotent : les pages peuvent appeler initTooltips() autant de fois que voulu
function initTooltips() {
  if (window.__tipInit) return;
  window.__tipInit = true;

  let tip = null;
  let current = null;

  function hide() {
    if (tip) { tip.remove(); tip = null; }
    current = null;
  }

  function show(el) {
    hide();
    const text = el.getAttribute('data-tip');
    if (!text || !text.trim()) return;
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.textContent = text;
    document.body.appendChild(tip);
    const r = el.getBoundingClientRect();
    let left = r.left + r.width / 2 - tip.offsetWidth / 2;
    let top  = r.top - tip.offsetHeight - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - tip.offsetWidth - 8));
    if (top < 8) top = r.bottom + 8; // sous l'élément s'il n'y a pas la place au-dessus
    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';
    current = el;
  }

  document.addEventListener('mouseover', function (e) {
    if (current && !document.body.contains(current)) hide(); // élément re-généré entre-temps
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el) { if (el !== current) show(el); }
    else if (current) hide();
  });

  document.addEventListener('mouseout', function (e) {
    if (!current) return;
    const to = e.relatedTarget;
    if (!to || !current.contains(to)) hide();
  });

  window.addEventListener('scroll', hide, true);
  window.addEventListener('triseason:update', hide);
}

// ── Sport config ─────────────────────────────────────────────────────────────
const SPORTS = {
  nat:  { label: 'Natation',  emoji: '<span class="sport-dot sport-dot--nat"></span>', color: '#2f95e6', unit: 'km', paceLabel: 'Allure', paceUnit: '/100m' },
  velo: { label: 'Vélo',      emoji: '<span class="sport-dot sport-dot--velo"></span>', color: '#d8791a', unit: 'km', paceLabel: 'Vitesse', paceUnit: 'km/h' },
  run:  { label: 'Course',    emoji: '<span class="sport-dot sport-dot--run"></span>', color: '#dc3d6a', unit: 'km', paceLabel: 'Allure', paceUnit: '/km' },
  muscu: { label: 'Musculation', emoji: '<span class="sport-dot sport-dot--muscu"></span>', color: '#9256fb', unit: '', paceLabel: null, paceUnit: '' },
};

const COMP_TYPES = ['TRI', 'RUN', 'VELO', 'NAT', 'DUATH', 'AQUA'];


// ── Musculation ─────────────────────────────────────────────────────────────
// Séance sport 'muscu' : durée + RPE (charge d'entraînement comme les autres
// sports) et session.exercises = [{ name, group, sets, reps, kg }]. Pour un
// exercice tenu (gainage), reps = secondes. La musculation n'apparaît dans les
// filtres, graphiques et listes de sports que si au moins une séance existe.
// Catalogue : [nom, muscles travaillés]. Muscles : clés de MUSCLES ; suffixe « - » =
// muscle secondaire (compte pour moitié sur la carte du corps). Ne pas renommer un
// exercice existant (les séances gardent le nom) : en ajouter un nouveau.
const MUSCLES = {
  pecs: 'Pectoraux', epaules: 'Épaules', biceps: 'Biceps', triceps: 'Triceps', avantbras: 'Avant-bras',
  abdos: 'Abdominaux', obliques: 'Obliques', dorsaux: 'Dorsaux', trapezes: 'Trapèzes', lombaires: 'Lombaires',
  fessiers: 'Fessiers', quadriceps: 'Quadriceps', ischios: 'Ischio-jambiers', adducteurs: 'Adducteurs', mollets: 'Mollets',
};
const MUSCU_CATALOG = [
  ['Pectoraux', [
    ['Développé couché (barre)', 'pecs triceps- epaules-'],
    ['Développé couché (haltères)', 'pecs triceps- epaules-'],
    ['Développé couché (machine)', 'pecs triceps- epaules-'],
    ['Développé incliné', 'pecs epaules- triceps-'],
    ['Développé incliné (haltères)', 'pecs epaules- triceps-'],
    ['Développé incliné (machine)', 'pecs epaules- triceps-'],
    ['Développé décliné', 'pecs triceps-'],
    ['Pec fly (machine)', 'pecs epaules-'],
    ['Écarté (haltères ou poulie)', 'pecs epaules-'],
    ['Écarté à la poulie (vis-à-vis)', 'pecs epaules-'],
    ['Pompes', 'pecs triceps- epaules- abdos-'],
  ]],
  ['Dos', [
    ['Tirage vertical', 'dorsaux biceps- trapezes-'],
    ['Tirage vertical prise serrée', 'dorsaux biceps-'],
    ['Tirage horizontal', 'dorsaux trapezes- biceps-'],
    ['Tractions', 'dorsaux biceps- avantbras-'],
    ['Tractions assistées (machine)', 'dorsaux biceps-'],
    ['Rowing (barre ou haltère)', 'dorsaux trapezes- biceps- lombaires-'],
    ['Rowing (machine)', 'dorsaux trapezes- biceps-'],
    ['Rowing T-bar', 'dorsaux trapezes- lombaires-'],
    ['Pull-over (poulie ou haltère)', 'dorsaux pecs-'],
    ['Soulevé de terre', 'lombaires fessiers ischios dorsaux- trapezes- quadriceps- avantbras-'],
    ['Extensions lombaires (banc)', 'lombaires fessiers- ischios-'],
    ['Shrugs (trapèzes)', 'trapezes avantbras-'],
  ]],
  ['Épaules', [
    ['Développé militaire', 'epaules triceps- trapezes-'],
    ['Développé épaules (haltères)', 'epaules triceps-'],
    ['Développé épaules (machine)', 'epaules triceps-'],
    ['Élévations latérales', 'epaules trapezes-'],
    ['Élévations latérales (poulie ou machine)', 'epaules'],
    ['Élévations frontales', 'epaules pecs-'],
    ['Oiseau (arrière d’épaule)', 'epaules trapezes- dorsaux-'],
    ['Reverse fly (machine)', 'epaules trapezes-'],
    ['Face pull', 'epaules trapezes-'],
    ['Rowing menton', 'epaules trapezes biceps-'],
  ]],
  ['Bras', [
    ['Curl biceps (barre)', 'biceps avantbras-'],
    ['Curl biceps (haltères)', 'biceps avantbras-'],
    ['Curl biceps (machine)', 'biceps'],
    ['Curl à la poulie', 'biceps avantbras-'],
    ['Curl pupitre', 'biceps'],
    ['Curl marteau', 'biceps avantbras'],
    ['Tirage triceps (poulie)', 'triceps'],
    ['Extension triceps au-dessus de la tête', 'triceps'],
    ['Barre au front', 'triceps'],
    ['Kickback triceps', 'triceps'],
    ['Dips', 'triceps pecs- epaules-'],
    ['Dips (machine)', 'triceps pecs-'],
    ['Curl poignets (avant-bras)', 'avantbras'],
  ]],
  ['Jambes', [
    ['Squat', 'quadriceps fessiers ischios- lombaires- adducteurs-'],
    ['Front squat', 'quadriceps fessiers- abdos-'],
    ['Squat (Smith machine)', 'quadriceps fessiers'],
    ['Goblet squat', 'quadriceps fessiers abdos-'],
    ['Hack squat (machine)', 'quadriceps fessiers-'],
    ['Presse à cuisses (assise)', 'quadriceps fessiers ischios-'],
    ['Presse à cuisses (verticale)', 'quadriceps fessiers ischios-'],
    ['Presse à cuisses (45°)', 'quadriceps fessiers ischios-'],
    ['Leg extension', 'quadriceps'],
    ['Leg curl', 'ischios mollets-'],
    ['Leg curl (assis)', 'ischios'],
    ['Soulevé de terre jambes tendues', 'ischios fessiers lombaires-'],
    ['Fentes', 'quadriceps fessiers ischios- adducteurs-'],
    ['Fentes bulgares', 'quadriceps fessiers adducteurs-'],
    ['Step-up', 'quadriceps fessiers'],
    ['Hip thrust', 'fessiers ischios-'],
    ['Kickback fessier (poulie ou machine)', 'fessiers ischios-'],
    ['Abducteurs (machine)', 'fessiers'],
    ['Adducteurs (machine)', 'adducteurs'],
    ['Mollets', 'mollets'],
    ['Mollets assis (machine)', 'mollets'],
  ]],
  ['Abdos et gainage', [
    ['Gainage (planche)', 'abdos obliques- epaules-'],
    ['Gainage latéral', 'obliques abdos-'],
    ['Crunch', 'abdos'],
    ['Crunch (machine)', 'abdos'],
    ['Crunch à la poulie', 'abdos'],
    ['Crunch oblique', 'obliques abdos-'],
    ['Relevé de jambes', 'abdos'],
    ['Russian twist', 'obliques abdos-'],
    ['Roue abdominale', 'abdos dorsaux- epaules-'],
    ['Mountain climbers', 'abdos quadriceps- epaules-'],
    ['Hollow body', 'abdos'],
    ['Dead bug', 'abdos lombaires-'],
    ['Rotation du buste (machine ou poulie)', 'obliques'],
  ]],
];
// Muscles par défaut d'un groupe (exercice libre rangé dans un groupe)
const MUSCU_GROUP_TARGETS = { 'Pectoraux': 'pecs', 'Dos': 'dorsaux', 'Épaules': 'epaules', 'Bras': 'biceps triceps', 'Jambes': 'quadriceps fessiers ischios', 'Abdos et gainage': 'abdos' };
const parseTargets = (str) => {
  const t = {};
  str.split(' ').filter(Boolean).forEach(k => { t[k.replace(/-$/, '')] = /-$/.test(k) ? 0.5 : 1; });
  return t;
};
const MUSCU_GROUPS = MUSCU_CATALOG.map(([g, list]) => [g, list.map(e => e[0])]);
const MUSCU_GROUP_OF = {}, MUSCU_TARGETS = {};
MUSCU_CATALOG.forEach(([g, list]) => list.forEach(([n, m]) => { MUSCU_GROUP_OF[n] = g; MUSCU_TARGETS[n] = parseTargets(m); }));
// Muscles travaillés par un exercice de séance ({ muscle: 1 ou 0,5 }), {} si inconnu
function muscuTargets(ex) {
  if (MUSCU_TARGETS[ex.name]) return MUSCU_TARGETS[ex.name];
  return ex.group && MUSCU_GROUP_TARGETS[ex.group] ? parseTargets(MUSCU_GROUP_TARGETS[ex.group]) : {};
}
// Exercices libres déjà utilisés (pas dans le catalogue), avec leur groupe, du plus récent au plus ancien
function muscuCustomExercises(data = getData()) {
  const seen = new Map();
  (data.sessions || []).filter(s => s.sport === 'muscu').sort((a, b) => b.date.localeCompare(a.date))
    .forEach(s => (s.exercises || []).forEach(e => { if (!MUSCU_GROUP_OF[e.name] && !seen.has(e.name)) seen.set(e.name, e.group || null); }));
  return [...seen].map(([name, group]) => ({ name, group }));
}
function hasMuscu(data = getData()) { return (data.sessions || []).some(s => s.sport === 'muscu'); }
// Sports à afficher : les 3 sports, plus la musculation si l'utilisateur en fait
function sportsShown(data = getData()) { return hasMuscu(data) ? ['nat', 'velo', 'run', 'muscu'] : ['nat', 'velo', 'run']; }
function lastMuscuSession(beforeId) {
  return getSessions({ sport: 'muscu' }).find(s => s.id !== beforeId && (s.exercises || []).length) || null;
}
// Séries d'un exercice : [{ reps, kg, max }]. Deux façons de l'enregistrer :
// - toutes les séries pareilles : { sets, reps, kg } (forme courte) ;
// - séries différentes (charges qui changent, série « Max ») : { series: [{ reps, kg, max }] }.
// Tous les calculs passent par exSeries pour lire les deux formes.
function exSeries(e) {
  if (Array.isArray(e.series) && e.series.length) return e.series;
  const n = Math.max(1, Math.round(e.sets || 1));
  return Array.from({ length: n }, () => ({ reps: e.reps || null, kg: e.kg || null }));
}
// Charge la plus lourde de l'exercice (sa meilleure série)
function exMaxKg(e) { return Math.max(0, ...exSeries(e).map(x => x.kg || 0)) || null; }
// Texte court : « 4 × 8 × 60 kg » ou « 8 × 60 · 6 × 70 · 1 × 90 kg (max) »
function muscuSetsText(e) {
  const hold = isHoldExercise(e.name);
  const r = v => v ? v + (hold ? ' s' : '') : '';
  const kgTxt = v => v ? v.toLocaleString('fr-FR') + ' kg' : '';
  if (!(Array.isArray(e.series) && e.series.length)) {
    return [e.sets, r(e.reps)].filter(Boolean).join(' × ') + (e.kg ? (e.sets || e.reps ? ' × ' : '') + kgTxt(e.kg) : '');
  }
  return e.series.map(x => [r(x.reps), kgTxt(x.kg)].filter(Boolean).join(' × ') + (x.max ? ' (max)' : '')).join(' · ');
}
// Tonnage d'une séance (séries × répétitions × kg), exercices sans charge exclus
function muscuVolume(s) {
  return Math.round((s.exercises || []).reduce((a, e) => a + exSeries(e).reduce((b, x) => b + (x.reps || 0) * (x.kg || 0), 0), 0));
}

// Exercices tenus (gainage…) : « reps » contient des secondes
const MUSCU_HOLD = /^(Gainage|Hollow body)/;
function isHoldExercise(name) { return MUSCU_HOLD.test(name || ''); }
// Charge maximale estimée sur 1 répétition (formule d'Epley), seulement jusqu'à 12 répétitions
function oneRepMax(kg, reps) {
  if (!(kg > 0) || !(reps > 0) || reps > 12) return null;
  return reps === 1 ? kg : Math.round(kg * (1 + reps / 30) * 2) / 2;
}
// Une ligne par séance où l'exercice a été fait (du plus ancien au plus récent) :
// charge max (et répétitions à cette charge), 1RM estimé, répétitions max, tonnage
function muscuExerciseHistory(name, { from, to } = {}) {
  return getSessions({ sport: 'muscu', from, to }).slice().reverse().map(s => {
    const rows = (s.exercises || []).filter(e => e.name === name);
    if (!rows.length) return null;
    const h = { date: s.date, id: s.id, kg: null, reps: null, orm: null, maxReps: null, volume: 0, sets: 0 };
    // Charge de la séance = la série la plus lourde ; une série « Max » est retenue (max: true)
    rows.forEach(e => exSeries(e).forEach(x => {
      if (x.kg && (h.kg == null || x.kg > h.kg || (x.kg === h.kg && (x.reps || 0) > (h.reps || 0)))) { h.kg = x.kg; h.reps = x.reps || null; h.max = !!x.max; }
      const o = oneRepMax(x.kg, x.reps);
      if (o && (h.orm == null || o > h.orm)) h.orm = o;
      if (x.reps && (h.maxReps == null || x.reps > h.maxReps)) h.maxReps = x.reps;
      h.volume += (x.reps || 0) * (x.kg || 0);
      h.sets += 1;
    }));
    h.volume = Math.round(h.volume);
    return h;
  }).filter(Boolean);
}
// Records par exercice, calculés à partir des séances (rien n'est enregistré).
// Triés du plus pratiqué au moins pratiqué.
function muscuRecords({ from, to } = {}) {
  const names = new Map();
  getSessions({ sport: 'muscu', from, to }).forEach(s => (s.exercises || []).forEach(e => {
    if (!names.has(e.name)) names.set(e.name, e.group || MUSCU_GROUP_OF[e.name] || null);
  }));
  return [...names].map(([name, group]) => {
    const hist = muscuExerciseHistory(name, { from, to });
    const best = (key) => hist.reduce((b, h) => (h[key] != null && (!b || h[key] > b[key]) ? h : b), null);
    const kg = best('kg'), orm = best('orm'), reps = best('maxReps'), vol = best('volume');
    return {
      name, group, hold: isHoldExercise(name), sessions: hist.length, last: hist.length ? hist[hist.length - 1].date : null,
      maxKg: kg ? { kg: kg.kg, reps: kg.reps, date: kg.date } : null,
      orm: orm ? { value: orm.orm, date: orm.date } : null,
      maxReps: reps ? { reps: reps.maxReps, date: reps.date } : null,
      volume: vol && vol.volume ? { value: vol.volume, date: vol.date } : null,
    };
  }).sort((a, b) => b.sessions - a.sessions || (b.last || '').localeCompare(a.last || ''));
}
// Travail par muscle sur une période, pour la carte du corps.
// mode 'sets' : séries (muscle secondaire = moitié) ; 'reps' : séries × répétitions
// (exercice tenu : 1 répétition pour 3 s) ; 'kg' : tonnage, exercices avec charge seulement.
const MUSCU_LOAD_MODES = { sets: 'séries', reps: 'répétitions', kg: 'kg soulevés' };
function muscuMuscleLoad({ from, to, mode = 'sets' } = {}) {
  const totals = {}, byExercise = {};
  getSessions({ sport: 'muscu', from, to }).forEach(s => (s.exercises || []).forEach(e => {
    const hold = isHoldExercise(e.name);
    const base = exSeries(e).reduce((a, x) => {
      const reps = hold ? Math.round((x.reps || 0) / 3) : (x.reps || 0);
      return a + (mode === 'sets' ? 1 : mode === 'reps' ? reps : reps * (x.kg || 0));
    }, 0);
    if (!base) return;
    const t = muscuTargets(e);
    Object.keys(t).forEach(m => {
      const v = base * t[m];
      totals[m] = (totals[m] || 0) + v;
      (byExercise[m] = byExercise[m] || {})[e.name] = (byExercise[m][e.name] || 0) + v;
    });
  }));
  Object.keys(totals).forEach(m => { totals[m] = Math.round(totals[m] * 10) / 10; });
  return { totals, byExercise };
}

// Carte du corps (face et dos) : un tracé par muscle, côté gauche dessiné puis
// recopié en miroir. Plus le muscle a travaillé, plus le violet est soutenu
// (5 niveaux, par rapport au muscle le plus travaillé de la période).
const BODY_FRONT = [
  ['trapezes', 'M45 27 L35 33.5 L45 32.5 Z'],
  ['epaules', 'M35.5 33 C27 32.5 22.5 39 23 49 L29.5 48.5 C30.5 42 32.5 38 37 36 Z'],
  ['pecs', 'M49.4 35.5 L37.5 35.8 C32.8 39.5 31.6 47 33.4 52.6 C38.2 56.8 45 57 49.4 54 Z'],
  ['biceps', 'M23 50.5 C21 57.5 21 65 22.6 71.5 L28.6 71.5 C29.8 65.5 30.6 58 29.8 49.8 Z'],
  ['avantbras', 'M22.4 73.5 C19.8 81.5 19.2 91 19.8 99.5 L24.8 99.5 C26.8 91.5 28.6 82 28.8 73.5 Z'],
  ['obliques', 'M39.6 57.5 C35.6 61.5 34.4 71.5 35.2 81.5 C36.6 87.5 39.2 91.5 42 94 C40.2 82 39.4 70 40.6 57.5 Z'],
  ['abdos', 'M49.4 57 L41.6 57.6 C40.6 69.5 41.2 81.5 43.4 93.5 L49.4 96 Z'],
  ['quadriceps', 'M36.2 96 C33.4 110 33.4 126 36 140 L46.2 140 C47.8 126 48.4 112 48.6 101 L42.4 95.6 Z'],
  ['adducteurs', 'M49.4 99 C46.4 106 46 116 47.2 126 L49.4 122 Z'],
  ['mollets', 'M36.4 150 C34.2 162 34.8 176 37 187 L44 187 C46 176 46.4 162 45.4 150 Z'],
];
const BODY_BACK = [
  ['trapezes', 'M50 25.5 L37.5 33.6 L44.5 36.4 L50 53 Z'],
  ['epaules', 'M35.5 33 C27 32.5 22.5 39 23 49 L29.5 48.5 C30.5 42 32.5 38 37 36 Z'],
  ['dorsaux', 'M49.4 54.5 L44 37.6 L36.4 37.4 C33 46 33.8 56 37.6 65.5 C41.6 71.5 45.6 75 49.4 77.5 Z'],
  ['lombaires', 'M49.4 78.5 L43.2 75.4 L42.2 91.5 L49.4 91.5 Z'],
  ['triceps', 'M23 50.5 C21 57.5 21 65 22.6 71.5 L28.6 71.5 C29.8 65.5 30.6 58 29.8 49.8 Z'],
  ['avantbras', 'M22.4 73.5 C19.8 81.5 19.2 91 19.8 99.5 L24.8 99.5 C26.8 91.5 28.6 82 28.8 73.5 Z'],
  ['fessiers', 'M49.4 92.6 L38 92.6 C33.2 98.5 33.2 108 37 113 C42 116.4 46.8 114.6 49.4 111 Z'],
  ['ischios', 'M37 115.6 C35 125 35 134 37 142 L46.2 142 C48 132.5 48.4 122.5 48.4 115.6 Z'],
  ['mollets', 'M36.2 148 C33 158 33.8 170 36.8 181 L44.2 181 C46.4 170 46.6 158 45.4 148 Z'],
];
// Parties sans muscle suivi (tête, cou, mains, genoux, pieds, bassin)
const BODY_NEUTRAL = 'M50 3 C55.5 3 59 7.5 59 13.5 C59 20 55.5 25 50 25 C44.5 25 41 20 41 13.5 C41 7.5 44.5 3 50 3 Z '
  + 'M45.5 24 L54.5 24 L55 30 L45 30 Z '
  + 'M19.6 101 C17.4 104 17.6 109 20.6 111 C23.6 110 25.4 106 24.8 101 Z M80.4 101 C82.6 104 82.4 109 79.4 111 C76.4 110 74.6 106 75.2 101 Z '
  + 'M36.4 142 L46 142 L45.6 148.5 L36.6 148.5 Z M63.6 142 L54 142 L54.4 148.5 L63.4 148.5 Z '
  + 'M37 188 L44.4 188 L46 193.5 L35.4 193.5 Z M63 188 L55.6 188 L54 193.5 L64.6 193.5 Z';
function bodyMapLevel(v, max) { return !v || !max ? 0 : Math.max(1, Math.min(5, Math.ceil(v / max * 5))); }
function muscuBodyMapSvg(totals = {}, selected = null) {
  const max = Math.max(0, ...Object.values(totals));
  const op = [0, 0.22, 0.4, 0.58, 0.78, 1];
  const fig = (shapes, label, extra) => {
    const paths = shapes.map(([m, d]) => {
      const lvl = bodyMapLevel(totals[m], max);
      const attrs = `data-m="${m}" class="bm-muscle${selected === m ? ' bm-muscle--on' : ''}" style="fill-opacity:${op[lvl]}"`;
      return `<path d="${d}" class="bm-base"/><path d="${d}" class="bm-base" transform="matrix(-1 0 0 1 100 0)"/>`
        + `<path d="${d}" ${attrs}><title>${MUSCLES[m]}</title></path><path d="${d}" ${attrs} transform="matrix(-1 0 0 1 100 0)"><title>${MUSCLES[m]}</title></path>`;
    }).join('');
    return `<figure class="bm-fig"><svg viewBox="14 0 72 196" role="img" aria-label="${label}"><path d="${BODY_NEUTRAL}" class="bm-neutral"/>${paths}${extra || ''}</svg><figcaption>${label}</figcaption></figure>`;
  };
  // Lignes des abdominaux (décor, pas cliquable)
  const abs = '<path class="bm-line" d="M42 67 L58 67 M42.4 77.5 L57.6 77.5 M43 87 L57 87"/>';
  return `<div class="bm-figs">${fig(BODY_FRONT, 'Face', abs)}${fig(BODY_BACK, 'Dos')}</div>`;
}

// Carte du corps complète dans un conteneur : figures, légende, muscle choisi
// (exercices qui l'ont travaillé) et classement des muscles. Utilisée par Forme
// et Sports → Musculation. opts = { from, to, mode }.
function renderBodyMap(el, opts = {}) {
  if (!el) return;
  const mode = opts.mode || 'sets';
  const load = muscuMuscleLoad({ from: opts.from, to: opts.to, mode });
  const unit = MUSCU_LOAD_MODES[mode];
  const fmt = v => (Math.round(v * 10) / 10).toLocaleString('fr-FR');
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ranked = Object.keys(load.totals).sort((a, b) => load.totals[b] - load.totals[a]);
  if (!el._bmSel || !load.totals[el._bmSel]) el._bmSel = ranked[0] || null;
  const max = ranked.length ? load.totals[ranked[0]] : 0;
  const sel = el._bmSel;
  const detail = sel ? (() => {
    const ex = Object.entries(load.byExercise[sel] || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return `<div class="bm-detail"><b>${MUSCLES[sel]}</b> : ${fmt(load.totals[sel])} ${unit}`
      + `<div class="bm-detail__ex">${ex.map(([n, v]) => esc(n) + ' <span>' + fmt(v) + '</span>').join(' · ')}</div></div>`;
  })() : '';
  const rest = Object.keys(MUSCLES).filter(m => !load.totals[m]);
  const list = ranked.map(m => `<button type="button" class="bm-row${m === sel ? ' bm-row--on' : ''}" data-m="${m}">
      <span class="bm-row__name">${MUSCLES[m]}</span><span class="bm-row__bar"><i style="width:${Math.max(4, load.totals[m] / max * 100)}%;opacity:${[0, .4, .55, .7, .85, 1][bodyMapLevel(load.totals[m], max)]}"></i></span>
      <span class="bm-row__val">${fmt(load.totals[m])}</span></button>`).join('');
  el.innerHTML = ranked.length
    ? `<div class="bm-layout"><div>${muscuBodyMapSvg(load.totals, sel)}
        <div class="bm-legend">moins <i style="opacity:.22"></i><i style="opacity:.4"></i><i style="opacity:.58"></i><i style="opacity:.78"></i><i></i> plus</div></div>
        <div>${detail}<div class="bm-list">${list}</div>
        ${rest.length ? `<div class="bm-rest">Pas travaillés sur la période : ${rest.map(m => MUSCLES[m].toLowerCase()).join(', ')}</div>` : ''}
        ${mode === 'kg' ? '<div class="bm-rest">Kg soulevés : séries × répétitions × charge, exercices avec charge seulement.</div>' : ''}</div></div>`
    : `<div class="bm-empty">${muscuBodyMapSvg({})}<p>Aucun exercice de musculation noté sur cette période${mode === 'kg' ? ' avec une charge' : ''}.</p></div>`;
  el.onclick = e => {
    const t = e.target.closest('[data-m]');
    if (!t) return;
    el._bmSel = t.dataset.m;
    renderBodyMap(el, opts);
  };
}

// ── Goals ─────────────────────────────────────────────────────────────────────
function getGoals(sport) {
  const data = getData();
  return (data.goals || {})[sport] || [];
}

function saveGoal(sport, goal) {
  const data = getData();
  if (!data.goals) data.goals = {};
  if (!data.goals[sport]) data.goals[sport] = [];
  const idx = data.goals[sport].findIndex(g => g.id === goal.id);
  if (idx >= 0) data.goals[sport][idx] = goal;
  else data.goals[sport].push(goal);
  saveData(data);
}

function deleteGoal(sport, id) {
  const data = getData();
  if (!data.goals?.[sport]) return;
  data.goals[sport] = data.goals[sport].filter(g => g.id !== id);
  saveData(data);
}

// ── Équipement (chaussures, vélo, combinaison) ──────────────────────────────
// data.gear = [{ id, sport, name, start 'YYYY-MM-DD', retired 'YYYY-MM-DD'|absent,
//   alert_km (seuil choisi par l'utilisateur)|absent, notes }]
// Une séance compte pour l'équipement de son sport en service ce jour-là : du jour
// de première utilisation jusqu'à la veille du suivant du même sport (ou au jour
// où il est retiré). Rien n'est stocké sur les séances : tout est recalculé.
const GEAR_KINDS = { run: 'Chaussures', velo: 'Vélo', nat: 'Combinaison' };
const GEAR_DEFAULT_ALERT = { run: 700, velo: 3000, nat: null };
// Repères généraux (fabricants, magasins spécialisés), à adapter : pas une règle.
const GEAR_HINTS = {
  run: 'Repère : une paire de chaussures de course tient en général 500 à 800 km, plutôt 300 à 500 km pour les modèles légers à plaque carbone. Change-les plus tôt si l’amorti paraît tassé ou la semelle usée.',
  velo: 'Repère d’entretien : une chaîne s’use en 3 000 à 5 000 km environ, les pneus route en 3 000 à 6 000 km selon le modèle. Mets le seuil qui te sert de rappel (révision, chaîne, pneus).',
  nat: 'Repère : une combinaison néoprène dure en général 3 à 5 saisons selon l’entretien (rinçage à l’eau douce, séchage à l’ombre).',
};
function getGear(data = getData()) {
  return (data.gear || []).slice().sort((a, b) => b.start.localeCompare(a.start));
}
function saveGear(g) {
  const data = getData();
  data.gear = data.gear || [];
  if (!g.id) g.id = newId();
  Object.keys(g).forEach(k => { if (g[k] == null || g[k] === '') delete g[k]; });
  const i = data.gear.findIndex(x => x.id === g.id);
  if (i >= 0) data.gear[i] = g; else data.gear.push(g);
  saveData(data);
  return g;
}
function deleteGear(id) {
  const data = getData();
  data.gear = (data.gear || []).filter(g => g.id !== id);
  saveData(data);
}
// Période couverte par chaque équipement : { id: { from, to } } (to inclus).
function gearRanges(data = getData()) {
  const out = {};
  ['run', 'velo', 'nat'].forEach(sp => {
    const list = (data.gear || []).filter(g => g.sport === sp).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    list.forEach((g, i) => {
      let to = list[i + 1] ? addDaysStr(list[i + 1].start, -1) : '9999-12-31';
      if (g.retired && g.retired < to) to = g.retired;
      out[g.id] = { from: g.start, to };
    });
  });
  return out;
}
function gearForSession(s, data = getData(), ranges = gearRanges(data)) {
  return (data.gear || []).find(g => g.sport === s.sport && ranges[g.id] && s.date >= ranges[g.id].from && s.date <= ranges[g.id].to) || null;
}
// Chiffres de chaque équipement, seuil et prévision au rythme des 8 dernières semaines.
function gearStats(data = getData(), today = localDateStr()) {
  const ranges = gearRanges(data);
  const out = {};
  (data.gear || []).forEach(g => {
    const r = ranges[g.id];
    const list = (data.sessions || []).filter(s => s.sport === g.sport && s.date >= r.from && s.date <= r.to && s.date <= today);
    const km = Math.round(list.reduce((a, s) => a + (s.distance || 0), 0) * 10) / 10;
    const st = {
      km, sessions: list.length,
      hours: list.reduce((a, s) => a + (s.duration || 0), 0),
      elevation: Math.round(list.reduce((a, s) => a + (s.elevation || 0), 0)),
      first: list.length ? list.reduce((m, s) => s.date < m ? s.date : m, list[0].date) : null,
      last: list.length ? list.reduce((m, s) => s.date > m ? s.date : m, list[0].date) : null,
      from: r.from, to: r.to === '9999-12-31' ? null : r.to,
      active: r.from <= today && r.to >= today,
      replaced: r.to !== '9999-12-31' && !(g.retired && g.retired === r.to),
      alert: g.alert_km || null, pct: null, state: 'ok', perWeek: null, etaWeeks: null, etaDate: null,
    };
    if (st.alert) {
      st.pct = Math.round(km / st.alert * 100);
      st.state = km >= st.alert ? 'over' : km >= st.alert * 0.9 ? 'near' : 'ok';
    }
    if (st.active) {
      const since = addDaysStr(today, -55) > r.from ? addDaysStr(today, -55) : r.from;
      const days = Math.max(1, Math.round((parseLocalDate(today) - parseLocalDate(since)) / 86400000) + 1);
      const recentKm = list.filter(s => s.date >= since).reduce((a, s) => a + (s.distance || 0), 0);
      if (days >= 7 && recentKm > 0) st.perWeek = Math.round(recentKm / days * 7 * 10) / 10;
      if (st.alert && st.perWeek && km < st.alert) {
        st.etaWeeks = Math.round((st.alert - km) / st.perWeek * 10) / 10;
        st.etaDate = addDaysStr(today, Math.round(st.etaWeeks * 7));
      }
    }
    out[g.id] = st;
  });
  return out;
}

// ── Tirer vers le bas pour actualiser (appli installée sur le téléphone) ────
// Dans un navigateur, le geste existe déjà ; dans l'appli installée sur l'écran
// d'accueil, non. En haut de la page, tirer vers le bas puis relâcher : nouvelles
// séances Strava (si connecté), puis la page est rechargée (données du compte relues).
const PTR_MSG_KEY = 'triseason_ptr_msg';
function isStandaloneApp() {
  return navigator.standalone === true || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
}
function initPullToRefresh() {
  if (window.__ptrInit || !('ontouchstart' in window) || !isStandaloneApp()) return;
  window.__ptrInit = true;
  const READY = 70, MAX = 110;
  let y0 = null, x0 = 0, pull = 0, busy = false, el = null;
  const box = () => {
    if (!el) {
      el = document.createElement('div');
      el.className = 'ptr';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span class="ptr__icon" aria-hidden="true"></span><span class="ptr__txt"></span>';
      document.body.appendChild(el);
    }
    return el;
  };
  const show = (y, txt, spin) => {
    const b = box();
    b.style.setProperty('--ptr-y', y + 'px');
    b.style.setProperty('--ptr-rot', Math.round(y * 4) + 'deg');
    b.querySelector('.ptr__txt').textContent = txt;
    b.classList.toggle('ptr--spin', !!spin);
    b.classList.add('ptr--on');
  };
  const hide = () => { if (el) el.classList.remove('ptr--on', 'ptr--spin'); pull = 0; };
  const blocked = () => window.scrollY > 0 || document.querySelector('.modal-overlay.open, #consentGate');
  document.addEventListener('touchstart', e => {
    y0 = null;
    if (busy || e.touches.length !== 1 || blocked()) return;
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; pull = 0;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (y0 === null) return;
    const dy = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
    if (dy <= 0 || dx > dy || window.scrollY > 0) { hide(); if (dy < 0 || dx > dy) y0 = null; return; }
    if (e.cancelable) e.preventDefault(); // pas de rebond de la page pendant le geste
    pull = Math.min(MAX, dy * 0.5);
    show(pull, pull >= READY ? 'Relâche pour actualiser' : 'Tire pour actualiser');
  }, { passive: false });
  const end = () => {
    if (y0 === null) return;
    y0 = null;
    if (pull >= READY) refreshNow(); else hide();
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', () => { y0 = null; hide(); }, { passive: true });
  async function refreshNow() {
    busy = true;
    show(READY, 'Actualisation…', true);
    let msg = '';
    if (stravaAvailable() && getStrava()) {
      try {
        const r = await Promise.race([stravaSync({ force: true }), new Promise(res => setTimeout(() => res('timeout'), 10000))]);
        msg = r === 'timeout' ? '' : stravaSyncMessage(r, true);
      } catch (err) { msg = err.message; }
    }
    try { sessionStorage.setItem(PTR_MSG_KEY, msg || 'Page actualisée.'); } catch {}
    location.reload();
  }
}
document.addEventListener('DOMContentLoaded', () => {
  initPullToRefresh();
  let msg = null;
  try { msg = sessionStorage.getItem(PTR_MSG_KEY); sessionStorage.removeItem(PTR_MSG_KEY); } catch {}
  if (msg) toast(msg);
});

// Run migration on load
migrateWeeksToSessions();

window.TS = {
  hydroGoal, setHydroGoal, HYDRO_GOAL_DEFAULT, formatLiters,
  getData, saveData, loadData, newId, resetAllData, deleteAccount, clearLocalUserData,
  getWeek, saveWeek, getCurrentWeek, getLast12Weeks, getLast52Weeks,
  getWeekMonday, formatDate, formatDateInput, getISOWeek, localDateStr, parseLocalDate,
  getSessions, saveSession, saveSessions, deleteSession, compactSession,
  getCompetitions, saveCompetition, deleteCompetition,
  syncCompetition, refreshCompetitionRecords, linkSessionsToCompetition,
  checkCompetitionLegs, describeCompSync, describeCompRecords, compClosestFormat, COMP_FORMATS,
  getSeasonsAvailable, getSeasonFilter, setSeasonFilter, getSeasonRange,
  getWeight, saveWeight, deleteWeight, getLatestWeight,
  getProfile, saveProfile,
  calcPace, calcTSS, calcWkg, wkgLevel, tssLevel,
  getSeasonStats, getNutritionImpact, NUTRI_FACTORS, NUTRI_OUTCOMES, NUTRI_MIN_GROUP,
  exportData, importData, migrateWeeksToSessions,
  getGoals, saveGoal, deleteGoal,
  getGear, saveGear, deleteGear, gearRanges, gearForSession, gearStats, GEAR_KINDS, GEAR_DEFAULT_ALERT, GEAR_HINTS,
  toast, initTooltips,
  healthEnabled, enableHealth, disableHealth, getHealthPeriods, saveHealthPeriod, deleteHealthPeriod,
  healthPhase, healthPeriodsOn, healthWeekPhase, HEALTH_TYPES, HEALTH_STATUS, HEALTH_ZONES, HEALTH_CONSENT_VERSION,
  formatHours, FUEL_PRESETS, fuelCarbs, getPlans, savePlan, deletePlan, parseDuration, planStatuses, planRatio, takeDonePlans, weeklyChallenges, challengeHistory, getAchievements, takeNewAchievements, badgeTileHtml,
  stravaAvailable, getStrava, stravaConnect, stravaHandleRedirect, stravaSync, stravaSyncMessage,
  stravaDisconnect, stravaToSession, SERVER_URL: TS_SERVER_URL,
  planStravaArchive, applyStravaArchive, stravaFetchHistory, dataBytes, DATA_MAX_BYTES, dataMaxBytes,
  splitData, assembleData, drawerHash, cloudLayoutNow: () => cloudLayout,
  MUSCU_GROUPS, MUSCU_GROUP_OF, MUSCU_CATALOG, MUSCLES, muscuTargets, muscuCustomExercises, hasMuscu, sportsShown, lastMuscuSession, muscuVolume, exSeries, exMaxKg, muscuSetsText,
  isHoldExercise, oneRepMax, muscuExerciseHistory, muscuRecords, muscuMuscleLoad, MUSCU_LOAD_MODES, muscuBodyMapSvg, bodyMapLevel, renderBodyMap,
  SPORTS, COMP_TYPES,
};
