// ===== Formkurve · Rechenlogik (App + Widget) =====
var FK = (function () {
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var mean = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; };
  var sd = function (a) {
    if (a.length < 3) return null;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  };
  var iso = function (d) { var z = new Date(d.getTime() - d.getTimezoneOffset() * 6e4); return z.toISOString().slice(0, 10); };
  var addDays = function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; };
  var day = function (s) { return new Date(s + 'T12:00:00'); };
  var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };

  // Form (TSB) nach den üblichen Zonen von TrainingPeaks / intervals.icu
  function formZone(tsb) {
    if (tsb == null) return null;
    if (tsb > 20) return { label: 'Übergang', tone: 'warn', text: 'Sehr frisch. Hält das länger an, baut die Fitness ab.' };
    if (tsb > 5) return { label: 'Frisch', tone: 'good', text: 'Ausgeruht. Gut für einen Wettkampf oder eine harte Einheit.' };
    if (tsb >= -10) return { label: 'Neutral', tone: 'neutral', text: 'Belastung und Erholung halten sich die Waage. Wenig Trainingsreiz.' };
    if (tsb >= -30) return { label: 'Produktiv', tone: 'good', text: 'Optimaler Trainingsbereich. Die Fitness wächst, solange die Erholung mithält.' };
    return { label: 'Überlastung', tone: 'bad', text: 'Sehr hohe Ermüdung. Erhöhtes Risiko für Übertraining und Verletzung.' };
  }
  function rampZone(r) {
    if (r == null) return null;
    if (r < 0) return { label: 'Abbau', tone: 'neutral' };
    if (r <= 5) return { label: 'Moderat', tone: 'good' };
    if (r <= 8) return { label: 'Hoch', tone: 'warn' };
    return { label: 'Zu steil', tone: 'bad' };
  }
  function acwrZone(x) {
    if (x == null) return null;
    if (x < 0.8) return { label: 'Unterfordert', tone: 'neutral' };
    if (x <= 1.3) return { label: 'Sweet Spot', tone: 'good' };
    if (x <= 1.5) return { label: 'Erhöht', tone: 'warn' };
    return { label: 'Spitze', tone: 'bad' };
  }

  // Eigener Schlafscore 0–100: Dauer 45, Qualität 20, nächtliche Erholung (HRV + Ruhepuls) 35
  function sleepScore(e, base, goalH) {
    if (!e || num(e.sleepSecs) == null) return null;
    var h = e.sleepSecs / 3600;
    var dur = h >= goalH ? 45 : h <= 4 ? h / 4 * 8 : 8 + (h - 4) / (goalH - 4) * 37;
    if (h > goalH + 2) dur -= 5;
    var q = num(e.sleepQuality), gs = num(e.sleepScore), qual;
    if (q != null) qual = [0, 20, 15, 9, 3][clamp(Math.round(q), 1, 4)];
    else if (gs != null) qual = gs / 100 * 20;
    else qual = 12;
    var hrv = num(e.hrv), rhr = num(e.restingHR), rec = 0;
    rec += (hrv != null && base.hrv) ? clamp(14 + (hrv / base.hrv - 1) * 60, 0, 20) : 12;
    rec += (rhr != null && base.rhr) ? clamp(11 - (rhr - base.rhr) * 2.5, 0, 15) : 9;
    return {
      total: Math.round(clamp(dur + qual + rec, 0, 100)),
      hours: h, garmin: gs, quality: q,
      parts: [
        { label: 'Dauer', v: dur, max: 45 },
        { label: 'Qualität', v: qual, max: 20 },
        { label: 'Erholung', v: rec, max: 35 }
      ]
    };
  }

  var SPORT = function (t) {
    t = (t || '').toLowerCase();
    if (t.indexOf('swim') >= 0) return 'swim';
    if (t.indexOf('ride') >= 0 || t.indexOf('bike') >= 0 || t.indexOf('cycl') >= 0) return 'bike';
    if (t.indexOf('run') >= 0) return 'run';
    return 'other';
  };

  var RECS = [
    { title: 'Ruhetag', tone: 'bad', zone: 'Kein Training', todo: 'Komplett frei oder 20–30 min lockeres Gehen und Mobility.' },
    { title: 'Locker bleiben', tone: 'warn', zone: 'Z1–Z2', todo: 'Nur Grundlage: Z1–Z2, höchstens 60–75 min, keine Intervalle.' },
    { title: 'Normales Training', tone: 'good', zone: 'Z2–Z3', todo: 'Plan umsetzen. Lange Z2-Einheit oder kurze Tempo-Reize sind okay.' },
    { title: 'Bereit für Qualität', tone: 'good', zone: 'Z4–Z5', todo: 'Guter Tag für Schwelle, VO2max-Intervalle oder eine lange Koppeleinheit.' }
  ];

  function analyze(W, A, opts) {
    opts = opts || {};
    var goalH = opts.sleepGoal || 8;
    var now = opts.now || new Date();
    var today = iso(now), cutoff = iso(addDays(now, -2));
    var w = (W || []).filter(function (x) { return x && x.id && x.id <= today; })
      .sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    var acts = (A || []).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });

    // Trainingsbelastung
    var loadRows = w.filter(function (x) { return num(x.ctl) != null && num(x.atl) != null; });
    var last = loadRows[loadRows.length - 1] || {};
    var ctl = num(last.ctl), atl = num(last.atl);
    var tsb = ctl != null ? ctl - atl : null;
    var ramp = num(last.rampRate);
    if (ramp == null && loadRows.length > 7) ramp = ctl - loadRows[loadRows.length - 8].ctl;
    var acwr = ctl ? atl / ctl : null;

    // letzte Nacht / heutige Werte (max. 2 Tage alt)
    var pick = function (f) {
      for (var i = w.length - 1; i >= 0; i--) {
        if (w[i].id < cutoff) break;
        if (num(w[i][f]) != null) return w[i];
      }
      return null;
    };
    var sleepE = pick('sleepSecs'), hrvE = pick('hrv'), rhrE = pick('restingHR');
    var refDay = (hrvE || rhrE || {}).id || today;
    var from = iso(addDays(day(refDay), -28));
    var hist = w.filter(function (x) { return x.id < refDay && x.id >= from; });
    var hv = hist.map(function (x) { return num(x.hrv); }).filter(function (v) { return v != null; });
    var rv = hist.map(function (x) { return num(x.restingHR); }).filter(function (v) { return v != null; });
    var base = { hrv: mean(hv), hrvSd: sd(hv), rhr: mean(rv), rhrSd: sd(rv) };
    var sleep = sleepScore(sleepE, base, goalH);
    var hrv = hrvE ? hrvE.hrv : null, rhr = rhrE ? rhrE.restingHR : null;

    // Bereitschaft
    var comp = [];
    if (hrv != null && base.hrv) comp.push({ k: 'HRV', s: clamp(70 + (hrv / base.hrv - 1) * 200, 0, 100), w: 0.3 });
    if (rhr != null && base.rhr) comp.push({ k: 'Ruhepuls', s: clamp(75 - (rhr - base.rhr) * 8, 0, 100), w: 0.15 });
    if (sleep) comp.push({ k: 'Schlaf', s: sleep.total, w: 0.3 });
    if (tsb != null) comp.push({ k: 'Form', s: clamp(60 + tsb * 1.5, 0, 100), w: 0.25 });
    var wsum = comp.reduce(function (s, c) { return s + c.w; }, 0);
    var readiness = wsum ? Math.round(comp.reduce(function (s, c) { return s + c.s * c.w; }, 0) / wsum) : null;

    var level = readiness == null ? null : readiness >= 75 ? 3 : readiness >= 60 ? 2 : readiness >= 45 ? 1 : 0;
    var flags = [];
    if (level != null) {
      if (tsb != null && tsb < -30) { flags.push('Form unter −30: die Ermüdung ist sehr hoch.'); level = Math.min(level, 1); }
      if (ramp != null && ramp > 8) { flags.push('Fitness steigt um mehr als 8 Punkte pro Woche.'); level = Math.min(level, 2); }
      var lowHrv = hrv != null && base.hrv && hrv < base.hrv * 0.85;
      var highRhr = rhr != null && base.rhr && rhr > base.rhr + 5;
      if (lowHrv && highRhr) { flags.push('HRV deutlich unter, Ruhepuls deutlich über deinem Normalwert.'); level = 0; }
      else if (lowHrv) { flags.push('HRV mehr als 15 % unter deinem 28-Tage-Schnitt.'); level = Math.min(level, 1); }
      else if (highRhr) { flags.push('Ruhepuls mehr als 5 Schläge über deinem Schnitt.'); level = Math.min(level, 1); }
      if (sleep && sleep.hours < 5.5) { flags.push('Weniger als 5,5 Stunden geschlafen.'); level = Math.min(level, 1); }
    }
    var rec = null;
    if (level != null) {
      rec = Object.assign({ level: level }, RECS[level]);
      var hrs = [36, 24, 12, 0][level] + Math.max(0, -(tsb || 0) - 10) * 0.6;
      rec.hours = Math.round(clamp(hrs, 0, 72) / 6) * 6;
    }

    // Woche (ab Montag) und Vergleich mit den 4 Wochen davor
    var dow = (now.getDay() + 6) % 7;
    var wkStart = iso(addDays(now, -dow));
    var week = { swim: { secs: 0, dist: 0, n: 0 }, bike: { secs: 0, dist: 0, n: 0 }, run: { secs: 0, dist: 0, n: 0 }, other: { secs: 0, dist: 0, n: 0 } };
    var weekLoad = 0, prevLoad = 0;
    var prevStart = iso(addDays(day(wkStart), -28));
    acts.forEach(function (a) {
      if (a.date >= wkStart && a.date <= today) {
        var s = week[SPORT(a.type)];
        s.secs += a.secs || 0; s.dist += a.dist || 0; s.n++;
        weekLoad += a.load || 0;
      } else if (a.date >= prevStart && a.date < wkStart) prevLoad += a.load || 0;
    });
    var prevAvg = prevLoad / 4;
    var dayFrac = (dow + 1) / 7;

    return {
      today: today, ctl: ctl, atl: atl, tsb: tsb, ramp: ramp, acwr: acwr,
      formZone: formZone(tsb), rampZone: rampZone(ramp), acwrZone: acwrZone(acwr),
      sleep: sleep, sleepDate: sleepE ? sleepE.id : null,
      hrv: hrv, rhr: rhr, base: base, components: comp,
      readiness: readiness, rec: rec, flags: flags,
      week: week, weekLoad: weekLoad, prevAvg: prevAvg, weekPace: prevAvg ? weekLoad / (prevAvg * dayFrac) : null,
      loadSeries: loadRows.slice(-42),
      hrvSeries: w.filter(function (x) { return num(x.hrv) != null; }).slice(-28),
      rhrSeries: w.filter(function (x) { return num(x.restingHR) != null; }).slice(-28),
      sleepSeries: w.filter(function (x) { return num(x.sleepSecs) != null; }).slice(-14),
      activities: acts.slice(0, 8)
    };
  }

  // intervals.icu-Aktivität -> internes Format
  function normActivity(a) {
    return {
      id: a.id, date: (a.start_date_local || '').slice(0, 10), time: (a.start_date_local || '').slice(11, 16),
      type: a.type || '', name: a.name || a.type || 'Einheit', secs: a.moving_time || a.elapsed_time || 0,
      dist: a.distance || 0, load: num(a.icu_training_load) || 0, hr: num(a.average_heartrate),
      eftp: num(a.icu_eftp) || num(a.icu_pm_ftp)
    };
  }

  // ---------- Kennwerte zum Vergleichen ----------
  // VO2max-Normen (Cooper Institute, wie bei Garmin): Grenzen für Ausgezeichnet / Sehr gut / Gut / Mittel
  var VO2N = {
    m: [[29, 55.4, 51.1, 45.4, 41.7], [39, 54.0, 48.3, 44.0, 40.5], [49, 52.5, 46.4, 42.4, 38.5], [59, 48.9, 43.4, 39.2, 35.6], [200, 45.7, 39.5, 35.5, 32.3]],
    w: [[29, 49.6, 43.9, 39.5, 36.1], [39, 47.4, 42.4, 37.8, 34.4], [49, 45.3, 39.7, 36.3, 33.0], [59, 41.1, 36.7, 33.0, 30.1], [200, 37.8, 33.0, 30.0, 27.5]]
  };
  function vo2Class(v, age, sex) {
    if (v == null || !age || !sex || !VO2N[sex]) return null;
    var r = VO2N[sex].filter(function (x) { return age <= x[0]; })[0];
    if (v >= r[1]) return { label: 'Ausgezeichnet', tone: 'good' };
    if (v >= r[2]) return { label: 'Sehr gut', tone: 'good' };
    if (v >= r[3]) return { label: 'Gut', tone: 'neutral' };
    if (v >= r[4]) return { label: 'Mittel', tone: 'warn' };
    return { label: 'Ausbaufähig', tone: 'bad' };
  }
  function wkgClass(x, sex) {
    if (x == null) return null;
    var f = sex === 'w' ? 0.85 : 1;
    if (x >= 4.8 * f) return { label: 'Elite', tone: 'good' };
    if (x >= 4.0 * f) return { label: 'Sehr stark', tone: 'good' };
    if (x >= 3.2 * f) return { label: 'Ambitioniert', tone: 'neutral' };
    if (x >= 2.5 * f) return { label: 'Hobby', tone: 'neutral' };
    return { label: 'Einsteiger', tone: 'warn' };
  }
  var field = function (row, names) {
    for (var i = 0; i < names.length; i++) { var v = num(row[names[i]]); if (v != null) return v; }
    return null;
  };
  function series(w, names, days, now) {
    var from = iso(addDays(now, -days));
    return w.filter(function (x) { return x.id >= from; })
      .map(function (x) { return { id: x.id, v: field(x, names) }; })
      .filter(function (p) { return p.v != null; });
  }
  // Wert, Vergleich mit vor ~30 Tagen, Verlauf
  function trend(s, now) {
    if (!s.length) return null;
    var last = s[s.length - 1], ref = iso(addDays(now, -30)), before = null;
    for (var i = s.length - 1; i >= 0; i--) if (s[i].id <= ref) { before = s[i]; break; }
    return { v: last.v, date: last.id, delta: before ? last.v - before.v : null, series: s };
  }
  var DEF = {
    vo2: ['vo2max', 'VO2max', 'vo2Max'], weight: ['weight'], bodyFat: ['bodyFat'],
    rhr: ['restingHR'], hrv: ['hrv'], spo2: ['spO2', 'spo2'], resp: ['respiration'],
    bb: ['bodyBattery', 'BodyBattery', 'body_battery'], stress: ['stressAvg', 'avgStress', 'garminStress'],
    steps: ['steps'], sleepHr: ['avgSleepingHR']
  };
  function metrics(W, A, athlete, opts) {
    opts = opts || {};
    var now = opts.now || new Date(), age = opts.age, sex = opts.sex;
    var w = (W || []).filter(function (x) { return x && x.id; }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    var t = function (k, d) { return trend(series(w, DEF[k], d || 180, now), now); };
    var ss = (athlete && athlete.sportSettings) || [];
    // Sporteinstellung wählen: zuerst die mit dem Haupttyp (Ride/Run/Swim), sonst eine passende Variante
    var MAIN = { bike: 'Ride', run: 'Run', swim: 'Swim' };
    var sport = function (kind) {
      var exact = ss.filter(function (s) { return (s.types || []).indexOf(MAIN[kind]) >= 0; })[0];
      return exact || ss.filter(function (s) { return (s.types || []).some(function (x) { return SPORT(x) === kind; }); })[0] || {};
    };
    var bike = sport('bike'), run = sport('run'), swim = sport('swim');
    var weightT = t('weight');
    var weight = weightT ? weightT.v : num(athlete && (athlete.icu_weight || athlete.weight));
    var ftp = num(bike.ftp);
    var eftps = (A || []).filter(function (a) { return a.eftp; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var eftp = eftps.length ? eftps[0].eftp : null;
    var vo2 = t('vo2');
    var pace = function (ms) { if (!ms) return null; var s = 1000 / ms; return Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0'); };
    var swimPace = function (ms) { if (!ms) return null; var s = 100 / ms; return Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0'); };
    var maxHr = num(run.max_hr) || num(bike.max_hr);
    return {
      performance: [
        { key: 'vo2', label: 'VO2max', unit: 'ml/kg/min', t: vo2, d: 1, cls: vo2Class(vo2 && vo2.v, age, sex), up: true, needsProfile: !!vo2 && !(age && sex) },
        { key: 'ftp', label: 'FTP Rad', unit: 'W', value: ftp, sub: eftp ? 'eFTP ' + Math.round(eftp) + ' W' : null },
        { key: 'wkg', label: 'FTP pro kg', unit: 'W/kg', value: ftp && weight ? ftp / weight : null, d: 2, cls: wkgClass(ftp && weight ? ftp / weight : null, sex) },
        { key: 'runpace', label: 'Laufschwelle', unit: 'min/km', text: pace(num(run.threshold_pace)) },
        { key: 'css', label: 'Schwimmschwelle', unit: 'min/100 m', text: swimPace(num(swim.threshold_pace)) },
        { key: 'lthr', label: 'Schwellenpuls Lauf', unit: 'bpm', value: num(run.lthr) },
        { key: 'maxhr', label: 'Maximalpuls', unit: 'bpm', value: maxHr },
        { key: 'weight', label: 'Gewicht', unit: 'kg', t: weightT, value: weight, d: 1 },
        { key: 'fat', label: 'Körperfett', unit: '%', t: t('bodyFat'), d: 1 }
      ],
      health: [
        { key: 'rhr', label: 'Ruhepuls', unit: 'bpm', t: t('rhr', 90), up: false },
        { key: 'hrv', label: 'HRV', unit: 'ms', t: t('hrv', 90), up: true },
        { key: 'sleepHr', label: 'Puls im Schlaf', unit: 'bpm', t: t('sleepHr', 90), up: false },
        { key: 'spo2', label: 'SpO2', unit: '%', t: t('spo2', 90) },
        { key: 'resp', label: 'Atemfrequenz', unit: '/min', t: t('resp', 90), d: 1 },
        { key: 'bb', label: 'Body Battery', unit: '', t: t('bb', 90), up: true },
        { key: 'stress', label: 'Stress Ø', unit: '', t: t('stress', 90), up: false },
        { key: 'steps', label: 'Schritte', unit: '', t: t('steps', 90) }
      ]
    };
  }

  // ---------- Strain, Schlafbedarf, 7-Tage-Verlauf ----------
  // Strain 0–21: logarithmisch aus der Trainingsbelastung (intervals.icu Load) eines Tages
  function strainOf(load) { return load > 0 ? Math.round(210 * (1 - Math.exp(-load / 120))) / 10 : 0; }
  var TARGETS = [[0, 8], [8, 12], [11, 15], [14, 18]];
  function daily(W, A, opts) {
    opts = opts || {};
    var now = opts.now || new Date(), goal = opts.sleepGoal || 8, today = iso(now);
    var byDay = {};
    (A || []).forEach(function (a) { byDay[a.date] = (byDay[a.date] || 0) + (a.load || 0); });
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = addDays(now, -i), id = iso(d), r = analyze(W, A, { now: d, sleepGoal: goal });
      days.push({ id: id, load: byDay[id] || 0, strain: strainOf(byDay[id] || 0), recovery: r.readiness, tone: r.rec ? r.rec.tone : 'neutral' });
    }
    var cur = analyze(W, A, opts);
    var lvl = cur.rec ? cur.rec.level : 2;
    var todayActs = (A || []).filter(function (a) { return a.date === today; })
      .map(function (a) { return Object.assign({ strain: strainOf(a.load) }, a); });
    // Schlafbedarf: Ziel + Ausgleich für die Belastung + Teil der Schlafschuld der letzten 3 Nächte
    var nights = (W || []).filter(function (x) { return x.id <= today && num(x.sleepSecs) != null; })
      .sort(function (a, b) { return a.id < b.id ? -1 : 1; }).slice(-3);
    var debt = nights.reduce(function (s, x) { return s + Math.max(0, goal - x.sleepSecs / 3600); }, 0);
    var st = strainOf(byDay[today] || 0);
    var need = { base: goal, strain: Math.round(st / 21 * 0.75 * 12) / 12, debt: Math.round(Math.min(1, debt * 0.25) * 12) / 12 };
    need.total = need.base + need.strain + need.debt;
    return { days: days, strainToday: st, loadToday: byDay[today] || 0, target: TARGETS[lvl], todayActs: todayActs, sleepNeed: need };
  }

  return { analyze: analyze, metrics: metrics, daily: daily, strain: strainOf, normActivity: normActivity, sport: SPORT, iso: iso, addDays: addDays, clamp: clamp, num: num };
})();

// ===== Formkurve · iPhone-Widget für Scriptable =====
// 1) Trage unten die Adresse deiner Formkurve-App ein (Tippen aufs Widget öffnet sie).
// 2) Skript einmal in Scriptable starten: API-Key und Athleten-ID eingeben.
// 3) Widget auf dem Homescreen hinzufügen → Scriptable → dieses Skript wählen.
const APP_URL = "https://bup97.github.io/Formkurve/";
const SLEEP_GOAL = 8; // Stunden
const KC = "formkurve_api_key", KA = "formkurve_athlete";

async function setup() {
  const a = new Alert();
  a.title = "intervals.icu verbinden";
  a.message = "API-Key aus intervals.icu → Settings → Developer Settings. Athleten-ID darf 0 bleiben.";
  a.addSecureTextField("API-Key", Keychain.contains(KC) ? Keychain.get(KC) : "");
  a.addTextField("Athleten-ID", Keychain.contains(KA) ? Keychain.get(KA) : "0");
  a.addAction("Speichern");
  a.addCancelAction("Abbrechen");
  if (await a.present() === -1) return false;
  Keychain.set(KC, a.textFieldValue(0).trim());
  Keychain.set(KA, a.textFieldValue(1).trim() || "0");
  return true;
}

async function api(path) {
  const auth = Data.fromString("API_KEY:" + Keychain.get(KC)).toBase64String();
  const req = new Request("https://intervals.icu/api/v1/athlete/" + encodeURIComponent(Keychain.get(KA)) + path);
  req.headers = { Authorization: "Basic " + auth };
  const res = await req.loadJSON();
  if (req.response && req.response.statusCode >= 400) throw new Error("intervals.icu: Fehler " + req.response.statusCode);
  return res;
}

async function loadData() {
  const now = new Date(), q = "?oldest=" + FK.iso(FK.addDays(now, -60)) + "&newest=" + FK.iso(now);
  const W = await api("/wellness" + q);
  const A = (await api("/activities" + q)).map(FK.normActivity);
  const r = FK.analyze(W, A, { sleepGoal: SLEEP_GOAL });
  r.day = FK.daily(W, A, { sleepGoal: SLEEP_GOAL });
  return r;
}

const C = {
  bg: new Color("#06080C"), ink: new Color("#F1F4F8"), muted: new Color("#8590A0"), track: new Color("#161C25"),
  good: new Color("#2EE59D"), warn: new Color("#FFC94A"), bad: new Color("#FF5C64"), neutral: new Color("#8590A0"),
  strain: new Color("#4F8BFF"), sleep: new Color("#9C8CFF"), mint: new Color("#4FF0C4")
};

function text(stack, s, size, color, weight) {
  const t = stack.addText(String(s));
  t.font = weight === "bold" ? Font.heavyRoundedSystemFont(size) : weight === "semi" ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6;
  return t;
}

// Ring als Bild: Hintergrundkreis, Fortschrittsbogen, Zahl in der Mitte
function ringImage(frac, color, label, size) {
  const S = size * 3, ctx = new DrawContext();
  ctx.size = new Size(S, S); ctx.opaque = false; ctx.respectScreenScale = true;
  const lw = S * 0.1, R = S / 2 - lw / 2 - 2, c = S / 2;
  const arc = (from, to, col) => {
    const p = new Path(), steps = Math.max(2, Math.round((to - from) * 120));
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 + 2 * Math.PI * (from + (to - from) * i / steps);
      const pt = new Point(c + R * Math.cos(a), c + R * Math.sin(a));
      if (i === 0) p.move(pt); else p.addLine(pt);
    }
    ctx.addPath(p); ctx.setStrokeColor(col); ctx.setLineWidth(lw); ctx.strokePath();
  };
  arc(0, 1, C.track);
  const f = Math.max(0, Math.min(1, frac || 0));
  if (f > 0.005) arc(0, f, color);
  ctx.setFont(Font.heavyRoundedSystemFont(S * (String(label).length > 3 ? 0.2 : 0.24)));
  ctx.setTextColor(C.ink); ctx.setTextAlignedCenter();
  const h = S * 0.3; ctx.drawTextInRect(String(label), new Rect(0, c - h / 2, S, h));
  return ctx.getImage();
}
function ringCol(stack, frac, color, label, name, size) {
  const s = stack.addStack(); s.layoutVertically(); s.centerAlignContent();
  const img = s.addImage(ringImage(frac, color, label, size)); img.imageSize = new Size(size, size);
  s.addSpacer(3);
  const n = s.addStack(); n.addSpacer(); text(n, name.toUpperCase(), 9, C.muted, "semi"); n.addSpacer();
}
const de1 = v => (Math.round(v * 10) / 10).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function build(r, family) {
  const w = new ListWidget();
  w.backgroundColor = C.bg; w.url = APP_URL;
  w.setPadding(12, 12, 12, 12);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  const rec = r.rec || { title: "Keine Daten", tone: "neutral", zone: "–" };
  const rc = C[rec.tone] || C.neutral, d = r.day;
  const rv = r.readiness, sl = r.sleep ? r.sleep.total : null;

  if (family === "small") {
    const h = w.addStack(); h.addSpacer(); ringCol(h, (rv || 0) / 100, rc, rv == null ? "–" : rv + "%", "Erholung", 78); h.addSpacer();
    w.addSpacer(4);
    const b = w.addStack(); b.addSpacer();
    text(b, "Strain " + de1(d.strainToday), 11, C.strain, "semi"); text(b, "  ·  ", 11, C.muted); text(b, "Schlaf " + (sl == null ? "–" : sl), 11, C.sleep, "semi");
    b.addSpacer();
    return w;
  }
  const row = w.addStack(); row.centerAlignContent();
  ringCol(row, (sl || 0) / 100, C.sleep, sl == null ? "–" : sl + "%", "Schlaf", 62); row.addSpacer();
  ringCol(row, (rv || 0) / 100, rc, rv == null ? "–" : rv + "%", "Erholung", 72); row.addSpacer();
  ringCol(row, d.strainToday / 21, C.strain, de1(d.strainToday), "Strain", 62);
  w.addSpacer(8);
  const t = w.addStack(); t.centerAlignContent();
  text(t, rec.title.toUpperCase(), 13, rc, "bold"); t.addSpacer();
  text(t, "Ziel " + d.target[0] + "–" + d.target[1] + " · " + rec.zone, 11, C.muted, "semi");
  return w;
}

function message(msg) {
  const w = new ListWidget(); w.backgroundColor = C.bg; w.url = APP_URL;
  text(w, "FORMKURVE", 10, C.mint, "semi"); w.addSpacer(6);
  const t = w.addText(msg); t.font = Font.systemFont(13); t.textColor = C.ink;
  return w;
}

let widget;
if (!Keychain.contains(KC) || !Keychain.get(KC)) {
  if (!config.runsInWidget && await setup()) widget = build(await loadData(), "medium");
  else widget = message("Öffne das Skript einmal in Scriptable und gib deinen intervals.icu-Key ein.");
} else {
  try { widget = build(await loadData(), config.widgetFamily || "medium"); }
  catch (e) { widget = message("Keine Daten: " + e.message); }
  if (!config.runsInWidget) {
    const a = new Alert(); a.title = "Formkurve"; a.message = "Vorschau zeigen oder Zugangsdaten ändern?";
    a.addAction("Vorschau"); a.addAction("Zugangsdaten ändern"); a.addCancelAction("Fertig");
    const c = await a.present();
    if (c === 1) { await setup(); widget = build(await loadData(), "medium"); }
    if (c === 0) await widget.presentMedium();
  }
}
Script.setWidget(widget);
Script.complete();
