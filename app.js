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
    const dateStr = monday.toISOString().split('T')[0];

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

function getUserDocRef(uid) {
  if (!window.firebase || !firebase.firestore) return null;
  return firebase.firestore().collection('users').doc(uid);
}

function pushToCloud(data) {
  const user = window.TS_USER;
  if (!user) return; // pas connecté (ou pas encore su) : rien à envoyer
  const ref = getUserDocRef(user.uid);
  if (!ref) return;
  ref.set({ data: data, updatedAt: Date.now() })
    .catch(err => {
      console.warn('[TriSeason] Échec de la synchronisation cloud :', err.message);
    });
}

function syncFromCloud(uid) {
  if (cloudSyncing) return;
  cloudSyncing = true;
  const ref = getUserDocRef(uid);
  if (!ref) { cloudSyncing = false; return; }

  ref.get().then(doc => {
    if (doc.exists && doc.data() && doc.data().data) {
      // Un compte cloud existe déjà : ses données font foi sur cet appareil.
      const cloudData = doc.data().data;
      localStorage.setItem(DB_KEY, JSON.stringify(cloudData));
      window.dispatchEvent(new CustomEvent('triseason:update', { detail: cloudData }));
    } else {
      // Premier login : on envoie ce qu'il y avait déjà en local (saison déjà
      // saisie avant la mise en place des comptes) pour l'attacher au compte.
      const localData = getData();
      pushToCloud(localData);
    }
  }).catch(err => {
    console.warn('[TriSeason] Impossible de récupérer les données cloud :', err.message);
  }).finally(() => {
    cloudSyncing = false;
  });
}

// Déclenché par auth-guard.js une fois la connexion confirmée. On gère aussi
// le cas où cet événement serait déjà passé avant que ce script ne s'exécute.
document.addEventListener('triseason:auth-ready', e => {
  if (e.detail) syncFromCloud(e.detail.uid);
});
if (window.TS_USER) syncFromCloud(window.TS_USER.uid);

function saveData(data) {
  localStorage.setItem(DB_KEY, JSON.stringify(data));
  window.dispatchEvent(new CustomEvent('triseason:update', { detail: data }));
  pushToCloud(data);
}

function getData() { return loadData(); }

// ── Week helpers ─────────────────────────────────────────────────────────────
function getISOWeek(date) {
  const d = new Date(date);
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
  const d = new Date(date);
  return d.toISOString().split('T')[0];
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
  const from = monday.toISOString().split('T')[0];
  const to   = sunday.toISOString().split('T')[0];
  const sessions = (data.sessions || []).filter(s => s.date >= from && s.date <= to);

  const result = {
    nat:  { dur: 0, dist: 0, rpe: 0, sessions: 0, rpeSum: 0, elevation: 0 },
    velo: { dur: 0, dist: 0, rpe: 0, sessions: 0, rpeSum: 0, elevation: 0 },
    run:  { dur: 0, dist: 0, rpe: 0, sessions: 0, rpeSum: 0, elevation: 0 },
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
  for (const sp of ['nat','velo','run']) {
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

function saveSession(session) {
  const data = getData();
  if (!session.id) session.id = Date.now().toString();
  const idx = data.sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) data.sessions[idx] = session;
  else data.sessions.push(session);
  saveData(data);
  return session;
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
  if (!comp.id) comp.id = Date.now().toString();
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
  if (sport === 'run') {
    const minPerKm = durH * 60 / distKm;
    const m = Math.floor(minPerKm);
    const s = Math.round((minPerKm - m) * 60);
    return `${m}'${String(s).padStart(2, '0')}"`;
  }
  if (sport === 'nat') {
    const minPer100 = durH * 60 / (distKm * 10);
    const m = Math.floor(minPer100);
    const s = Math.round((minPer100 - m) * 60);
    return `${m}'${String(s).padStart(2, '0')}"`;
  }
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
  if (wkg < 2)   return { label: 'Débutant',          color: '#94a3b8' };
  if (wkg < 2.5) return { label: 'Amateur débutant',   color: '#4ade80' };
  if (wkg < 3)   return { label: 'Amateur régulier',   color: '#22c55e' };
  if (wkg < 3.5) return { label: 'Bon niveau',         color: '#eab308' };
  if (wkg < 4)   return { label: 'Très bon amateur',   color: '#f97316' };
  if (wkg < 5)   return { label: 'Élite amateur',      color: '#ef4444' };
  return              { label: 'Professionnel',        color: '#a855f7' };
}

function tssLevel(tss) {
  if (tss < 50)  return { label: '🟢 Récupération', color: '#22c55e' };
  if (tss < 150) return { label: '🟡 Normal',        color: '#eab308' };
  if (tss < 300) return { label: '🟠 Élevé',         color: '#f97316' };
  return              { label: '🔴 Très élevé',    color: '#ef4444' };
}

// ── Season stats ──────────────────────────────────────────────────────────────
function getSeasonStats() {
  const data = getData();
  const sessions = data.sessions || [];
  const stats = {
    nat:  { km: 0, h: 0, sessions: 0 },
    velo: { km: 0, h: 0, sessions: 0 },
    run:  { km: 0, h: 0, sessions: 0 },
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

// ── Export / Import ───────────────────────────────────────────────────────────
function exportData() {
  const data = getData();
  data._exported = new Date().toISOString();
  data._version = '1.0';
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `triseason-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
}

function importData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        saveData({ ...structuredClone(DEFAULT_DATA), ...data });
        resolve(data);
      } catch { reject(new Error('Fichier invalide')); }
    };
    reader.readAsText(file);
  });
}

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
  nat:  { label: 'Natation',  emoji: '🏊', color: '#0D7377', unit: 'km', paceLabel: 'Allure', paceUnit: '/100m' },
  velo: { label: 'Vélo',      emoji: '🚴', color: '#F4A261', unit: 'km', paceLabel: 'Vitesse', paceUnit: 'km/h' },
  run:  { label: 'Course',    emoji: '🏃', color: '#E76F51', unit: 'km', paceLabel: 'Allure', paceUnit: '/km' },
};

const COMP_TYPES = ['TRI', 'RUN', 'VELO', 'NAT', 'DUATH', 'AQUA'];


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

// Run migration on load
migrateWeeksToSessions();

window.TS = {
  getData, saveData, loadData,
  getWeek, saveWeek, getCurrentWeek, getLast12Weeks, getLast52Weeks,
  getWeekMonday, formatDate, formatDateInput, getISOWeek,
  getSessions, saveSession, deleteSession,
  getCompetitions, saveCompetition, deleteCompetition,
  syncCompetition, refreshCompetitionRecords, linkSessionsToCompetition,
  checkCompetitionLegs, describeCompSync, describeCompRecords, compClosestFormat, COMP_FORMATS,
  getSeasonsAvailable, getSeasonFilter, setSeasonFilter, getSeasonRange,
  getWeight, saveWeight, deleteWeight, getLatestWeight,
  getProfile, saveProfile,
  calcPace, calcTSS, calcWkg, wkgLevel, tssLevel,
  getSeasonStats,
  exportData, importData, migrateWeeksToSessions,
  getGoals, saveGoal, deleteGoal,
  toast, initTooltips,
  SPORTS, COMP_TYPES,
};
