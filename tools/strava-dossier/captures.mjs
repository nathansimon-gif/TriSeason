// Captures d'écran pour la demande à Strava (augmenter le nombre de comptes connectés).
// Usage : node captures.mjs   (depuis ce dossier ; il faut avoir fait « npm install » dans ../app-tests)
// Réutilise le faux Firebase et les données de test des tests automatiques : aucune vraie donnée.
// À relancer après le changement de nom ou de logo, et après la pose des logos officiels Strava.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS = join(HERE, '..', 'app-tests');
const OUT = join(HERE, 'captures');
const run = readFileSync(join(TESTS, 'run.mjs'), 'utf8');
const cut = run.indexOf("  // 1. Chaque page s'affiche sans erreur");
if (cut < 0) throw new Error('run.mjs a changé : repère « // 1. Chaque page » introuvable');

const body = `
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'fr-FR' };
  const OUT = ${JSON.stringify(OUT)};
  const names = ['Sortie longue', 'Fractionné 10 x 400 m', 'Footing récup', 'Seuil', 'Côtes', 'Tempo'];
  const withStrava = () => {
    const d = sampleData();
    d.sessions.forEach((s, i) => { s.strava_id = String(16000000000 + i); s.name = names[i % names.length]; s.kcal = 420 + i * 7; });
    d.strava = { name: 'Camille D.', athlete_id: 1, last_sync: Date.now() - 5 * 60000, access_token: 'x', refresh_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return d;
  };
  const open = async (data) => {
    const v = await newUser({ data, ctxOpts: phone });
    await v.ctx.addInitScript(() => { try { localStorage.setItem('triseason_strava_check', String(Date.now())); } catch (e) {} });
    return v;
  };
  const shot = (v, name) => v.page.screenshot({ path: OUT + '/' + name + '.png' });

  let v = await open(withStrava());
  await v.page.goto(BASE + '/index.html'); await v.page.waitForTimeout(1500);
  await shot(v, '1-dashboard');
  await v.page.goto(BASE + '/sessions.html'); await v.page.waitForTimeout(1200);
  await shot(v, '2-seances-liste');
  await v.page.click('.ses-row__hit'); await v.page.waitForTimeout(600);
  await shot(v, '3-seance-detail');
  await v.page.goto(BASE + '/profile.html#parametres'); await v.page.waitForTimeout(1200);
  await v.page.evaluate(() => { const el = document.getElementById('stravaCard'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70); }); await v.page.waitForTimeout(300);
  await shot(v, '4-profil-strava-connecte');
  await v.ctx.close();

  const d2 = withStrava(); delete d2.strava;
  v = await open(d2);
  await v.page.goto(BASE + '/profile.html#parametres'); await v.page.waitForTimeout(1200);
  await v.page.evaluate(() => { const el = document.getElementById('stravaCard'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70); }); await v.page.waitForTimeout(300);
  await v.page.waitForTimeout(2500);
  await shot(v, '5-profil-connecter-strava');
  await v.page.evaluate(() => TS.showWelcome());
  await v.page.waitForSelector('#welcome');
  for (let i = 0; i < 3; i++) { await v.page.click('#welcome [data-wq-act="skip"]'); await v.page.waitForTimeout(80); }
  await shot(v, '6-bienvenue-connecter-strava');
  await v.ctx.close();

  v = await open(withStrava());
  await v.page.goto(BASE + '/confidentialite.html'); await v.page.waitForTimeout(1500);
  await v.page.evaluate(() => { const el = [...document.querySelectorAll('p')].find(x => /Si tu connectes ton compte Strava/.test(x.textContent)); let h = el; while (h && !/^H[23]$/.test(h.tagName)) h = h.previousElementSibling; window.scrollTo(0, (h || el).getBoundingClientRect().top + window.scrollY - 20); });
  await v.page.waitForTimeout(200);
  await v.page.waitForTimeout(800);
  await shot(v, '7-confidentialite-strava');
  if (v.errors.length) console.log('Erreurs :', v.errors);
  await v.ctx.close();
  await browser.close(); server.close();
  console.log('Captures enregistrées dans', OUT);
}
main();
`;
const tmp = join(TESTS, '_captures_strava.tmp.mjs');
writeFileSync(tmp, run.slice(0, cut) + body);
try { execFileSync(process.execPath, [tmp], { stdio: 'inherit', cwd: TESTS }); }
finally { unlinkSync(tmp); }
