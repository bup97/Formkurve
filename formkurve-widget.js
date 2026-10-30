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

  return { analyze: analyze, metrics: metrics, normActivity: normActivity, sport: SPORT, iso: iso, addDays: addDays, clamp: clamp, num: num };
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
  return FK.analyze(W, A, { sleepGoal: SLEEP_GOAL });
}

const C = {
  bg: Color.dynamic(new Color("#FFFFFF"), new Color("#131924")),
  ink: Color.dynamic(new Color("#121826"), new Color("#E8ECF3")),
  muted: Color.dynamic(new Color("#5A6476"), new Color("#93A0B4")),
  accent: Color.dynamic(new Color("#2A50D4"), new Color("#87A3FF")),
  good: Color.dynamic(new Color("#16804F"), new Color("#4BC98B")),
  warn: Color.dynamic(new Color("#AE6A08"), new Color("#E8AD47")),
  bad: Color.dynamic(new Color("#BF3434"), new Color("#F27373")),
  neutral: Color.dynamic(new Color("#5A6476"), new Color("#93A0B4"))
};
const sgn = v => v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v));

function text(stack, s, size, color, weight) {
  const t = stack.addText(String(s));
  t.font = weight === "bold" ? Font.boldRoundedSystemFont(size) : weight === "semi" ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6;
  return t;
}
function metric(stack, label, value, color) {
  const s = stack.addStack(); s.layoutVertically();
  text(s, label.toUpperCase(), 9, C.muted, "semi");
  text(s, value, 17, color || C.ink, "bold");
}

function build(r, family) {
  const w = new ListWidget();
  w.backgroundColor = C.bg; w.url = APP_URL;
  w.setPadding(14, 14, 14, 14);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  const rec = r.rec || { title: "Keine Daten", tone: "neutral", zone: "–" };
  const tone = C[rec.tone] || C.neutral;

  const head = w.addStack(); head.centerAlignContent();
  text(head, "FORMKURVE", 10, C.accent, "semi"); head.addSpacer();
  if (family !== "small" && r.formZone) text(head, "Form " + r.formZone.label, 10, C[r.formZone.tone], "semi");
  w.addSpacer(6);

  if (family === "small") {
    text(w, r.readiness == null ? "–" : r.readiness, 40, tone, "bold");
    text(w, rec.title, 14, C.ink, "semi");
    w.addSpacer();
    text(w, "Form " + sgn(r.tsb) + " · " + rec.zone, 11, C.muted);
    return w;
  }
  const row = w.addStack(); row.centerAlignContent();
  const left = row.addStack(); left.layoutVertically();
  text(left, r.readiness == null ? "–" : r.readiness, 44, tone, "bold");
  row.addSpacer(12);
  const right = row.addStack(); right.layoutVertically();
  text(right, rec.title, 18, C.ink, "bold");
  text(right, "Intensität " + rec.zone + (rec.hours ? " · Erholung ~" + rec.hours + " h" : ""), 12, C.muted);
  w.addSpacer();
  const m = w.addStack();
  metric(m, "Form", sgn(r.tsb), r.formZone ? C[r.formZone.tone] : null); m.addSpacer();
  metric(m, "Schlaf", r.sleep ? r.sleep.total : "–"); m.addSpacer();
  metric(m, "HRV", r.hrv == null ? "–" : Math.round(r.hrv)); m.addSpacer();
  metric(m, "Ruhepuls", r.rhr == null ? "–" : Math.round(r.rhr));
  return w;
}

function message(msg) {
  const w = new ListWidget(); w.backgroundColor = C.bg; w.url = APP_URL;
  text(w, "FORMKURVE", 10, C.accent, "semi"); w.addSpacer(6);
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
