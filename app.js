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
  saveData(data);
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
  setTimeout(() => { t.classList.remove('toast--show'); setTimeout(() => t.remove(), 300); }, 2800);
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
