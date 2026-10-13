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
    await v.ctx.route(/openfoodfacts\.org/, r => {
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
    assert(asked.length === 2 && asked[1].includes('/api/v2/product/3017620422003'), 'requêtes : ' + asked.join(' | '));
    return 'recherche, code-barres et enregistrement';
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
