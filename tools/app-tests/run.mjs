// Tests automatiques de TriSeason.
//
// Ouvre le site dans un navigateur invisible (Chromium), avec un faux Firebase
// et des données de test : aucune vraie donnée n'est lue ni modifiée.
// Usage : node run.mjs            → affiche le résumé, écrit results.json
// Code de sortie : 0 si tout passe, 1 sinon.

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { deflateRawSync, crc32 } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TZ = 'Europe/Paris';

// ── Petit serveur pour les fichiers du site ─────────────────────────────────
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/plain' };
function startServer() {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── Navigateur : celui de Playwright, ou un Chromium déjà installé ──────────
function findChromium() {
  const candidates = [process.env.CHROMIUM_PATH];
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(base)) {
    readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
      .forEach(d => candidates.push(join(base, d, 'chrome-linux', 'chrome'), join(base, d, 'chrome-linux64', 'chrome')));
  }
  return candidates.find(p => p && existsSync(p));
}

// ── Faux Firebase (état « serveur » partagé entre pages via localStorage) ──
const firebaseStub = (uid) => `
(function(){
  const load=()=>JSON.parse(localStorage.getItem('__fb')||'{"docs":{}}');
  const save=(st)=>localStorage.setItem('__fb',JSON.stringify(st));
  const user = ${uid ? `{uid:'${uid}', email:'${uid}@test.fr', providerData:[{providerId:'password'}],
    reauthenticateWithCredential(){return Promise.resolve();}, reauthenticateWithPopup(){return Promise.resolve();},
    delete(){return Promise.resolve();}}` : 'null'};
  const authObj={ currentUser:user, languageCode:null, onAuthStateChanged(cb){setTimeout(()=>cb(user),10)},
    signOut(){return Promise.resolve()}, sendPasswordResetEmail(){return Promise.resolve()},
    createUserWithEmailAndPassword(){return Promise.resolve()}, signInWithEmailAndPassword(){return Promise.resolve()}, signInWithPopup(){return Promise.resolve()} };
  window.firebase={apps:[],initializeApp(){this.apps.push(1)},
    auth:Object.assign(()=>authObj,{EmailAuthProvider:{credential:()=>({})},GoogleAuthProvider:function(){}}),
    firestore:Object.assign(()=>({collection:()=>({doc:(id)=>({
      get(){const d=load().docs[id];return Promise.resolve({exists:!!d,data:()=>JSON.parse(JSON.stringify(d||{}))})},
      set(v,opt){const st=load(); let d=st.docs[id]||{};
        if(opt&&opt.mergeFields) opt.mergeFields.forEach(k=>d[k]=v[k]);
        else if(opt&&opt.merge){for(const k in v){ if(v[k]&&v[k].__union){const a=d[k]||[];v[k].__union.forEach(x=>{if(!a.includes(x))a.push(x)});d[k]=a;} else d[k]=v[k];}}
        else d=v; st.docs[id]=d; save(st); return Promise.resolve();},
      delete(){const st=load(); delete st.docs[id]; save(st); return Promise.resolve();}
    })})}),{FieldValue:{arrayUnion:(...v)=>({__union:v})}})};
})();`;

// ── Données de test ──────────────────────────────────────────────────────────
function day(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function sampleData() {
  const sessions = [];
  for (let i = 1; i <= 40; i++) {
    const sport = ['run', 'velo', 'nat'][i % 3];
    sessions.push({ id: 's' + i, date: day(-i), sport, duration: sport === 'velo' ? 1.5 : 0.75,
      distance: sport === 'velo' ? 42 : sport === 'run' ? 9 : 2, rpe: 5 + (i % 4), sensation: 2 + (i % 4), fc_avg: 140 });
  }
  const meals = [];
  for (let i = 1; i <= 30; i++) meals.push({ id: 'm' + i, date: day(-i), type: 'déjeuner', desc: 'riz + poulet', glucides: 150 + (i % 5) * 40, proteines: 40, lipides: 20 });
  return { profile: { name: 'Test', fcmax: 190 }, weeks: {}, _migrated: true, weight: [{ date: day(-10), value: 70 }], records: [],
    competitions: [{ id: 'c1', date: day(-20), name: '10 km test', type: 'RUN', distance: '10', goal_time: '0:42:00', actual_time: '0:41:07' },
                   { id: 'c2', date: day(30), name: 'Triathlon test', type: 'TRI', distance: '51.5', goal_time: '2:30:00' }],
    sessions, nutrition: { meals, hydration: { [day(-1)]: 2000 }, fuel: [] } };
}

// ── Tests ────────────────────────────────────────────────────────────────────
const PAGES = ['index', 'sessions', 'sport', 'competitions', 'nutrition', 'records', 'forme', 'profile'];
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, detail: detail || '', ms: Date.now() - t0 }); }
  catch (e) { results.push({ name, ok: false, detail: String(e && e.message || e).slice(0, 400), ms: Date.now() - t0 }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const server = await startServer();
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: findChromium() });

  // Ouvre un contexte « utilisateur connecté » avec des données de test.
  async function newUser({ uid = 'testeur', data = sampleData(), consent = true, external } = {}) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', timezoneId: TZ, viewport: { width: 1280, height: 900 } });
    let currentUid = uid;
    await ctx.route(/gstatic\.com/, r => r.request().url().includes('app-compat')
      ? r.fulfill({ body: firebaseStub(currentUid), contentType: 'application/javascript' })
      : r.fulfill({ body: '', contentType: 'application/javascript' }));
    if (external) ctx.on('request', r => { const h = new URL(r.url()).host; if (!h.startsWith('127.0.0.1')) external.add(h); });
    await ctx.addInitScript(([d, u, c]) => {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      localStorage.setItem('triseason_data', JSON.stringify(d));
      if (u) localStorage.setItem('triseason_owner', u);
      localStorage.setItem('__fb', JSON.stringify({ docs: u ? { [u]: { data: d, ...(c ? { consent: { healthData: true, version: 1, at: 1 } } : {}) } } : {} }));
    }, [data, uid, consent]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    return { ctx, page, errors, setUid: (u) => { currentUid = u; } };
  }

  // 1. Chaque page s'affiche sans erreur
  const external = new Set();
  const u = await newUser({ external });
  for (const p of PAGES) {
    await test(`Page ${p}.html : s'affiche sans erreur`, async () => {
      u.errors.length = 0;
      await u.page.goto(`${BASE}/${p}.html`); await u.page.waitForTimeout(700);
      assert(!u.errors.length, 'erreur JavaScript : ' + u.errors[0]);
      assert(await u.page.locator('.page, .container').first().isVisible(), 'contenu non affiché');
      assert(!(await u.page.locator('#consentGate').count()), 'fenêtre d’accord affichée alors que l’accord est donné');
    });
  }
  await test('Pages publiques (connexion, confidentialité, aide) : s’affichent sans erreur', async () => {
    const v = await newUser({ uid: null });
    for (const p of ['login', 'confidentialite', 'aide']) {
      await v.page.goto(`${BASE}/${p}.html`); await v.page.waitForTimeout(500);
      assert(!v.errors.length, `${p}.html : ${v.errors[0]}`);
    }
    await v.ctx.close();
  });

  // 2. Aucune ressource tierce à part Firebase
  await test('Aucun site extérieur contacté à part Firebase (RGPD)', async () => {
    const others = [...external].filter(h => h !== 'www.gstatic.com');
    assert(!others.length, 'contacté : ' + others.join(', '));
  });

  // 3. Même version des fichiers partout
  await test('Même numéro de version des fichiers sur toutes les pages', async () => {
    const versions = {};
    readdirSync(ROOT).filter(f => f.endsWith('.html')).forEach(f => {
      (readFileSync(join(ROOT, f), 'utf8').match(/\?v=[\w.-]+/g) || []).forEach(v => { (versions[v] = versions[v] || []).push(f); });
    });
    const list = Object.keys(versions);
    assert(list.length <= 1, 'versions différentes : ' + list.map(v => `${v} (${[...new Set(versions[v])].join(', ')})`).join(' / '));
    return list[0] || '';
  });

  // 4. Calculs (dans le navigateur, heure de Paris)
  await u.page.goto(`${BASE}/sessions.html`); await u.page.waitForTimeout(600);
  await test('Semaines : une séance du dimanche reste dans sa semaine', async () => {
    // Données isolées : une course le dimanche 11/10 (semaine 41), du vélo le lundi 12/10 (semaine 42)
    const r = await u.page.evaluate(() => {
      const saved = TS.getData();
      const d = JSON.parse(JSON.stringify(saved));
      d.sessions = [{ id: 'dim', date: '2026-10-11', sport: 'run', duration: 1, distance: 10 },
                    { id: 'lun', date: '2026-10-12', sport: 'velo', duration: 2, distance: 60 }];
      TS.saveData(d);
      const out = { w41run: TS.getWeek('2026-W41').run.dist, w41velo: TS.getWeek('2026-W41').velo.dist,
                    w42run: TS.getWeek('2026-W42').run.dist, w42velo: TS.getWeek('2026-W42').velo.dist,
                    iso: TS.getISOWeek('2026-10-11') };
      TS.saveData(saved);
      return out;
    });
    assert(r.iso === '2026-W41', 'semaine calculée : ' + r.iso);
    assert(r.w41run === 10 && r.w42run === 0, `course du dimanche : S41=${r.w41run} km, S42=${r.w42run} km (attendu 10 / 0)`);
    assert(r.w42velo === 60 && r.w41velo === 0, `vélo du lundi : S41=${r.w41velo} km, S42=${r.w42velo} km (attendu 0 / 60)`);
  });
  await test('Durées : saisie à la seconde (1:30:15, 1h30\'15, 45min20…)', async () => {
    const r = await u.page.evaluate(() => ['1:30:15', "1h30'15", '45min20', '1h30', '1.5', 'abc'].map(v => { const h = parseDurInput(v); return h === null ? null : formatHMS(h); }));
    const want = ['1:30:15', '1:30:15', '0:45:20', '1:30:00', '1:30:00', null];
    assert(JSON.stringify(r) === JSON.stringify(want), 'obtenu ' + JSON.stringify(r));
  });
  await test('Heures au format 1h30 (totaux et moyennes)', async () => {
    const r = await u.page.evaluate(() => [1.5, 0.75, 2, 7.999, 0, 10 + 5 / 60].map(TS.formatHours));
    assert(JSON.stringify(r) === JSON.stringify(['1h30', '45min', '2h', '8h', '0h', '10h05']), JSON.stringify(r));
    await u.page.goto(`${BASE}/index.html`); await u.page.waitForTimeout(700);
    const t = await u.page.textContent('#totalH');
    assert(/^(\d+h(\d\d)?|\d+min)$/.test(t.trim()), 'Heures semaine : ' + t);
  });
  await test('Allure : arrondie à la seconde (pas de 3\'60")', async () => {
    const r = await u.page.evaluate(() => TS.calcPace(19.9667 / 60, 5, 'run'));
    assert(r === "4'00\"", 'obtenu ' + r);
  });
  await test('Records automatiques : temps à la seconde depuis une séance', async () => {
    const r = await u.page.evaluate(() => {
      const d = TS.getData();
      d.competitions.push({ id: 'cauto', date: '2026-09-27', name: 'Test auto', type: 'RUN', distance: '10' });
      d.sessions.push({ id: 'sauto', date: '2026-09-27', sport: 'run', duration: 2467 / 3600, distance: 10, comp_id: 'cauto' });
      TS.saveData(d); TS.syncCompetition('cauto');
      const dd = TS.getData();
      return { time: dd.competitions.find(c => c.id === 'cauto').actual_time, recs: (dd.records || []).filter(x => x.comp_id === 'cauto').map(x => x.time) };
    });
    assert(r.time === '41:07', 'temps de course : ' + r.time);
    assert(r.recs.includes('41:07'), 'record : ' + JSON.stringify(r.recs));
  });
  await test('Nutrition et performance : comparaison calculée', async () => {
    const r = await u.page.evaluate(() => TS.getNutritionImpact().comparisons.carbs_prev.sensation);
    assert(r.n > 0 && r.enough, `${r.n} séances utilisables, groupes ${r.high.n}/${r.low.n}`);
    return `${r.high.n} / ${r.low.n} séances`;
  });
  await test('Badges : obtenus à la bonne date', async () => {
    const r = await u.page.evaluate(() => {
      const d = { sessions: [
        { id: 'a', date: '2026-10-05', sport: 'velo', distance: 60, duration: 2 },
        { id: 'b', date: '2026-10-05', sport: 'run', distance: 10, duration: 1 },
        { id: 'c', date: '2026-10-07', sport: 'nat', distance: 2.2, duration: 1 },
        { id: 'e', date: '2026-10-08', sport: 'velo', distance: 45, duration: 1.5 },
        { id: 'f', date: '2026-10-11', sport: 'run', distance: 5, duration: 0.5 } ],
        nutrition: { meals: ['01', '02', '03', '04', '05', '06', '07'].map((x, i) => ({ id: 'm' + i, date: '2026-10-' + x })), hydration: {} },
        competitions: [{ id: 'c1', date: '2026-10-04', actual_time: '0:41:07', goal_time: '0:42:00' }] };
      const b = Object.fromEntries(TS.getAchievements(d).map(x => [x.id, x]));
      return { brick: b.brick.date, tri: b.tri_week.date, velo: b.velo100.date, swim: b.swim2k.date, meals7: b.meals7.date,
        goal: b.goal.date, finisher: b.finisher.date, half: b.half.earned, halfProg: b.half.value, s50: b.s50.value };
    });
    const want = { brick: '2026-10-05', tri: '2026-10-07', velo: '2026-10-08', swim: '2026-10-07', meals7: '2026-10-07', goal: '2026-10-04', finisher: '2026-10-04' };
    Object.entries(want).forEach(([k, v]) => assert(r[k] === v, `${k} : ${r[k]} au lieu de ${v}`));
    assert(!r.half && r.halfProg === 10 && r.s50 === 5, 'progression : ' + JSON.stringify(r));
  });
  await test('Défis de la semaine : choisis d’après les 4 semaines précédentes', async () => {
    const r = await u.page.evaluate(() => {
      const sessions = [];
      // 4 semaines avant la semaine du 12/10/2026 : 3 courses et 2 vélos par semaine, pas de natation
      [-28, -21, -14, -7].forEach(off => {
        const day = (n) => { const x = TS.parseLocalDate('2026-10-12'); x.setDate(x.getDate() + off + n); return TS.localDateStr(x); };
        [0, 2, 4].forEach(n => sessions.push({ date: day(n), sport: 'run' }));
        [1, 5].forEach(n => sessions.push({ date: day(n), sport: 'velo' }));
      });
      sessions.push({ date: '2026-10-13', sport: 'velo' }, { date: '2026-10-18', sport: 'velo' });
      const d = { sessions, nutrition: { meals: [{ date: '2026-10-12' }], hydration: {} } };
      return TS.weeklyChallenges('2026-W42', d).map(c => [c.label, c.value, c.done]);
    });
    assert(JSON.stringify(r) === JSON.stringify([['3 séances de vélo', 2, false], ['Repas notés 3 jours', 1, false]]), JSON.stringify(r));
  });
  await test('Dashboard : carte « Ce que Strava ne te montre pas »', async () => {
    await u.page.goto(`${BASE}/index.html`); await u.page.waitForTimeout(800);
    const full = await u.page.textContent('#insightBody');
    const v = await newUser({ data: { profile: {}, sessions: [], nutrition: { meals: [], hydration: {} } } });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const empty = await v.page.textContent('#insightBody');
    await v.ctx.close();
    assert(/Quand tu as (mangé|bu) plus de .*Les autres fois, /s.test(full) && full.includes('pas un conseil'), 'avec données : ' + full.slice(0, 160));
    assert(/Encore\s+6 séances/.test(empty), 'sans données : ' + empty.slice(0, 200));
  });
  await test('Identifiants uniques (rien ne s’écrase lors d’un import groupé)', async () => {
    const r = await u.page.evaluate(() => { const before = TS.getData().sessions.length;
      for (let i = 0; i < 30; i++) TS.saveSession({ date: '2026-08-0' + (1 + i % 9), sport: 'nat', duration: 0.5, distance: 1 });
      return TS.getData().sessions.length - before; });
    assert(r === 30, `${r} séances sur 30`);
  });
  await u.ctx.close();

  // Nutrition : produits du commerce (faux Open Food Facts, rien n'est envoyé au vrai site)
  await test('Nutrition : produit Open Food Facts ajouté au repas, sans compter deux fois', async () => {
    const v = await newUser();
    const asked = [];
    await v.ctx.route(/openfoodfacts\.org|workers\.dev\/off\//, r => {
      const url = r.request().url(); asked.push(url);
      const compote = { code: '3045320001570', product_name: 'Compote pomme', brands: 'Andros, Andros SAS', serving_quantity: '100',
        nutriments: { carbohydrates_100g: 14, proteins_100g: 0.3, fat_100g: 0.2, 'energy-kcal_100g': 60 } };
      const body = url.includes('/api/v2/product/')
        ? { status: 1, product: { ...compote, product_name: 'Pâte à tartiner', brands: 'Marque', nutriments: { carbohydrates_100g: 57, proteins_100g: 6, fat_100g: 31 } } }
        : { products: [compote, { code: '1', product_name: 'Sans valeurs', nutriments: {} }] };
      r.fulfill({ body: JSON.stringify(body), contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    const p = v.page;
    await p.goto(`${BASE}/nutrition.html`); await p.waitForTimeout(700);
    await p.evaluate(() => openMealModal());
    await p.fill('#m_desc', 'riz 150g'); await p.dispatchEvent('#m_desc', 'input');
    await p.fill('#off_q', 'compote'); await p.click('text=Chercher');
    await p.waitForSelector('.off-item');
    const shown = await p.locator('.off-item').count();
    await p.click('.off-item >> nth=0');
    await p.fill('#off_qty_input', '200'); await p.click('text=Ajouter au repas');
    const gluc = await p.inputValue('#m_glucides');
    const desc = await p.inputValue('#m_desc');
    // Code-barres : recherche directe du produit
    await p.fill('#off_q', '3017620422003'); await p.click('text=Chercher');
    await p.waitForSelector('#off_qty_input');
    await p.fill('#off_qty_input', '30'); await p.click('text=Ajouter au repas');
    const gluc2 = await p.inputValue('#m_glucides');
    await p.evaluate(() => saveMealForm());
    const saved = await p.evaluate(() => { const m = TS.getData().nutrition.meals; return m[m.length - 1]; });
    await v.ctx.close();
    assert(!v.errors.length, 'erreur JavaScript : ' + v.errors[0]);
    assert(shown === 1, `${shown} produits affichés (le produit sans valeurs doit être masqué)`);
    assert(desc.includes('[Compote pomme – Andros · 200 g]'), 'description : ' + desc);
    assert(gluc === '70', `glucides ${gluc} au lieu de 70 (riz 42 + compote 28 ; « pomme » ne doit pas être recompté)`);
    assert(gluc2 === '87', `glucides ${gluc2} au lieu de 87 après le code-barres`);
    assert(saved.glucides === 87 && saved.products?.length === 2 && saved.products[0].qty === 200 && !saved.products[0].label, 'repas enregistré : ' + JSON.stringify(saved));
    assert(asked.length === 2 && asked[0].includes('workers.dev/off/search?q=compote') && asked[1].includes('openfoodfacts.org/api/v2/product/3017620422003'), 'requêtes : ' + asked.join(' | '));
    return 'recherche, code-barres et enregistrement';
  });

  // Strava (faux Strava et faux serveur TriSeason : aucun vrai compte n'est utilisé)
  async function stravaUser() {
    const v = await newUser();
    const calls = [];
    // Réglages Strava remplacés par ceux du test (faux serveur)
    await v.ctx.route(/\/app\.js/, async r => {
      const res = await r.fetch();
      const body = (await res.text()).replace(/const STRAVA_CLIENT_ID = '[^']*';/, "const STRAVA_CLIENT_ID = '12345';")
        .replace(/const TS_SERVER_URL = '[^']*';/, "const TS_SERVER_URL = 'https://serveur.test';");
      r.fulfill({ response: res, body });
    });
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    await v.ctx.route(/serveur\.test/, r => {
      calls.push(r.request().url().replace('https://serveur.test', '') + ' ' + (r.request().postData() || ''));
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      const path = new URL(r.request().url()).pathname;
      const body = path === '/strava/token'
        ? { access_token: 'acces-1', refresh_token: 'renouv-1', expires_at: Math.floor(Date.now() / 1000) + 21600, athlete: { id: 99, firstname: 'Léa', lastname: 'Test' } }
        : { ok: true };
      r.fulfill({ body: JSON.stringify(body), contentType: 'application/json', headers: cors });
    });
    await v.ctx.route(/strava\.com\/api\/v3\/athlete\/activities/, r => {
      calls.push('strava ' + r.request().headers().authorization);
      const acts = [
        { id: 501, sport_type: 'Ride', start_date: day(-1) + 'T06:00:00Z', start_date_local: day(-1) + 'T08:00:00Z', elapsed_time: 5400, distance: 42100 },
        { id: 502, sport_type: 'Run', name: 'Sortie <b>du soir</b>', start_date: day(-2) + 'T21:30:00Z', start_date_local: day(-2) + 'T23:30:00Z',
          elapsed_time: 3615, moving_time: 3500, distance: 10012.3, total_elevation_gain: 85.4, average_heartrate: 151.6, max_heartrate: 178 },
        { id: 503, sport_type: 'Walk', start_date: day(-3) + 'T10:00:00Z', start_date_local: day(-3) + 'T12:00:00Z', elapsed_time: 1800, distance: 2000 },
      ];
      r.fulfill({ body: JSON.stringify(acts), contentType: 'application/json', headers: cors });
    });
    return { ...v, calls };
  }

  await test('Strava : connexion, séances ajoutées sans doublon (date locale, durée à la seconde)', async () => {
    const v = await stravaUser();
    await v.ctx.addInitScript(() => sessionStorage.setItem('triseason_strava_state', 'etat-ok'));
    await v.page.goto(`${BASE}/profile.html?state=etat-ok&code=code-1&scope=read,activity:read_all`);
    await v.page.waitForFunction(() => TS.getData().strava && TS.getData().strava.last_sync, null, { timeout: 8000 });
    const r = await v.page.evaluate(() => ({ d: TS.getData(), url: location.search, card: document.getElementById('stravaBody').textContent }));
    await v.ctx.close();
    assert(!v.errors.length, 'erreur JavaScript : ' + v.errors[0]);
    const fromStrava = r.d.sessions.filter(s => s.strava_id);
    const run = r.d.sessions.find(s => s.strava_id === 502);
    const ride = r.d.sessions.find(s => s.strava_id === 501);
    assert(r.d.sessions.length === 41, `${r.d.sessions.length} séances au lieu de 41 (40 + la course ; le vélo existait déjà, la marche est ignorée)`);
    assert(ride && ride.id === 's1', 'le vélo n’a pas été relié à la séance déjà importée');
    assert(run && run.date === day(-2), 'date de la course : ' + (run && run.date) + ' au lieu de ' + day(-2) + ' (heure locale 23:30)');
    assert(run.duration === 3615 / 3600 && run.distance === 10.01 && run.elevation === 85 && run.fc_avg === 152, 'valeurs : ' + JSON.stringify(run));
    assert(fromStrava.length === 2 && !r.d.sessions.some(s => s.strava_id === 503), 'séances liées : ' + fromStrava.length);
    assert(r.d.strava.refresh_token === 'renouv-1' && r.d.strava.name === 'Léa Test', 'connexion non enregistrée');
    assert(!r.url.includes('code='), 'le code est resté dans l’adresse');
    assert(r.card.includes('Léa Test'), 'carte Profil : ' + r.card.slice(0, 80));
    assert(v.calls.some(c => c.startsWith('/strava/token') && c.includes('code-1')) && v.calls.some(c => c === 'strava Bearer acces-1'), 'appels : ' + v.calls.join(' | '));
    return '1 ajoutée, 1 reliée, 1 ignorée';
  });

  await test('Strava : connexion refusée si le lien ne vient pas de TriSeason', async () => {
    const v = await stravaUser();
    await v.ctx.addInitScript(() => sessionStorage.setItem('triseason_strava_state', 'etat-ok'));
    await v.page.goto(`${BASE}/profile.html?state=autre&code=code-pirate&scope=read,activity:read_all`);
    await v.page.waitForTimeout(1500);
    const st = await v.page.evaluate(() => TS.getData().strava);
    await v.ctx.close();
    assert(!st && !v.calls.some(c => c.includes('code-pirate')), 'le code a été utilisé');
  });

  await test('Strava : déconnexion (séances gardées ou supprimées au choix)', async () => {
    const v = await stravaUser();
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(async () => {
      const seed = (d) => { d.strava = { access_token: 'a', refresh_token: 'r', expires_at: Date.now() / 1000 + 9999, after: 0 };
        d.sessions[0].strava_id = 1; d.sessions[1].strava_id = 2; TS.saveData(d); };
      seed(TS.getData());
      await TS.stravaDisconnect({ deleteSessions: false });
      const kept = TS.getData();
      seed(TS.getData());
      await TS.stravaDisconnect({ deleteSessions: true });
      const del = TS.getData();
      return { kept: kept.sessions.length, keptIds: kept.sessions.filter(s => s.strava_id).length, keptConn: !!kept.strava, del: del.sessions.length };
    });
    await v.ctx.close();
    assert(r.kept === 40 && r.keptIds === 0 && !r.keptConn, 'garder : ' + JSON.stringify(r));
    assert(r.del === 38, 'supprimer : ' + r.del + ' séances au lieu de 38');
    assert(v.calls.filter(c => c.startsWith('/strava/deauthorize')).length === 2, 'Strava non prévenu');
  });

  await test('Strava : bouton « Actualiser Strava » sur la page Séances', async () => {
    const v = await stravaUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(800);
    const hiddenBefore = await v.page.locator('#stravaRefreshBtn').isHidden();
    await v.page.evaluate(() => { const d = TS.getData();
      d.strava = { access_token: 'acces-1', refresh_token: 'r', expires_at: Date.now() / 1000 + 9999, after: 0 }; TS.saveData(d); });
    await v.page.waitForTimeout(200);
    await v.page.click('#stravaRefreshBtn');
    await v.page.waitForFunction(() => TS.getData().sessions.some(s => s.strava_id === 502), null, { timeout: 8000 });
    const n = await v.page.evaluate(() => TS.getData().sessions.length);
    await v.ctx.close();
    assert(!v.errors.length, 'erreur JavaScript : ' + v.errors[0]);
    assert(hiddenBefore, 'bouton visible alors que Strava n’est pas connecté');
    assert(n === 41, `${n} séances au lieu de 41`);
  });

  // Petite archive .zip construite pour le test (un fichier GPS stocké, activities.csv compressé)
  function makeZip(entries) {
    const locals = [], centrals = []; let off = 0;
    entries.forEach(({ name, data, deflate }) => {
      const raw = Buffer.from(data), comp = deflate ? deflateRawSync(raw) : raw, nb = Buffer.from(name);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
      lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
      ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
    });
    const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
  }

  await test('Archive Strava (.zip) : historique importé sans doublon, date locale', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(800);
    // s1 = vélo de la veille (42 km, 1h30) ; la séance s2 est déjà reliée à l'activité 900
    await v.page.evaluate(() => { const d = TS.getData(); d.sessions.find(s => s.id === 's2').strava_id = 900; TS.saveData(d); });
    const [y1, m1, d1] = day(-1).split('-');
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m1 - 1];
    const head = 'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,Average Speed,Elevation Gain,Elevation Loss,Elevation Low,Elevation High,Max Grade,Average Grade,Average Positive Grade,Average Negative Grade,Max Cadence,Average Cadence,Max Heart Rate,Average Heart Rate,Max Watts,Average Watts,Calories';
    const row = (id, date, name, type, sec, m, desc = '') => [id, `"${date}"`, `"${name}"`, type, `"${desc}"`, sec, (m / 1000).toFixed(2), 170, '', 'false', '', '', '', '', '',
      sec + '.0', sec, m + '.0', '', '', '120.0', '', '', '', '', '', '', '', '', '', '171.0', '148.4', '', '', '640.0'].join(',');
    const csv = [head,
      row(901, `${mon} ${+d1}, ${y1}, 10:30:00 PM`, 'Course du soir, en ville', 'Run', 3615, 10012, 'Bonne sortie,\navec "pluie"'),  // 22h30 UTC → lendemain 00h30 à Paris
      row(902, `${mon} ${+d1}, ${y1}, 7:00:00 AM`, 'Sortie vélo', 'Ride', 5400, 42100),  // même séance que s1 (déjà importée par fichier)
      row(900, `${mon} ${+d1}, ${y1}, 6:00:00 AM`, 'Natation', 'Swim', 2700, 2000),       // déjà reliée
      row(903, `${mon} ${+d1}, ${y1}, 9:00:00 AM`, 'Balade', 'Walk', 3600, 4000),
    ].join('\n');
    const zip = makeZip([{ name: 'export_1/activities/123.fit.gz', data: 'x'.repeat(5000) }, { name: 'export_1/activities.csv', data: csv, deflate: true }]);
    await v.page.setInputFiles('#archiveInput', { name: 'export_1.zip', mimeType: 'application/zip', buffer: zip });
    await v.page.waitForSelector('#archiveResult button.btn--primary', { timeout: 5000 });
    const summary = await v.page.textContent('#archiveResult');
    await v.page.click('#archiveResult button.btn--primary');
    await v.page.waitForTimeout(300);
    const r = await v.page.evaluate(() => TS.getData().sessions);
    await v.ctx.close();
    assert(!v.errors.length, 'erreur JavaScript : ' + v.errors[0]);
    const run = r.find(s => s.strava_id === 901);
    assert(summary.includes('1 séance à ajouter') && summary.includes('1 ignorée'), 'résumé : ' + summary.replace(/\s+/g, ' ').slice(0, 200));
    assert(r.length === 41 && r.find(s => s.id === 's1').strava_id === 902, `${r.length} séances, s1 reliée : ${r.find(s => s.id === 's1').strava_id}`);
    assert(run && run.date === day(0) && run.sport === 'run' && run.duration === 3615 / 3600 && run.distance === 10.01 && run.fc_avg === 148 && run.elevation === 120,
      'course : ' + JSON.stringify(run) + ' (date attendue ' + day(0) + ')');
  });

  await test('Archive Strava : limite de 1 Mo par compte respectée', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => {
      const acts = [];
      for (let i = 0; i < 9000; i++) acts.push({ id: 10000 + i, start: new Date(Date.UTC(2014, 0, 1) + i * 36e5 * 10), name: 'Sortie numéro ' + i,
        sport: ['run', 'velo', 'nat'][i % 3], elapsed: 3600, distance_m: 10000, elevation: 50, hrAvg: 140, hrMax: 170, kcal: 500 });
      const plan = TS.planStravaArchive(acts);
      TS.applyStravaArchive(plan);
      return { dropped: plan.dropped, added: plan.add.length, bytes: TS.dataBytes(TS.getData()), max: TS.DATA_MAX_BYTES,
        newest: plan.add[0].date, oldest: plan.oldestKept };
    });
    await v.ctx.close();
    assert(r.dropped > 0 && r.bytes <= r.max && r.newest > r.oldest, JSON.stringify(r));
    return `${r.added} ajoutées, ${r.dropped} trop anciennes, ${Math.round(r.bytes / 1024)} Ko`;
  });

  await test('Import groupé : un seul envoi au cloud à la fois', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(800);
    const n = await v.page.evaluate(async () => {
      let sets = 0;
      const fs = firebase.firestore;
      firebase.firestore = () => { const db = fs(); return { collection: (c) => ({ doc: (id) => { const d = db.collection(c).doc(id);
        return { ...d, set: (...a) => { sets++; return new Promise(r => setTimeout(r, 50)).then(() => d.set(...a)); } }; } }) }; };
      firebase.firestore.FieldValue = fs.FieldValue;
      for (let i = 0; i < 40; i++) TS.saveSession({ date: '2026-08-01', sport: 'run', duration: 0.5, distance: 5 });
      await new Promise(r => setTimeout(r, 400));
      return { sets, cloud: JSON.parse(localStorage.getItem('__fb')).docs.testeur.data.sessions.length };
    });
    await v.ctx.close();
    assert(n.sets <= 3 && n.cloud === 80, `${n.sets} envois, ${n.cloud} séances dans le cloud (80 attendues)`);
  });

  await test('Strava : « Récupérer tout l’historique » montre un aperçu avant d’importer', async () => {
    const v = await stravaUser();
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(600);
    await v.page.evaluate(() => { const d = TS.getData();
      d.strava = { access_token: 'acces-1', refresh_token: 'r', expires_at: Date.now() / 1000 + 9999, after: Date.now() / 1000 }; TS.saveData(d); });
    await v.page.waitForTimeout(200);
    await v.page.click('text=Récupérer tout l’historique');
    await v.page.waitForSelector('#archiveResult button.btn--primary', { timeout: 8000 });
    const summary = await v.page.textContent('#archiveResult');
    const before = await v.page.evaluate(() => TS.getData().sessions.length);
    await v.page.click('#archiveResult button.btn--primary');
    await v.page.waitForTimeout(300);
    const after = await v.page.evaluate(() => TS.getData().sessions);
    await v.ctx.close();
    assert(!v.errors.length, 'erreur JavaScript : ' + v.errors[0]);
    assert(summary.includes('3 activités sur ton compte Strava') && summary.includes('1 séance à ajouter'), 'aperçu : ' + summary.replace(/\s+/g, ' ').slice(0, 200));
    assert(before === 40, `${before} séances avant validation : rien ne doit être importé avant le clic`);
    assert(after.length === 41 && after.find(s => s.strava_id === 502).date === day(-2) && after.find(s => s.id === 's1').strava_id === 501,
      `${after.length} séances après validation`);
  });

  await test('Serveur TriSeason : site non autorisé refusé, clé secrète jamais renvoyée', async () => {
    const { default: worker } = await import('../server/worker.js');
    const env = { STRAVA_CLIENT_ID: '12345', STRAVA_CLIENT_SECRET: 'SECRET-XYZ', ALLOWED_ORIGIN: 'https://site.test' };
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: init && init.body });
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, athlete: { id: 1, firstname: 'X', email: 'x@y.z' } }), { status: 200 }); };
    try {
      const req = (origin) => new Request('https://w.test/strava/token', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'c' }) });
      const bad = await worker.fetch(req('https://pirate.test'), env);
      const sentByBad = sent.length;
      const good = await worker.fetch(req('https://site.test'), env);
      const text = await good.text();
      assert(bad.status === 403 && !sentByBad, 'site pirate : ' + bad.status);
      assert(good.status === 200 && good.headers.get('Access-Control-Allow-Origin') === 'https://site.test', 'site autorisé : ' + good.status);
      assert(!text.includes('SECRET') && !text.includes('email'), 'réponse : ' + text);
      assert(sent[0].url === 'https://www.strava.com/oauth/token' && JSON.parse(sent[0].body).client_secret === 'SECRET-XYZ', 'appel Strava : ' + JSON.stringify(sent[0]));
    } finally { globalThis.fetch = realFetch; }
  });

  // 5. Données personnelles
  await test('RGPD : déconnexion → plus aucune donnée dans le navigateur', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(600);
    v.setUid(null);
    await Promise.all([v.page.waitForURL(/login\.html/), v.page.evaluate(() => window.TS_logout())]);
    const left = await v.page.evaluate(() => [localStorage.getItem('triseason_data'), localStorage.getItem('triseason_owner')]);
    await v.ctx.close();
    assert(!left[0] && !left[1], 'données restantes');
  });
  await test('RGPD : un autre compte sur le même appareil ne récupère pas les données', async () => {
    const v = await newUser();
    v.setUid('autre');
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => ({ n: TS.getData().sessions.length, cloud: (JSON.parse(localStorage.getItem('__fb')).docs.autre || {}).data }));
    await v.ctx.close();
    assert(r.n === 0, `${r.n} séances de l’ancien compte visibles`);
    assert(!r.cloud || !(r.cloud.sessions || []).length, 'données de l’ancien compte envoyées dans le nouveau compte');
  });
  await test('RGPD : fenêtre d’accord pour un compte sans consentement', async () => {
    const v = await newUser({ consent: false });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const shown = await v.page.locator('#consentGate').isVisible();
    await v.ctx.close();
    assert(shown, 'fenêtre non affichée');
  });

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok);
  const summary = { date: new Date().toISOString(), total: results.length, passed: results.length - failed.length, failed: failed.length, results };
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results.json'), JSON.stringify(summary, null, 2));
  console.log(toMarkdown(summary));
  process.exit(failed.length ? 1 : 0);
}

export function toMarkdown(s) {
  const lines = [s.failed
    ? `**${s.failed} test${s.failed > 1 ? 's' : ''} en échec** sur ${s.total}`
    : `**Tous les tests passent** (${s.total}/${s.total})`];
  s.results.filter(r => !r.ok).forEach(r => lines.push(`- ÉCHEC — ${r.name} : ${r.detail}`));
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Les tests n’ont pas pu tourner :', e.message); process.exit(2); });
}
