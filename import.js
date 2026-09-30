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
  const date      = firstTime ? firstTime.split('T')[0] : new Date().toISOString().split('T')[0];

  // Duration in hours
  let durationH = null;
  if (firstTime && lastTime) {
    const ms  = new Date(lastTime) - new Date(firstTime);
    durationH = Math.round(ms / 36000) / 100; // 2 decimal places
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
          ? new Date(startTime).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0];

        // Duration
        const totalElapsed = session?.total_elapsed_time;
        const durationH = totalElapsed ? Math.round(totalElapsed / 36) / 100 : null;

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

  const date = firstLap?.getAttribute('StartTime')?.split('T')[0] || new Date().toISOString().split('T')[0];

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
    duration: Math.round(totalSec / 36) / 100,
    distance: Math.round(totalDist / 10) / 100,
    fc_avg:   hrCount ? Math.round(hrSum / hrCount) : null,
    fc_max:   maxHR || null,
    elevation: elevationGain,
    notes:    `Import TCX${totalCal ? ' · ' + totalCal + ' kcal' : ''}`,
    _skip: cls.skip || null,
    _source: 'tcx'
  };
}

// ── Expose ────────────────────────────────────────────────────────────────────
window.TriImport = { parseActivityFile, detectSport, classifyFit, classifyText };
