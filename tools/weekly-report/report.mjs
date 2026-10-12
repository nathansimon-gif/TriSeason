// Rapport hebdomadaire d'activité TriSeason — lecture seule sur Firebase.
//
// Identifiants : une clé de compte de service Google (JSON), fournie par
//   - FIREBASE_SA_KEY : le contenu JSON de la clé, ou
//   - GOOGLE_APPLICATION_CREDENTIALS : le chemin vers le fichier de la clé.
// Rôles nécessaires (lecture seule) : Firebase Authentication Viewer,
// Cloud Datastore Viewer, Monitoring Viewer.
//
// Usage : node report.mjs [--week AAAA-MM-JJ]   (lundi de la semaine voulue ;
// par défaut la dernière semaine complète, du lundi au dimanche, heure de Paris)
// Écrit le rapport en Markdown sur la sortie standard et le détail dans
// report-<lundi>.json.

import { readFileSync, writeFileSync } from 'node:fs';

export const TZ = 'Europe/Paris';
export const DOC_LIMIT_BYTES = 1024 * 1024; // limite d'un document Firestore

// ── Dates (jour local à Paris) ───────────────────────────────────────────────
export function parisDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10); // calcul sur des dates UTC pures : pas de décalage
}

// Lundi de la dernière semaine complète (si on est lundi, c'est le lundi d'avant).
export function lastFullWeekMonday(now = new Date()) {
  const today = parisDay(now);
  const [y, m, d] = today.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = lundi
  return addDays(today, -dow - 7);
}

// Instant UTC correspondant à 00:00 heure de Paris pour un jour donné.
export function parisMidnight(day) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).formatToParts(guess);
  const hourInParis = Number(parts.find(p => p.type === 'hour').value);
  return new Date(guess.getTime() - hourInParis * 3600 * 1000);
}

// ── Calcul du rapport (pur, testable sans Firebase) ──────────────────────────
// users   : [{ uid, creationTime, lastSignInTime, providers: [] }]   (Firebase Auth)
// docs    : [{ uid, activeDays: [], data: {...}, sizeBytes }]         (Firestore users/{uid})
// metrics : { reads: {day: n}, writes: {day: n}, deletes: {day: n} } ou null
export function computeReport({ weekStart, users, docs, metrics, prevMetrics }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = days[6];
  const prevStart = addDays(weekStart, -7);
  const inWeek = d => d && d >= weekStart && d <= weekEnd;
  const inPrevWeek = d => d && d >= prevStart && d < weekStart;

  const dau = {};
  days.forEach(d => { dau[d] = 0; });
  let wau = 0, prevWau = 0;
  docs.forEach(doc => {
    const active = new Set(doc.activeDays || []);
    days.forEach(d => { if (active.has(d)) dau[d] += 1; });
    if ([...active].some(inWeek)) wau += 1;
    if ([...active].some(inPrevWeek)) prevWau += 1;
  });

  const authDay = t => (t ? parisDay(new Date(t)) : null);
  const newUsers = users.filter(u => inWeek(authDay(u.creationTime))).length;
  const prevNewUsers = users.filter(u => inPrevWeek(authDay(u.creationTime))).length;

  let sessionsWeek = 0, sessionsTotal = 0, mealsWeek = 0, compsWeek = 0;
  const bySport = { nat: 0, velo: 0, run: 0 };
  let usersLoggingSessions = 0, usersLoggingMeals = 0;
  let biggest = { uid: null, sizeBytes: 0 };
  docs.forEach(doc => {
    const data = doc.data || {};
    const sessions = data.sessions || [];
    const meals = (data.nutrition && data.nutrition.meals) || [];
    sessionsTotal += sessions.length;
    const sw = sessions.filter(s => inWeek(s.date));
    sessionsWeek += sw.length;
    sw.forEach(s => { if (bySport[s.sport] !== undefined) bySport[s.sport] += 1; });
    const mw = meals.filter(m => inWeek(m.date)).length;
    mealsWeek += mw;
    compsWeek += (data.competitions || []).filter(c => inWeek(c.date)).length;
    if (sw.length) usersLoggingSessions += 1;
    if (mw) usersLoggingMeals += 1;
    if ((doc.sizeBytes || 0) > biggest.sizeBytes) biggest = { uid: doc.uid, sizeBytes: doc.sizeBytes };
  });

  const sumWeek = (series) => series ? days.reduce((a, d) => a + (series[d] || 0), 0) : null;
  const firestore = metrics ? {
    reads: sumWeek(metrics.reads), writes: sumWeek(metrics.writes), deletes: sumWeek(metrics.deletes),
    readsByDay: days.map(d => metrics.reads[d] || 0),
    writesByDay: days.map(d => metrics.writes[d] || 0),
  } : null;
  const prevFirestore = prevMetrics ? {
    reads: Object.values(prevMetrics.reads).reduce((a, b) => a + b, 0),
    writes: Object.values(prevMetrics.writes).reduce((a, b) => a + b, 0),
  } : null;

  return {
    weekStart, weekEnd, days,
    users: { total: users.length, withData: docs.length, newThisWeek: newUsers, newPrevWeek: prevNewUsers },
    activity: {
      dau, wau, prevWau,
      avgDau: Math.round((Object.values(dau).reduce((a, b) => a + b, 0) / 7) * 10) / 10,
      tracked: docs.some(d => (d.activeDays || []).length > 0),
    },
    content: { sessionsWeek, sessionsTotal, bySport, mealsWeek, compsWeek, usersLoggingSessions, usersLoggingMeals },
    firestore, prevFirestore,
    storage: { biggestBytes: biggest.sizeBytes, biggestPct: Math.round(biggest.sizeBytes / DOC_LIMIT_BYTES * 1000) / 10 },
  };
}

// ── Mise en forme Markdown (français) ───────────────────────────────────────
const nf = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('fr-FR'));
const fmtDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
function trend(cur, prev) {
  if (prev === null || prev === undefined || cur === null) return '';
  if (prev === 0) return cur > 0 ? ' (nouveau)' : '';
  const pct = Math.round((cur - prev) / prev * 100);
  return pct === 0 ? ' (stable)' : ` (${pct > 0 ? '+' : ''}${pct} % vs semaine précédente)`;
}

export function toMarkdown(r) {
  const L = [];
  L.push(`# TriSeason — rapport du ${fmtDay(r.weekStart)} au ${fmtDay(r.weekEnd)}`);
  L.push('');
  L.push('## Utilisateurs');
  L.push(`- Comptes au total : **${nf(r.users.total)}** (dont ${nf(r.users.withData)} avec des données)`);
  L.push(`- Nouveaux inscrits : **${nf(r.users.newThisWeek)}**${trend(r.users.newThisWeek, r.users.newPrevWeek)}`);
  if (r.activity.tracked) {
    L.push(`- Utilisateurs actifs sur la semaine : **${nf(r.activity.wau)}**${trend(r.activity.wau, r.activity.prevWau)}`);
    L.push(`- Actifs par jour (moyenne) : **${String(r.activity.avgDau).replace('.', ',')}**`);
    L.push('');
    L.push('| Jour | Actifs |' + (r.firestore ? ' Lectures | Écritures |' : ''));
    L.push('|---|---:|' + (r.firestore ? '---:|---:|' : ''));
    r.days.forEach((d, i) => {
      L.push(`| ${fmtDay(d)} | ${nf(r.activity.dau[d])} |` + (r.firestore ? ` ${nf(r.firestore.readsByDay[i])} | ${nf(r.firestore.writesByDay[i])} |` : ''));
    });
  } else {
    L.push('- Actifs par jour : pas encore de données (le suivi d’activité vient d’être ajouté à l’appli).');
  }
  L.push('');
  L.push('## Utilisation de Firebase (Firestore)');
  if (r.firestore) {
    L.push(`- Lectures : **${nf(r.firestore.reads)}**${trend(r.firestore.reads, r.prevFirestore && r.prevFirestore.reads)}`);
    L.push(`- Écritures : **${nf(r.firestore.writes)}**${trend(r.firestore.writes, r.prevFirestore && r.prevFirestore.writes)}`);
    L.push(`- Suppressions : **${nf(r.firestore.deletes)}**`);
    L.push(`- Repère quota gratuit (plan Spark) : 50 000 lectures et 20 000 écritures **par jour**. Jour le plus chargé cette semaine : ${nf(Math.max(...r.firestore.readsByDay))} lectures, ${nf(Math.max(...r.firestore.writesByDay))} écritures.`);
  } else {
    L.push('- Chiffres indisponibles (rôle « Monitoring Viewer » manquant sur la clé, ou API Cloud Monitoring désactivée).');
  }
  L.push('');
  L.push('## Contenu saisi cette semaine');
  L.push(`- Séances : **${nf(r.content.sessionsWeek)}** (natation ${nf(r.content.bySport.nat)}, vélo ${nf(r.content.bySport.velo)}, course ${nf(r.content.bySport.run)}) par ${nf(r.content.usersLoggingSessions)} utilisateur(s)`);
  L.push(`- Repas : **${nf(r.content.mealsWeek)}** par ${nf(r.content.usersLoggingMeals)} utilisateur(s)`);
  L.push(`- Compétitions courues ou prévues dans la semaine : ${nf(r.content.compsWeek)}`);
  L.push(`- Séances au total, tous utilisateurs : ${nf(r.content.sessionsTotal)}`);
  L.push('');
  L.push('## Santé technique');
  const pct = r.storage.biggestPct;
  L.push(`- Plus gros compte : ${nf(Math.round(r.storage.biggestBytes / 1024))} Ko, soit ${String(pct).replace('.', ',')} % de la limite de 1 Mo par utilisateur${pct >= 50 ? ' — à surveiller : prévoir le découpage du stockage' : ''}.`);
  return L.join('\n');
}

// ── Accès Firebase (lecture seule) ──────────────────────────────────────────
function loadServiceAccount() {
  if (process.env.FIREBASE_SA_KEY) return JSON.parse(process.env.FIREBASE_SA_KEY);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  return null;
}

async function fetchAuthUsers(auth) {
  const out = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    page.users.forEach(u => out.push({
      uid: u.uid,
      creationTime: u.metadata.creationTime,
      lastSignInTime: u.metadata.lastSignInTime,
      providers: u.providerData.map(p => p.providerId),
    }));
    pageToken = page.pageToken;
  } while (pageToken);
  return out;
}

async function fetchUserDocs(db) {
  const snap = await db.collection('users').get();
  return snap.docs.map(d => {
    const v = d.data();
    return { uid: d.id, activeDays: v.activeDays || [], data: v.data || {}, sizeBytes: Buffer.byteLength(JSON.stringify(v)) };
  });
}

// Compteurs Firestore journaliers via l'API Cloud Monitoring.
async function fetchFirestoreMetrics(credential, projectId, startDay, endDayExclusive) {
  const { access_token: token } = await credential.getAccessToken();
  const start = parisMidnight(startDay).toISOString();
  const end = parisMidnight(endDayExclusive).toISOString();
  const get = async (type) => {
    const params = new URLSearchParams({
      filter: `metric.type="firestore.googleapis.com/document/${type}"`,
      'interval.startTime': start,
      'interval.endTime': end,
      'aggregation.alignmentPeriod': '3600s',
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    });
    const byDay = {};
    let pageToken = '';
    do {
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Cloud Monitoring ${res.status} : ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      (body.timeSeries || []).forEach(ts => ts.points.forEach(p => {
        const day = parisDay(new Date(p.interval.startTime));
        byDay[day] = (byDay[day] || 0) + Number(p.value.int64Value || 0);
      }));
      pageToken = body.nextPageToken || '';
    } while (pageToken);
    return byDay;
  };
  return { reads: await get('read_count'), writes: await get('write_count'), deletes: await get('delete_count') };
}

async function main() {
  const argWeek = process.argv.indexOf('--week');
  const weekStart = argWeek > 0 ? process.argv[argWeek + 1] : lastFullWeekMonday();
  const sa = loadServiceAccount();
  if (!sa) {
    console.error('Aucune clé Firebase trouvée : ajoute la variable FIREBASE_SA_KEY (contenu JSON de la clé de compte de service) aux réglages de l’environnement.');
    process.exit(2);
  }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore } = await import('firebase-admin/firestore');
  const credential = cert(sa);
  const app = initializeApp({ credential, projectId: sa.project_id });

  const [users, docs] = await Promise.all([fetchAuthUsers(getAuth(app)), fetchUserDocs(getFirestore(app))]);
  let metrics = null, prevMetrics = null, metricsError = null;
  try {
    metrics = await fetchFirestoreMetrics(credential, sa.project_id, weekStart, addDays(weekStart, 7));
    prevMetrics = await fetchFirestoreMetrics(credential, sa.project_id, addDays(weekStart, -7), weekStart);
  } catch (e) { metricsError = e.message; }

  const report = computeReport({ weekStart, users, docs, metrics, prevMetrics });
  let md = toMarkdown(report);
  if (metricsError) md += `\n\n_Lectures/écritures indisponibles : ${metricsError}_`;
  console.log(md);
  writeFileSync(`report-${weekStart}.json`, JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Échec du rapport :', e.message); process.exit(1); });
}
