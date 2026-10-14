// TriSeason Tracker — Import GPX / FIT
// Parses activity files and converts to TriSeason session format

// ── Elevation gain — hysteresis-based, matches GPS device methodology ─────────
// Naive point-to-point summation is unreliable: raw altitude readings are noisy
// and either cancel out (under-estimating gain) or inflate wildly (over-estimating,
// sometimes 50%+ on a real climb, or hundreds of meters of "gain" on flat ground).
// A moving-average smoothing pass plus a small hysteresis threshold (the same
// principle Garmin/Strava use internally) gives a realistic total. The window
// adapts to how many altitude points are actually available — a fixed window
// would flatten sparse data (few points per activity) down to near zero.
function smoothSeries(values, windowSize) {
  return values.map(function(_, i) {
    var half  = Math.floor(windowSize / 2);
    var start = Math.max(0, i - half);
    var end   = Math.min(values.length, i + half + 1);
    var slice = values.slice(start, end);
    return slice.reduce(function(a, b) { return a + b; }, 0) / slice.length;
  });
}

function calcElevationGain(rawAltitudes) {
  var values = (rawAltitudes || []).filter(function(v) { return typeof v === 'number' && !isNaN(v); });
  if (values.length < 2) return null;
  // Never smooth away more than ~1/4 of the available points
  var windowSize = Math.max(1, Math.min(7, Math.floor(values.length / 4)));
  var smoothed   = smoothSeries(values, windowSize);
  var threshold  = windowSize >= 5 ? 2 : 0.5; // lighter threshold when data is sparse
  var gain = 0, ref = smoothed[0];
  for (var i = 1; i < smoothed.length; i++) {
    var p = smoothed[i];
    if (p > ref + threshold) { gain += (p - ref); ref = p; }
    else if (p < ref - threshold) { ref = p; }
  }
  return Math.round(gain);
}

// ── GPX Parser ────────────────────────────────────────────────────────────────
function parseGPX(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'text/xml');
  const trk    = doc.querySelector('trk');
  if (!trk) throw new Error('Fichier GPX invalide — aucune trace trouvée');

  const name     = trk.querySelector('name')?.textContent || '';
  const typeEl   = trk.querySelector('type')?.textContent?.toLowerCase() || '';
  const trkpts   = [...doc.querySelectorAll('trkpt')];

  if (!trkpts.length) throw new Error('Aucun point GPS trouvé dans le fichier');

  // Date from first point
  const firstTime = trkpts[0].querySelector('time')?.textContent;
  const lastTime  = trkpts[trkpts.length - 1].querySelector('time')?.textContent;
  const date      = TS.localDateStr(firstTime ? new Date(firstTime) : new Date());

  // Duration in hours
  let durationH = null;
  if (firstTime && lastTime) {
    const ms  = new Date(lastTime) - new Date(firstTime);
    durationH = Math.round(ms / 1000) / 3600; // à la seconde près
  }

  // Distance via Haversine
  let distKm = 0;
  for (let i = 1; i < trkpts.length; i++) {
    const lat1 = parseFloat(trkpts[i-1].getAttribute('lat'));
    const lon1 = parseFloat(trkpts[i-1].getAttribute('lon'));
    const lat2 = parseFloat(trkpts[i].getAttribute('lat'));
    const lon2 = parseFloat(trkpts[i].getAttribute('lon'));
    distKm += haversine(lat1, lon1, lat2, lon2);
  }
  distKm = Math.round(distKm * 100) / 100;

  // HR from extensions
  const hrValues = [...doc.querySelectorAll('hr, HeartRateBpm value, gpxtpx\\:hr')].map(el => parseInt(el.textContent)).filter(v => !isNaN(v) && v > 0);
  const fc_avg = hrValues.length ? Math.round(hrValues.reduce((a, b) => a + b) / hrValues.length) : null;
  const fc_max = hrValues.length ? Math.max(...hrValues) : null;

  // Power
  const powerValues = [...doc.querySelectorAll('power, gpxtpx\\:Watts')].map(el => parseInt(el.textContent)).filter(v => !isNaN(v) && v > 0);
  const power_avg = powerValues.length ? Math.round(powerValues.reduce((a, b) => a + b) / powerValues.length) : null;

  // Elevation gain — smoothed altitude series from <ele> tags
  const elevations = trkpts
    .map(pt => parseFloat(pt.querySelector('ele')?.textContent))
    .filter(v => !isNaN(v));
  const elevationGain = calcElevationGain(elevations);

  // Detect sport from name/type (or flag walking / strength to be ignored)
  const cls   = classifyText(name + ' ' + typeEl);
  const sport = cls.sport || 'run';

  return {
    date, sport, duration: durationH, distance: distKm,
    fc_avg, fc_max, power_avg, elevation: elevationGain, notes: name || 'Import GPX',
    _skip: cls.skip || null,
    _source: 'gpx'
  };
}

// ── FIT Parser ────────────────────────────────────────────────────────────────
function parseFIT(buffer) {
  return new Promise((resolve, reject) => {
    if (!window.FitParser) {
      reject(new Error('Parseur FIT non chargé'));
      return;
    }
    const fitParser = new window.FitParser({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      mode: 'both',
    });

    fitParser.parse(buffer, (error, data) => {
      if (error) { reject(new Error('Fichier FIT invalide : ' + error)); return; }

      try {
        const session = data.sessions?.[0] || data.activity?.sessions?.[0];
        const records = data.records || [];

        // Date
        const startTime = session?.start_time || data.activity?.timestamp;
        const date = startTime
          ? TS.localDateStr(new Date(startTime))
          : TS.localDateStr();

        // Duration
        const totalElapsed = session?.total_elapsed_time;
        const durationH = totalElapsed ? Math.round(totalElapsed) / 3600 : null; // à la seconde près

        // Distance — total_distance is now in meters (lengthUnit: 'm'), convert to km
        const totalDist = session?.total_distance;
        const distKm = totalDist ? Math.round(totalDist / 100) / 10 : null;

        // HR
        const fc_avg   = session?.avg_heart_rate || null;
        const fc_max   = session?.max_heart_rate || null;
        const fc_rest  = data.hr_zone_calc?.resting_heart_rate || null;

        // Power
        const power_avg = session?.avg_power || null;
        const power_max = session?.max_power || null;
        const np        = session?.normalized_power || null;

        // Elevation gain (meters) — computed from raw per-point altitude.
        // On many Garmin bike computers, altitude is logged in high-frequency
        // "gps_metadata" messages (alongside GPS position) rather than in the
        // standard "record" messages, which may only carry HR/power/cadence.
        // We check both sources before falling back to the device's own
        // session-level rollup, which is sometimes missing or unreliable.
        // Note: entry-level GPS-only devices without a barometric altimeter
        // (e.g. some Coros/Decathlon Kiprun models) record no altitude data
        // at all — in that case this correctly returns null.
        const gpsMeta = data.gps_metadata || [];
        let altitudeSeries = records
          .map(r => (r.enhanced_altitude != null ? r.enhanced_altitude : r.altitude))
          .filter(v => v != null && !isNaN(v));
        if (altitudeSeries.length < 2) {
          altitudeSeries = gpsMeta
            .map(r => (r.enhanced_altitude != null ? r.enhanced_altitude : r.altitude))
            .filter(v => v != null && !isNaN(v));
        }
        const elevation = altitudeSeries.length > 1
          ? calcElevationGain(altitudeSeries)
          : (session?.total_ascent ? Math.round(session.total_ascent) : null);

        // Sport detection
        const fitSport = session?.sport     || data.activity?.sessions?.[0]?.sport     || '';
        const fitSub   = session?.sub_sport || data.activity?.sessions?.[0]?.sub_sport || '';
        const cls      = classifyFit(fitSport, fitSub);
        const sport    = cls.sport || 'run';

        // Calories / notes
        const calories = session?.total_calories || null;
        const device   = data.file_creator?.software_version ? 'Garmin' :
                         data.device_info?.[0]?.manufacturer || '';
        const notes    = [
          device ? `Import ${device}` : 'Import FIT',
          calories ? `${calories} kcal` : '',
        ].filter(Boolean).join(' · ');

        resolve({
          date, sport, duration: durationH, distance: distKm,
          fc_avg, fc_max, fc_rest, power_avg, power_max, np,
          kcal: calories,
          elevation,
          notes,
          _skip: cls.skip || null,
          _source: 'fit'
        });
      } catch (e) {
        reject(new Error('Erreur lors du parsing FIT : ' + e.message));
      }
    });
  });
}

// ── Sport detection ───────────────────────────────────────────────────────────
// ── Classification des activités ──────────────────────────────────────────────
// Seules la natation, le vélo et la course sont suivies. La marche / randonnée et
// la musculation / fitness sont reconnues pour être IGNORÉES à l'import, au lieu
// d'être rangées par erreur dans "course". Résultat : { sport } ou { skip }.

// FIT : noms de sport normalisés du décodeur (session.sport / session.sub_sport)
function classifyFit(sportRaw, subRaw) {
  const s   = String(sportRaw || '').toLowerCase();
  const sub = String(subRaw   || '').toLowerCase();

  // Musculation, fitness, cardio en salle... ("training" = catégorie générique FIT)
  if (s === 'training' || /strength|weight/.test(sub)) return { skip: 'musculation' };
  // Marche, randonnée
  if (s === 'walking' || s === 'hiking' || /walk|hik/.test(sub)) return { skip: 'marche' };

  // Appareils de salle : vélo d'appartement et tapis restent suivis, le reste est ignoré
  if (s === 'fitness_equipment') {
    if (/cycling|spin/.test(sub)) return { sport: 'velo' };
    if (sub === 'treadmill')      return { sport: 'run' };
    return { skip: 'musculation' };
  }

  if (s.indexOf('swim') !== -1)                                  return { sport: 'nat' };
  if (s.indexOf('cycling') !== -1 || s.indexOf('biking') !== -1) return { sport: 'velo' }; // inclut e_biking
  if (s.indexOf('running') !== -1 || s.indexOf('trail') !== -1)  return { sport: 'run' };

  // Sport générique ou absent : le sous-sport peut trancher
  if (!s || s === 'generic' || s === 'all') {
    if (/swim|open_water/.test(sub))              return { sport: 'nat' };
    if (/cycling|mountain|gravel|road/.test(sub)) return { sport: 'velo' };
    if (/treadmill|trail|track|street/.test(sub)) return { sport: 'run' };
  }
  return { sport: null };
}

// GPX / TCX : classification par mots-clés (nom de l'activité, type, sport déclaré)
function classifyText(text) {
  const t = String(text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-]+/g, ' ');

  // 1) Mots-clés sportifs sans ambiguïté
  if (/swim|natation|pool|open.water|nata|piscine/.test(t))        return { sport: 'nat' };
  if (/ride|cycling|velo|bik(e|ing)|cycle|zwift|vtt|mtb|gravel/.test(t)) return { sport: 'velo' };
  if (/run|course|jogging|trail|marathon|10k|5k/.test(t))          return { sport: 'run' };
  // 2) Activités non suivies
  if (/strength|weight ?training|weights|muscu|renforcement|\bgym\b/.test(t)) return { skip: 'musculation' };
  if (/walk|marche|hik(e|ing)|randonnee|\brando\b/.test(t))                   return { skip: 'marche' };
  // 3) Mots-clés plus faibles
  if (/indoor|trainer/.test(t))   return { sport: 'velo' };
  if (/semi|treadmill/.test(t))   return { sport: 'run' };
  return { sport: null };
}

// Compatibilité : renvoie toujours un sport ("course" par défaut si inconnu)
function detectSport(text) {
  return classifyText(text).sport || 'run';
}

// ── Haversine distance ────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Main entry: parse any activity file ───────────────────────────────────────
async function parseActivityFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'gpx') {
    const text = await file.text();
    return parseGPX(text);
  }

  if (ext === 'fit') {
    const buffer = await file.arrayBuffer();
    return await parseFIT(buffer);
  }

  if (ext === 'tcx') {
    const text = await file.text();
    return parseTCX(text);
  }

  throw new Error(`Format .${ext} non supporté. Utilisez .fit, .gpx ou .tcx`);
}

// ── TCX Parser (Garmin Training Center XML) ───────────────────────────────────
function parseTCX(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'text/xml');
  const act    = doc.querySelector('Activity');
  if (!act) throw new Error('Fichier TCX invalide');

  const cls      = classifyText((act.getAttribute('Sport') || '') + ' ' + (doc.querySelector('Notes')?.textContent || ''));
  const sport    = cls.sport || 'run';
  const laps     = [...doc.querySelectorAll('Lap')];
  const firstLap = laps[0];

  const lapStart = firstLap?.getAttribute('StartTime');
  const date = TS.localDateStr(lapStart ? new Date(lapStart) : new Date());

  // Totals from laps
  let totalSec = 0, totalDist = 0, totalCal = 0;
  let hrSum = 0, hrCount = 0, maxHR = 0;

  laps.forEach(lap => {
    totalSec  += parseFloat(lap.querySelector('TotalTimeSeconds')?.textContent || 0);
    totalDist += parseFloat(lap.querySelector('DistanceMeters')?.textContent   || 0);
    totalCal  += parseInt(lap.querySelector('Calories')?.textContent           || 0);
    const avg = parseInt(lap.querySelector('AverageHeartRateBpm Value')?.textContent || 0);
    const max = parseInt(lap.querySelector('MaximumHeartRateBpm Value')?.textContent || 0);
    if (avg > 0) { hrSum += avg; hrCount++; }
    if (max > maxHR) maxHR = max;
  });

  // Elevation gain from Trackpoint AltitudeMeters values (all laps combined)
  const altitudes = [...doc.querySelectorAll('Trackpoint AltitudeMeters')]
    .map(el => parseFloat(el.textContent))
    .filter(v => !isNaN(v));
  const elevationGain = calcElevationGain(altitudes);

  return {
    date, sport,
    duration: Math.round(totalSec) / 3600, // à la seconde près
    distance: Math.round(totalDist / 10) / 100,
    fc_avg:   hrCount ? Math.round(hrSum / hrCount) : null,
    fc_max:   maxHR || null,
    elevation: elevationGain,
    notes:    `Import TCX${totalCal ? ' · ' + totalCal + ' kcal' : ''}`,
    _skip: cls.skip || null,
    _source: 'tcx'
  };
}

// ── Archive Strava (export complet du compte) ────────────────────────────────
// On ne lit QUE le tableau activities.csv (un résumé par activité), jamais les
// milliers de fichiers GPS de l'archive : quelques centaines de Ko à traiter,
// même pour une archive de plusieurs Go. Le .zip est lu par morceaux (File.slice),
// sans le charger en entier.
async function readStravaArchive(file) {
  if (/\.csv$/i.test(file.name)) return parseStravaCsv(await file.text());
  if (!/\.zip$/i.test(file.name)) throw new Error('Choisis le fichier .zip de l’archive Strava, ou le fichier activities.csv qu’il contient.');
  return parseStravaCsv(await readZipEntry(file, /(^|\/)activities\.csv$/i));
}

async function sliceBytes(file, start, end) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

async function readZipEntry(file, nameRe) {
  // Fin de l'archive : enregistrement « fin du répertoire central »
  const tailLen = Math.min(file.size, 66000);
  const tail = await sliceBytes(file, file.size - tailLen, file.size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Ce fichier n’est pas une archive .zip valide.');
  let cdSize = tail.getUint32(eocd + 12, true), cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
    // Archive de plus de 4 Go (ZIP64)
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('Archive .zip non reconnue.');
    const z64Off = Number(tail.getBigUint64(loc + 8, true));
    const z64 = await sliceBytes(file, z64Off, z64Off + 56);
    cdSize = Number(z64.getBigUint64(40, true)); cdOffset = Number(z64.getBigUint64(48, true));
  }
  const cd = await sliceBytes(file, cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder();
  for (let p = 0; p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50;) {
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    let localOff = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (nameRe.test(name)) {
      if (compSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) { // tailles ZIP64 dans le champ « extra »
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.getUint16(e, true), len = cd.getUint16(e + 2, true);
          if (id === 1) {
            let q = e + 4;
            if (cd.getUint32(p + 24, true) === 0xFFFFFFFF) q += 8;           // taille décompressée
            if (compSize === 0xFFFFFFFF) { compSize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (localOff === 0xFFFFFFFF) localOff = Number(cd.getBigUint64(q, true));
          }
          e += 4 + len;
        }
      }
      const lh = await sliceBytes(file, localOff, localOff + 30);
      const start = localOff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const blob = file.slice(start, start + compSize);
      if (method === 0) return await blob.text();
      if (method !== 8) throw new Error('Format de compression non pris en charge : décompresse l’archive et choisis activities.csv.');
      if (typeof DecompressionStream === 'undefined') throw new Error('Ce navigateur ne sait pas ouvrir le .zip : décompresse l’archive et choisis activities.csv.');
      return await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('Pas de fichier activities.csv dans cette archive. Vérifie que c’est bien l’archive envoyée par Strava.');
}

// CSV (guillemets, virgules et retours à la ligne dans les descriptions)
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvNum(v) {
  if (v == null) return null;
  v = String(v).trim();
  if (!v) return null;
  v = v.includes('.') ? v.replace(/,/g, '') : v.replace(',', '.');
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

const MONTHS = { jan: 0, janv: 0, feb: 1, fev: 1, févr: 1, fevr: 1, mar: 2, mars: 2, apr: 3, avr: 3, may: 4, mai: 4, jun: 5, juin: 5,
  jul: 6, juil: 6, aug: 7, aou: 7, août: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11, déc: 11 };
// Date de l'archive Strava (heure UTC) → instant. Formats : « Oct 12, 2026, 6:30:00 AM »,
// « 12 oct. 2026, 06:30:00 », « 2026-10-12 06:30:00 ».
function parseStravaDate(v) {
  v = String(v || '').trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  const low = v.toLowerCase();
  let d, mon, y;
  if ((m = low.match(/^([a-zéû]+)\.? (\d{1,2}),? (\d{4})/))) { mon = m[1]; d = +m[2]; y = +m[3]; }
  else if ((m = low.match(/^(\d{1,2}) ([a-zéû]+)\.? (\d{4})/))) { d = +m[1]; mon = m[2]; y = +m[3]; }
  else return null;
  const mi = MONTHS[mon] ?? MONTHS[mon.slice(0, 3)];
  if (mi == null) return null;
  const t = low.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/);
  let h = t ? +t[1] : 12; const min = t ? +t[2] : 0, sec = t && t[3] ? +t[3] : 0;
  if (t && t[4]) { const pm = t[4][0] === 'p'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return new Date(Date.UTC(y, mi, d, h, min, sec));
}

function stravaTypeToSport(type) {
  const t = String(type || '').toLowerCase();
  if (/swim|natation|nage/.test(t)) return 'nat';
  if (/ride|v[ée]lo|vtt|gravel|bike|cycl|velomobile|handcycle/.test(t)) return 'velo';
  if (/run|course|trail|jogging/.test(t)) return 'run';
  return null;
}

// activities.csv → [{ id, start (Date), name, type, sport, elapsed, distance_m, ... }]
// Les colonnes sont cherchées par leur nom (anglais ou français) ; la 2e colonne
// « Distance » (en mètres) et « Elapsed Time » (en secondes, précise) sont préférées.
function parseStravaCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Le fichier activities.csv est vide.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const all = (...names) => head.map((h, i) => names.includes(h) ? i : -1).filter(i => i >= 0);
  const first = (...names) => all(...names)[0];
  const last = (...names) => { const a = all(...names); return a[a.length - 1]; };
  const col = {
    id: first('activity id', 'id de l’activité', "id de l'activité") ?? 0,
    date: first('activity date', 'date de l’activité', "date de l'activité") ?? 1,
    name: first('activity name', 'nom de l’activité', "nom de l'activité") ?? 2,
    type: first('activity type', 'type d’activité', "type d'activité") ?? 3,
    elapsed: last('elapsed time', 'temps écoulé') ?? 5,
    distance: last('distance') ?? 6,
    elevation: first('elevation gain', 'dénivelé positif'),
    hrAvg: first('average heart rate', 'fréquence cardiaque moyenne'),
    hrMax: last('max heart rate', 'fréquence cardiaque max.', 'fréquence cardiaque maximale'),
    watts: first('average watts', 'puissance moyenne'),
    wattsMax: first('max watts', 'puissance max.', 'puissance maximale'),
    np: first('weighted average power', 'puissance moyenne pondérée'),
    kcal: first('calories'),
  };
  const twoDistances = all('distance').length > 1; // sinon la seule colonne est en km
  const out = [];
  rows.slice(1).forEach(r => {
    const id = csvNum(r[col.id]);
    const start = parseStravaDate(r[col.date]);
    if (!id || !start || isNaN(start)) return;
    const dist = csvNum(r[col.distance]);
    const g = (k) => col[k] == null ? null : csvNum(r[col[k]]);
    out.push({ id, start, name: r[col.name] || '', type: r[col.type] || '', sport: stravaTypeToSport(r[col.type]),
      elapsed: csvNum(r[col.elapsed]), distance_m: dist == null ? null : (twoDistances ? dist : dist * 1000),
      elevation: g('elevation'), hrAvg: g('hrAvg'), hrMax: g('hrMax'), watts: g('watts'), wattsMax: g('wattsMax'), np: g('np'), kcal: g('kcal') });
  });
  if (!out.length) throw new Error('Aucune activité lisible dans activities.csv.');
  return out;
}

// ── Expose ────────────────────────────────────────────────────────────────────
window.TriImport = { parseActivityFile, detectSport, classifyFit, classifyText,
  readStravaArchive, parseStravaCsv, parseStravaDate, parseCsv, readZipEntry };
