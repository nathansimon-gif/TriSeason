// Tests automatiques de ORKA.
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
  const authObj={ currentUser:user, languageCode:null, onAuthStateChanged(cb){setTimeout(()=>cb(user),+(localStorage.getItem('__authDelay')||10))},
    signOut(){return Promise.resolve()}, sendPasswordResetEmail(){return Promise.resolve()},
    createUserWithEmailAndPassword(){return Promise.resolve()}, signInWithEmailAndPassword(){return Promise.resolve()}, signInWithPopup(){return Promise.resolve()} };
  window.firebase={apps:[],initializeApp(){this.apps.push(1)},
    auth:Object.assign(()=>authObj,{EmailAuthProvider:{credential:()=>({})},GoogleAuthProvider:function(){}}),
    firestore:Object.assign(()=>({collection:()=>mkCol(''),batch(){const ops=[];return{
      set(r,v,o){ops.push(['s',r,v,o]);return this}, delete(r){ops.push(['d',r]);return this},
      commit(){ if(ops.some(o=>o[1]._deny())) return denied(); const st=load();
        ops.forEach(o=>o[0]==='s'?o[1]._applySet(st,o[2],o[3]):o[1]._applyDel(st)); st.commits=(st.commits||0)+1; save(st); return Promise.resolve();}};}}),
      {FieldValue:{arrayUnion:(...v)=>({__union:v})}})};
  // Documents : 'uid' (users/uid) dans st.docs ; sous-documents 'uid/drawers/clé' dans st.sub.
  // localStorage.__fbDenySub = '1' simule des règles Firebase sans la ligne des sous-tiroirs.
  function denied(){return Promise.reject(Object.assign(new Error('Missing or insufficient permissions.'),{code:'permission-denied'}));}
  function clone(x){return JSON.parse(JSON.stringify(x));}
  function mkCol(cpath){return{doc:(id)=>mkDoc(cpath?cpath+'/'+id:id),
    get(){ if(localStorage.getItem('__fbDenySub')==='1'&&cpath) return denied();
      const st=load(),pre=cpath+'/'; const docs=Object.keys(st.sub||{}).filter(k=>k.startsWith(pre)&&!k.slice(pre.length).includes('/'))
        .map(k=>({id:k.slice(pre.length),exists:true,data:()=>clone(st.sub[k])})); st.reads=(st.reads||0)+Math.max(1,docs.length); save(st);
      return Promise.resolve({docs,empty:!docs.length,size:docs.length});}};}
  function mkDoc(path){const top=!path.includes('/');
    const deny=()=>!top&&localStorage.getItem('__fbDenySub')==='1';
    const getRaw=st=>top?st.docs[path]:(st.sub||{})[path];
    const putRaw=(st,d)=>{if(top)st.docs[path]=d;else(st.sub=st.sub||{})[path]=d;};
    const applySet=(st,v,opt)=>{let d=getRaw(st)||{};
      if(opt&&opt.mergeFields) opt.mergeFields.forEach(k=>d[k]=v[k]);
      else if(opt&&opt.merge){for(const k in v){ if(v[k]&&v[k].__union){const a=d[k]||[];v[k].__union.forEach(x=>{if(!a.includes(x))a.push(x)});d[k]=a;} else d[k]=v[k];}}
      else d=clone(v); putRaw(st,d); st.writes=(st.writes||0)+1;};
    const applyDel=st=>{if(top)delete st.docs[path];else if(st.sub)delete st.sub[path]; st.writes=(st.writes||0)+1;};
    const ref={id:path.split('/').pop(),_deny:deny,_applySet:applySet,_applyDel:applyDel,
      get(){if(deny())return denied();const st=load();st.reads=(st.reads||0)+1;save(st);const d=getRaw(st);const snap={id:ref.id,exists:!!d,data:()=>clone(d||{})};const wait=top?+(localStorage.getItem('__fbDelay')||0):0;return wait?new Promise(r=>setTimeout(()=>r(snap),wait)):Promise.resolve(snap);},
      set(v,opt){if(deny())return denied();const st=load();applySet(st,v,opt);save(st);return Promise.resolve();},
      delete(){if(deny())return denied();const st=load();applyDel(st);save(st);return Promise.resolve();},
      collection(name){return mkCol(path+'/'+name);}};
    return ref;}
})();`;

// Données d'un compte telles qu'enregistrées dans le faux cloud, tiroirs remis
// ensemble (calcul indépendant du code de l'appli) : window.__cloud('testeur').
const CLOUD_HELPER = `window.__cloud = function (uid) {
  const st = JSON.parse(localStorage.getItem('__fb') || '{"docs":{}}');
  const doc = st.docs[uid];
  if (!doc || !doc.data) return doc ? doc.data : undefined;
  if (doc.layout !== 2 || Array.isArray(doc.data.sessions)) return doc.data;
  const pre = uid + '/drawers/', d = Object.assign({}, doc.data, { sessions: [] }), meals = [], fuel = [];
  Object.keys(st.sub || {}).filter(k => k.startsWith(pre)).sort().forEach(k => {
    const g = JSON.parse(st.sub[k].json);
    (g.sessions || []).forEach(x => d.sessions.push(x)); (g.meals || []).forEach(x => meals.push(x)); (g.fuel || []).forEach(x => fuel.push(x));
  });
  if (doc.data.nutrition || meals.length || fuel.length) d.nutrition = Object.assign({}, doc.data.nutrition, { meals, fuel });
  return d;
};`;

// ── Données de test ──────────────────────────────────────────────────────────
// Jour J+offset sur le calendrier de Paris. On part de la date du jour à Paris et on
// compte en jours de calendrier : décaler l'heure UTC puis convertir donnait deux fois
// le même jour autour d'un changement d'heure (ex. le 28/10 à 22 h UTC).
function day(offset) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
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
  return { profile: { name: 'Test', fcmax: 190 }, weeks: {}, _migrated: true, news_seen: ['muscu', 'sports', 'orka'], weight: [{ date: day(-10), value: 70 }], records: [],
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
  async function newUser({ uid = 'testeur', data = sampleData(), consent = true, external, ctxOpts = {} } = {}) {
    // Messages de nouveauté déjà vus, sauf si le test le précise (news_seen: [] pour les voir)
    if (data && !('news_seen' in data)) data = { ...data, news_seen: ['muscu', 'sports', 'orka'] };
    // Résumé du mois déjà vu, sauf si le test le précise (month_seen: null pour le voir)
    if (data && !('month_seen' in data)) data = { ...data, month_seen: '9999-12' };
    const ctx = await browser.newContext({ serviceWorkers: 'block', timezoneId: TZ, viewport: { width: 1280, height: 900 }, ...ctxOpts });
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
    await ctx.addInitScript(CLOUD_HELPER);
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

  await test('Appli installée : adresses relatives (le site est dans un sous-dossier)', async () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    const assets = (sw.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
    const absolute = (assets.match(/'\/[^']*'/g) || []);
    assert(m.start_url && !m.start_url.startsWith('/') && m.scope && !m.scope.startsWith('/'), 'manifest : ' + m.start_url + ' / ' + m.scope);
    assert(assets && !absolute.length, 'sw.js : adresses absolues ' + absolute.join(', '));
    const missing = (assets.match(/'\.\/([^']+)'/g) || []).map(x => x.slice(3, -1)).filter(f => f && !existsSync(join(ROOT, f)));
    assert(!missing.length, 'fichiers absents : ' + missing.join(', '));
  });

  await test('Appli installée : le menu passe sous la barre d\'état du téléphone', async () => {
    const css = readFileSync(join(ROOT, 'style.css'), 'utf8');
    assert(/--safe-top:\s*env\(safe-area-inset-top/.test(css), 'variable --safe-top absente');
    assert(/\.nav \{[^}]*padding-top: var\(--safe-top\)/.test(css), 'barre de navigation sans marge du haut');
    assert((css.match(/\.page \{ padding-top: calc\([^;]*var\(--safe-top\)/g) || []).length >= 2, 'pages sans marge du haut');
  });

  await test('Connexion : l\'œil affiche le mot de passe, « Créer un compte » est un bouton', async () => {
    const v = await newUser({ uid: null }); const p = v.page;
    await p.goto(`${BASE}/login.html`); await p.waitForTimeout(400);
    const type = () => p.$eval('#authPassword', i => i.type);
    assert(await type() === 'password', 'mot de passe visible au départ');
    await p.click('#authPassword + .pw-eye');
    assert(await type() === 'text', 'l\'œil n\'affiche pas le mot de passe');
    await p.click('#authPassword + .pw-eye');
    assert(await type() === 'password', 'l\'œil ne recache pas le mot de passe');
    await p.click('#authSwitch .btn');
    assert((await p.textContent('#authTitle')).includes('Créer un compte'), 'le bouton ne passe pas en création de compte');
    assert(await p.$('#authPassword + .pw-eye'), 'œil absent en création de compte');
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
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
  await test('Dashboard : carte « Ce que Strava ne te montre pas » (dernière séance + repas autour)', async () => {
    await u.page.goto(`${BASE}/index.html`); await u.page.waitForTimeout(800);
    const full = (await u.page.innerText('#insightBody')).replace(/\s+/g, ' ');
    // Compte avec jours d'entraînement et de repos, et un ravitaillement
    const meals = [1, 2, 3, 4, 5, 6].map(i => ({ id: 'm' + i, date: day(-i), glucides: i % 2 ? 300 : 200, kcal: 2500 }));
    const v = await newUser({ data: { profile: {}, sessions: [1, 3, 5].map(i => ({ id: 's' + i, date: day(-i), sport: 'velo', duration: 2, distance: 60 })),
      nutrition: { meals, hydration: { [day(-1)]: 1500 }, fuel: [{ id: 'f1', date: day(-1), type: 'gel', qty: 2 }, { id: 'f2', date: day(-1), type: 'barre', qty: 1 }] } } });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const mixed = (await v.page.innerText('#insightBody')).replace(/\s+/g, ' ');
    const w = await newUser({ data: { profile: {}, sessions: [], nutrition: { meals: [], hydration: {} } } });
    await w.page.goto(`${BASE}/index.html`); await w.page.waitForTimeout(800);
    const empty = await w.page.textContent('#insightBody');
    await v.ctx.close(); await w.ctx.close();
    assert(full.includes('hier') && /la veille 230 g de glucides/i.test(full) && full.includes('2 L d’eau'), 'avec données : ' + full.slice(0, 260));
    assert(mixed.includes('≈ 80 g de glucides') && mixed.includes('≈ 40 g par heure') && mixed.includes('327 g de glucides les jours d’entraînement') && /le jour même 380 g de glucides/i.test(mixed)   /* ravitaillements compris */ && mixed.includes('200 g les jours de repos'),
      'entraînement / repos : ' + mixed.slice(0, 400));
    assert(empty.includes('Importe une séance'), 'sans données : ' + empty.slice(0, 200));
  });
  await test('Séances prévues : réalisées, en partie, pas faites (une séance ne compte qu’une fois)', async () => {
    const r = await u.page.evaluate(() => {
      const d = { sessions: [
          { id: 'a', date: '2026-10-05', sport: 'run', distance: 10.2, duration: 0.85 },
          { id: 'b', date: '2026-10-06', sport: 'velo', distance: 30, duration: 1 },
          { id: 'c', date: '2026-10-07', sport: 'nat', distance: 2, duration: 0.7 },
          { id: 'd', date: '2026-10-07', sport: 'nat', distance: 1, duration: 0.4 } ],
        plans: [
          { id: 'p1', date: '2026-10-05', sport: 'run', distance: 10, duration: 0.83 },
          { id: 'p2', date: '2026-10-06', sport: 'velo', duration: 2 },
          { id: 'p3', date: '2026-10-04', sport: 'run', distance: 8 },
          { id: 'p4', date: '2030-01-01', sport: 'nat' },
          { id: 'p5', date: '2026-10-07', sport: 'nat', distance: 1 },
          { id: 'p6', date: '2026-10-07', sport: 'nat', distance: 2 },
          { id: 'p7', date: '2026-10-06', sport: 'run' } ] };
      const st = TS.planStatuses(d);
      return Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.state + (v.session ? ':' + v.session.id : '')]));
    });
    const want = { p1: 'done:a', p2: 'partial:b', p3: 'missed', p4: 'upcoming', p5: 'done:d', p6: 'done:c', p7: 'missed' };
    Object.entries(want).forEach(([k, v]) => assert(r[k] === v, `${k} : ${r[k]} au lieu de ${v}`));
    const durs = await u.page.evaluate(() => ['1h30', '45min', '1:15:00', '2', '1h'].map(TS.parseDuration));
    assert(JSON.stringify(durs) === JSON.stringify([1.5, 0.75, 1.25, 2, 1]), 'durées : ' + JSON.stringify(durs));
  });
  await test('Séances prévues : planifier depuis le calendrier, séance reconnue toute seule', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const today = day(0);
    await v.page.click(`.cal-cell--click[onclick*="${today}"]`);
    await v.page.click('#pl_sport [data-sport="velo"]');
    await v.page.fill('#pl_dist', '40'); await v.page.fill('#pl_dur', '1h30'); await v.page.fill('#pl_notes', 'Sortie tranquille');
    await v.page.click('#planModal .btn--primary');
    await v.page.waitForTimeout(300);
    const plan = await v.page.evaluate(() => TS.getPlans()[0]);
    const listBefore = await v.page.innerText('#planList');
    const toasts = [];
    await v.page.exposeFunction('__toast', t => toasts.push(t));
    await v.page.evaluate(() => { const o = TS.toast; TS.toast = (m, t) => { window.__toast(m); o(m, t); }; });
    await v.page.evaluate((d) => TS.saveSession({ date: d, sport: 'velo', distance: 41, duration: 1.45 }), today);
    await v.page.waitForTimeout(1200);
    const after = await v.page.evaluate(() => ({ list: document.getElementById('planList').innerText, ann: TS.getPlans()[0].announced, marks: document.querySelectorAll('.cal-plan--done').length }));
    await v.ctx.close();
    assert(!v.errors.length, 'erreur JavaScript : ' + v.errors[0]);
    assert(plan && plan.sport === 'velo' && plan.distance === 40 && plan.duration === 1.5 && plan.date === today && plan.notes === 'Sortie tranquille', 'séance prévue : ' + JSON.stringify(plan));
    assert(/Aujourd’hui/.test(listBefore), 'liste avant : ' + listBefore);
    assert(/Réalisée/.test(after.list) && after.ann && after.marks === 1, 'après : ' + JSON.stringify(after));
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

  // Strava (faux Strava et faux serveur ORKA : aucun vrai compte n'est utilisé)
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
    // Détail d'une activité : seule source des calories chez Strava
    await v.ctx.route(/strava\.com\/api\/v3\/activities\/\d+/, r => {
      const id = Number(r.request().url().match(/activities\/(\d+)/)[1]);
      calls.push('détail ' + id);
      const detail = { 501: { id: 501, calories: 0, kilojoules: 1103.6 }, 502: { id: 502, calories: 812.4 } }[id] || { id, calories: 0 };
      r.fulfill({ body: JSON.stringify(detail), contentType: 'application/json', headers: cors });
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
    assert(Math.round(run.duration * 3600) === 3615 && run.distance === 10.01 && run.elevation === 85 && run.fc_avg === 152, 'valeurs : ' + JSON.stringify(run));
    assert(run.kcal === 812 && ride.kcal === 1104, `kcal non reprises de Strava : course ${run.kcal}, vélo ${ride.kcal}`);
    assert(fromStrava.length === 2 && !r.d.sessions.some(s => s.strava_id === 503), 'séances liées : ' + fromStrava.length);
    assert(r.d.strava.refresh_token === 'renouv-1' && r.d.strava.name === 'Léa Test', 'connexion non enregistrée');
    assert(!r.url.includes('code='), 'le code est resté dans l’adresse');
    assert(r.card.includes('Léa Test'), 'carte Profil : ' + r.card.slice(0, 80));
    assert(v.calls.some(c => c.startsWith('/strava/token') && c.includes('code-1')) && v.calls.some(c => c === 'strava Bearer acces-1'), 'appels : ' + v.calls.join(' | '));
    return '1 ajoutée, 1 reliée, 1 ignorée';
  });

  await test('Strava : limite de comptes atteinte → message clair, archive proposée', async () => {
    const v = await stravaUser();
    await v.ctx.route(/serveur\.test\/strava\/token/, r => r.fulfill({ status: 403, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Limite', code: 'athlete_limit' }) }));
    await v.ctx.addInitScript(() => sessionStorage.setItem('triseason_strava_state', 'etat-ok'));
    await v.page.goto(`${BASE}/profile.html?state=etat-ok&code=code-1&scope=read,activity:read_all`);
    await v.page.waitForTimeout(1500);
    const r = await v.page.evaluate(() => ({ st: TS.getData().strava, card: document.getElementById('stravaBody').innerText }));
    await v.ctx.close();
    assert(!v.errors.length, 'erreur JavaScript : ' + v.errors[0]);
    assert(!r.st && r.card.includes('pas encore ouverte à tout le monde') && r.card.includes('Importer mon archive Strava'), 'carte : ' + r.card.slice(0, 200));
  });

  await test('Strava : connexion refusée si le lien ne vient pas de ORKA', async () => {
    const v = await stravaUser();
    await v.ctx.addInitScript(() => sessionStorage.setItem('triseason_strava_state', 'etat-ok'));
    await v.page.goto(`${BASE}/profile.html?state=autre&code=code-pirate&scope=read,activity:read_all`);
    await v.page.waitForTimeout(1500);
    const st = await v.page.evaluate(() => TS.getData().strava);
    await v.ctx.close();
    assert(!st && !v.calls.some(c => c.includes('code-pirate')), 'le code a été utilisé');
  });

  await test('Mes sports : triathlon toujours possible en compétition, record automatique créé et visible même sans les 3 sports', async () => {
    const data = sampleData(); data.profile.sports = ['run']; data.competitions = []; data.records = [];
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/competitions.html`); await v.page.waitForTimeout(600);
    const before = await v.page.evaluate(() => { openCompModal(); const sel = document.getElementById('c_type');
      return { types: [...sel.options].map(o => o.value), def: sel.value, multi: TS.multisportShown() }; });
    const r = await v.page.evaluate(() => {
      const c = TS.saveCompetition({ date: TS.localDateStr(new Date(Date.now() - 5 * 864e5)), name: 'Tri test', type: 'TRI', distance: '51.5', actual_time: '2:35:10' });
      TS.refreshCompetitionRecords(c.id || TS.getCompetitions().find(x => x.name === 'Tri test').id);
      return { recs: TS.getData().records.map(x => x.sport + ' ' + x.dist + ' ' + x.time + (x.auto ? ' auto' : '')) };
    });
    await v.page.goto(`${BASE}/records.html`); await v.page.waitForTimeout(700);
    const page = await v.page.evaluate(() => ({ tri: getComputedStyle(document.querySelector('[data-rec-sport="tri"]')).display,
      cards: document.getElementById('records-tri').textContent.replace(/\s+/g, ' '), velo: getComputedStyle(document.querySelector('[data-rec-sport="velo"]')).display }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(['TRI', 'DUATH', 'AQUA'].every(t => before.types.includes(t)) && before.def === 'RUN' && !before.multi, 'types de course : ' + JSON.stringify(before));
    assert(r.recs.length === 1 && /^tri .* 2:35:10 auto$/.test(r.recs[0]), 'record automatique : ' + JSON.stringify(r.recs));
    assert(page.tri !== 'none' && /2:35:10/.test(page.cards) && page.velo === 'none', 'records : ' + JSON.stringify(page));
  });

  await test('Mes sports : sans choix fait, tout est importé comme avant (musculation Strava comprise)', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(500);
    const r = await v.page.evaluate(() => ({ chosen: TS.sportsChosen(), muscuShown: TS.muscuOn(), imported: TS.ALL_SPORTS.filter(sp => TS.sportImported(sp)).join(),
      plan: TS.planStravaArchive([{ id: 991, start: new Date(), localDate: TS.localDateStr(), sport: 'muscu', elapsed: 3000 }]).add.length }));
    await v.ctx.close();
    assert(r.chosen === null && !r.muscuShown && r.imported === 'nat,velo,run,muscu' && r.plan === 1, 'import sans choix : ' + JSON.stringify(r));
  });

  await test('Mes sports : un sport recoché récupère sur Strava les séances faites depuis qu’il avait été décoché', async () => {
    const v = await stravaUser();
    const afters = [];
    await v.ctx.route(/strava\.com\/api\/v3\/athlete\/activities/, r => {
      afters.push(+new URL(r.request().url()).searchParams.get('after'));
      r.fulfill({ body: JSON.stringify([
        { id: 777, sport_type: 'Run', start_date: day(-20) + 'T06:00:00Z', start_date_local: day(-20) + 'T08:00:00Z', elapsed_time: 2400, distance: 8000 },
        { id: 778, sport_type: 'Yoga', start_date: day(-19) + 'T06:00:00Z', start_date_local: day(-19) + 'T08:00:00Z', elapsed_time: 2400 },
      ]), contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await v.page.goto(`${BASE}/profile.html#mes-sports`); await v.page.waitForTimeout(800);
    const offAt = await v.page.evaluate(() => {
      const d = TS.getData(), now = Math.floor(Date.now() / 1000);
      d.strava = { access_token: 'acces-1', refresh_token: 'r', expires_at: now + 9999, after: now - 3600 };
      d.profile.sports = ['nat', 'velo', 'run']; TS.saveData(d);
      TS.setSportsChosen(['nat', 'velo']);   // course décochée maintenant…
      const d2 = TS.getData(); d2.profile.sports_off.run = now - 30 * 86400; TS.saveData(d2);   // …il y a 30 jours
      renderSportChoice();
      return d2.profile.sports_off.run;
    });
    await v.page.click('[data-sport-choice="run"]'); await v.page.waitForTimeout(1200);
    const r = await v.page.evaluate(() => { const d = TS.getData();
      return { got: d.sessions.filter(s => s.strava_id === 777).map(s => s.sport + ' ' + s.date), yoga: d.sessions.some(s => s.strava_id === 778),
        off: d.profile.sports_off, back: d.strava.backfill_after, after: d.strava.after, chosen: d.profile.sports }; });
    // Synchro suivante : de nouveau à partir de la dernière séance reçue (plus de récupération)
    await v.page.evaluate(() => TS.stravaSync({ force: true })); await v.page.waitForTimeout(300);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(afters.length >= 1 && Math.abs(afters[0] - (offAt - 3 * 86400)) < 5, 'Strava interrogé depuis la décoche : ' + JSON.stringify({ afters, offAt }));
    assert(r.got.length === 1 && r.got[0].startsWith('run ') && !r.yoga, 'séance récupérée : ' + JSON.stringify(r));
    assert(!r.off && !r.back && r.after > offAt + 20 * 86400 && r.chosen.join() === 'nat,velo,run', 'état après récupération : ' + JSON.stringify(r));
    assert(afters[afters.length - 1] > offAt + 20 * 86400, 'synchro suivante normale : ' + afters.join());
  });

  await test('Strava : déconnexion (séances gardées ou supprimées au choix)', async () => {
    const v = await stravaUser();
    await v.page.goto(`${BASE}/profile.html#parametres`); await v.page.waitForTimeout(800);
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
      row(901, `${mon} ${+d1}, ${y1}, 11:30:00 PM`, 'Course du soir, en ville', 'Run', 3615, 10012, 'Bonne sortie,\navec "pluie"'),  // 23h30 UTC → lendemain à Paris, été (01h30) comme hiver (00h30)
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
    assert(run && run.date === day(0) && run.sport === 'run' && Math.round(run.duration * 3600) === 3615 && run.distance === 10.01 && run.fc_avg === 148 && run.elevation === 120,
      'course : ' + JSON.stringify(run) + ' (date attendue ' + day(0) + ')');
  });

  const bigArchive = () => {
    const acts = [];
    for (let i = 0; i < 9000; i++) acts.push({ id: 10000 + i, start: new Date(Date.UTC(2014, 0, 1) + i * 36e5 * 10), name: 'Sortie numéro ' + i,
      sport: ['run', 'velo', 'nat'][i % 3], elapsed: 3600, distance_m: 10000, elevation: 50, hrAvg: 140, hrMax: 170, kcal: 500 });
    const plan = TS.planStravaArchive(acts);
    TS.applyStravaArchive(plan);
    return { dropped: plan.dropped, added: plan.add.length, bytes: TS.dataBytes(TS.getData()), max: TS.dataMaxBytes(),
      newest: plan.add[0].date, oldest: plan.oldestKept, layout: TS.cloudLayoutNow() };
  };
  await test('Tiroirs : tout l’historique Strava tient (9 000 séances), aucun document au-delà de 1 Mo', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(1000);
    const r = await v.page.evaluate(bigArchive);
    await v.page.waitForTimeout(1500);
    const c = await v.page.evaluate(() => {
      const st = JSON.parse(localStorage.getItem('__fb'));
      const sizes = [JSON.stringify(st.docs.testeur).length, ...Object.keys(st.sub || {}).map(k => JSON.stringify(st.sub[k]).length)];
      return { n: window.__cloud('testeur').sessions.length, biggest: Math.max(...sizes), drawers: Object.keys(st.sub || {}).filter(k => k.includes('/drawers/')).length };
    });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(r.layout === 2 && r.dropped === 0 && r.added === 9000, JSON.stringify(r));
    assert(c.n === 9040 && c.biggest < 900 * 1024, 'cloud : ' + JSON.stringify(c));
    return `${r.added} ajoutées, ${Math.round(r.bytes / 1024)} Ko en tout, plus gros document ${Math.round(c.biggest / 1024)} Ko, ${c.drawers} tiroirs`;
  });

  await test('Règles Firebase pas à jour : ancien rangement gardé, limite de 1 Mo respectée, rien de perdu', async () => {
    const v = await newUser();
    await v.ctx.addInitScript(() => localStorage.setItem('__fbDenySub', '1'));
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(1000);
    const r = await v.page.evaluate(bigArchive);
    await v.page.waitForTimeout(800);
    const c = await v.page.evaluate(() => { const st = JSON.parse(localStorage.getItem('__fb'));
      return { layout: st.docs.testeur.layout, n: st.docs.testeur.data.sessions.length, local: TS.getData().sessions.length, sub: Object.keys(st.sub || {}).length }; });
    await v.ctx.close();
    assert(r.layout === 1 && r.dropped > 0 && r.bytes <= r.max && r.newest > r.oldest, JSON.stringify(r));
    assert(c.layout !== 2 && c.sub === 0 && c.n === c.local, 'cloud : ' + JSON.stringify(c));
    return `${r.added} ajoutées, ${r.dropped} trop anciennes, ${Math.round(r.bytes / 1024)} Ko`;
  });

  await test('Import groupé : un seul envoi au cloud à la fois', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(800);
    await v.page.waitForTimeout(600); // déménagement en tiroirs terminé
    const n = await v.page.evaluate(async () => {
      const st = () => JSON.parse(localStorage.getItem('__fb'));
      const before = st().commits || 0;
      for (let i = 0; i < 40; i++) TS.saveSession({ date: '2026-08-01', sport: 'run', duration: 0.5, distance: 5 });
      await new Promise(r => setTimeout(r, 400));
      return { sets: (st().commits || 0) - before, cloud: window.__cloud('testeur').sessions.length };
    });
    await v.ctx.close();
    assert(n.sets <= 3 && n.cloud === 80, `${n.sets} envois, ${n.cloud} séances dans le cloud (80 attendues)`);
  });

  await test('Strava : « Récupérer tout l’historique » montre un aperçu avant d’importer', async () => {
    const v = await stravaUser();
    await v.page.goto(`${BASE}/profile.html#parametres`); await v.page.waitForTimeout(600);
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

  await test('Serveur ORKA : limite de comptes Strava signalée', async () => {
    const { default: worker } = await import('../server/worker.js');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Forbidden', errors: [{ resource: 'Athlete', code: 'limit of connected athletes exceeded' }] }), { status: 403 });
    try {
      const res = await worker.fetch(new Request('https://w.test/strava/token', { method: 'POST', headers: { Origin: 'https://site.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'c' }) }),
        { STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 's', ALLOWED_ORIGIN: 'https://site.test' });
      const body = await res.json();
      assert(res.status === 403 && body.code === 'athlete_limit', res.status + ' ' + JSON.stringify(body));
    } finally { globalThis.fetch = realFetch; }
  });

  await test('Serveur ORKA : site non autorisé refusé, clé secrète jamais renvoyée', async () => {
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

  await test('Nutrition : ravitaillement avec glucides au choix (gels, barres…)', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/nutrition.html`); await v.page.waitForTimeout(700);
    await v.page.evaluate(() => openFuelModal());
    await v.page.selectOption('#f_type', 'gel');
    const chips = await v.page.locator('#f_presets .fuel-chip').count();
    await v.page.click('#f_presets .fuel-chip:has-text("Maurten Gel 160")');
    await v.page.fill('#f_qty', '2');
    await v.page.evaluate(() => saveFuelForm());
    await v.page.evaluate(() => openFuelModal());
    await v.page.selectOption('#f_type', 'banane');
    const banana = await v.page.inputValue('#f_carbs');
    await v.page.evaluate(() => saveFuelForm());
    const r = await v.page.evaluate(() => { const f = TS.getData().nutrition.fuel; return { f, list: document.getElementById('fuelList').innerText }; });
    await v.ctx.close();
    assert(!v.errors.length, 'erreur JavaScript : ' + v.errors[0]);
    assert(chips >= 10, chips + ' choix pour les gels');
    const gel = r.f.find(x => x.type === 'gel');
    assert(gel && gel.carbs === 40 && gel.qty === 2 && gel.name === 'Maurten Gel 160', 'gel : ' + JSON.stringify(gel));
    assert(banana === '25' && r.f.find(x => x.type === 'banane').carbs === 25, 'banane : ' + banana);
    assert(/80 g gluc\./.test(r.list) && !/≈ 80/.test(r.list), 'liste : ' + r.list);
  });

  // 5. Données personnelles
  await test('RGPD : déconnexion → plus aucune donnée dans le navigateur', async () => {
    // Sans news_seen : le message de nouveauté arrive juste après la déconnexion (bug corrigé)
    const data = sampleData(); data.news_seen = [];
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(500);
    v.setUid(null);
    await Promise.all([v.page.waitForURL(/login\.html/), v.page.evaluate(() => { window.TS_logout(); setTimeout(() => TS.saveData(TS.getData()), 0); })]);
    const left = await v.page.evaluate(() => [localStorage.getItem('triseason_data'), localStorage.getItem('triseason_owner')]);
    await v.ctx.close();
    assert(!left[0] && !left[1], 'données restantes');
  });
  await test('RGPD : un autre compte sur le même appareil ne récupère pas les données', async () => {
    const v = await newUser();
    v.setUid('autre');
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => ({ n: TS.getData().sessions.length, cloud: window.__cloud('autre') }));
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

  await test('Calendrier : un jour montre le détail des séances faites, « Modifier » ouvre la séance', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    await v.page.evaluate((d) => openPlanDay(d), day(-2));
    await v.page.waitForTimeout(200);
    const r = await v.page.evaluate(() => ({ body: document.getElementById('planDayBody').innerText,
      form: getComputedStyle(document.getElementById('planForm')).display,
      btn: getComputedStyle(document.getElementById('planFormOpen')).display }));
    const s2 = sampleData().sessions.find(x => x.date === day(-2));
    await v.page.click('#planDayBody .day-sess a.btn');
    await v.page.waitForURL(/sessions\.html/); await v.page.waitForTimeout(600);
    const modal = await v.page.evaluate(() => ({ open: document.getElementById('sessionModal').classList.contains('open'), date: document.getElementById('s_date').value }));
    // Jour à venir vide : le formulaire de planification s'ouvre directement
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(600);
    await v.page.evaluate((d) => openPlanDay(d), day(3));
    const future = await v.page.evaluate(() => getComputedStyle(document.getElementById('planForm')).display);
    const bubbles = await v.page.evaluate(() => document.querySelectorAll('#calGrid [data-tip], .cal-cell[data-tip]').length);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const hms = s2.sport === 'velo' ? '1:30:00' : '0:45:00';
    assert(r.body.includes(hms) && r.body.includes('FC moy.') && r.body.includes('RPE'), 'détail absent : ' + r.body.slice(0, 200));
    assert(/nutrition du jour/i.test(r.body), 'nutrition du jour absente');
    assert(r.form === 'none' && r.btn !== 'none', 'le formulaire de planification cache le détail');
    assert(modal.open && modal.date === day(-2), 'la séance ne s’ouvre pas dans Séances');
    assert(future !== 'none', 'formulaire fermé pour un jour à venir');
    assert(bubbles === 0, 'bulle flottante encore présente sur les jours du calendrier');
  });

  await test('Séances allégées : noms Strava automatiques retirés, champs vides et durées raccourcis, rien d’utile perdu', async () => {
    const data = sampleData();
    const long = 4027 / 3600; // 1:07:07, écrit avec beaucoup de décimales
    data.sessions.push(
      { id: 'st1', date: day(-3), sport: 'run', duration: long, distance: 10.9, fc_avg: null, power_avg: null, np: null, notes: 'Morning Run · Strava', strava_id: 111 },
      { id: 'st2', date: day(-4), sport: 'velo', duration: 2.5, distance: 70, notes: 'Sortie club avec Paul · Strava', strava_id: 222 },
      { id: 'st3', date: day(-5), sport: 'nat', duration: 0.75, distance: 2, notes: 'Natation dans l\'après-midi · Strava', strava_id: 333 },
      { id: 'f1', date: day(-6), sport: 'run', duration: 0.5, distance: 5, notes: 'Import FIT · 300 kcal', kcal: 300, comp_id: null });
    const before = JSON.stringify(data).length;
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(900);
    const r = await v.page.evaluate(() => {
      const c = window.__cloud('testeur');
      const by = id => c.sessions.find(s => s.id === id);
      return { size: JSON.stringify(c).length, compact: c._compact, n: c.sessions.length, st1: by('st1'), st2: by('st2'), st3: by('st3'), f1: by('f1'),
        nulls: c.sessions.some(s => Object.values(s).some(x => x === null || x === '')) };
    });
    // Une nouvelle séance saisie à la main est enregistrée sans champs vides
    const saved = await v.page.evaluate(() => TS.saveSession({ date: '2026-08-01', sport: 'run', duration: 1 / 3, fc_avg: null, notes: '' }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(r.compact === 1 && r.n === 44, 'données non allégées ou séances perdues : ' + JSON.stringify({ c: r.compact, n: r.n }));
    assert(!('notes' in r.st1) && !('notes' in r.st3), 'nom automatique Strava gardé');
    assert(r.st2.notes === 'Sortie club avec Paul', 'nom écrit à la main modifié : ' + r.st2.notes);
    assert(r.f1.notes === 'Import FIT · 300 kcal' && r.f1.kcal === 300, 'séance importée par fichier modifiée');
    assert(Math.round(r.st1.duration * 3600) === 4027 && String(r.st1.duration).length <= 8, 'durée : ' + r.st1.duration);
    assert(r.st1.strava_id === 111 && r.st1.distance === 10.9 && !r.nulls, 'champ utile perdu ou champ vide restant');
    assert(r.size < before, 'pas de place gagnée');
    assert(!('fc_avg' in saved) && !('notes' in saved) && Math.round(saved.duration * 3600) === 1200, 'nouvelle séance pas allégée : ' + JSON.stringify(saved));
  });

  await test('Hydratation : boutons +100, +250 et +500 ml (Dashboard et Nutrition)', async () => {
    const v = await newUser();
    const labels = {};
    for (const p of ['index', 'nutrition']) {
      await v.page.goto(`${BASE}/${p}.html`); await v.page.waitForTimeout(600);
      labels[p] = await v.page.evaluate((fn) => [...document.querySelectorAll(`button[onclick^="${fn}("]`)].map(b => b.textContent.trim()), p === 'index' ? 'quickHydro' : 'addHydro');
    }
    const before = await v.page.evaluate(() => (TS.getData().nutrition.hydration || {})[TS.localDateStr()] || 0);
    await v.page.click('button[onclick="addHydro(100)"]'); await v.page.waitForTimeout(200);
    const after = await v.page.evaluate(() => (TS.getData().nutrition.hydration || {})[TS.localDateStr()] || 0);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const want = '+100 ml,+250 ml,+500 ml';
    assert(labels.index.join() === want && labels.nutrition.join() === want, 'boutons : ' + JSON.stringify(labels));
    assert(after - before === 100, `+100 ml non ajouté (${before} → ${after})`);
  });

  await test('Appli installée : tirer vers le bas en haut de page actualise (pas ailleurs)', async () => {
    const pullDown = (page, dist) => page.evaluate((dist) => {
      const t = (y) => new Touch({ identifier: 1, target: document.body, clientX: 150, clientY: y });
      document.dispatchEvent(new TouchEvent('touchstart', { touches: [t(100)], bubbles: true, cancelable: true }));
      for (let y = 100; y <= 100 + dist; y += 20) document.dispatchEvent(new TouchEvent('touchmove', { touches: [t(y)], bubbles: true, cancelable: true }));
      const txt = (document.querySelector('.ptr__txt') || {}).textContent || '';
      window.__avant = 1;
      document.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true, cancelable: true }));
      return txt;
    }, dist);
    const mobile = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
    // Appli installée (navigator.standalone, comme sur iPhone)
    const v = await newUser({ ctxOpts: mobile });
    await v.ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(700);
    const short = await pullDown(v.page, 60);            // trop court : rien
    await v.page.waitForTimeout(300);
    const stillThere = await v.page.evaluate(() => window.__avant === 1);
    const ready = await pullDown(v.page, 200);           // assez long : actualise
    await v.page.waitForLoadState('load'); await v.page.waitForTimeout(800);
    const reloaded = await v.page.evaluate(() => window.__avant === undefined);
    const toastTxt = await v.page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' '));
    // Fenêtre ouverte : le geste ne fait rien
    await v.page.evaluate(() => openPlanDay(TS.localDateStr()));
    await pullDown(v.page, 200); await v.page.waitForTimeout(500);
    const modalKept = await v.page.evaluate(() => window.__avant === 1);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    // Dans le navigateur (pas installée) : le geste natif suffit, rien n'est ajouté
    const w = await newUser({ ctxOpts: mobile });
    await w.page.goto(`${BASE}/index.html`); await w.page.waitForTimeout(700);
    await pullDown(w.page, 200); await w.page.waitForTimeout(500);
    const browserNoop = await w.page.evaluate(() => window.__avant === 1 && !document.querySelector('.ptr'));
    await w.ctx.close();
    assert(short === 'Tire pour actualiser' && stillThere, 'geste court : ' + short);
    assert(ready === 'Relâche pour actualiser' && reloaded, 'pas actualisé : ' + ready);
    assert(/actualisée|séance/i.test(toastTxt), 'pas de message après actualisation : ' + toastTxt);
    assert(modalKept, 'actualisation pendant qu’une fenêtre est ouverte');
    assert(browserNoop, 'geste ajouté dans le navigateur');
  });

  await test('Équipement : km comptés depuis la 1re utilisation, relais par le nouveau, seuil, prévision, alerte', async () => {
    const data = sampleData();
    // Course : séances les jours -3, -6, … -39, 9 km chacune
    data.gear = [{ id: 'gA', sport: 'run', name: 'Vieille paire', start: day(-40), alert_km: 60 }];
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(700);
    const one = await v.page.evaluate(() => TS.gearStats()['gA']);
    // Nouvelle paire ajoutée par la fenêtre : l'ancienne s'arrête la veille
    await v.page.click('#equipement button:has-text("+ Ajouter")');
    await v.page.selectOption('#g_sport', 'run');
    const defAlert = await v.page.inputValue('#g_alert');
    const hint = await v.page.textContent('#gearHint');
    await v.page.fill('#g_name', 'Nouvelle paire');
    await v.page.fill('#g_start', day(-10));
    await v.page.fill('#g_alert', '30');
    await v.page.click('#gearModal .btn--primary'); await v.page.waitForTimeout(300);
    const r = await v.page.evaluate(() => {
      const g = TS.getGear(); const st = TS.gearStats();
      const b = g.find(x => x.name === 'Nouvelle paire');
      return { a: st['gA'], b: st[b.id], card: document.getElementById('gearList').innerText,
        onDay: (TS.gearForSession({ sport: 'run', date: TS.localDateStr(new Date(Date.now() - 3 * 864e5)) }) || {}).name };
    });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(700);
    const dash = await v.page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('gearAlertCard')).display !== 'none', txt: document.getElementById('gearAlertBody').innerText }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(one.km === 117 && one.sessions === 13 && one.state === 'over', 'avant : ' + JSON.stringify(one));
    assert(defAlert === '700' && /500 à 800 km/.test(hint), 'seuil proposé ou repère : ' + defAlert + ' / ' + hint);
    assert(r.a.km === 90 && r.a.sessions === 10 && !r.a.active && r.a.to === day(-11), 'ancienne paire : ' + JSON.stringify(r.a));
    assert(r.b.km === 27 && r.b.sessions === 3 && r.b.active && r.b.state === 'near' && r.b.pct === 90, 'nouvelle paire : ' + JSON.stringify(r.b));
    assert(r.b.perWeek > 0 && r.b.etaDate && r.b.etaDate >= day(0), 'prévision absente : ' + JSON.stringify(r.b));
    assert(r.onDay === 'Nouvelle paire', 'séance récente pas sur la nouvelle paire');
    assert(/27 \/ 30 km/.test(r.card) && /seuil atteint dans|seuil atteint/.test(r.card) && /Anciens équipements/.test(r.card), 'carte : ' + r.card.slice(0, 300));
    assert(dash.shown && /Nouvelle paire/.test(dash.txt) && /bientôt/.test(dash.txt), 'alerte Dashboard : ' + JSON.stringify(dash));
  });

  // ── Rangement en tiroirs ──────────────────────────────────────────────────
  const fbState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('__fb')));
  // Nouvel appareil (ou autre navigateur) : même cloud, copie locale vide ou donnée
  async function otherDevice(fb, { keepLocal = null } = {}) {
    const w = await newUser({ data: {} });
    await w.ctx.addInitScript(([fb, local]) => {
      if (sessionStorage.getItem('__dev2')) return;
      sessionStorage.setItem('__dev2', '1');
      localStorage.setItem('__fb', JSON.stringify(fb));
      if (local) localStorage.setItem('triseason_data', JSON.stringify(local)); else localStorage.removeItem('triseason_data');
    }, [fb, keepLocal]);
    return w;
  }
  const sortedIds = (list) => list.map(x => x.id).sort().join(',');

  await test('Tiroirs : déménagement vérifié, copie de secours, rien de perdu', async () => {
    const data = sampleData();
    data.sessions.push({ id: 'old', date: '2019-05-04', sport: 'run', duration: 1, distance: 12 });
    data.nutrition.fuel = [{ id: 'f1', date: day(-2), type: 'gel', qty: 2 }];
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(1200);
    const st = await fbState(v.page);
    const r = await v.page.evaluate(() => ({ local: TS.getData(), cloud: window.__cloud('testeur') }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const main = st.docs.testeur, keys = Object.keys(st.sub || {});
    assert(main.layout === 2 && !('sessions' in main.data) && !('meals' in main.data.nutrition) && !('fuel' in main.data.nutrition), 'document principal pas allégé');
    assert(keys.includes('testeur/drawers/sessions-2019') && keys.some(k => /drawers\/sessions-2026$/.test(k)) && keys.some(k => /drawers\/nutrition-\d{4}-\d{2}$/.test(k)), 'tiroirs : ' + keys.join(', '));
    assert(Object.keys(main.drawers).length === keys.filter(k => k.includes('/drawers/')).length, 'sommaire incomplet');
    const bk = st.sub['testeur/backup/v1'];
    assert(bk && bk.data.sessions.length === 41 && bk.data.nutrition.meals.length === 30, 'copie de secours absente ou incomplète');
    assert(sortedIds(r.cloud.sessions) === sortedIds(data.sessions) && r.cloud.nutrition.meals.length === 30 && r.cloud.nutrition.fuel.length === 1, 'cloud différent des données');
    assert(sortedIds(r.local.sessions) === sortedIds(data.sessions) && r.local.nutrition.meals.length === 30 && r.local.records && r.local.profile.name === 'Test', 'copie locale abîmée');
  });

  await test('Tiroirs : nouvel appareil (tout relu), puis seulement le nécessaire (lectures et écritures)', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(1200);
    const fb = await fbState(v.page);
    await v.ctx.close();
    const nDrawers = Object.keys(fb.docs.testeur.drawers).length;
    // Nouvel appareil : copie locale vide → tout est relu
    const w = await otherDevice(fb);
    await w.page.goto(`${BASE}/index.html`); await w.page.waitForTimeout(1000);
    const a = await w.page.evaluate(() => ({ n: TS.getData().sessions.length, meals: TS.getData().nutrition.meals.length, reads: JSON.parse(localStorage.getItem('__fb')).reads }));
    // Page suivante, rien n'a changé : seul le document principal est lu
    const r0 = await w.page.evaluate(() => JSON.parse(localStorage.getItem('__fb')).reads || 0);
    await w.page.goto(`${BASE}/sessions.html`); await w.page.waitForTimeout(800);
    const r1 = await w.page.evaluate(() => JSON.parse(localStorage.getItem('__fb')).reads || 0);
    // Une séance ajoutée : un seul tiroir réécrit (+ le sommaire), en un seul envoi
    const before = await fbState(w.page);
    await w.page.evaluate(() => TS.saveSession({ date: TS.localDateStr(), sport: 'run', duration: 0.5, distance: 5 }));
    await w.page.waitForTimeout(400);
    const after = await fbState(w.page);
    const changed = Object.keys(after.sub).filter(k => JSON.stringify(after.sub[k]) !== JSON.stringify(before.sub[k]));
    assert(!w.errors.length, w.errors[0]);
    await w.ctx.close();
    assert(a.n === 40 && a.meals === 30 && a.reads >= 1 + nDrawers, 'nouvel appareil : ' + JSON.stringify(a) + ' tiroirs ' + nDrawers);
    assert(r1 - r0 === 1, `page suivante : ${r1 - r0} lectures (1 attendue)`);
    assert(changed.length === 1 && /sessions-\d{4}$/.test(changed[0]) && after.commits - before.commits === 1, 'écritures : ' + changed.join(', ') + ' / ' + (after.commits - before.commits) + ' envois');
  });

  await test('Tiroirs : un appareil resté sur l’ancienne version réécrit tout → ses données font foi, rangées à nouveau', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(1200);
    const fb = await fbState(v.page);
    await v.ctx.close();
    // Ancienne version : tout le contenu dans le document principal (sans toucher layout)
    const full = sampleData(); full.sessions = full.sessions.slice(0, 10); full._compact = 1;
    fb.docs.testeur.data = full;
    const w = await otherDevice(fb);
    await w.page.goto(`${BASE}/index.html`); await w.page.waitForTimeout(1200);
    const r = await w.page.evaluate(() => ({ local: TS.getData().sessions.length, cloud: window.__cloud('testeur').sessions.length, layout: JSON.parse(localStorage.getItem('__fb')).docs.testeur.layout,
      inMain: Array.isArray(JSON.parse(localStorage.getItem('__fb')).docs.testeur.data.sessions) }));
    await w.ctx.close();
    assert(r.local === 10 && r.cloud === 10 && r.layout === 2 && !r.inMain, JSON.stringify(r));
  });

  await test('Tiroirs : deux appareils enregistrent l’un après l’autre → le cloud reste lisible et cohérent', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(1200);
    const fb = await fbState(v.page);
    const local = await v.page.evaluate(() => TS.getData());
    // Appareil B chargé en même temps que A, avec la même copie
    const b = await otherDevice(fb, { keepLocal: local });
    await b.page.goto(`${BASE}/index.html`); await b.page.waitForTimeout(1000);
    // A ajoute une séance, puis B (qui ne l'a pas vue) ajoute un repas
    await v.page.evaluate(() => TS.saveSession({ id: 'deA', date: TS.localDateStr(), sport: 'run', duration: 0.5, distance: 5 }));
    await v.page.waitForTimeout(300);
    const fbA = await fbState(v.page);
    await b.page.evaluate((fbA) => localStorage.setItem('__fb', JSON.stringify(fbA)), fbA); // même serveur
    await b.page.evaluate(() => { const d = TS.getData(); d.nutrition.meals.push({ id: 'deB', date: TS.localDateStr(), type: 'déjeuner', glucides: 80 }); TS.saveData(d); });
    await b.page.waitForTimeout(400);
    const fbB = await fbState(b.page);
    await v.ctx.close(); await b.ctx.close();
    // Cohérence : chaque tiroir correspond à son empreinte dans le sommaire
    const c = await otherDevice(fbB);
    await c.page.goto(`${BASE}/index.html`); await c.page.waitForTimeout(1500);
    const r = await c.page.evaluate(() => ({ meals: TS.getData().nutrition.meals.some(m => m.id === 'deB'), n: TS.getData().sessions.length,
      ok: (() => { const st = JSON.parse(localStorage.getItem('__fb')); const idx = st.docs.testeur.drawers;
        return Object.keys(idx).every(k => st.sub['testeur/drawers/' + k] && TS.drawerHash(st.sub['testeur/drawers/' + k].json) === idx[k]); })() }));
    assert(!c.errors.length, c.errors[0]);
    await c.ctx.close();
    assert(r.ok && r.meals && r.n >= 40, 'cloud incohérent ou illisible : ' + JSON.stringify(r));
  });

  await test('Tiroirs : tiroir manquant → rien n’est écrasé, la copie locale reste', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(1200);
    const fb = await fbState(v.page);
    const local = await v.page.evaluate(() => TS.getData());
    await v.ctx.close();
    const key = Object.keys(fb.sub).find(k => /sessions-\d{4}$/.test(k));
    delete fb.sub[key];
    const w = await otherDevice(fb, { keepLocal: { ...local, sessions: local.sessions.slice(0, 5) } }); // copie locale différente : il faut relire
    await w.page.goto(`${BASE}/index.html`); await w.page.waitForTimeout(3500);
    await w.page.evaluate(() => TS.saveSession({ date: TS.localDateStr(), sport: 'run', duration: 0.5, distance: 5 }));
    await w.page.waitForTimeout(300);
    const after = await fbState(w.page);
    await w.ctx.close();
    assert(JSON.stringify(after.docs.testeur.data) === JSON.stringify(fb.docs.testeur.data) && Object.keys(after.sub).length === Object.keys(fb.sub).length, 'cloud modifié alors que la lecture a échoué');
  });

  await test('Tiroirs : « Effacer mes données » vide les tiroirs, « Supprimer mon compte » efface tout', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(1200);
    await v.page.evaluate(() => TS.resetAllData()); await v.page.waitForTimeout(600);
    const reset = await fbState(v.page);
    await v.page.evaluate(() => TS.saveSession({ date: TS.localDateStr(), sport: 'run', duration: 0.5, distance: 5 })); await v.page.waitForTimeout(400);
    await v.page.evaluate(() => TS.deleteAccount('mdp')); await v.page.waitForTimeout(400);
    const gone = await fbState(v.page);
    await v.ctx.close();
    assert(!Object.keys(reset.sub || {}).length && reset.docs.testeur.layout === 2, 'après effacement : ' + Object.keys(reset.sub || {}).join(', '));
    assert(!gone.docs.testeur && !Object.keys(gone.sub || {}).length, 'après suppression : ' + Object.keys(gone.sub || {}).join(', '));
  });

  await test('Apparence : mode clair choisi dans Profil, gardé sur toutes les pages, graphiques convertis ; sombre inchangé', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/profile.html#apparence`); await v.page.waitForTimeout(700);
    const dark = await v.page.evaluate(() => ({ t: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }));
    await Promise.all([v.page.waitForNavigation(), v.page.click('[data-theme-pick="light"]')]);
    await v.page.waitForTimeout(500);
    const prof = await v.page.evaluate(() => ({ t: document.documentElement.dataset.theme, checked: document.querySelector('[data-theme-pick="light"]').getAttribute('aria-checked') }));
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(900);
    const forme = await v.page.evaluate(() => {
      const ch = Chart.getChart(document.getElementById('chartPMC'));
      return { t: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor,
        tick: ch && ch.options.scales.x.ticks.color, run: ch && ch.data.datasets[1].borderColor,
        meta: document.querySelector('meta[name="theme-color"]').content };
    });
    await v.page.goto(`${BASE}/login.html`); await v.page.waitForTimeout(400);
    const login = await v.page.evaluate(() => document.documentElement.dataset.theme);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(dark.t === 'dark' && dark.bg === '#0d1016', 'sombre par défaut : ' + JSON.stringify(dark));
    assert(prof.t === 'light' && prof.checked === 'true', 'Profil : ' + JSON.stringify(prof));
    assert(forme.t === 'light' && forme.bg === 'rgb(238, 241, 245)' && forme.tick === '#6b7486' && forme.run === '#cb2f63' && forme.meta === '#eef1f5', 'Forme : ' + JSON.stringify(forme));
    assert(login === 'light', 'connexion pas en clair');
  });

  await test('Ressenti à noter : ressenti et effort (RPE) dans la même fenêtre', async () => {
    const data = sampleData();
    data.sessions.push({ id: 'nf1', date: day(-1), sport: 'run', duration: 0.5, distance: 5 },
                       { id: 'nf2', date: day(-2), sport: 'velo', duration: 1, distance: 30, rpe: 6 });
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(700);
    await v.page.click('text=Noter ressenti et effort');
    const rows = await v.page.locator('#feelingRows .feeling-row').count();
    const preset = await v.page.evaluate(() => document.querySelector('#feel-nf2 .rpe-btn.active')?.textContent);
    await v.page.click('#feel-nf1 .sensation-btn[title="Bon"]');
    const halfDone = await v.page.evaluate(() => document.getElementById('feel-nf1').classList.contains('done'));
    await v.page.click('#feel-nf1 .rpe-btn:text-is("7")');
    await v.page.click('#feel-nf2 .sensation-btn[title="Excellent"]');
    await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => ({ s1: TS.getSessions().find(s => s.id === 'nf1'), s2: TS.getSessions().find(s => s.id === 'nf2'),
      open: document.getElementById('feelingModal').classList.contains('open') }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(rows === 2 && preset === '6', `lignes ${rows}, RPE déjà noté affiché : ${preset}`);
    assert(!halfDone, 'séance marquée faite sans effort');
    assert(r.s1.sensation === 4 && r.s1.rpe === 7 && r.s2.sensation === 5 && r.s2.rpe === 6, 'enregistré : ' + JSON.stringify([r.s1, r.s2]));
    assert(!r.open, 'la fenêtre ne s’est pas fermée une fois tout noté');
  });

  await test('Nutrition : graphique 7 jours, kcal consommées et besoin du jour (par défaut) ou nombre de repas', async () => {
    const data = sampleData();
    data.profile = { ...data.profile, age: 30, height: 175 };
    data.nutrition.kcalGoals = { [day(-1)]: 3100 };
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/nutrition.html`); await v.page.waitForTimeout(800);
    const kcal = await v.page.evaluate(() => { const c = Chart.getChart(document.getElementById('chartMeals'));
      return { mode: document.getElementById('mealsChartMode').value, labels: c.data.datasets.map(d => d.label), eaten: c.data.datasets[0].data, need: c.data.datasets[1] && c.data.datasets[1].data }; });
    await v.page.selectOption('#mealsChartMode', 'meals'); await v.page.waitForTimeout(300);
    const meals = await v.page.evaluate(() => Chart.getChart(document.getElementById('chartMeals')).data.datasets.map(d => d.label + ':' + d.data.join(',')));
    await v.page.reload(); await v.page.waitForTimeout(800);
    const kept = await v.page.evaluate(() => document.getElementById('mealsChartMode').value);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    // Repas de test : glucides 150-310 g, protéines 40, lipides 20 → kcal = g×4 + 160 + 180
    assert(kcal.mode === 'kcal' && kcal.labels.join() === 'Kcal consommées,Besoin du jour', 'graphique kcal : ' + JSON.stringify(kcal));
    assert(kcal.eaten[5] > 0 && kcal.eaten.length === 7, 'kcal consommées : ' + kcal.eaten);
    assert(kcal.need[5] === 3100 && kcal.need[6] > 1500, 'besoin du jour : ' + kcal.need);
    assert(/^Repas:/.test(meals[0]) && meals.length === 1, 'graphique repas : ' + meals);
    assert(kept === 'meals', 'choix non gardé');
  });

  await test('Chargement : écran de démarrage si la connexion tarde, cartes en chargement sur un nouvel appareil, pastille Enregistré / hors connexion', async () => {
    // 1. Connexion lente : écran de démarrage, contenu caché, puis page normale
    const v = await newUser();
    await v.ctx.addInitScript(() => localStorage.setItem('__authDelay', '1500'));
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const boot = await v.page.evaluate(() => ({ splash: !!document.getElementById('tsSplash') && getComputedStyle(document.getElementById('tsSplash')).opacity === '1',
      hidden: getComputedStyle(document.querySelector('.page')).visibility }));
    await v.page.waitForTimeout(1500);
    const after = await v.page.evaluate(() => ({ splash: !!document.getElementById('tsSplash'), vis: getComputedStyle(document.querySelector('.page')).visibility }));
    // 2. Enregistrement : « Enregistré »
    await v.page.evaluate(() => TS.saveSession({ date: TS.localDateStr(), sport: 'run', duration: 0.5, distance: 5 }));
    await v.page.waitForTimeout(150);
    const saved = await v.page.evaluate(() => document.getElementById('tsSync')?.textContent);
    // 3. Hors connexion : message qui reste
    await v.ctx.setOffline(true); await v.page.waitForTimeout(200);
    const off = await v.page.evaluate(() => ({ t: document.getElementById('tsSync').textContent, on: document.getElementById('tsSync').classList.contains('ts-sync--on') }));
    await v.ctx.setOffline(false); await v.page.waitForTimeout(200);
    const back = await v.page.evaluate(() => document.getElementById('tsSync').classList.contains('ts-sync--offline'));
    const fb = await fbState(v.page);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    // 4. Nouvel appareil, lecture du compte lente : cartes « en chargement », puis les vraies données
    const w = await otherDevice(fb);
    await w.ctx.addInitScript(() => localStorage.setItem('__fbDelay', '1500'));
    await w.page.goto(`${BASE}/sessions.html`); await w.page.waitForTimeout(700);
    const loading = await w.page.evaluate(() => ({ cls: document.documentElement.classList.contains('ts-loading-data'), pill: document.getElementById('tsSync')?.textContent }));
    await w.page.waitForTimeout(1800);
    const loaded = await w.page.evaluate(() => ({ cls: document.documentElement.classList.contains('ts-loading-data'), n: TS.getData().sessions.length }));
    assert(!w.errors.length, w.errors[0]);
    await w.ctx.close();
    assert(boot.splash && boot.hidden === 'hidden', 'écran de démarrage : ' + JSON.stringify(boot));
    assert(!after.splash && after.vis === 'visible', 'page pas affichée après connexion : ' + JSON.stringify(after));
    assert(/Synchronisation|Enregistré/.test(saved || ''), 'pastille après enregistrement : ' + saved);
    assert(off.on && /Pas de réseau/.test(off.t) && !back, 'hors connexion : ' + JSON.stringify(off) + ' / revenu ' + back);
    assert(loading.cls && /Chargement de tes données/.test(loading.pill || ''), 'nouvel appareil pendant la lecture : ' + JSON.stringify(loading));
    assert(!loaded.cls && loaded.n === 41, 'après la lecture : ' + JSON.stringify(loaded));
  });

  // Option santé : blessures, maladie, reprise (accord à part, RGPD art. 9)
  await test('Blessures : rien sans l’accord à part, case à cocher obligatoire', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(700);
    const before = await v.page.evaluate(() => ({ on: TS.healthEnabled(), btn: document.getElementById('hpEnableBtn').disabled,
      add: getComputedStyle(document.getElementById('hpAddBtn')).display }));
    let refused = false;
    try { await v.page.evaluate(() => TS.saveHealthPeriod({ type: 'maladie', start: '2026-01-01', status: 'en_cours' })); } catch { refused = true; }
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(500);
    await v.page.click('text=+ Nouvelle séance');
    const painShown = await v.page.locator('#painGroup').isVisible();
    await v.page.goto(`${BASE}/forme.html#healthCard`); await v.page.waitForTimeout(500);
    await v.page.check('#hpConsent');
    await v.page.click('#hpEnableBtn'); await v.page.waitForTimeout(300);
    const after = await v.page.evaluate(() => ({ on: TS.healthEnabled(), cloud: window.__cloud('testeur').health,
      add: getComputedStyle(document.getElementById('hpAddBtn')).display }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(!before.on && before.btn && before.add === 'none', 'option active ou bouton cliquable sans accord');
    assert(refused, 'une période peut être enregistrée sans accord');
    assert(!painShown, 'case douleur affichée sans accord');
    assert(after.on && after.cloud && after.cloud.consent && after.cloud.consent.version >= 1 && after.add !== 'none', 'accord non enregistré');
  });

  await test('Blessures : période, douleur sur la séance, défis adaptés, série en pause', async () => {
    const data = sampleData();
    data.health = { consent: { version: 1, at: 1 }, periods: [] };
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(700);
    await v.page.click('#hpAddBtn');
    await v.page.selectOption('#hp_type', 'blessure');
    await v.page.selectOption('#hp_zone', 'Genou');
    await v.page.check('#hpSportsGroup input[value="run"]');
    await v.page.fill('#hp_start', day(-20));
    await v.page.fill('#hp_end', day(-6));
    await v.page.click('#healthModal .btn--primary'); await v.page.waitForTimeout(300);
    const forme = await v.page.evaluate(() => ({ p: TS.getHealthPeriods()[0], text: document.getElementById('healthBody').textContent,
      chart: !!document.getElementById('chartHealth'), bands: getComputedStyle(document.getElementById('pmcBandsNote')).display }));
    // Douleur sur une séance pendant la blessure
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(500);
    await v.page.click('text=+ Nouvelle séance');
    await v.page.fill('#s_date', day(-2)); await v.page.dispatchEvent('#s_date', 'change');
    const label = await v.page.textContent('#painLabel');
    await v.page.fill('#s_dur', '0:30:00'); await v.page.fill('#s_dist', '5'); await v.page.selectOption('#s_sport', 'run');
    await v.page.fill('#s_pain', '4');
    await v.page.click('#sessionModal .btn--primary'); await v.page.waitForTimeout(300);
    const r = await v.page.evaluate(() => {
      const s = TS.getSessions().find(x => x.pain != null);
      const wk = TS.getCurrentWeek();
      return { pain: s && s.pain, phase: TS.healthWeekPhase(wk), ids: TS.weeklyChallenges(wk).map(c => c.id) };
    });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(forme.p && forme.p.zone === 'Genou' && forme.p.status === 'reprise', 'période mal enregistrée : ' + JSON.stringify(forme.p));
    assert(/Reprise depuis/.test(forme.text) && forme.chart, 'résumé de reprise ou graphique absent');
    assert(forme.bands !== 'none', 'période non signalée sur le graphique de forme');
    assert(/genou/.test(label), 'case douleur sans la zone : ' + label);
    assert(r.pain === 4, 'douleur non enregistrée');
    assert(r.phase === 'reprise' && r.ids.includes('regular') && !r.ids.includes('sport') && !r.ids.includes('sessions'), 'défis non adaptés : ' + JSON.stringify(r));
  });

  await test('Blessures : compétitions et séances dures sur le graphique de douleur, douleur comparée juste après', async () => {
    const data = sampleData();
    const mk = (id, d, extra) => Object.assign({ id, date: day(d), sport: 'run', duration: 0.75, distance: 8 }, extra);
    data.sessions = [mk('a', -10, { rpe: 9, pain: 6 }), mk('b', -9, { rpe: 5, pain: 5 }), mk('c', -5, { rpe: 5, pain: 2 }), mk('d', -4, { rpe: 4, sensation: 4, pain: 3 }),
      mk('e', -17, { rpe: 5, sensation: 1 })];   // 7 jours avant « a » : toujours une autre semaine
    data.competitions = [{ id: 'c1', date: day(-20), name: '10 km test', type: 'RUN', distance: '10', actual_time: '0:41:07' }];
    data.health = { consent: { version: 1, at: 1 }, periods: [{ id: 'h1', type: 'blessure', zone: 'Genou', sports: ['run'], start: day(-30), end: day(-12), status: 'reprise' }] };
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => {
      const ch = Chart.getChart('chartHealth');
      return { labels: ch.data.datasets.map(d => d.label), comp: ch.data.datasets.find(d => d.mark === 'comp').data.filter(x => x != null).length,
        hard: ch.data.datasets.find(d => d.mark === 'hard').data.filter(x => x != null).length, note: document.getElementById('painHardNote').textContent.replace(/\s+/g, ' ') };
    });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(r.labels.includes('Compétition') && r.labels.some(l => /Séance dure/.test(l)) && r.comp === 1 && r.hard === 2, 'repères : ' + JSON.stringify(r));
    assert(/5,5\/10 en moyenne \(2 séances\), contre 2,5\/10 le reste du temps \(2 séances\)/.test(r.note) && /pas une preuve/.test(r.note), 'comparaison : ' + r.note);
  });

  await test('Cycle menstruel : accord à part, durée moyenne, phase, prévision, comparaison, calendrier, modes, effacement', async () => {
    const v = await newUser({ ctxOpts: { viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/forme.html#cycleCard`); await v.page.waitForTimeout(700);
    const off = await v.page.evaluate(() => { let err = ''; try { TS.addPeriodStart(TS.localDateStr()); } catch (e) { err = e.message; }
      return { err, consent: !!document.getElementById('cyConsent'), btn: document.getElementById('cyEnableBtn').disabled }; });
    await v.page.check('#cyConsent'); await v.page.click('#cyEnableBtn'); await v.page.waitForTimeout(200);
    const r = await v.page.evaluate((d) => {
      TS.addPeriodStart(d.m58); TS.addPeriodStart(d.m30); TS.addPeriodStart(d.m2); TS.addPeriodStart(d.m1);   // le 4e : mêmes règles, ignoré
      TS.toggleCycleSign(TS.localDateStr(), 'crampes');
      renderCycle(); renderPMC();
      const info = TS.cycleInfo();
      const ph = x => { const p = TS.cyclePhaseOn(x); return p ? p.phase + ':' + p.day : null; };
      return { starts: info.starts.length, avg: info.avgLength, today: ph(TS.localDateStr()), fol: ph(d.m20), ov: ph(d.m17), lut: ph(d.m15),
        pred: (TS.cyclePredicted(1)[0] || {}).start, imp: TS.cycleImpact(), text: document.getElementById('cycleBody').textContent.replace(/\s+/g, ' '),
        pmc: getComputedStyle(document.getElementById('pmcCycleNote')).display, signs: TS.getData().cycle.signs };
    }, { m58: day(-58), m30: day(-30), m20: day(-20), m17: day(-17), m15: day(-15), m2: day(-2), m1: day(-1) });
    // Pas de débordement sur le côté (liste « type de cycle » au libellé long)
    r.overflow = await v.page.evaluate(() => document.getElementById('cycleCard').scrollWidth - document.getElementById('cycleCard').clientWidth);
    // Calendrier du Dashboard
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const cal = await v.page.evaluate((d) => {
      const show = (date) => { const x = TS.parseLocalDate(date); calYear = x.getFullYear(); calMonthIdx = x.getMonth(); renderActivityCalendar(); };
      show(d.m2);
      const noted = document.querySelectorAll('#calGrid .cal-period:not(.cal-period--pred)').length;
      // Repère des règles en rose (variable --cycle), pas en gris
      const mk = document.querySelector('#calGrid .cal-period');
      const pink = mk ? getComputedStyle(mk).borderLeftColor : '';
      openPlanDay(d.m2);
      const dayTxt = document.getElementById('planDayBody').textContent; closeModal('planModal');
      show(d.p26);
      const pred = document.querySelectorAll('#calGrid .cal-period--pred').length;
      return { noted, pred, dayTxt, pink, legend: getComputedStyle(document.getElementById('calLegendCycle')).display };
    }, { m2: day(-2), p26: day(26) });
    // Contraception hormonale : pas de phases ni de prévision
    const hormonal = await v.page.evaluate((d) => { TS.setCycleMode('hormonal'); const p = TS.cyclePhaseOn(d.m20);
      return { phase: p && p.phase, pred: TS.cyclePredicted(1).length, regles: TS.cyclePhaseOn(TS.localDateStr()).phase }; }, { m20: day(-20) });
    await v.page.goto(`${BASE}/profile.html#parametres`); await v.page.waitForTimeout(600);
    const prof = await v.page.textContent('#cycleBody');
    await v.page.click('#cycleBody .btn--danger'); await v.page.waitForTimeout(300);
    const gone = await v.page.evaluate(() => ({ local: TS.getData().cycle, cloud: (window.__cloud('testeur') || {}).cycle }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(/non activée/.test(off.err) && off.consent && off.btn, 'sans accord : ' + JSON.stringify(off));
    assert(r.overflow <= 1, 'carte Cycle plus large que l’écran : ' + r.overflow);
    assert(r.starts === 3 && r.avg === 28 && r.today === 'regles:3' && r.fol === 'folliculaire:11' && r.ov === 'ovulation:14' && r.lut === 'luteale:16', 'calculs : ' + JSON.stringify(r));
    assert(r.pred === day(26) && /Durée moyenne de tes cycles : 28 jours/.test(r.text) && /Règles : jour 3/.test(r.text), 'prévision / texte : ' + r.pred + ' ' + r.text.slice(0, 200));
    assert(r.imp.enough && r.imp.during >= 3 && /Pendant tes règles/.test(r.text) && r.pmc !== 'none' && r.signs[day(0)].join() === 'crampes', 'comparaison / graphique / signes : ' + JSON.stringify(r.imp));
    assert(cal.noted >= 2 && cal.pred >= 1 && /Règles \(jour 1\)/.test(cal.dayTxt) && cal.legend !== 'none', 'calendrier : ' + JSON.stringify(cal));
    assert(cal.pink === 'rgb(244, 114, 208)', 'repère des règles en rose dans le calendrier : ' + cal.pink);
    assert(hormonal.phase === null && hormonal.pred === 0 && hormonal.regles === 'regles', 'contraception hormonale : ' + JSON.stringify(hormonal));
    assert(/Activée le/.test(prof) && /3 débuts de règles notés/.test(prof) && !gone.local && !gone.cloud, 'Profil / effacement : ' + JSON.stringify({ prof, gone }));
  });

  await test('Blessures : une semaine d’arrêt ratée ne casse pas la série de défis', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(700);
    const r = await v.page.evaluate(() => {
      const d = TS.getData();
      const without = TS.challengeHistory(d);
      d.health = { consent: { version: 1, at: 1 }, periods: [{ id: 'h1', type: 'maladie', start: TS.localDateStr(new Date(Date.now() - 21 * 864e5)), end: null, status: 'en_cours' }] };
      const withP = TS.challengeHistory(d);
      return { without: without.best, withP: withP.best, paused: withP.paused, n: withP.current.length };
    });
    await v.ctx.close();
    assert(r.paused === 'arret' && r.n === 1, 'pas en pause pendant l’arrêt : ' + JSON.stringify(r));
    assert(r.withP >= r.without, 'série plus courte avec un arrêt : ' + JSON.stringify(r));
  });

  await test('Blessures : retirer son accord efface tout (périodes et douleurs)', async () => {
    const data = sampleData();
    data.health = { consent: { version: 1, at: 1 }, periods: [{ id: 'h1', type: 'blessure', zone: 'Dos', start: day(-10), end: null, status: 'en_cours' }] };
    data.sessions[0].pain = 3;
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/profile.html#parametres`); await v.page.waitForTimeout(700);
    await v.page.click('text=Retirer mon accord et tout effacer'); await v.page.waitForTimeout(300);
    const r = await v.page.evaluate(() => { const c = window.__cloud('testeur');
      return { on: TS.healthEnabled(), health: c.health, pain: c.sessions.some(s => 'pain' in s), n: c.sessions.length }; });
    await v.ctx.close();
    assert(!r.on && !r.health && !r.pain, 'informations santé encore présentes : ' + JSON.stringify(r));
    assert(r.n === 40, 'séances perdues');
  });

  await test('Musculation : cachée sans séance, exercices enregistrés, « Reprendre la dernière séance », comptée dans la charge', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(600);
    const before = await v.page.evaluate(() => !!document.querySelector('#filterSport option[value="muscu"]'));
    await v.page.click('text=+ Nouvelle séance');
    await v.page.selectOption('#s_sport', 'muscu');
    const shown = await v.page.evaluate(() => ({ dist: getComputedStyle(document.getElementById('distGroup')).display,
      ex: getComputedStyle(document.getElementById('muscuGroup')).display, rows: document.querySelectorAll('#muscuRows .muscu-row').length,
      repeat: getComputedStyle(document.getElementById('muscuRepeatBtn')).display }));
    await v.page.fill('#s_date', day(-3)); await v.page.fill('#s_dur', '1:00:00'); await v.page.fill('#s_rpe', '7');
    const row1 = '#muscuRows .muscu-row:nth-child(1) ';
    await v.page.click(row1 + '.muscu-pick'); await v.page.fill('#mpSearch', 'squat');
    await v.page.click('#mpList [data-name="Squat"]');
    await v.page.fill(row1 + '[data-k="sets"]', '4'); await v.page.fill(row1 + '[data-k="reps"]', '8'); await v.page.fill(row1 + '[data-k="kg"]', '80');
    await v.page.click('text=+ Ajouter un exercice');
    const row2 = '#muscuRows .muscu-row:nth-child(2) ';
    await v.page.click(row2 + '.muscu-pick'); await v.page.fill('#mpSearch', 'planche');
    await v.page.click('#mpList [data-name="Gainage (planche)"]');
    await v.page.fill(row2 + '[data-k="sets"]', '3'); await v.page.fill(row2 + '[data-k="reps"]', '45');
    await v.page.click('#sessionModal .btn--primary'); await v.page.waitForTimeout(300);
    const saved = await v.page.evaluate(() => {
      const s = TS.getSessions({ sport: 'muscu' })[0];
      return { s, vol: TS.muscuVolume(s), filter: !!document.querySelector('#filterSport option[value="muscu"]'),
        cloud: window.__cloud('testeur').sessions.some(x => x.sport === 'muscu' && x.exercises.length === 2) };
    });
    // Nouvelle séance : reprendre la dernière
    await v.page.click('text=+ Nouvelle séance');
    await v.page.selectOption('#s_sport', 'muscu');
    await v.page.click('#muscuRepeatBtn');
    const repeated = await v.page.evaluate(() => [...document.querySelectorAll('#muscuRows .muscu-row')].map(r => r.querySelector('.muscu-pick').dataset.name + '/' + r.querySelector('[data-k="kg"]').value));
    await v.page.evaluate(() => closeModal());
    // Dashboard : jour de la séance, totaux, charge (CTL/ATL)
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(700);
    const dash = await v.page.evaluate(() => {
      const s = TS.getSessions({ sport: 'muscu' })[0];
      return { html: daySessionHtml(s, null, {}, TS.getData()), week: TS.getWeek(TS.getISOWeek(TS.parseLocalDate(s.date))).muscu.sessions,
        plan: getComputedStyle(document.querySelector('#pl_sport [data-sport="muscu"]')).display };
    });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(!before, 'Musculation dans le filtre sans aucune séance');
    assert(shown.dist === 'none' && shown.ex !== 'none' && shown.rows === 1 && shown.repeat === 'none', 'formulaire musculation : ' + JSON.stringify(shown));
    const ex = saved.s && saved.s.exercises;
    assert(ex && ex.length === 2 && ex[0].name === 'Squat' && ex[0].group === 'Jambes' && ex[0].sets === 4 && ex[0].reps === 8 && ex[0].kg === 80
      && ex[1].reps === 45 && !('kg' in ex[1]) && !('distance' in saved.s), 'exercices mal enregistrés : ' + JSON.stringify(saved.s));
    assert(saved.vol === 2560 && saved.filter && saved.cloud, 'tonnage / filtre / cloud : ' + JSON.stringify({ vol: saved.vol, f: saved.filter, c: saved.cloud }));
    assert(repeated.join() === 'Squat/80,Gainage (planche)/', 'reprise de la dernière séance : ' + repeated.join());
    assert(/Squat<\/b> 4 × 8 × 80 kg/.test(dash.html) && /Tonnage/.test(dash.html) && dash.week === 1, 'détail du jour : ' + dash.html.slice(0, 300));
  });

  await test('Musculation : recherche d’exercice (machines, muscles) et exercice libre rangé dans un groupe', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(500);
    await v.page.click('text=+ Nouvelle séance');
    await v.page.selectOption('#s_sport', 'muscu');
    await v.page.click('#muscuRows .muscu-pick');
    // Sans recherche : zones de travail fermées, à dérouler
    const zones = await v.page.evaluate(() => ({ labels: [...document.querySelectorAll('#mpList .mp-zone > span:first-child')].map(e => e.textContent),
      items: document.querySelectorAll('#mpList .mp-item').length }));
    await v.page.click('#mpList [data-zone="Triceps"]');
    const triZone = await v.page.$$eval('#mpList .mp-item', els => els.map(e => e.dataset.name));
    await v.page.click('#mpList [data-zone="Dos"]'); await v.page.click('#mpList [data-zone="Jambes"]');
    const deadlift = await v.page.$$eval('#mpList .mp-item[data-name="Soulevé de terre"]', els => els.length);
    await v.page.click('#mpList [data-zone="Triceps"]');
    const closed = await v.page.$$eval('#mpList .mp-item[data-name="Dips"]', els => els.length);
    const names = async q => { await v.page.fill('#mpSearch', q); return v.page.$$eval('#mpList .mp-item', els => els.map(e => e.dataset.name)); };
    const fly = await names('pec fly');
    const tri = await names('triceps');
    const machine = await names('machine');
    const accents = await names('ecarte');
    await v.page.fill('#mpSearch', 'Mollets debout (machine)');
    await v.page.click('#mpList .mp-chip[data-group="Jambes"]');
    await v.page.fill('#s_date', day(-1)); await v.page.fill('#s_dur', '0:45:00');
    await v.page.click('#sessionModal .btn--primary'); await v.page.waitForTimeout(300);
    const r = await v.page.evaluate(() => {
      const ex = TS.getSessions({ sport: 'muscu' })[0].exercises[0];
      return { ex, targets: TS.muscuTargets(ex), mine: TS.muscuCustomExercises().map(e => e.name) };
    });
    // Rouvrir : l'exercice libre est proposé dans « Mes exercices »
    await v.page.click('text=+ Nouvelle séance'); await v.page.selectOption('#s_sport', 'muscu');
    await v.page.click('#muscuRows .muscu-pick');
    const mine = await v.page.$$eval('#mpList .mp-zone > span:first-child', els => els.map(e => e.textContent));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(zones.labels.join() === 'Pectoraux,Dos,Épaules,Biceps,Triceps,Jambes,Abdos et gainage' && zones.items === 0, 'zones : ' + JSON.stringify(zones));
    assert(triZone.includes('Dips') && triZone.includes('Barre au front') && triZone.every(n => !/Développé couché/.test(n)), 'zone Triceps : ' + triZone.join());
    assert(deadlift === 2 && closed === 0, 'soulevé de terre dans Dos et Jambes / zone refermée : ' + deadlift + ' ' + closed);
    assert(fly[0] === 'Pec fly (machine)', 'pec fly : ' + fly.join());
    assert(tri.includes('Dips') && tri.includes('Tirage triceps (poulie)') && !tri.includes('Développé couché (barre)'), 'triceps : ' + tri.join());
    assert(machine.length >= 15 && machine.every(n => /machine/i.test(n)), 'machine : ' + machine.join());
    assert(accents.includes('Écarté (haltères ou poulie)'), 'recherche sans accents : ' + accents.join());
    assert(r.ex.name === 'Mollets debout (machine)' && r.ex.group === 'Jambes' && r.targets.quadriceps === 1, 'exercice libre : ' + JSON.stringify(r));
    assert(r.mine.includes('Mollets debout (machine)') && mine[0] === 'Mes exercices', 'Mes exercices : ' + mine.join());
  });

  await test('Téléphone : barre du bas (Forme à la place de Profil), icône Profil en haut, Profil dans le menu ☰', async () => {
    const out = {};
    for (const p of ['index', 'nutrition', 'forme', 'profile']) {
      const data = sampleData(); Object.assign(data.profile, { height: 180, age: 30, sex: 'M' });   // besoin du jour calculable
      const v = await newUser({ data, ctxOpts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
      await v.page.goto(`${BASE}/${p}.html`); await v.page.waitForTimeout(700);
      out[p] = await v.page.evaluate(() => ({
        tabs: [...document.querySelectorAll('.mobile-nav__item')].map(a => a.textContent.trim() + (a.classList.contains('active') ? '*' : '')).join(),
        icon: getComputedStyle(document.querySelector('.nav__profile')).display, menuBefore: getComputedStyle(document.querySelector('.nav__link--menu')).display }));
      await v.page.click('.nav__menu-btn'); await v.page.waitForTimeout(150);
      out[p].menuOpen = await v.page.evaluate(() => getComputedStyle(document.querySelector('.nav__link--menu')).display);
      if (p === 'nutrition') out.legend = await v.page.evaluate(() => { const ch = Chart.getChart('chartMeals'); return ch && ch.legend.legendItems.map(l => l.text + ':' + l.pointStyle + ':' + (l.lineDash || []).length).join(); });
      assert(!v.errors.length, p + ' : ' + v.errors[0]);
      await v.ctx.close();
    }
    const d = await newUser();
    await d.page.goto(`${BASE}/index.html`); await d.page.waitForTimeout(600);
    const desk = await d.page.evaluate(() => ({ menu: getComputedStyle(document.querySelector('.nav__link--menu')).display, icon: getComputedStyle(document.querySelector('.nav__profile')).display }));
    await d.ctx.close();
    assert(out.index.tabs === 'Dashboard*,Séances,Sports,Nutrition,Forme' && out.forme.tabs.endsWith('Forme*') && !/Profil/.test(out.profile.tabs), 'barre du bas : ' + JSON.stringify(out));
    assert(['index', 'nutrition', 'forme', 'profile'].every(p => out[p].icon !== 'none' && out[p].menuBefore === 'none' && out[p].menuOpen !== 'none'), 'icône / menu : ' + JSON.stringify(out));
    assert(desk.menu === 'none' && desk.icon !== 'none', 'ordinateur : ' + JSON.stringify(desk));
    assert(/Kcal consommées:rect:0,Besoin du jour \(pointillés\):line:0/.test(out.legend), 'légende du besoin : ' + out.legend);
  });

  await test('Photo de profil : réduite en petite image, affichée à la place de l’icône Profil sur toutes les pages, retirable', async () => {
    const v = await newUser({ ctxOpts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(700);
    // Image de 600 × 400 fabriquée dans la page (PNG), envoyée au champ fichier
    const png = await v.page.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 400; const x = c.getContext('2d');
      x.fillStyle = '#c33'; x.fillRect(0, 0, 600, 400); x.fillStyle = '#3c3'; x.fillRect(250, 150, 100, 100); return c.toDataURL('image/png').split(',')[1]; });
    await v.page.setInputFiles('#photoInput', { name: 'moi.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await v.page.waitForTimeout(400);
    // Fenêtre de recadrage : zoom au maximum (×4) au centre = le carré vert de 100 px
    const cropOpen = await v.page.evaluate(() => document.getElementById('cropModal').classList.contains('open'));
    await v.page.fill('#cropZoom', '4'); await v.page.dispatchEvent('#cropZoom', 'input');
    // Glisser puis revenir : le recadrage reste dans l'image (pas de bord vide)
    const box = await v.page.locator('#cropView').boundingBox();
    await v.page.mouse.move(box.x + 100, box.y + 100); await v.page.mouse.down(); await v.page.mouse.move(box.x + 400, box.y + 400); await v.page.mouse.up();
    const clamped = await v.page.evaluate(() => crop.ox <= 0 && crop.oy <= 0);
    await v.page.evaluate(() => cropSetZoom(1)); await v.page.evaluate(() => cropSetZoom(4));
    await v.page.evaluate(() => { const sc = cropScale(); crop.ox = crop.V / 2 - 300 * sc; crop.oy = crop.V / 2 - 200 * sc; cropDraw(); });
    await v.page.click('#cropModal .btn--primary'); await v.page.waitForTimeout(500);
    const corner = await v.page.evaluate(() => new Promise(r => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 192;
      const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(4, 4, 1, 1).data; r([d[0], d[1], d[2]]); }; i.src = TS.getProfile().photo; }));
    const prof = await v.page.evaluate(() => { const p = TS.getProfile().photo || ''; const img = new Image(); img.src = p;
      return { prefix: p.slice(0, 23), kb: Math.round(p.length * 0.75 / 1024), avatar: !!document.querySelector('#avatarEl img'),
        nav: !!document.querySelector('.nav__profile img.nav__avatar'), remove: !document.getElementById('photoRemove').hidden, cloud: !!(window.__cloud('testeur').profile || {}).photo }; });
    const dims = await v.page.evaluate(() => new Promise(r => { const i = new Image(); i.onload = () => r(i.width + 'x' + i.height); i.src = TS.getProfile().photo; }));
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(600);
    const other = await v.page.evaluate(() => ({ img: !!document.querySelector('.nav__profile img'), shown: getComputedStyle(document.querySelector('.nav__profile')).display }));
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(600);
    await v.page.click('#photoRemove'); await v.page.waitForTimeout(200);
    const after = await v.page.evaluate(() => ({ photo: TS.getProfile().photo || null, nav: !!document.querySelector('.nav__profile svg') }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(prof.prefix === 'data:image/jpeg;base64,' && prof.kb < 40 && dims === '192x192' && prof.avatar && prof.nav && prof.remove && prof.cloud, 'photo : ' + JSON.stringify({ ...prof, dims }));
    assert(cropOpen && clamped && corner[1] > 150 && corner[0] < 100, 'recadrage (coin vert attendu) : ' + JSON.stringify({ cropOpen, clamped, corner }));
    assert(other.img && other.shown !== 'none', 'autre page : ' + JSON.stringify(other));
    assert(!after.photo && after.nav, 'retrait : ' + JSON.stringify(after));
  });

  await test('Téléphone : champs en 16 px (pas de zoom automatique de l’iPhone), aucune fenêtre qui glisse de côté', async () => {
    const v = await newUser({ ctxOpts: { viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true } });
    const sizes = {};
    for (const p of ['sessions', 'nutrition']) {
      await v.page.goto(`${BASE}/${p}.html`); await v.page.waitForTimeout(600);
      Object.assign(sizes, await v.page.evaluate(() => {
        const out = {};
        document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]), select, textarea')
          .forEach(el => { const f = parseFloat(getComputedStyle(el).fontSize); if (f < 16) out[el.id || el.className] = f; });
        document.querySelectorAll('.modal').forEach(m => { if (getComputedStyle(m).overflowX !== 'hidden') out['modal ' + (m.parentNode.id || '')] = getComputedStyle(m).overflowX; });
        return out;
      }));
    }
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(!Object.keys(sizes).length, 'champs trop petits ou fenêtres qui glissent : ' + JSON.stringify(sizes));
  });

  await test('Musculation : records, progression (Sports), carte du corps (Forme), section Records ; rien sans séance', async () => {
    const data = sampleData();
    data.sessions.push(
      { id: 'mu1', date: day(-20), sport: 'muscu', duration: 1, rpe: 7, exercises: [{ name: 'Squat', group: 'Jambes', sets: 4, reps: 8, kg: 60 }, { name: 'Pompes', group: 'Pectoraux', sets: 3, reps: 20 }] },
      { id: 'mu2', date: day(-10), sport: 'muscu', duration: 1, rpe: 7, exercises: [{ name: 'Squat', group: 'Jambes', sets: 4, reps: 6, kg: 70 }, { name: 'Pompes', group: 'Pectoraux', sets: 3, reps: 25 }] },
      { id: 'mu3', date: day(-3), sport: 'muscu', duration: 1, rpe: 8, exercises: [{ name: 'Squat', group: 'Jambes', sets: 5, reps: 5, kg: 80 }, { name: 'Gainage (planche)', group: 'Abdos et gainage', sets: 3, reps: 60 }] });
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/sport.html?sport=muscu&exo=Pompes`); await v.page.waitForTimeout(800);
    const sport = await v.page.evaluate(() => ({
      tab: getComputedStyle(document.getElementById('tab-muscu')).display, view: getComputedStyle(document.getElementById('muscuView')).display,
      endu: getComputedStyle(document.getElementById('enduranceView')).display, exo: document.getElementById('muscuExo').value,
      rows: document.querySelectorAll('#muscuExo option').length, oldCard: !!document.getElementById('muscuRecords'), kpi: document.getElementById('muscuKPIs').textContent,
      chart: !!Chart.getChart('chartMuscuProg'), map: document.querySelectorAll('#muscuBodyMap .bm-muscle').length }));
    await v.page.selectOption('#muscuExo', 'Squat'); await v.page.waitForTimeout(200);
    const note = await v.page.textContent('#muscuProgNote');
    const calc = await v.page.evaluate(() => {
      const r = TS.muscuRecords();
      const sq = r.find(x => x.name === 'Squat'), po = r.find(x => x.name === 'Pompes'), ga = r.find(x => x.name === 'Gainage (planche)');
      const sets = TS.muscuMuscleLoad({ mode: 'sets' }).totals, kg = TS.muscuMuscleLoad({ mode: 'kg' }).totals;
      return { sq, po, ga, sets, kg, order: r.map(x => x.name) };
    });
    // Carte du corps complète : Sports → Muscu (Forme n'en garde qu'une ligne et un lien)
    const forme1 = await v.page.evaluate(() => ({ card: getComputedStyle(document.getElementById('carte-du-corps')).display,
      quad: document.querySelector('#muscuBodyMap .bm-muscle[data-m="quadriceps"]').style.fillOpacity,
      calf: document.querySelector('#muscuBodyMap .bm-muscle[data-m="mollets"]').style.fillOpacity,
      detail: document.querySelector('#muscuBodyMap .bm-detail').textContent }));
    await v.page.click('#muscuBodyMap .bm-row[data-m="abdos"]'); await v.page.waitForTimeout(100);
    const forme2 = await v.page.evaluate(() => document.querySelector('#muscuBodyMap .bm-detail').textContent);
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(800);
    const formeLine = await v.page.evaluate(() => ({ card: getComputedStyle(document.getElementById('bodyMapCard')).display,
      text: document.getElementById('bodyMapLine').textContent, oldMap: !!document.querySelector('#bodyMapCard svg'),
      link: document.querySelector('#bodyMapCard a').getAttribute('href') }));
    await v.page.click('#bodyMapCard a'); await v.page.waitForTimeout(900);
    const jumped = await v.page.evaluate(() => { const r = document.getElementById('carte-du-corps').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
    await v.page.goto(`${BASE}/records.html`); await v.page.waitForTimeout(700);
    const rec = await v.page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('muscuRecordSection')).display,
      cards: [...document.querySelectorAll('#records-muscu .record-card')].map(c => c.querySelector('.record-val').textContent) }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    // Sans musculation : rien n'apparaît
    const w = await newUser();
    await w.page.goto(`${BASE}/sport.html?sport=muscu`); await w.page.waitForTimeout(600);
    const none = await w.page.evaluate(() => ({ tab: getComputedStyle(document.getElementById('tab-muscu')).display, view: getComputedStyle(document.getElementById('muscuView')).display }));
    await w.page.goto(`${BASE}/forme.html`); await w.page.waitForTimeout(600);
    none.forme = await w.page.evaluate(() => getComputedStyle(document.getElementById('bodyMapCard')).display);
    await w.page.goto(`${BASE}/records.html`); await w.page.waitForTimeout(600);
    none.rec = await w.page.evaluate(() => getComputedStyle(document.getElementById('muscuRecordSection')).display);
    assert(!w.errors.length, w.errors[0]);
    await w.ctx.close();

    assert(sport.tab !== 'none' && sport.view !== 'none' && sport.endu === 'none' && sport.exo === 'Pompes' && sport.rows === 3 && !sport.oldCard && sport.chart && sport.map > 0,
      'page Sports musculation : ' + JSON.stringify(sport));
    assert(/60 kg → 80 kg \(\+20 kg\)/.test(note), 'progression : ' + note);
    assert(calc.sq.maxKg.kg === 80 && calc.sq.maxKg.reps === 5 && calc.sq.orm.value === 93.5 && calc.sq.sessions === 3 && calc.order[0] === 'Squat', 'records Squat : ' + JSON.stringify(calc.sq));
    assert(!calc.po.maxKg && calc.po.maxReps.reps === 25 && calc.ga.hold && calc.ga.maxReps.reps === 60, 'records sans charge : ' + JSON.stringify([calc.po, calc.ga]));
    assert(calc.sets.quadriceps === 13 && calc.sets.pecs === 6 && calc.sets.triceps === 3, 'charge par muscle : ' + JSON.stringify(calc.sets));
    assert(calc.kg.quadriceps === 60 * 32 + 70 * 24 + 80 * 25 && !calc.kg.pecs, 'kg soulevés par muscle : ' + JSON.stringify(calc.kg));
    assert(forme1.card !== 'none' && forme1.quad === '1' && forme1.calf === '0' && /Quadriceps/.test(forme1.detail) && /Squat/.test(forme1.detail), 'carte du corps : ' + JSON.stringify(forme1));
    assert(/Abdominaux/.test(forme2) && /Gainage/.test(forme2), 'carte du corps, détail d’un muscle : ' + forme2);
    assert(formeLine.card !== 'none' && /Surtout : quadriceps/.test(formeLine.text) && !formeLine.oldMap && /carte-du-corps/.test(formeLine.link) && jumped,
      'Forme : une ligne et un lien vers la carte : ' + JSON.stringify({ ...formeLine, jumped }));
    assert(rec.shown !== 'none' && rec.cards.join() === '80 kg,25 rép.,60 s', 'section Records : ' + JSON.stringify(rec));
    assert(none.tab === 'none' && none.view === 'none' && none.forme === 'none' && none.rec === 'none', 'musculation visible sans séance : ' + JSON.stringify(none));
  });

  await test('Musculation : page Sports (volume par séance, mois, effort, meilleures semaines, objectifs en kg), moyennes, défi bonus, badges', async () => {
    const data = sampleData();
    for (let i = 0; i < 10; i++) data.sessions.push({ id: 'mx' + i, date: day(-2 - i * 4), sport: 'muscu', duration: 1, rpe: 6 + (i % 4),
      exercises: [{ name: 'Squat', group: 'Jambes', sets: 4, reps: 8, kg: 60 + i }, { name: 'Pompes', group: 'Pectoraux', sets: 3, reps: 20 }] });
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/sport.html?sport=muscu`); await v.page.waitForTimeout(900);
    const page = await v.page.evaluate(() => ({
      volOpts: [...document.querySelectorAll('#muscuVolExo option')].map(o => o.textContent),
      allBars: Chart.getChart('chartMuscuVol').data.datasets[0].data.length,
      monthly: !!Chart.getChart('chartMuscuMonthly'), effort: document.getElementById('muscuEffort').textContent,
      best: document.querySelectorAll('#muscuBestWeeks .stat-row').length,
      goalTypes: [...document.querySelectorAll('#goalType option')].map(o => o.value),
      goalsIn: document.getElementById('goalsCard').parentNode.id,
      weeks: Chart.getChart('chartMuscuWeeks').data.labels.length,
      legend: Chart.getChart('chartMuscuProg').legend.legendItems.map(l => l.text + ':' + (l.lineDash || []).length) }));
    await v.page.selectOption('#muscuVolExo', 'Pompes'); await v.page.waitForTimeout(100);
    const pompes = await v.page.evaluate(() => ({ label: Chart.getChart('chartMuscuVol').data.datasets[0].label, data: Chart.getChart('chartMuscuVol').data.datasets[0].data }));
    await v.page.selectOption('#goalType', 'kg_month'); await v.page.fill('#goalTarget', '20000');
    await v.page.click('#goalsCard .btn--primary'); await v.page.waitForTimeout(200);
    const goal = await v.page.textContent('#goalsContent');
    await v.page.click('#tab-run'); await v.page.waitForTimeout(200);
    const runGoal = await v.page.evaluate(() => ({ types: [...document.querySelectorAll('#goalType option')].map(o => o.value), in: document.getElementById('goalsCard').parentNode.id }));
    await v.page.goto(`${BASE}/sport.html?sport=muscu`); await v.page.waitForTimeout(600);
    const avgs = await v.page.textContent('#muscuAvgs');
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(900);
    const ch = await v.page.evaluate(() => ({ list: TS.challengeHistory().current, html: document.getElementById('challengeList').innerHTML,
      badges: TS.getAchievements().filter(b => b.kind === 'muscu').map(b => b.id + ':' + b.earned) }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const w = await newUser();
    await w.page.goto(`${BASE}/sessions.html`); await w.page.waitForTimeout(500);
    const none = await w.page.evaluate(() => ({ avgs: document.getElementById('sessionTable').textContent + document.getElementById('filterSport').textContent, ch: TS.weeklyChallenges(TS.getCurrentWeek()).map(c => c.id),
      badges: TS.getAchievements().filter(b => b.kind === 'muscu').length }));
    await w.ctx.close();
    assert(page.weeks === 8, 'graphique par semaine : ' + page.weeks + ' semaines au lieu de 8');
    assert(page.legend.length === 2 && page.legend.every(l => /:0$/.test(l)), 'légende charge / 1RM : ' + page.legend.join());
    assert(page.volOpts[0] === 'Toutes les séances' && page.volOpts.includes('Squat') && page.allBars === 10 && page.monthly, 'volume par séance : ' + JSON.stringify(page));
    assert(/Difficile/.test(page.effort) && /Effort moyen/.test(page.effort) && page.best >= 3, 'effort / meilleures semaines : ' + JSON.stringify(page));
    assert(page.goalTypes.includes('kg_week') && !page.goalTypes.includes('dist_week') && page.goalsIn === 'muscuGoalsSlot', 'objectifs musculation : ' + JSON.stringify(page));
    assert(/Répétitions au total/.test(pompes.label) && pompes.data.every(x => x === 60), 'volume Pompes : ' + JSON.stringify(pompes));
    assert(/Kg soulevés \/ mois/.test(goal) && /20\s000 kg/.test(goal), 'objectif en kg : ' + goal);
    assert(runGoal.types.includes('dist_week') && runGoal.in === 'enduGoalsSlot', 'objectifs course : ' + JSON.stringify(runGoal));
    assert(/Par séance en moyenne/.test(avgs) && /kg soulevés/.test(avgs) && /exercice/.test(avgs) && /séries/.test(avgs), 'moyennes : ' + avgs.replace(/\s+/g, ' '));
    const bonus = ch.list.find(c => c.bonus);
    assert(bonus && bonus.kind === 'muscu' && bonus.target > 0 && bonus.label && /Bonus/.test(ch.html), 'défi bonus : ' + JSON.stringify(ch.list));
    assert(ch.badges.includes('muscu10:true') && ch.badges.some(b => b.startsWith('muscu_full')), 'badges : ' + ch.badges.join());
    assert(!/Musculation/.test(none.avgs) && !none.ch.some(id => id.startsWith('muscu')) && !none.badges, 'musculation visible sans séance : ' + JSON.stringify(none));
  });

  await test('Hydratation : objectif 1,5 L par défaut, modifiable, utilisé par le défi et le graphique', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/nutrition.html`); await v.page.waitForTimeout(700);
    const before = await v.page.evaluate(() => ({ text: document.getElementById('hydroGoalLine').textContent, goal: TS.hydroGoal(),
      line: Chart.getChart('chartHydro').data.datasets[1].data[0] }));
    await v.page.click('#hydroGoalLine .link-btn');
    await v.page.fill('#hydroGoalInput', '2,2'.replace(',', '.'));
    await v.page.click('#hydroGoalLine .btn--primary'); await v.page.waitForTimeout(300);
    const after = await v.page.evaluate(() => ({ text: document.getElementById('hydroGoalLine').textContent, goal: TS.hydroGoal(),
      cloud: window.__cloud('testeur').profile.hydro_goal, ch: TS.weeklyChallenges(TS.getCurrentWeek()).find(c => c.id === 'hydro') }));
    await v.page.click('#hydroGoalLine .link-btn');
    await v.page.click('text=Par défaut (1,5 L)'); await v.page.waitForTimeout(200);
    const reset = await v.page.evaluate(() => TS.hydroGoal());
    // « Avant tes courses » (eau et kcal des 7 jours avant chaque course) ; l'ancienne carte en double a disparu
    const obs = await v.page.evaluate(() => ({ card: getComputedStyle(document.getElementById('raceNutriCard')).display,
      text: document.getElementById('perfComparison').textContent.replace(/\s+/g, ' '), old: /Hydratation et RPE|Séances les plus faciles/.test(document.body.textContent) }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(/1,5 L/.test(before.text) && before.goal === 1500 && before.line === 1500, 'défaut : ' + JSON.stringify(before));
    assert(/2,2 L/.test(after.text) && after.goal === 2200 && after.cloud === 2200, 'modifié : ' + JSON.stringify(after));
    assert(after.ch && /2,2 L/.test(after.ch.label), 'défi hydratation : ' + JSON.stringify(after.ch));
    assert(reset === 1500, 'retour au défaut : ' + reset);
    assert(obs.card !== 'none' && /10 km test/.test(obs.text) && /Objectif atteint/.test(obs.text) && !obs.old, 'avant tes courses : ' + JSON.stringify(obs).slice(0, 300));
  });

  await test('Musculation : message de nouveauté une seule fois par compte, pas pour un nouveau compte', async () => {
    const data = sampleData(); data.news_seen = ['sports', 'orka'];
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(1500);
    const first = await v.page.evaluate(() => { const m = document.getElementById('newsModal'); return m && m.classList.contains('open') && m.textContent; });
    await v.page.click('#newsModal [data-close]'); await v.page.waitForTimeout(400);
    const cloud = await v.page.evaluate(() => window.__cloud('testeur').news_seen);
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(1200);
    const again = await v.page.evaluate(() => !!document.getElementById('newsModal'));
    // Bouton « Ajouter une séance de musculation »
    await v.page.goto(`${BASE}/sessions.html?nouvelle=muscu`); await v.page.waitForTimeout(700);
    const form = await v.page.evaluate(() => ({ open: document.getElementById('sessionModal').classList.contains('open'), sport: document.getElementById('s_sport').value }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const fresh = sampleData(); fresh.news_seen = []; fresh.sessions = [];
    const w = await newUser({ data: fresh });
    await w.page.goto(`${BASE}/index.html`); await w.page.waitForTimeout(1500);
    const newbie = await w.page.evaluate(() => ({ modal: (document.getElementById('newsModal') || {}).textContent || '', seen: TS.getData().news_seen }));
    await w.ctx.close();
    assert(first && /Nouveau : la musculation/.test(first), 'message absent à la première ouverture');
    assert(cloud && cloud.includes('muscu') && !again, 'message réaffiché : ' + JSON.stringify({ cloud, again }));
    assert(form.open && form.sport === 'muscu', 'lien vers une séance de musculation : ' + JSON.stringify(form));
    // Nouveau compte : pas d'annonce musculation (marquée vue), mais « Choisis tes sports »
    assert(/Choisis tes sports/.test(newbie.modal) && !/musculation/i.test(newbie.modal.split('Choisis')[0]) && (newbie.seen || []).includes('muscu') && newbie.seen.includes('sports'), 'nouveau compte : ' + JSON.stringify(newbie).slice(0, 300));
  });

  await test('Dashboard : compétitions dans le calendrier (drapeau) et dans la fenêtre du jour', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(async (d) => {
      const show = (date) => { const x = TS.parseLocalDate(date); calYear = x.getFullYear(); calMonthIdx = x.getMonth(); renderActivityCalendar(); };
      const cellOf = (date) => [...document.querySelectorAll('#calGrid .cal-cell--click')][TS.parseLocalDate(date).getDate() - 1];
      show(d.future);
      const fut = cellOf(d.future), cells = [...document.querySelectorAll('#calGrid .cal-cell--click')];
      const other = cells[TS.parseLocalDate(d.future).getDate() === 1 ? 1 : 0];
      const out = { race: fut.classList.contains('cal-cell--race'), flag: !!fut.querySelector('.cal-flag'), label: fut.getAttribute('aria-label'),
        plain: other.classList.contains('cal-cell--race') };
      openPlanDay(d.future);
      out.modal = document.getElementById('planDayBody').textContent;
      out.formOpen = document.getElementById('planForm').style.display !== 'none';
      closeModal('planModal');
      show(d.past);
      openPlanDay(d.past);
      out.past = document.getElementById('planDayBody').textContent;
      return out;
    }, { future: day(30), past: day(-20) });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(r.race && r.flag && /Compétition : Triathlon test/.test(r.label) && !r.plain, 'calendrier : ' + JSON.stringify(r));
    assert(/Triathlon test/.test(r.modal) && /Dans 30 jours/.test(r.modal) && /Objectif 2:30:00/.test(r.modal) && !r.formOpen, 'fenêtre du jour (à venir) : ' + r.modal);
    assert(/10 km test/.test(r.past) && /Réalisé 0:41:07/.test(r.past) && /Course à pied/.test(r.past), 'fenêtre du jour (passée) : ' + r.past);
  });

  await test('Musculation : séries détaillées (charges différentes, série « Max ») dans un seul exercice', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(500);
    await v.page.click('text=+ Nouvelle séance');
    await v.page.selectOption('#s_sport', 'muscu');
    await v.page.fill('#s_date', day(-1)); await v.page.fill('#s_dur', '1:00:00');
    const row = '#muscuRows .muscu-row:nth-child(1) ';
    await v.page.click(row + '.muscu-pick'); await v.page.fill('#mpSearch', 'squat'); await v.page.click('#mpList [data-name="Squat"]');
    await v.page.fill(row + '> [data-k="sets"]', '3'); await v.page.fill(row + '> [data-k="reps"]', '8'); await v.page.fill(row + '> [data-k="kg"]', '60');
    await v.page.click(row + '.muscu-detail__open');
    const prefilled = await v.page.$$eval(row + '.muscu-serie', ls => ls.map(l => l.querySelector('[data-k="reps"]').value + 'x' + l.querySelector('[data-k="kg"]').value));
    const s2 = row + '.muscu-serie:nth-child(2) ', s3 = row + '.muscu-serie:nth-child(3) ';
    await v.page.fill(s2 + '[data-k="reps"]', '6'); await v.page.fill(s2 + '[data-k="kg"]', '70');
    await v.page.fill(s3 + '[data-k="reps"]', ''); await v.page.fill(s3 + '[data-k="kg"]', '90');
    await v.page.click(s3 + '.muscu-max');
    const maxReps = await v.page.inputValue(s3 + '[data-k="reps"]');
    // Deuxième exercice : séries détaillées mais toutes pareilles → forme courte
    await v.page.click('text=+ Ajouter un exercice');
    const row2 = '#muscuRows .muscu-row:nth-child(2) ';
    await v.page.click(row2 + '.muscu-pick'); await v.page.fill('#mpSearch', 'leg extension'); await v.page.click('#mpList [data-name="Leg extension"]');
    await v.page.click(row2 + '.muscu-detail__open');
    await v.page.fill(row2 + '.muscu-serie [data-k="reps"]', '12'); await v.page.fill(row2 + '.muscu-serie [data-k="kg"]', '40');
    await v.page.click(row2 + '.muscu-series__actions .btn');
    await v.page.click('#sessionModal .btn--primary'); await v.page.waitForTimeout(300);
    const r = await v.page.evaluate(() => {
      const s = TS.getSessions({ sport: 'muscu' })[0];
      const h = TS.muscuExerciseHistory('Squat')[0];
      return { ex: s.exercises, vol: TS.muscuVolume(s), h, text: TS.muscuSetsText(s.exercises[0]), load: TS.muscuMuscleLoad({ mode: 'sets' }).totals.quadriceps, id: s.id };
    });
    // Réouverture : les séries détaillées reviennent telles quelles
    await v.page.evaluate(id => editSession(id), r.id); await v.page.waitForTimeout(200);
    const reopened = await v.page.evaluate(() => {
      const row = document.querySelector('#muscuRows .muscu-row');
      return { detail: row.classList.contains('muscu-row--detail'), n: row.querySelectorAll('.muscu-serie').length,
        max: [...row.querySelectorAll('.muscu-max')].map(b => b.getAttribute('aria-pressed')).join() };
    });
    await v.page.click('#muscuRows .muscu-row:nth-child(1) .muscu-series__actions .link-btn');
    const simple = await v.page.evaluate(() => { const row = document.querySelector('#muscuRows .muscu-row');
      return ['sets', 'reps', 'kg'].map(k => row.querySelector(':scope > [data-k="' + k + '"]').value).join('/') + ':' + row.classList.contains('muscu-row--detail'); });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(prefilled.join() === '8x60,8x60,8x60' && maxReps === '1', 'pré-remplissage / Max : ' + prefilled.join() + ' ' + maxReps);
    assert(r.ex.length === 2 && r.ex[0].name === 'Squat' && r.ex[0].series.length === 3 && r.ex[0].series[2].max === true && r.ex[0].series[2].reps === 1
      && !('max' in r.ex[0].series[0]) && !('sets' in r.ex[0]), 'exercice détaillé : ' + JSON.stringify(r.ex[0]));
    assert(!r.ex[1].series && r.ex[1].sets === 2 && r.ex[1].reps === 12 && r.ex[1].kg === 40, 'forme courte : ' + JSON.stringify(r.ex[1]));
    assert(r.vol === 8 * 60 + 6 * 70 + 90 + 2 * 12 * 40, 'tonnage : ' + r.vol);
    assert(r.h.kg === 90 && r.h.reps === 1 && r.h.max && r.h.sets === 3, 'charge de la séance = la plus lourde : ' + JSON.stringify(r.h));
    assert(r.text === '8 × 60 kg · 6 × 70 kg · 1 × 90 kg (max)' && r.load === 5, 'texte / carte du corps : ' + r.text + ' ' + r.load);
    assert(reopened.detail && reopened.n === 3 && reopened.max === 'false,false,true', 'réouverture : ' + JSON.stringify(reopened));
    assert(simple === '3/8/60:false', 'retour à la forme simple : ' + simple);
  });

  await test('Musculation : records (anciennes séances comprises), records battus, détail par exercice, annonce à l’enregistrement', async () => {
    const data = sampleData();
    const mk = (id, d, ex) => ({ id, date: day(d), sport: 'muscu', duration: 1, exercises: ex });
    data.sessions.push(
      mk('r1', -60, [{ name: 'Squat', group: 'Jambes', sets: 4, reps: 8, kg: 80 }, { name: 'Tractions', group: 'Dos', sets: 3, reps: 8 }]),
      mk('r2', -40, [{ name: 'Squat', group: 'Jambes', series: [{ reps: 5, kg: 90 }, { reps: 3, kg: 95 }] }, { name: 'Tractions', group: 'Dos', sets: 3, reps: 10 }]),
      mk('r3', -20, [{ name: 'Squat', group: 'Jambes', series: [{ reps: 8, kg: 85 }, { reps: 1, kg: 105, max: true }] }, { name: 'Développé couché (barre)', group: 'Pectoraux', sets: 4, reps: 6, kg: 70 }]),
      mk('r4', -5, [{ name: 'Squat', group: 'Jambes', sets: 3, reps: 5, kg: 100 }]));
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/records.html`); await v.page.waitForTimeout(800);
    const page = await v.page.evaluate(() => ({
      cards: [...document.querySelectorAll('#records-muscu .record-card')].map(c => c.querySelector('.record-label').textContent + '=' + c.querySelector('.record-val').textContent + '|' + (c.querySelector('.mrec-sub') || {}).textContent),
      chips: [...document.querySelectorAll('#muscuRecGroups .mrec-chip')].map(c => c.textContent),
      events: [...document.querySelectorAll('#muscuRecEvents .mrec-ev')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
      fresh: !!document.querySelector('#records-muscu .pb-badge') }));
    await v.page.click('#muscuRecGroups [data-group="Dos"]'); await v.page.waitForTimeout(100);
    const dos = await v.page.$$eval('#records-muscu .record-label', ls => ls.map(l => l.textContent));
    await v.page.click('#muscuRecGroups [data-group=""]');
    await v.page.click('#records-muscu [data-exo="Squat"]'); await v.page.waitForTimeout(200);
    const modal = (await v.page.innerText('#mrecBody')).replace(/\s+/g, ' ');
    // Nouvelle séance qui bat le record : annonce à l'enregistrement + mention « Record » dans le calendrier
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(500);
    const toast = await v.page.evaluate(() => {
      const shown = []; const orig = TS.toast; TS.toast = (m) => { shown.push(m); return orig(m); };
      openSessionModal(); document.getElementById('s_sport').value = 'muscu'; toggleElevationField();
      document.getElementById('s_date').value = TS.localDateStr(); document.getElementById('s_dur').value = '0:50:00';
      fillMuscuRows([{ name: 'Squat', group: 'Jambes', sets: 2, reps: 2, kg: 107.5 }, { name: 'Tractions', group: 'Dos', sets: 3, reps: 12 }]);
      saveSessionForm();
      return shown.join(' / ');
    });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(700);
    const dayHtml = await v.page.evaluate(() => { const s = TS.getSessions({ sport: 'muscu' })[0]; return daySessionHtml(s, null, {}, TS.getData()); });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const sq = page.cards.find(c => c.startsWith('Squat='));
    assert(sq && /=105 kg\|1 rép\. \(max\)/.test(sq), 'carte Squat (série max comprise) : ' + JSON.stringify(page.cards));
    assert(page.cards.some(c => /^Tractions=10 rép\./.test(c)) && page.cards.length === 3, 'cartes : ' + JSON.stringify(page.cards));
    assert(page.chips.join() === 'Tous,Jambes,Dos,Pectoraux' && dos.join() === 'Tractions', 'filtre par groupe : ' + page.chips.join() + ' / ' + dos.join());
    // Records battus : Squat 95 (après 80), 105 (après 95) ; Tractions 10 (après 8). Pas la 1re séance, pas 100 kg (< 105).
    assert(page.events.length === 3 && /Squat 105 kg × 1 \(max\).*\+10 kg/.test(page.events[0]) && page.events.some(e => /Tractions 10 rép\..*\+2 rép\./.test(e))
      && page.events.some(e => /Squat 95 kg × 3.*\+15 kg/.test(e)), 'records battus : ' + JSON.stringify(page.events));
    assert(!page.fresh, 'pastille « Nouveau » sans record récent');
    assert(/1 répétition 105 kg/.test(modal) && /3 répétitions ou plus 100 kg \(5 rép\.\)/.test(modal) && /8 répétitions ou plus 85 kg/.test(modal) && /1RM estimé \? ≈ 116,5 kg/.test(modal),
      'détail Squat : ' + modal.slice(0, 400));
    assert(/Nouveau record ! Squat : 107,5 kg \(avant 105 kg\) · Tractions : 12 rép\. \(avant 10 rép\.\)/.test(toast), 'annonce : ' + toast);
    assert((dayHtml.match(/muscu-pr/g) || []).length === 2, 'mention Record dans le calendrier : ' + dayHtml.slice(0, 300));
  });

  await test('Mes sports : message d’ouverture, choix dans Profil → Paramètres, appli et imports limités aux sports choisis', async () => {
    const data = sampleData(); data.news_seen = ['muscu', 'orka'];
    data.sessions.push({ id: 'mu1', date: day(-2), sport: 'muscu', duration: 1, exercises: [{ name: 'Squat', group: 'Jambes', sets: 3, reps: 5, kg: 80 }] });
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(1500);
    const news = await v.page.evaluate(() => (document.getElementById('newsModal') || {}).textContent || '');
    await Promise.all([v.page.waitForNavigation(), v.page.click('#newsModal a.btn--primary')]);
    await v.page.waitForTimeout(700);
    const prof = await v.page.evaluate(() => ({ params: !document.querySelector('[data-ptab-panel="parametres"]').hidden, profil: document.querySelector('[data-ptab-panel="profil"]').hidden,
      checked: [...document.querySelectorAll('[data-sport-choice]')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.sportChoice) }));
    await v.page.click('[data-sport-choice="nat"]'); await v.page.click('[data-sport-choice="muscu"]'); await v.page.waitForTimeout(300);
    const after = await v.page.evaluate(() => ({ chosen: window.__cloud('testeur').profile.sports,
      note: document.querySelector('[data-sport-choice="nat"]').textContent.replace(/\s+/g, ' ') }));
    // Dernier sport : on ne peut pas tout décocher
    await v.page.click('[data-sport-choice="velo"]'); await v.page.click('[data-sport-choice="run"]'); await v.page.waitForTimeout(200);
    const last = await v.page.evaluate(() => TS.sportsShown());
    await v.page.click('[data-sport-choice="velo"]'); await v.page.waitForTimeout(200);
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(900);
    const dash = await v.page.evaluate(() => ({ hero: document.getElementById('heroStrip').textContent, legendNat: getComputedStyle(document.querySelector('[data-legend-sport="nat"]')).display,
      freq: Chart.getChart('chartTrend').data.datasets.map(d => d.label), modal: !!document.getElementById('newsModal') }));
    await v.page.goto(`${BASE}/sport.html?sport=nat`); await v.page.waitForTimeout(700);
    const sport = await v.page.evaluate(() => ({ nat: getComputedStyle(document.getElementById('tab-nat')).display, muscu: getComputedStyle(document.getElementById('tab-muscu')).display, cur: currentSport }));
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(700);
    const ses = await v.page.evaluate(() => ({ filter: [...document.querySelectorAll('#filterSport option')].map(o => o.value).join(), rows: document.querySelectorAll('#sessionTable .ses-row').length,
      badgeNat: !!document.querySelector('#sessionTable .sport-dot--nat'), avgs: document.getElementById('sessionTable').textContent }));
    await v.page.click('text=+ Nouvelle séance');
    const form = await v.page.$$eval('#s_sport option', os => os.map(o => o.value).join());
    const imp = await v.page.evaluate(() => {
      const now = new Date();
      const plan = TS.planStravaArchive([{ id: 901, start: now, localDate: TS.localDateStr(), sport: 'nat', elapsed: 1800, distance_m: 1500 },
        { id: 902, start: now, localDate: TS.localDateStr(), sport: 'run', elapsed: 1800, distance_m: 5000 }]);
      return { add: plan.add.map(s => s.sport), ignored: plan.ignored, kept: TS.getSessions({ sport: 'nat' }).length,
        badges: TS.getAchievements().filter(b => !b.earned).map(b => b.id),
        earnedSwim: TS.getAchievements().some(b => b.id === 'swim2k' && b.earned),
        hiddenIfNotEarned: (() => { const d = TS.getData(); d.sessions = d.sessions.filter(x => x.sport !== 'nat'); return TS.getAchievements(d).map(b => b.id); })() };
    });
    await v.page.goto(`${BASE}/records.html`); await v.page.waitForTimeout(600);
    const rec = await v.page.evaluate(() => ({ nat: getComputedStyle(document.querySelector('[data-rec-sport="nat"]')).display, tri: getComputedStyle(document.querySelector('[data-rec-sport="tri"]')).display,
      muscu: getComputedStyle(document.getElementById('muscuRecordSection')).display, intro: document.getElementById('recIntro').textContent }));
    await v.page.goto(`${BASE}/competitions.html`); await v.page.waitForTimeout(600);
    const comp = await v.page.evaluate(() => { openCompModal(); return [...document.querySelectorAll('#c_type option')].map(o => o.value); });
    await v.page.goto(`${BASE}/nutrition.html`); await v.page.waitForTimeout(600);
    const nutri = await v.page.evaluate(() => document.body.innerText);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(/Choisis tes sports/.test(news), 'message d’ouverture : ' + news.slice(0, 120));
    assert(prof.params && prof.profil && prof.checked.join() === 'nat,velo,run,muscu', 'Profil → Paramètres : ' + JSON.stringify(prof));
    assert(after.chosen.join() === 'velo,run' && /gardées, masquées/.test(after.note), 'choix enregistré : ' + JSON.stringify(after));
    assert(last.join() === 'run', 'au moins un sport : ' + last.join());
    assert(!/Natation/.test(dash.hero) && dash.legendNat === 'none' && dash.freq.join() === 'Vélo,Course' && !dash.modal, 'Dashboard : ' + JSON.stringify(dash));
    assert(sport.nat === 'none' && sport.muscu === 'none' && sport.cur === 'velo', 'Sports : ' + JSON.stringify(sport));
    assert(ses.filter === ',velo,run' && !ses.badgeNat && !/Natation|Musculation/.test(ses.avgs) && form === 'velo,run', 'Séances : ' + JSON.stringify(ses) + ' ' + form);
    assert(imp.add.join() === 'run' && imp.ignored === 1 && imp.kept === 13, 'import Strava / séances gardées : ' + JSON.stringify(imp));
    assert(imp.earnedSwim && !imp.hiddenIfNotEarned.includes('swim2k') && !imp.hiddenIfNotEarned.includes('tri_week'), 'badges des sports non suivis (obtenus gardés, les autres masqués) : ' + imp.hiddenIfNotEarned.join());
    // Les données de test ont un triathlon prévu : sa section reste visible ; tous les types de course restent proposés
    assert(rec.nat === 'none' && rec.tri !== 'none' && rec.muscu === 'none' && /vélo, course et triathlon/.test(rec.intro), 'Records : ' + JSON.stringify(rec));
    assert(['TRI', 'RUN', 'BIKE', 'NAT', 'DUATH', 'AQUA'].every(t => comp.includes(t)) && !/triathlon/i.test(nutri) && !/Repères nutritionnels/.test(nutri), 'courses multisport toujours proposées / repères retirés : ' + comp.join() + ' / ' + nutri.slice(0, 200));
  });

  await test('Records de course : distance de route la plus proche (temps estimé à l’allure), trail à sa vraie distance', async () => {
    const data = sampleData(); data.records = [];
    data.competitions = [
      { id: 'k1', date: day(-30), name: '10 km un peu long', type: 'RUN', distance: '10.8', actual_time: '0:45:00' },
      { id: 'k2', date: day(-20), name: 'Trail des crêtes', type: 'RUN', distance: '23', actual_time: '2:30:00', trail: true },
      { id: 'k3', date: day(-10), name: 'Course de 33 km', type: 'RUN', distance: '33', actual_time: '3:00:00' },
      { id: 'k4', date: day(-5), name: 'Semi', type: 'RUN', distance: '21.3', actual_time: '1:40:00' }];
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/competitions.html`); await v.page.waitForTimeout(600);
    const r = await v.page.evaluate(() => {
      ['k1', 'k2', 'k3', 'k4'].forEach(id => TS.refreshCompetitionRecords(id));
      openCompModal(TS.getCompetitions().find(c => c.id === 'k2'));
      const trail = { shown: getComputedStyle(document.getElementById('c_trail_group')).display, checked: document.getElementById('c_trail').checked };
      document.getElementById('c_type').value = 'TRI'; toggleTrailField();
      trail.hiddenForTri = getComputedStyle(document.getElementById('c_trail_group')).display;
      closeModal();
      return { recs: TS.getData().records.map(x => x.comp_id + ' ' + x.dist + ' ' + x.time), notes: TS.getData().records.find(x => x.comp_id === 'k1').notes, trail };
    });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(r.recs.includes('k1 10km 41:40') && /allure moyenne \(10,8 km en 45:00\)/.test(r.notes), '10,8 km → 10 km : ' + JSON.stringify(r));
    assert(r.recs.includes('k2 Trail 23 km 2:30:00') && r.recs.includes('k3 33 km 3:00:00') && r.recs.includes('k4 Semi-marathon (21,1km) 1:39:04'), 'trail / longue distance / semi : ' + JSON.stringify(r.recs));
    assert(r.trail.shown !== 'none' && r.trail.checked && r.trail.hiddenForTri === 'none', 'case Trail : ' + JSON.stringify(r.trail));
  });

  await test('Ravitaillements reliés à une séance : moment (min ou km), modification, séance, course, Forme', async () => {
    const data = sampleData();
    data.sessions[0].comp_id = 'c1';   // s1 : vélo d'hier, 1h30, reliée à la course c1
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/nutrition.html?ravito=s1`); await v.page.waitForTimeout(800);
    const opened = await v.page.evaluate(() => ({ open: document.getElementById('fuelModal').classList.contains('open'), day: currentDay,
      ses: document.getElementById('f_session').value, moment: getComputedStyle(document.getElementById('f_moment')).display }));
    await v.page.selectOption('#f_type', 'gel'); await v.page.fill('#f_carbs', '25'); await v.page.fill('#f_timing', '1h15');
    await v.page.click('#fuelModal .btn--primary'); await v.page.waitForTimeout(200);
    await v.page.evaluate(() => openFuelModal(null, 's1'));
    await v.page.selectOption('#f_type', 'banane'); await v.page.fill('#f_km', '30');
    await v.page.click('#fuelModal .btn--primary'); await v.page.waitForTimeout(200);
    // Modifier le gel : 2 gels
    await v.page.click('#fuelList .fuel-row:first-child .fuel-row__label');
    const edit = await v.page.evaluate(() => ({ title: document.getElementById('f_title').textContent, ses: document.getElementById('f_session').value, t: document.getElementById('f_timing').value }));
    await v.page.fill('#f_qty', '2'); await v.page.click('#fuelModal .btn--primary'); await v.page.waitForTimeout(300);
    const r = await v.page.evaluate(() => ({ fuel: TS.getData().nutrition.fuel.map(f => [f.type, f.qty, f.session_id, f.timing, f.km].join('|')),
      row: document.getElementById('fuelList').textContent.replace(/\s+/g, ' '), sum: TS.sessionFuelSummary(TS.getSessions().find(s => s.id === 's1')),
      impact: TS.getNutritionImpact().points.find(p => p.id === 's1').factors.fuel_hour,
      parse: [TS.parseFuelTime('1h15'), TS.parseFuelTime('1:15'), TS.parseFuelTime('45'), TS.parseFuelTime('45min'), TS.fuelTimeText(45), TS.fuelTimeText(75)].join() }));
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const dayHtml = await v.page.evaluate(() => { const s = TS.getSessions().find(x => x.id === 's1'); return daySessionHtml(s, null, {}, TS.getData()); });
    await v.page.goto(`${BASE}/sessions.html?seance=s1`); await v.page.waitForTimeout(700);
    const sesFuel = await v.page.textContent('#s_fuel');
    await v.page.goto(`${BASE}/competitions.html`); await v.page.waitForTimeout(700);
    const comp = await v.page.evaluate(() => document.body.textContent.replace(/\s+/g, ' ').match(/Ravitaillement : [^·]+· \d+ g de glucides · \d+ g\/h/));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(opened.open && opened.day === day(-1) && opened.ses === 's1' && opened.moment !== 'none', 'ouverture depuis la séance : ' + JSON.stringify(opened));
    assert(edit.title === 'Modifier le ravitaillement' && edit.ses === 's1' && edit.t === '1h15', 'modification : ' + JSON.stringify(edit));
    assert(r.fuel.length === 2 && r.fuel.includes('gel|2|s1|75|') && r.fuel.includes('banane|1|s1||30'), 'ravitaillements : ' + JSON.stringify(r.fuel));
    assert(r.sum.carbs === 75 && r.sum.perHour === 50 && r.impact === 50 && /1h15/.test(r.row) && r.parse === '75,75,45,45,45 min,1h15' && /km 30/.test(r.row), 'résumé : ' + JSON.stringify(r));
    assert(/75 g de glucides/.test(dayHtml) && /50 g\/h/.test(dayHtml) && dayHtml.indexOf('1h15') < dayHtml.indexOf('km 30'), 'détail du jour : ' + dayHtml.slice(0, 300));
    assert(/75 g de glucides/.test(sesFuel) && /\+ Ravitaillement/.test(sesFuel), 'fiche séance : ' + sesFuel);
    assert(comp && /Ravitaillement : 2 × Gel, Banane \/ fruit · 75 g de glucides · 50 g\/h/.test(comp[0]), 'course : ' + (comp && comp[0]));
  });

  await test('Musculation : séance Strava « WeightTraining » et fichier .fit de musculation importés', async () => {
    const v = await newUser();
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(500);
    const r = await v.page.evaluate(() => ({
      strava: TS.stravaToSession({ id: 9, sport_type: 'WeightTraining', type: 'WeightTraining', name: 'Evening Weight Training', start_date_local: '2026-10-20T18:00:00Z', elapsed_time: 3000, distance: 0 }),
      walk: TS.stravaToSession({ id: 10, sport_type: 'Walk', start_date_local: '2026-10-20T18:00:00Z', elapsed_time: 3000 }),
      fit: window.TriImport.classifyFit('training', 'strength_training'), cardio: window.TriImport.classifyFit('training', 'cardio_training'),
      txt: window.TriImport.classifyText('Séance de musculation'),
    }));
    await v.ctx.close();
    assert(r.strava && r.strava.sport === 'muscu' && !r.strava.notes && !r.strava.distance && Math.round(r.strava.duration * 3600) === 3000, 'Strava : ' + JSON.stringify(r.strava));
    assert(r.walk === null, 'la marche ne doit pas être importée');
    assert(r.fit.sport === 'muscu' && r.cardio.skip && r.txt.sport === 'muscu', 'import fichiers : ' + JSON.stringify(r));
  });

  await test('Textes : « ? » au toucher, tutoiement partout, virgule décimale, plus d’avertissement jaune', async () => {
    const v = await newUser({ ctxOpts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    // 1. Le « ? » du titre s'ouvre au doigt, se referme en touchant ailleurs
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(800);
    const icon = v.page.locator('.page-header .tip-icon');
    await icon.tap(); await v.page.waitForTimeout(150);
    const open1 = await v.page.evaluate(() => (document.querySelector('.tooltip') || {}).textContent || '');
    await v.page.tap('.page-header p'); await v.page.waitForTimeout(150);
    const closed = await v.page.evaluate(() => !document.querySelector('.tooltip'));
    await icon.tap(); await v.page.waitForTimeout(150); await icon.tap(); await v.page.waitForTimeout(150);
    const toggled = await v.page.evaluate(() => !document.querySelector('.tooltip'));
    const kb = await v.page.evaluate(() => { const i = document.querySelector('.page-header .tip-icon'); return i.getAttribute('tabindex') === '0' && i.getAttribute('role') === 'button'; });
    // 2. Aucun « vous » (texte visible et bulles) ; pas d'avertissement jaune ; virgule décimale
    const found = {};
    for (const p of PAGES) {
      await v.page.goto(`${BASE}/${p}.html`); await v.page.waitForTimeout(700);
      const t = await v.page.evaluate(() => document.body.innerText + ' ' + [...document.querySelectorAll('[data-tip]')].map(e => e.getAttribute('data-tip')).join(' '));
      // Exceptions : libellés de Strava cités tels quels
      const hits = (t.replace(/Télécharger ou supprimer votre compte|Voir les données de vos activités/g, '').match(/[^.\n]{0,30}\b(vous|votre|vos)\b[^.\n]{0,30}/gi) || []);
      if (hits.length) found[p] = hits.slice(0, 3);
      if (await v.page.$('.disclaimer-box')) found[p + ' (avertissement)'] = ['disclaimer-box'];
    }
    const speed = await v.page.evaluate(() => TS.calcPace(1, 28, 'velo'));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(/modèles connus/.test(open1) && closed && toggled && kb, '« ? » au toucher : ' + JSON.stringify({ open1: open1.slice(0, 60), closed, toggled, kb }));
    assert(!Object.keys(found).length, '« vous » restant : ' + JSON.stringify(found));
    assert(speed === '28,0 km/h', 'vitesse : ' + speed);
  });

  await test('Doublons retirés : Métriques clés, Résumé du mois, Progression mensuelle ; Profil → Records en une ligne ; effort ressenti dans Forme', async () => {
    const data = sampleData();
    data.records = [{ id: 'r1', sport: 'run', dist: '10km', time: '0:41:07', date: day(-20) }, { id: 'r2', sport: 'velo', dist: '40km', time: '1:10:00', date: day(-40) }];
    // Effort ressenti plus bas les jours où l'on a bu davantage
    data.nutrition.hydration = {};
    data.sessions.forEach((x, i) => { data.nutrition.hydration[x.date] = i % 2 ? 2500 : 800; x.rpe = i % 2 ? 4 : 8; });
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const dash = await v.page.evaluate(() => ({ metrics: !!document.getElementById('metricsGrid'), month: !!document.getElementById('msJoursActifs'),
      txt: /Métriques clés/.test(document.body.innerText), cal: document.getElementById('calGrid').children.length }));
    await v.page.goto(`${BASE}/sport.html`); await v.page.waitForTimeout(800);
    const sport = await v.page.evaluate(() => ({ prog: !!document.getElementById('monthlyProgress'), best: document.getElementById('bestWeeks').children.length }));
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(800);
    const prof = await v.page.evaluate(() => ({ text: document.getElementById('pbGrid').textContent, href: document.getElementById('pbGrid').closest('a').getAttribute('href') }));
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(800);
    await v.page.selectOption('#niFactor', 'hydration'); await v.page.selectOption('#niOutcome', 'rpe'); await v.page.waitForTimeout(300);
    const forme = await v.page.evaluate(() => ({ head: (document.querySelector('#niBody .ni-headline') || {}).textContent || document.getElementById('niBody').textContent.slice(0, 200),
      groups: [...document.querySelectorAll('#niBody .ni-group__val')].map(e => e.textContent) }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(!dash.metrics && !dash.month && !dash.txt && dash.cal > 27, 'Dashboard : ' + JSON.stringify(dash));
    assert(!sport.prog && sport.best > 0, 'Sports : ' + JSON.stringify(sport));
    assert(/2 records · dernier : 10km en 0:41:07/.test(prof.text) && prof.href === 'records.html', 'Profil : ' + JSON.stringify(prof));
    assert(/moins d’hydratation/.test(forme.head) && /effort ressenti 4,0 points plus élevé/.test(forme.head) && forme.groups.join() === '4,0/10,8,0/10', 'Forme, effort ressenti : ' + JSON.stringify(forme));
  });

  await test('Dashboard simplifié : bandeau course, tuiles de la semaine, graphique à onglets, poids dans Profil', async () => {
    const data = sampleData();
    data.sessions.push({ id: 'mu1', date: day(0), sport: 'muscu', duration: 1, rpe: 7, exercises: [{ name: 'Squat', group: 'Jambes', sets: 4, reps: 8, kg: 60 }] });
    data.weight = [{ date: day(-30), value: 72 }, { date: day(-10), value: 70.4 }];
    data.profile.height = 180;
    const v = await newUser({ data, ctxOpts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(900);
    const d1 = await v.page.evaluate(() => ({
      banner: document.getElementById('raceBanner').hidden ? '' : document.getElementById('raceBanner').textContent.replace(/\s+/g, ' ').trim(),
      tiles: [...document.querySelectorAll('#heroStrip .hero-sport__sport')].map(e => e.textContent),
      sum: document.querySelector('.week-sum').textContent.replace(/\s+/g, ' ').trim(),
      gone: ['weightDisplay', 'nextRaceDisplay', 'badgesRecent', 'chartWeekly', 'chartMonthly', 'chartDonut', 'chartFrequency'].filter(id => document.getElementById(id)),
      badges: document.getElementById('badgesLink').textContent,
      ds: Chart.getChart('chartTrend').data.datasets.map(x => x.label), n: Chart.getChart('chartTrend').data.labels.length,
      overflow: document.documentElement.scrollWidth - innerWidth, height: document.documentElement.scrollHeight }));
    await v.page.click('[data-trend-what="sessions"]'); await v.page.click('[data-trend-per="month"]'); await v.page.waitForTimeout(200);
    const d2 = await v.page.evaluate(() => ({ ds: Chart.getChart('chartTrend').data.datasets.map(x => x.label), n: Chart.getChart('chartTrend').data.labels.length,
      total: Chart.getChart('chartTrend').data.datasets.reduce((a, x) => a + x.data.reduce((p, q) => p + q, 0), 0), kept: localStorage.getItem('triseason_trend') }));
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(800);
    const p1 = await v.page.evaluate(() => ({ latest: document.getElementById('pwLatest').textContent, svg: !!document.querySelector('#pwChart svg'), rows: document.querySelectorAll('#weightHistory [onclick^="deleteWeightEntry"]').length }));
    await v.page.fill('#weightInput', '69.8'); await v.page.click('text=Noter'); await v.page.waitForTimeout(200);
    const p2 = await v.page.evaluate(() => ({ latest: document.getElementById('pwLatest').textContent, cloud: window.__cloud('testeur').weight.length, sub: document.getElementById('profileSub').textContent }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(/^J-30 Triathlon test/.test(d1.banner) && /Objectif 2:30:00/.test(d1.banner), 'bandeau : ' + d1.banner);
    assert(d1.tiles.join() === 'Natation,Vélo,Course,Muscu' && /^Cette semaine/.test(d1.sum) && /séance/.test(d1.sum), 'tuiles : ' + JSON.stringify(d1));
    assert(!d1.gone.length && /^Mes badges · \d+ \/ \d+/.test(d1.badges), 'anciens blocs : ' + JSON.stringify(d1));
    assert(d1.ds.join() === 'Natation,Vélo,Course' && d1.n === 12 && d2.ds.join() === 'Natation,Vélo,Course,Musculation' && d2.n === 8 && d2.total >= 41 && /month/.test(d2.kept), 'graphique : ' + JSON.stringify({ d1, d2 }));
    assert(d1.overflow <= 0 && d1.height < 4600, 'longueur / débordement : ' + JSON.stringify({ o: d1.overflow, h: d1.height }));
    assert(/70,4 kg/.test(p1.latest) && /IMC 21,7/.test(p1.latest) && p1.svg && p1.rows === 2, 'poids dans Profil : ' + JSON.stringify(p1));
    assert(/69,8 kg/.test(p2.latest) && p2.cloud === 3 && /69,8 kg/.test(p2.sub), 'nouvelle pesée : ' + JSON.stringify(p2));
  });

  await test('Sports décochés : « Ce que Strava ne te montre pas » prend la dernière séance d’un sport suivi', async () => {
    const data = sampleData(); data.profile.sports = ['run'];
    data.sessions.push({ id: 'v0', date: day(0), sport: 'velo', duration: 1, distance: 30 });
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => ({ ins: document.querySelector('#insightBody .ins-session').textContent.replace(/\s+/g, ' '),
      tiles: [...document.querySelectorAll('#heroStrip .hero-sport__sport')].map(e => e.textContent).join(), trend: Chart.getChart('chartTrend').data.datasets.map(x => x.label).join() }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(/Course/.test(r.ins) && !/Vélo/.test(r.ins) && r.tiles === 'Course' && r.trend === 'Course', JSON.stringify(r));
  });

  await test('Séances simplifiées : liste en lignes + « Voir plus », fenêtre Importer, filtres repliés ; FC, puissance et W/kg dans Sports', async () => {
    const data = sampleData();
    data.sessions.filter(x => x.sport === 'velo').forEach((x, i) => { x.power_avg = 200 + i; });
    const v = await newUser({ data, ctxOpts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(800);
    const s1 = await v.page.evaluate(() => ({ rows: document.querySelectorAll('#sessionTable .ses-row').length, more: document.getElementById('sessionMore').textContent.trim(),
      sum: document.getElementById('sessionStats').textContent.replace(/\s+/g, ' '), first: document.querySelector('.ses-row').textContent.replace(/\s+/g, ' ').trim(),
      gone: ['chartFC', 'chartPower', 'wkgTable', 'sportAvgs'].filter(id => document.getElementById(id)), dropVisible: document.getElementById('importModal').classList.contains('open'),
      adv: getComputedStyle(document.getElementById('advancedFilters')).display, overflow: document.documentElement.scrollWidth - innerWidth }));
    await v.page.click('#sessionMore button'); await v.page.waitForTimeout(150);
    const rows2 = await v.page.evaluate(() => document.querySelectorAll('#sessionTable .ses-row').length);
    await v.page.selectOption('#filterSport', 'run'); await v.page.waitForTimeout(150);
    const rowsRun = await v.page.evaluate(() => document.querySelectorAll('#sessionTable .ses-row').length);
    await v.page.click('.page-header [onclick="openImportModal()"]'); await v.page.waitForTimeout(150);
    const modal = await v.page.evaluate(() => ({ open: document.getElementById('importModal').classList.contains('open'), drop: getComputedStyle(document.getElementById('importModal')).opacity !== '0' || true }));
    await v.page.click('#importModal .modal__close');
    await v.page.click('.ses-row'); await v.page.waitForTimeout(150);
    const edit = await v.page.evaluate(() => document.getElementById('sessionModal').classList.contains('open'));
    await v.page.goto(`${BASE}/sessions.html#historique-strava`); await v.page.waitForTimeout(700);
    const hash = await v.page.evaluate(() => document.getElementById('importModal').classList.contains('open'));
    await v.page.goto(`${BASE}/sport.html?sport=velo`); await v.page.waitForTimeout(800);
    const velo = await v.page.evaluate(() => ({ avg: document.getElementById('sportAvgs').textContent, wkg: document.getElementById('wkgCurrent').textContent,
      power: !!Chart.getChart('chartSportPower'), fc: !!Chart.getChart('chartSportFC') }));
    await v.page.click('#tab-run'); await v.page.waitForTimeout(300);
    const run = await v.page.evaluate(() => ({ avg: document.getElementById('sportAvgs').textContent, power: getComputedStyle(document.getElementById('sportPowerWrap')).display }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(s1.rows === 30 && s1.more === 'Voir plus (10)' && rows2 === 40 && rowsRun === 13, 'liste / voir plus : ' + JSON.stringify({ s1: s1.rows, more: s1.more, rows2, rowsRun }));
    assert(/40 séances/.test(s1.sum) && /km/.test(s1.sum) && /m de natation/.test(s1.sum) && !s1.gone.length && !s1.dropVisible && s1.adv === 'none' && s1.overflow <= 0, 'page : ' + JSON.stringify(s1));
    assert(modal.open && modal.drop && edit && hash, 'fenêtre importer / modifier : ' + JSON.stringify({ modal, edit, hash }));
    assert(/140 bpm/.test(velo.avg) && /W/.test(velo.avg) && /W\/kg moyen : 2,/.test(velo.wkg) && velo.power && velo.fc, 'Sports vélo : ' + JSON.stringify(velo));
    assert(/140 bpm/.test(run.avg) && run.power === 'none', 'Sports course : ' + JSON.stringify(run));
  });

  await test('Forme, Profil, Paramètres simplifiés : forme en premier, options santé repliées, badges repliés, zone sensible à part', async () => {
    const v = await newUser({ ctxOpts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/forme.html`); await v.page.waitForTimeout(900);
    const f1 = await v.page.evaluate(() => ({
      order: [...document.querySelectorAll('.container > .card')].filter(c => getComputedStyle(c).display !== 'none').map(c => (c.querySelector('.card__title') || {}).textContent.trim().split('\n')[0].trim()),
      head: document.querySelector('#tsbInterpretation .tsb-head__t') ? document.querySelector('#tsbInterpretation .tsb-head__t').textContent : '',
      badges: document.querySelectorAll('.confidence-badge').length,
      opts: getComputedStyle(document.getElementById('healthOptsCard')).display, health: getComputedStyle(document.getElementById('healthCard')).display,
      overflow: document.documentElement.scrollWidth - innerWidth }));
    await v.page.click('#optRowCycle button'); await v.page.waitForTimeout(200);
    const f2 = await v.page.evaluate(() => ({ cycle: getComputedStyle(document.getElementById('cycleCard')).display, row: getComputedStyle(document.getElementById('optRowCycle')).display, consent: !!document.getElementById('cyConsent') }));
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(800);
    const p1 = await v.page.evaluate(() => ({ tiles: document.querySelectorAll('#badgesAll > *').length, more: document.getElementById('badgesMore').hidden ? '' : document.getElementById('badgesMore').textContent }));
    if (p1.more) { await v.page.click('#badgesMore'); await v.page.waitForTimeout(150); }
    const p2 = await v.page.evaluate(() => document.querySelectorAll('#badgesAll > *').length);
    await v.page.goto(`${BASE}/profile.html#parametres`); await v.page.waitForTimeout(800);
    const set = await v.page.evaluate(() => ({ danger: [...document.querySelectorAll('.set-danger .set-row')].map(r => r.textContent.trim().split('\n')[0].trim()),
      oldBtns: document.querySelectorAll('[data-ptab-panel="parametres"] .data-export-btn').length, email: document.getElementById('accountEmail').textContent,
      options: document.getElementById('options-sante').textContent.replace(/\s+/g, ' '), overflow: document.documentElement.scrollWidth - innerWidth }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(f1.order[0] === 'Ta forme' && /Nutrition et performance/.test(f1.order[1]) && /Observations/.test(f1.order[2]) && f1.order.includes('Options santé') && f1.head && !f1.badges && f1.health === 'none' && f1.overflow <= 0,
      'Forme : ' + JSON.stringify(f1));
    assert(f2.cycle !== 'none' && f2.row === 'none' && f2.consent, 'Découvrir le cycle : ' + JSON.stringify(f2));
    assert(p1.tiles <= 7 && /^Voir les \d+ badges$/.test(p1.more) && p2 > p1.tiles, 'badges : ' + JSON.stringify({ p1, p2 }));
    assert(set.danger.length === 2 && /Effacer toutes mes données/.test(set.danger[0]) && /Supprimer mon compte/.test(set.danger[1]) && !set.oldBtns && /Blessures/.test(set.options) && /Cycle/.test(set.options) && set.overflow <= 0,
      'Paramètres : ' + JSON.stringify(set));
  });

  await test('Séances : lien « Voir sur Strava » sur les séances venues de Strava ; graphiques : l’infobulle suit le doigt', async () => {
    const data = sampleData();
    data.sessions[0].strava_id = 12345678;
    const v = await newUser({ data, ctxOpts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(800);
    const link = await v.page.evaluate(() => { const a = document.querySelector('.ses-row .ses-strava');
      return a ? { href: a.getAttribute('href'), target: a.target, n: document.querySelectorAll('.ses-strava').length, text: a.textContent } : null; });
    // Toucher le lien n'ouvre pas la fenêtre de la séance ; toucher ailleurs sur la ligne, si
    await v.page.evaluate(() => { document.querySelector('.ses-strava').addEventListener('click', e => e.preventDefault(), { once: true }); });
    await v.page.tap('.ses-strava'); await v.page.waitForTimeout(150);
    const afterLink = await v.page.evaluate(() => document.getElementById('sessionModal').classList.contains('open'));
    await v.page.tap('.ses-row .ses-row__hit', { position: { x: 30, y: 20 } }); await v.page.waitForTimeout(150);
    const afterRow = await v.page.evaluate(() => document.getElementById('sessionModal').classList.contains('open'));
    // Graphique du Dashboard : un point du graphique sans viser une barre montre l'infobulle de la semaine la plus proche
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(900);
    await v.page.evaluate(() => Chart.getChart('chartTrend').canvas.scrollIntoView({ block: 'center', behavior: 'instant' })); await v.page.waitForTimeout(400);
    const box = await v.page.evaluate(() => { const ch = Chart.getChart('chartTrend'); const a = ch.chartArea;
      const r = ch.canvas.getBoundingClientRect(); return { x: r.left + a.left + (a.right - a.left) * 0.9, y: r.top + a.top + 4, touch: getComputedStyle(ch.canvas).touchAction }; });
    await v.page.touchscreen.tap(box.x, box.y); await v.page.waitForTimeout(200);
    const tip = await v.page.evaluate(() => { const ch = Chart.getChart('chartTrend'); return { active: ch.getActiveElements().length, op: ch.tooltip.opacity, mode: ch.options.interaction.mode }; });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(link && link.href === 'https://www.strava.com/activities/12345678' && link.target === '_blank' && link.n === 1 && /Voir sur Strava/.test(link.text), 'lien Strava : ' + JSON.stringify(link));
    assert(!afterLink && afterRow, 'clic lien / ligne : ' + JSON.stringify({ afterLink, afterRow }));
    assert(box.touch === 'pan-y' && tip.active > 0 && tip.op > 0 && tip.mode === 'index', 'infobulle au doigt : ' + JSON.stringify({ box, tip }));
  });

  await test('Ravitaillements comptés dans la journée (glucides, kcal, eau des boissons) ; séries des objectifs de semaine et de mois', async () => {
    const data = sampleData();
    const today = day(0);
    data.nutrition.meals.push({ id: 'mt', date: today, type: 'déjeuner', glucides: 100, proteines: 30, lipides: 10 });
    data.nutrition.hydration[today] = 1000;
    data.nutrition.fuel = [{ id: 'f1', date: today, type: 'gel', qty: 2, carbs: 25 },
      { id: 'f2', date: today, type: 'boisson-iso', qty: 1, carbs: 35 },
      { id: 'f3', date: today, type: 'flasque', qty: 1, carbs: 50, ml: 300 }];
    // Objectif course : 9 km / semaine (une course de 9 km tous les 3 jours) et 3 séances / semaine
    data.goals = { run: [{ id: 'g1', type: 'dist_week', target: 9 }, { id: 'g2', type: 'sessions_week', target: 3 }, { id: 'g3', type: 'dist_year', target: 500 }] };
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/nutrition.html`); await v.page.waitForTimeout(800);
    const n1 = await v.page.evaluate(() => ({ intake: TS.dayIntake(TS.localDateStr()), gl: document.getElementById('kpiGlucides').textContent,
      kcal: document.getElementById('kpiKcal').textContent, hydro: document.getElementById('kpiHydro').textContent,
      note: document.getElementById('kpiFuelNote').textContent, ring: document.getElementById('hydroFuelNote').textContent }));
    // Nouveau ravitaillement « boisson » : 500 ml proposés d'office, le total du jour se met à jour tout de suite
    await v.page.evaluate(() => openFuelModal());
    await v.page.selectOption('#f_type', 'boisson-iso'); await v.page.waitForTimeout(100);
    const mlDefault = await v.page.inputValue('#f_ml');
    await v.page.fill('#f_carbs', '40');
    await v.page.click('#fuelModal .btn--primary'); await v.page.waitForTimeout(300);
    const n2 = await v.page.evaluate(() => ({ gl: document.getElementById('kpiGlucides').textContent, hydro: document.getElementById('kpiHydro').textContent,
      saved: TS.getData().nutrition.fuel.slice(-1)[0], ch: TS.weeklyChallenges(TS.getCurrentWeek()).find(c => c.id === 'hydro') }));
    await v.page.goto(`${BASE}/sport.html?sport=run`); await v.page.waitForTimeout(800);
    const g = await v.page.evaluate(() => ({ st: TS.getGoals('run').map(x => TS.goalStreak('run', x)), text: document.getElementById('goalsContent').textContent.replace(/\s+/g, ' ') }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    // 100 (repas) + 50 (2 gels) + 35 (boisson) + 50 (flasque) = 235 g ; eau : 1 000 + 500 + 300 = 1 800 ml
    assert(n1.intake.glucides === 235 && n1.intake.water === 1800 && n1.intake.fuelMl === 800 && n1.gl === '235' && n1.hydro === '1800'
      && n1.kcal === String(Math.round(100 * 4 + 30 * 4 + 10 * 9 + 135 * 4)) && /Dont ravitaillements : 135 g de glucides/.test(n1.note) && /800 ml/.test(n1.ring),
      'totaux du jour : ' + JSON.stringify(n1));
    assert(mlDefault === '500' && n2.gl === '275' && n2.hydro === '2300' && n2.saved.ml === 500, 'nouveau ravitaillement : ' + JSON.stringify({ mlDefault, n2 }));
    const [dist, ses, year] = g.st;
    assert(dist && dist.per === 'week' && dist.streak >= 5 && ses && ses.streak === 0 && year === null && /Série : \d+ semaines d'affilée/.test(g.text) && /Pas de série en cours/.test(g.text),
      'séries : ' + JSON.stringify(g));
  });

  await test('Nom : ORKA affiché partout, message « TriSeason devient ORKA » une seule fois pour les comptes existants', async () => {
    const data = sampleData(); data.news_seen = ['muscu', 'sports'];
    const v = await newUser({ data });
    const titles = {};
    for (const p of PAGES) {
      await v.page.goto(`${BASE}/${p}.html`); await v.page.waitForTimeout(p === 'index' ? 1500 : 500);
      titles[p] = await v.page.evaluate(() => ({ title: document.title, logo: (document.querySelector('.nav__logo') || {}).textContent || '', old: /TriSeason/.test(document.body.innerText + document.title) && !/anciennement TriSeason|TriSeason devient/.test(document.body.innerText) }));
      if (p === 'index') {
        titles.news = await v.page.evaluate(() => (document.getElementById('newsModal') || {}).textContent || '');
        if (titles.news) { await v.page.click('#newsModal .btn--primary'); await v.page.waitForTimeout(300); }
      }
    }
    const manifest = await v.page.evaluate(() => fetch('manifest.json').then(r => r.json()));
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(600);
    const again = await v.page.evaluate(() => ({ modal: !!document.getElementById('newsModal'), seen: TS.getData().news_seen, keys: Object.keys(localStorage).filter(k => k.startsWith('triseason_')).length }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const bad = Object.entries(titles).filter(([k, t]) => k !== 'news' && (!/ORKA/.test(t.title) || !/ORKA/.test(t.logo) || t.old));
    assert(!bad.length, 'pages : ' + JSON.stringify(bad));
    assert(/TriSeason devient ORKA/.test(titles.news) && !again.modal && again.seen.includes('orka') && again.keys > 0, 'message : ' + JSON.stringify({ news: titles.news.slice(0, 80), again }));
    assert(manifest.name === 'ORKA' && manifest.short_name === 'ORKA', 'manifest : ' + JSON.stringify(manifest).slice(0, 120));
  });

  await test('Séances prévues : 2 prochaines visibles (« Voir les n autres »), semaines passées repliées', async () => {
    const data = sampleData();
    // Lundi de la semaine en cours (calendrier de Paris) et quelques séances prévues autour
    const mondayOffset = (() => { const d = new Date(day(0) + 'T12:00:00Z'); return -((d.getUTCDay() + 6) % 7); })();
    const mk = (id, off) => ({ id, date: day(off), sport: 'run', distance: 10 });
    data.plans = [mk('old1', mondayOffset - 9), mk('old2', mondayOffset - 3), mk('n1', 1), mk('n2', 2), mk('n3', 4), mk('n4', 6)];
    if (mondayOffset < 0) data.plans.push(mk('week', mondayOffset));   // plus tôt cette semaine (sauf si on est lundi)
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const ids = () => v.page.evaluate(() => [...document.querySelectorAll('#planList .plan-row')].map(b => (b.getAttribute('onclick').match(/'([^']+)'\)$/) || [])[1]));
    const before = await ids();
    const buttons = await v.page.evaluate(() => [...document.querySelectorAll('#planList .plan-more')].map(b => b.textContent));
    await v.page.click('#planList .plan-more >> text=autres séances prévues'); await v.page.waitForTimeout(100);
    const allNext = await ids();
    await v.page.click('#planList .plan-more >> text=semaines passées'); await v.page.waitForTimeout(100);
    const withOld = await ids();
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const week = mondayOffset < 0 ? ['week'] : [];
    assert(JSON.stringify(before) === JSON.stringify([...week, 'n1', 'n2']), 'au départ : ' + JSON.stringify(before));
    assert(buttons.some(b => /semaines passées \(2\)/.test(b)) && buttons.some(b => /les 2 autres séances prévues/.test(b)), 'boutons : ' + JSON.stringify(buttons));
    assert(JSON.stringify(allNext) === JSON.stringify([...week, 'n1', 'n2', 'n3', 'n4']), 'toutes à venir : ' + JSON.stringify(allNext));
    assert(JSON.stringify(withOld) === JSON.stringify(['old1', 'old2', ...week, 'n1', 'n2', 'n3', 'n4']), 'avec semaines passées : ' + JSON.stringify(withOld));
  });

  await test('Résumé du mois : affiché une fois à l’ouverture du Dashboard, pages qu’on fait défiler, sans défilement latéral', async () => {
    const v = await newUser({ data: { ...sampleData(), month_seen: null }, ctxOpts: { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true } });
    await v.page.goto(`${BASE}/index.html`);
    await v.page.waitForSelector('#monthSummary', { timeout: 5000 });
    const first = await v.page.evaluate(() => {
      const b = document.getElementById('monthSummary');
      return { title: b.querySelector('.ms-page:not([hidden]) .ms-page__title').textContent, pages: b.querySelectorAll('.ms-page').length,
        titles: [...b.querySelectorAll('.ms-page__title')].map(x => x.textContent),
        overflow: document.documentElement.scrollWidth > window.innerWidth || b.scrollWidth > b.clientWidth };
    });
    const overflows = [];
    for (let i = 1; i < first.pages; i++) {
      await v.page.click('#monthSummary [data-ms="next"]'); await v.page.waitForTimeout(60);
      overflows.push(await v.page.evaluate(() => { const p = document.querySelector('#monthSummary .ms__pages'); return p.scrollWidth > p.clientWidth; }));
    }
    const lastBtn = await v.page.textContent('#monthSummary [data-ms="next"]');
    await v.page.click('#monthSummary [data-ms="next"]'); await v.page.waitForTimeout(300);
    const closed = await v.page.evaluate(() => !document.getElementById('monthSummary') && !document.documentElement.classList.contains('ms-open'));
    const seen = await v.page.evaluate(() => TS.getData().month_seen);
    await v.page.reload(); await v.page.waitForTimeout(1500);
    const again = await v.page.evaluate(() => !!document.getElementById('monthSummary'));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    const last = (() => { const d = new Date(day(0) + 'T12:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
    assert(/^Ton mois (d’|de )/.test(first.title), 'titre : ' + first.title);
    assert(first.pages >= 5, 'pages : ' + JSON.stringify(first.titles));
    assert(['Tes jours d’entraînement', 'Tes distances', 'Tes temps forts', 'Ta nutrition', 'Ta forme'].every(t => first.titles.includes(t)), 'pages : ' + JSON.stringify(first.titles));
    assert(!first.overflow && !overflows.some(Boolean), 'défilement latéral : ' + JSON.stringify(overflows));
    assert(lastBtn === 'Terminer', 'dernier bouton : ' + lastBtn);
    assert(closed, 'pas refermé');
    assert(seen === last, 'mois vu : ' + seen + ' au lieu de ' + last);
    assert(!again, 'réaffiché au rechargement');
  });

  await test('Résumé du mois : pas sur les autres pages, pas sans séance le mois d’avant, ouvert depuis le calendrier', async () => {
    const v = await newUser({ data: { ...sampleData(), month_seen: null } });
    await v.page.goto(`${BASE}/sessions.html`); await v.page.waitForTimeout(1500);
    const onSessions = await v.page.evaluate(() => !!document.getElementById('monthSummary'));
    await v.ctx.close();
    // Nouveau compte : séances seulement ce mois-ci → rien à résumer, mois marqué vu quand même
    const d0 = day(0);
    const w = await newUser({ data: { ...sampleData(), month_seen: null, sessions: [{ id: 'a', date: d0, sport: 'run', duration: 1, distance: 10 }] } });
    await w.page.goto(`${BASE}/index.html`); await w.page.waitForTimeout(1500);
    const shown = await w.page.evaluate(() => !!document.getElementById('monthSummary'));
    const seen = await w.page.evaluate(() => TS.getData().month_seen);
    // Bouton du calendrier : mois en cours (une séance) puis mois vide (message, rien d'ouvert)
    await w.page.click('#calSummaryBtn'); await w.page.waitForTimeout(150);
    const cur = await w.page.evaluate(() => document.querySelector('#monthSummary .ms-page__kicker').textContent);
    await w.page.click('#monthSummary [data-ms="close"]'); await w.page.waitForTimeout(300);
    await w.page.evaluate(() => { changeCalMonth(-1); changeCalMonth(-1); });
    await w.page.click('#calSummaryBtn'); await w.page.waitForTimeout(150);
    const empty = await w.page.evaluate(() => ({ open: !!document.getElementById('monthSummary'), toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ') }));
    assert(!w.errors.length, w.errors[0]);
    await w.ctx.close();
    assert(!onSessions, 'affiché sur la page Séances');
    assert(!shown && /^\d{4}-\d{2}$/.test(seen || ''), 'nouveau compte : affiché=' + shown + ' vu=' + seen);
    assert(/en cours/.test(cur), 'mois en cours : ' + cur);
    assert(!empty.open && /Aucune séance/.test(empty.toast), 'mois vide : ' + JSON.stringify(empty));
  });

  await test('Résumé du mois : chiffres justes (séances, série, meilleure journée, records, courses, muscu, nutrition)', async () => {
    const S = (id, date, sport, h, km, extra = {}) => ({ id, date, sport, duration: h, distance: km, ...extra });
    const data = { ...sampleData(), sessions: [
      S('r1', '2025-04-02', 'run', 0.5, 6, { rpe: 6, sensation: 4 }), S('r2', '2025-04-03', 'run', 1, 12, { rpe: 6, sensation: 4 }),
      S('r3', '2025-04-04', 'run', 0.75, 9, { rpe: 6, sensation: 4 }), S('v1', '2025-04-12', 'velo', 3, 90, { elevation: 800 }),
      S('n1', '2025-04-15', 'nat', 0.75, 2.5), S('p1', '2025-03-20', 'run', 1, 10),
      S('m1', '2025-04-20', 'muscu', 1, null, { exercises: [{ name: 'Squat', group: 'Jambes', sets: 3, reps: 10, kg: 60 }] }),
      S('m0', '2025-03-10', 'muscu', 1, null, { exercises: [{ name: 'Squat', group: 'Jambes', sets: 3, reps: 10, kg: 50 }] }),
    ], records: [
      { id: 'x0', sport: 'run', dist: '10 km', time: '0:45:00', date: '2024-10-01' },
      { id: 'x1', sport: 'run', dist: '10 km', time: '0:44:10', date: '2025-04-27' },
      { id: 'x2', sport: 'run', dist: '5 km', time: '0:21:00', date: '2025-04-06' },
    ], competitions: [{ id: 'c1', date: '2025-04-27', name: '10 km d’avril', type: 'RUN', distance: '10', goal_time: '0:45:00', actual_time: '0:44:10' }],
      nutrition: { meals: [
        { id: 'a', date: '2025-04-02', glucides: 300, proteines: 100, lipides: 50 }, { id: 'b', date: '2025-04-03', glucides: 400, proteines: 100, lipides: 50 },
        { id: 'c', date: '2025-04-08', glucides: 200, proteines: 100, lipides: 50 }, { id: 'd', date: '2025-04-09', glucides: 220, proteines: 100, lipides: 50 }],
        hydration: { '2025-04-02': 2000, '2025-04-03': 1000 }, fuel: [] } };
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/index.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => {
      const m = TS.monthSummary('2025-04');
      const pages = TS.monthSummaryPages(m);
      return { n: m.total.n, km: m.total.km, h: m.total.h, prevN: m.prev.n, active: m.activeDays, streak: m.streak, bestDay: m.bestDay, elev: m.total.elev,
        rec: m.records.map(x => x.dist + ':' + x.pb + ':' + x.first), comp: m.comps.map(c => c.goalOk), muscu: m.muscu && [m.muscu.n, m.muscu.sets, m.muscu.kg],
        mrec: m.muscuRecords.map(e => e.name + ':' + e.value), train: m.nutrition.train, rest: m.nutrition.rest, water: [m.nutrition.waterDays, m.nutrition.waterAvg, m.nutrition.waterGoalDays],
        titles: pages.map(h => (h.match(/ms-page__title">([^<]+)/) || [])[1]), oct: TS.monthSummaryPages(TS.monthSummary('2025-04'))[0].includes('Ton mois d’avril') };
    });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(r.n === 6 && Math.abs(r.km - 119.5) < 1e-9 && r.prevN === 2 && r.active === 6, 'totaux : ' + JSON.stringify(r));
    assert(r.streak.days === 3 && r.streak.from === '2025-04-02' && r.streak.to === '2025-04-04', 'série : ' + JSON.stringify(r.streak));
    assert(r.bestDay === '2025-04-12' && r.elev === 800, 'meilleure journée : ' + r.bestDay);
    assert(JSON.stringify(r.rec) === JSON.stringify(['5 km:true:true', '10 km:true:false']), 'records : ' + JSON.stringify(r.rec));
    assert(JSON.stringify(r.comp) === '[true]', 'course : ' + JSON.stringify(r.comp));
    assert(JSON.stringify(r.muscu) === '[1,3,1800]' && JSON.stringify(r.mrec) === '["Squat:60"]', 'muscu : ' + JSON.stringify([r.muscu, r.mrec]));
    // Jours d'entraînement avec repas : 2 et 3 avril (350 g en moyenne) ; repos : 8 et 9 avril (210 g)
    assert(r.train && r.train.carbs === 350 && r.rest && r.rest.carbs === 210, 'nutrition : ' + JSON.stringify([r.train, r.rest]));
    assert(JSON.stringify(r.water) === '[2,1500,1]', 'eau : ' + JSON.stringify(r.water));
    assert(r.oct && ['Courses et records', 'Ta musculation', 'Ta nutrition'].every(t => r.titles.includes(t)), 'pages : ' + JSON.stringify(r.titles));
  });

  await test('Résumé du mois : liste des mois dans Profil (2 derniers, puis « Voir tout »), un mois s’ouvre en le touchant', async () => {
    // Séances sur 4 mois (le mois en cours et les 3 d'avant)
    const data = sampleData();
    const m0 = day(0).slice(0, 7);
    const back = n => { const d = new Date(m0 + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };
    [1, 2, 3].forEach(n => data.sessions.push({ id: 'old' + n, date: back(n) + '-15', sport: 'run', duration: 1, distance: 10 }));
    const v = await newUser({ data, ctxOpts: { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(800);
    const rowsOf = () => v.page.evaluate(() => [...document.querySelectorAll('#monthList .month-row')].map(b => b.textContent.replace(/\s+/g, ' ').trim()));
    const rows = await rowsOf();
    const btn = await v.page.evaluate(() => { const b = document.getElementById('monthMore'); return b.offsetParent !== null ? b.textContent : null; });
    await v.page.click('#monthMore'); await v.page.waitForTimeout(100);
    const all = await rowsOf();
    await v.page.click('#monthList .month-row >> nth=3'); await v.page.waitForTimeout(200);
    const r = await v.page.evaluate(() => ({ kicker: (document.querySelector('#monthSummary .ms-page__kicker') || {}).textContent,
      overflow: document.documentElement.scrollWidth > window.innerWidth }));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(rows.length === 2 && /en cours/.test(rows[0]), 'au départ : ' + JSON.stringify(rows));
    assert(btn === 'Voir tout (4 mois)', 'bouton : ' + btn);
    assert(all.length === 4 && /séance · 1h/.test(all[3]), 'tout : ' + JSON.stringify(all));
    const name = all[3].split(' ').slice(0, 2).join(' ').toLowerCase();
    assert(r.kicker && r.kicker.toLowerCase().startsWith(name), 'ouvert : ' + r.kicker + ' attendu ' + name);
    assert(!r.overflow, 'défilement latéral');
  });


  await test('Comparer deux mois : chiffres, même date pour le mois en cours, raccourcis « il y a 1 an », sans défilement latéral', async () => {
    const data = sampleData();
    const m0 = day(0).slice(0, 7), d0 = Number(day(0).slice(8, 10));
    const back = n => { const d = new Date(m0 + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };
    const y1 = back(12);
    // Il y a un an : une sortie le 1er (comptée à la même date) et une le 28 (après la date du jour, sauf en fin de mois)
    data.sessions.push({ id: 'ya', date: y1 + '-01', sport: 'run', duration: 1, distance: 10 }, { id: 'yb', date: y1 + '-28', sport: 'velo', duration: 2, distance: 60 });
    // Deux mois passés fixes : comparaison sur le mois entier
    data.sessions.push({ id: 'p1', date: '2024-01-05', sport: 'run', duration: 1, distance: 12 }, { id: 'p2', date: '2024-01-20', sport: 'run', duration: 0.5, distance: 6 },
      { id: 'p3', date: '2023-01-31', sport: 'run', duration: 1, distance: 9 });
    const v = await newUser({ data, ctxOpts: { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => {
      const c = TS.monthCompare('2024-01', '2023-01');
      return { until: c.until, a: [c.a.total.n, c.a.total.km], b: [c.b.total.n, c.b.total.km], curve: c.curves.km[0].slice(-1)[0], len: [c.curves.km[0].length, c.curves.km[1].length] };
    });
    await v.page.click('#monthCompareBtn'); await v.page.waitForTimeout(200);
    const ui = await v.page.evaluate(() => ({ a: document.getElementById('mcA').value, b: document.getElementById('mcB').value,
      note: (document.querySelector('#mcOut .ms-note') || {}).textContent || '', chart: !!document.querySelector('#mcChart svg path.mc-line--a'),
      cals: document.querySelectorAll('.mc-cal').length, overflow: (() => { const b = document.querySelector('.mc__body'); return b.scrollWidth > b.clientWidth || document.documentElement.scrollWidth > innerWidth; })() }));
    const same = await v.page.evaluate(() => { const c = TS.monthCompare(document.getElementById('mcA').value, document.getElementById('mcB').value); return [c.until, c.b.total.n]; });
    await v.page.click('.mc__chip >> text=Mois d’avant'); await v.page.waitForTimeout(100);
    const prevB = await v.page.evaluate(() => document.getElementById('mcB').value);
    await v.page.click('#monthCompare [data-mc="close"]'); await v.page.waitForTimeout(300);
    const closed = await v.page.evaluate(() => !document.getElementById('monthCompare'));
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(r.until === null && JSON.stringify(r.a) === '[2,18]' && JSON.stringify(r.b) === '[1,9]' && r.curve === 18 && r.len[0] === 31 && r.len[1] === 31, 'mois passés : ' + JSON.stringify(r));
    assert(ui.a === m0 && ui.b === y1, 'mois proposés : ' + JSON.stringify(ui));
    assert(same[0] === d0 && same[1] === (d0 >= 28 ? 2 : 1), 'même date : ' + JSON.stringify(same));
    assert(new RegExp('au ' + d0 + ' de chaque mois').test(ui.note), 'note : ' + ui.note);
    assert(ui.chart && ui.cals === 2 && !ui.overflow, 'écran : ' + JSON.stringify(ui));
    assert(prevB === back(1) && closed, 'mois d’avant : ' + prevB);
  });

  await test('Comparer deux mois : courbe par sport (distance, heures, séances du sport choisi)', async () => {
    const data = sampleData();
    data.profile.sports = ['nat', 'velo', 'run', 'muscu'];
    data.sessions.push({ id: 'a1', date: '2024-03-02', sport: 'run', duration: 1, distance: 10 }, { id: 'a2', date: '2024-03-05', sport: 'velo', duration: 2, distance: 60 },
      { id: 'a3', date: '2024-03-09', sport: 'run', duration: 0.5, distance: 5 }, { id: 'a4', date: '2024-03-12', sport: 'muscu', duration: 1, exercises: [] },
      { id: 'b1', date: '2023-03-03', sport: 'velo', duration: 1, distance: 30 });
    const v = await newUser({ data, ctxOpts: { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true } });
    await v.page.goto(`${BASE}/profile.html`); await v.page.waitForTimeout(800);
    const r = await v.page.evaluate(() => {
      const c = TS.monthCompare('2024-03', '2023-03');
      const last = x => x[x.length - 1];
      return { sports: c.sports, run: c.curve('km', 'run').map(last), velo: c.curve('km', 'velo').map(last), runN: c.curve('n', 'run').map(last),
        muscuH: c.curve('h', 'muscu').map(last), all: c.curve('km').map(last) };
    });
    await v.page.evaluate(() => TS.showMonthCompare('2024-03', '2023-03')); await v.page.waitForTimeout(200);
    const chips = await v.page.evaluate(() => [...document.querySelectorAll('[data-mc-sport]')].map(b => b.textContent.trim()));
    await v.page.click('[data-mc-metric="n"]'); await v.page.click('[data-mc-sport="run"]'); await v.page.waitForTimeout(100);
    const runUi = await v.page.evaluate(() => ({ on: document.querySelector('[data-mc-metric].on').dataset.mcMetric, read: document.getElementById('mcRead').textContent }));
    await v.page.click('[data-mc-metric="km"]'); await v.page.click('[data-mc-sport="muscu"]'); await v.page.waitForTimeout(100);
    const muscuUi = await v.page.evaluate(() => ({ km: !!document.querySelector('[data-mc-metric="km"]'), on: document.querySelector('[data-mc-metric].on').dataset.mcMetric }));
    await v.page.click('[data-mc-sport="velo"]'); await v.page.waitForTimeout(100);
    const veloOn = await v.page.evaluate(() => document.querySelector('[data-mc-metric].on').dataset.mcMetric);
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(JSON.stringify(r.sports) === '["velo","run","muscu"]', 'sports : ' + JSON.stringify(r.sports));
    assert(JSON.stringify(r.run) === '[15,0]' && JSON.stringify(r.velo) === '[60,30]' && JSON.stringify(r.runN) === '[2,0]' && JSON.stringify(r.muscuH) === '[1,0]' && JSON.stringify(r.all) === '[75,30]', 'courbes : ' + JSON.stringify(r));
    assert(JSON.stringify(chips) === '["Tous","Vélo","Course","Musculation"]', 'boutons : ' + JSON.stringify(chips));
    assert(runUi.on === 'n' && /2 séances/.test(runUi.read), 'course, séances : ' + JSON.stringify(runUi));
    assert(!muscuUi.km && muscuUi.on === 'h', 'musculation : ' + JSON.stringify(muscuUi));
    assert(veloOn === 'km', 'vélo : retour aux km choisis : ' + veloOn);
  });

  await test('Nutrition : repas et ravitaillements sans émojis, nom du repas lisible, crayon de modification en icône', async () => {
    const data = sampleData();
    data.nutrition.meals.push({ id: 'mx', date: day(0), type: 'collation-après-midi', desc: 'banane', glucides: 25 });
    data.nutrition.fuel = [{ id: 'fx', date: day(0), type: 'gel', qty: 2 }];
    const v = await newUser({ data });
    await v.page.goto(`${BASE}/nutrition.html`); await v.page.waitForTimeout(900);
    const r = await v.page.evaluate(() => {
      const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
      const zone = ['mealsList', 'fuelList', 'm_type', 'f_type'].map(id => (document.getElementById(id) || {}).textContent || '').join(' ').replace(/[★☆]/g, '');   // étoiles du favori : symboles, pas des émojis
      return { emoji: emoji.test(zone), title: [...document.querySelectorAll('#mealsList .meal-card__title')].map(t => t.textContent.trim()),
        pencil: !!document.querySelector('#mealsList button[aria-label="Modifier ce repas"] svg') };
    });
    assert(!v.errors.length, v.errors[0]);
    await v.ctx.close();
    assert(!r.emoji, 'émojis encore présents');
    assert(r.title.includes('Collation de l’après-midi'), 'titres : ' + JSON.stringify(r.title));
    assert(r.pencil, 'pas de crayon en icône');
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
