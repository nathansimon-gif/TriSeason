// Rapport hebdomadaire d'activité TriSeason — lecture seule sur Firebase.
//
// Identifiants : une clé de compte de service Google (JSON), fournie par
//   - FIREBASE_SA_KEY : le contenu JSON de la clé, ou
//   - GOOGLE_APPLICATION_CREDENTIALS : le chemin vers le fichier de la clé.
// Rôles nécessaires (lecture seule) : Firebase Authentication Viewer,
// Cloud Datastore Viewer, Monitoring Viewer.
//
// Usage : node report.mjs [--week AAAA-MM-JJ] [--email] [--tests ../app-tests/results.json]   (lundi de la semaine voulue ;
// par défaut la dernière semaine complète, du lundi au dimanche, heure de Paris)
// Écrit le rapport en Markdown sur la sortie standard et le détail dans
// report-<lundi>.json.
// --email : envoie aussi le rapport par e-mail via l'API Resend, à l'adresse
// REPORT_EMAIL_TO. La clé Resend est normalement un « secret réseau » de
// l'environnement Claude : le proxy l'ajoute lui-même à la requête vers
// api.resend.com, le script ne la voit pas. RESEND_API_KEY reste possible
// pour un lancement ailleurs (voir README).

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
export function computeReport({ weekStart, users, docs, metrics, prevMetrics, metricsError = null, tests = null }) {
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
  let biggest = { uid: null, sizeBytes: 0 }, biggestTotal = 0, inDrawers = 0, backups = 0;
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
    biggestTotal = Math.max(biggestTotal, doc.totalBytes || doc.sizeBytes || 0);
    if (doc.layout === 2) inDrawers += 1;
    if (doc.hasBackup) backups += 1;
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
    firestore, prevFirestore, metricsError, tests,
    storage: { biggestBytes: biggest.sizeBytes, biggestPct: Math.round(biggest.sizeBytes / DOC_LIMIT_BYTES * 1000) / 10,
      biggestTotal, inDrawers, backups, accounts: docs.length },
  };
}

// ── Feuille de route (FEUILLE-DE-ROUTE.md) : à faire et fait la semaine ──────
// Pur et testable : md = contenu du fichier, weekStart / weekEnd = 'AAAA-MM-JJ'.
const roadmapClean = t => t
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*|`|_/g, '')
  .replace(/^\d+\.\s*/, '').replace(/\s+/g, ' ').trim();
const roadmapShort = (t, n = 150) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t);
function roadmapItem(line) {
  const m = line.match(/^- \[ \] ((?:🧑|🤖)+)\s*(.*)$/u);
  if (!m) return null;
  const who = m[1].includes('🧑') && m[1].includes('🤖') ? 'Toi + Claude' : m[1].includes('🧑') ? 'Toi' : 'Claude';
  let text = m[2].trim();
  const bold = text.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  // « **Titre** : détail » → « Titre » suffit ; sinon le début de la phrase
  if (bold) text = bold[1] + (bold[2] && !/^[:(]/.test(bold[2]) ? ' ' + bold[2] : '');
  return { who, text: roadmapShort(roadmapClean(text)) };
}
function roadmapSection(md, title) {
  const i = md.indexOf('\n## ' + title);
  if (i < 0) return '';
  const rest = md.slice(i + 4 + title.length);
  const j = rest.indexOf('\n## ');
  return j < 0 ? rest : rest.slice(0, j);
}
export function parseRoadmap(md, weekStart, weekEnd) {
  const items = sec => sec.split('\n').map(roadmapItem).filter(Boolean); // seulement le 1er niveau (pas de retrait)
  const toIso = d => { const [dd, mm, yy] = d.split('/'); return `${yy}-${mm}-${dd}`; };
  const done = [];
  roadmapSection(md, 'Fait').split('\n').forEach(l => {
    const m = l.match(/^\| (\d\d\/\d\d\/\d{4}) \| (#\d+) \| (.+) \|$/);
    if (m && toIso(m[1]) >= weekStart && toIso(m[1]) <= weekEnd) done.push({ date: toIso(m[1]), pr: m[2], text: roadmapShort(roadmapClean(m[3]), 120) });
  });
  const later = ['Dans 3 à 6 mois', 'Plus tard', 'Dans 1 an', 'Quand l’appli devient payante', "Quand l'appli devient payante"]
    .map(t => { const k = md.split('\n## ').find(x => x.startsWith(t)); return k ? items(k).length : 0; }).reduce((a, b) => a + b, 0);
  return { now: items(roadmapSection(md, 'Maintenant (en cours)')), soon: items(roadmapSection(md, 'Bientôt (dans le mois)')), later, done };
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
  // Santé de l'appli : résultat des tests automatiques (tools/app-tests), lancés juste avant.
  L.push('## Santé de l’appli (tests automatiques)');
  if (r.tests && r.tests.total) {
    if (r.tests.failed) {
      L.push(`- **${r.tests.failed} test${r.tests.failed > 1 ? 's' : ''} en échec** sur ${r.tests.total} : un problème est à corriger.`);
      r.tests.results.filter(t => !t.ok).forEach(t => L.push(`- Échec — ${t.name} : ${t.detail}`));
    } else {
      L.push(`- **Tout fonctionne** : ${r.tests.total} tests passés (pages, calculs, données personnelles).`);
    }
  } else {
    L.push('- Tests non lancés cette semaine.' + (r.tests && r.tests.error ? ' Raison : ' + r.tests.error : ''));
  }
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
    const err = r.metricsError || '';
    if (/billing/i.test(err)) {
      L.push('- Chiffres indisponibles : Google ne les fournit que si la facturation est activée sur le projet (forfait Blaze). En attendant, ils restent consultables dans la console Firebase, onglet Firestore → Utilisation.');
    } else if (/403|permission/i.test(err)) {
      L.push('- Chiffres indisponibles : la clé n’a pas le rôle « Lecteur Monitoring ».');
    } else {
      L.push('- Chiffres indisponibles' + (err ? ' : ' + err.slice(0, 160) : '.'));
    }
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
  L.push(`- Plus gros document : ${nf(Math.round(r.storage.biggestBytes / 1024))} Ko, soit ${String(pct).replace('.', ',')} % de la limite de 1 Mo par document${pct >= 50 ? ' — à surveiller' : ''}.`);
  if (r.storage.biggestTotal && r.storage.biggestTotal !== r.storage.biggestBytes) L.push(`- Plus gros compte au total (tous ses tiroirs) : ${nf(Math.round(r.storage.biggestTotal / 1024))} Ko.`);
  if (r.storage.accounts) L.push(`- Rangement en tiroirs : **${nf(r.storage.inDrawers)}** compte(s) sur ${nf(r.storage.accounts)}${r.storage.inDrawers < r.storage.accounts ? ' (les autres passent en tiroirs à leur prochaine ouverture de l’appli)' : ''}. Copies de secours de l’ancien rangement gardées : ${nf(r.storage.backups)}.`);
  if (r.roadmap) {
    const rm = r.roadmap;
    L.push('');
    L.push('## Feuille de route');
    L.push(`**Fait la semaine dernière** (${fmtDay(r.weekStart)} → ${fmtDay(r.weekEnd)})`);
    if (rm.done.length) rm.done.forEach(d => L.push(`- ${fmtDay(d.date)} · PR ${d.pr} — ${d.text}`));
    else L.push('- Rien de fusionné cette semaine.');
    L.push('');
    L.push('**À faire maintenant**');
    if (rm.now.length) rm.now.forEach(t => L.push(`- **${t.who}** — ${t.text}`));
    else L.push('- Rien en cours.');
    L.push('');
    L.push('**Ensuite, dans le mois**');
    if (rm.soon.length) rm.soon.slice(0, 10).forEach(t => L.push(`- **${t.who}** — ${t.text}`));
    else L.push('- Rien de prévu.');
    if (rm.soon.length > 10) L.push(`- … et ${rm.soon.length - 10} autre(s).`);
    if (rm.later) L.push(`- Plus tard (3 mois et au-delà) : ${rm.later} idée(s) notée(s) dans la feuille de route.`);
  } else if (r.roadmapError) {
    L.push('');
    L.push('## Feuille de route');
    L.push('- Feuille de route illisible : ' + r.roadmapError);
  }
  return L.join('\n');
}

// ── E-mail (API Resend, en HTTPS) ───────────────────────────────────────────
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/_(.+?)_/g, '<i>$1</i>');

// Markdown du rapport → HTML simple (titres, listes, tableaux, gras).
export function markdownToHtml(md) {
  const out = [];
  let list = false, table = null;
  const flush = () => {
    if (list) { out.push('</ul>'); list = false; }
    if (table) {
      const [head, , ...rows] = table;
      const cells = (r, tag) => r.split('|').slice(1, -1).map((c, i) => `<${tag} style="padding:4px 10px;border-bottom:1px solid #ddd;text-align:${i === 0 ? 'left' : 'right'}">${inline(c.trim())}</${tag}>`).join('');
      out.push('<table style="border-collapse:collapse;font-size:14px;margin:8px 0">'
        + `<tr>${cells(head, 'th')}</tr>` + rows.map(r => `<tr>${cells(r, 'td')}</tr>`).join('') + '</table>');
      table = null;
    }
  };
  md.split('\n').forEach(line => {
    if (line.startsWith('|')) { if (list) { out.push('</ul>'); list = false; } (table = table || []).push(line); return; }
    if (table) flush();
    if (line.startsWith('# ')) { flush(); out.push(`<h1 style="font-size:20px">${inline(line.slice(2))}</h1>`); }
    else if (line.startsWith('## ')) { flush(); out.push(`<h2 style="font-size:16px;margin-top:20px">${inline(line.slice(3))}</h2>`); }
    else if (line.startsWith('- ')) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(line.slice(2))}</li>`); }
    else if (line.trim()) { flush(); out.push(`<p>${inline(line)}</p>`); }
    else flush();
  });
  flush();
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1f27;max-width:640px;line-height:1.5">${out.join('\n')}</div>`;
}

export async function sendReportEmail({ subject, markdown, to, apiKey, from = 'TriSeason <onboarding@resend.dev>', fetchImpl = fetch }) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html: markdownToHtml(markdown), text: markdown }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status} : ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── Accès Firebase (lecture seule) ──────────────────────────────────────────
export function loadServiceAccount(env = process.env) {
  // Forme simple pour les réglages de l'environnement : deux valeurs sur une ligne
  // chacune, copiées du fichier JSON (client_email et private_key).
  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return {
      project_id: env.FIREBASE_PROJECT_ID || 'triseason-3c80c',
      client_email: env.FIREBASE_CLIENT_EMAIL.trim(),
      private_key: env.FIREBASE_PRIVATE_KEY.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n'),
    };
  }
  if (env.FIREBASE_SA_KEY) return JSON.parse(env.FIREBASE_SA_KEY);
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
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

// Document principal + tiroirs (users/{uid}/drawers) → données complètes et tailles.
// Même règle que l'appli : données en tiroirs si layout 2 et pas de séances dans
// le document principal (sinon un ancien appareil a tout réécrit dans le principal).
export function assembleUserDoc(uid, v, drawers = [], hasBackup = false) {
  const size = x => Buffer.byteLength(JSON.stringify(x));
  const data = v.data || {};
  const layout = v.layout === 2 && !Array.isArray(data.sessions) ? 2 : 1;
  let full = data;
  if (layout === 2) {
    full = { ...data, sessions: [] };
    const meals = [], fuel = [];
    drawers.slice().sort((a, b) => a.id.localeCompare(b.id)).forEach(d => {
      const g = JSON.parse(d.json || '{}');
      full.sessions.push(...(g.sessions || [])); meals.push(...(g.meals || [])); fuel.push(...(g.fuel || []));
    });
    if (data.nutrition || meals.length || fuel.length) full.nutrition = { ...(data.nutrition || {}), meals, fuel };
  }
  const sizes = [size(v), ...drawers.map(d => size({ json: d.json, n: d.n, at: d.at }))];
  return { uid, activeDays: v.activeDays || [], data: full, layout, hasBackup,
    sizeBytes: Math.max(...sizes), totalBytes: sizes.reduce((a, b) => a + b, 0) };
}

async function fetchUserDocs(db) {
  const snap = await db.collection('users').get();
  return Promise.all(snap.docs.map(async d => {
    const v = d.data();
    const [dr, bk] = await Promise.all([d.ref.collection('drawers').get(), d.ref.collection('backup').doc('v1').get()]);
    return assembleUserDoc(d.id, v, dr.docs.map(x => ({ id: x.id, ...x.data() })), bk.exists);
  }));
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
    console.error('Aucune clé Firebase trouvée : ajoute FIREBASE_CLIENT_EMAIL et FIREBASE_PRIVATE_KEY (ou FIREBASE_SA_KEY) aux variables d’environnement (voir README).');
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

  // --tests chemin/vers/results.json : résultat des tests automatiques à inclure
  let tests = null;
  const argTests = process.argv.indexOf('--tests');
  if (argTests > 0) {
    try { tests = JSON.parse(readFileSync(process.argv[argTests + 1], 'utf8')); }
    catch (e) { tests = { error: 'résultat introuvable (' + e.message.slice(0, 80) + ')' }; }
  }
  const report = computeReport({ weekStart, users, docs, metrics, prevMetrics, metricsError, tests });
  // Feuille de route du dépôt (branche à jour au moment du lancement)
  try {
    report.roadmap = parseRoadmap(readFileSync(new URL('../../FEUILLE-DE-ROUTE.md', import.meta.url), 'utf8'), weekStart, addDays(weekStart, 6));
  } catch (e) { report.roadmapError = e.message.slice(0, 120); }
  const md = toMarkdown(report);
  console.log(md);
  if (process.argv.includes('--email')) {
    const to = process.env.REPORT_EMAIL_TO, apiKey = process.env.RESEND_API_KEY;
    if (!to) {
      console.error('\nE-mail non envoyé : il manque l’adresse REPORT_EMAIL_TO.');
    } else {
      try {
        await sendReportEmail({ subject: `TriSeason — rapport de la semaine du ${fmtDay(weekStart)}`, markdown: md, to, apiKey, from: process.env.REPORT_EMAIL_FROM });
        console.error(`\nE-mail envoyé à ${to}.`);
      } catch (e) {
        console.error(`\nE-mail non envoyé : ${e.message}`);
      }
    }
  }
  writeFileSync(`report-${weekStart}.json`, JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Échec du rapport :', e.message); process.exit(1); });
}
