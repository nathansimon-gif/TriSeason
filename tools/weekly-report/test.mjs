// Tests du calcul du rapport, sans accès à Firebase : node test.mjs
import assert from 'node:assert/strict';
import { loadServiceAccount, computeReport, toMarkdown, lastFullWeekMonday, parisMidnight, addDays, parisDay, markdownToHtml, sendReportEmail } from './report.mjs';

// Dates
assert.equal(lastFullWeekMonday(new Date('2026-10-12T08:00:00Z')), '2026-10-05'); // lundi → lundi précédent
assert.equal(lastFullWeekMonday(new Date('2026-10-18T21:30:00Z')), '2026-10-05'); // dimanche 23h30 à Paris
assert.equal(lastFullWeekMonday(new Date('2026-10-18T22:30:00Z')), '2026-10-12'); // déjà lundi 00h30 à Paris
assert.equal(addDays('2026-10-26', 6), '2026-11-01');
assert.equal(parisMidnight('2026-10-12').toISOString(), '2026-10-11T22:00:00.000Z'); // heure d'été
assert.equal(parisMidnight('2026-11-02').toISOString(), '2026-11-01T23:00:00.000Z'); // heure d'hiver
assert.equal(parisDay(new Date('2026-10-11T22:30:00Z')), '2026-10-12');

// Clé en deux variables (private_key copiée telle quelle du JSON, avec des \n littéraux)
const sa = loadServiceAccount({ FIREBASE_CLIENT_EMAIL: ' rapport@x.iam.gserviceaccount.com ', FIREBASE_PRIVATE_KEY: '"-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n"' });
assert.equal(sa.client_email, 'rapport@x.iam.gserviceaccount.com');
assert.equal(sa.private_key, '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n');
assert.equal(sa.project_id, 'triseason-3c80c');
assert.equal(loadServiceAccount({}), null);

// Calcul
const weekStart = '2026-10-05';
const users = [
  { uid: 'a', creationTime: '2026-01-10T10:00:00Z' },
  { uid: 'b', creationTime: '2026-10-07T10:00:00Z' },   // nouveau cette semaine
  { uid: 'c', creationTime: '2026-09-30T10:00:00Z' },   // nouveau semaine précédente
  { uid: 'd', creationTime: '2026-10-11T21:30:00Z' },   // dimanche 23h30 à Paris : cette semaine
];
const docs = [
  { uid: 'a', sizeBytes: 300000, activeDays: ['2026-10-05', '2026-10-06', '2026-09-30'],
    data: { sessions: [{ date: '2026-10-05', sport: 'run' }, { date: '2026-10-06', sport: 'velo' }, { date: '2026-09-01', sport: 'nat' }],
            nutrition: { meals: [{ date: '2026-10-05' }, { date: '2026-10-12' }] }, competitions: [{ date: '2026-10-11' }] } },
  { uid: 'b', sizeBytes: 2000, activeDays: ['2026-10-07', '2026-10-11'], data: { sessions: [{ date: '2026-10-11', sport: 'nat' }] } },
  { uid: 'c', sizeBytes: 1000, activeDays: ['2026-10-01'], data: {} },
];
const metrics = { reads: { '2026-10-05': 100, '2026-10-06': 50, '2026-10-12': 999 }, writes: { '2026-10-05': 10 }, deletes: {} };
const prevMetrics = { reads: { '2026-09-30': 75 }, writes: { '2026-09-30': 20 }, deletes: {} };
const r = computeReport({ weekStart, users, docs, metrics, prevMetrics });

assert.equal(r.weekEnd, '2026-10-11');
assert.deepEqual(r.users, { total: 4, withData: 3, newThisWeek: 2, newPrevWeek: 1 });
assert.deepEqual(r.activity.dau, { '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1, '2026-10-08': 0, '2026-10-09': 0, '2026-10-10': 0, '2026-10-11': 1 });
assert.equal(r.activity.wau, 2);
assert.equal(r.activity.prevWau, 2);
assert.equal(r.content.sessionsWeek, 3);
assert.deepEqual(r.content.bySport, { nat: 1, velo: 1, run: 1 });
assert.equal(r.content.mealsWeek, 1);
assert.equal(r.content.compsWeek, 1);
assert.equal(r.content.usersLoggingSessions, 2);
assert.equal(r.firestore.reads, 150);            // le 12 n'est pas dans la semaine
assert.equal(r.firestore.writes, 10);
assert.equal(r.prevFirestore.reads, 75);
assert.equal(r.storage.biggestPct, 28.6);

const md = toMarkdown(r);
assert.match(md, /Nouveaux inscrits : \*\*2\*\* \(\+100 % vs semaine précédente\)/);
assert.match(md, /Lectures : \*\*150\*\* \(\+100 % vs semaine précédente\)/);

// Sans suivi d'activité ni métriques
const r2 = computeReport({ weekStart, users, docs: [{ uid: 'a', data: {} }], metrics: null, prevMetrics: null });
const md2 = toMarkdown(r2);
assert.match(md2, /pas encore de données/);
assert.match(md2, /Chiffres indisponibles/);
assert.match(toMarkdown(computeReport({ weekStart, users, docs, metrics: null, prevMetrics: null, metricsError: 'Cloud Monitoring 403 : This API method requires billing to be enabled' })), /forfait Blaze/);

// E-mail : conversion HTML et appel à l'API (simulé)
const html = markdownToHtml(md);
assert.match(html, /<h1[^>]*>TriSeason — rapport du lun\. 5 oct\./);
assert.match(html, /<li>Nouveaux inscrits : <b>2<\/b>/);
assert.match(html, /<table[^>]*><tr><th[^>]*>Jour<\/th>/);
assert.doesNotMatch(markdownToHtml('- a <script>'), /<script>/);
let sent;
await sendReportEmail({ subject: 'Sujet', markdown: md, to: 'moi@exemple.fr', apiKey: 'cle-test',
  fetchImpl: async (url, opts) => { sent = { url, opts }; return { ok: true, json: async () => ({ id: 'x' }) }; } });
assert.equal(sent.url, 'https://api.resend.com/emails');
assert.equal(sent.opts.headers.Authorization, 'Bearer cle-test');
const payload = JSON.parse(sent.opts.body);
assert.deepEqual(payload.to, ['moi@exemple.fr']);
assert.equal(payload.from, 'TriSeason <onboarding@resend.dev>');
// Sans clé dans le script (secret réseau injecté par le proxy) : pas d'en-tête Authorization
await sendReportEmail({ subject: 's', markdown: 'x', to: 't@x.fr',
  fetchImpl: async (url, opts) => { sent = { url, opts }; return { ok: true, json: async () => ({}) }; } });
assert.equal(sent.opts.headers.Authorization, undefined);
await assert.rejects(sendReportEmail({ subject: 's', markdown: 'x', to: 't', apiKey: 'k',
  fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'interdit' }) }), /Resend 403/);

// Section « Santé de l'appli »
const okTests = { total: 20, failed: 0, results: [] };
const koTests = { total: 20, failed: 1, results: [{ name: 'Semaines', ok: false, detail: 'S41=0 km' }] };
assert.match(toMarkdown(computeReport({ weekStart, users, docs, metrics, prevMetrics, tests: okTests })), /Tout fonctionne.*20 tests/);
assert.match(toMarkdown(computeReport({ weekStart, users, docs, metrics, prevMetrics, tests: koTests })), /1 test en échec[\s\S]*Échec — Semaines : S41=0 km/);
assert.match(toMarkdown(computeReport({ weekStart, users, docs, metrics, prevMetrics })), /Tests non lancés/);

console.log('Tous les tests passent.\n');
console.log(md);
