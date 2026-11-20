const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3080;
const HOST = '0.0.0.0';
const ROOT_DIR = __dirname;
const STATE_FILE = path.join(ROOT_DIR, 'family-state.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon'
};

function loadGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const candidates = [
    path.join(ROOT_DIR, '.env'),
    path.resolve(ROOT_DIR, '..', 'nettobox', '.env')
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^GEMINI_API_KEY=(.+)$/m);
        if (match && match[1].trim()) return match[1].trim();
      } catch {
        // Ignore unreadable .env
      }
    }
  }
  return '';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nowTimeHe() {
  return new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

function nowHourJerusalem() {
  const h = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hour12: false,
      timeZone: 'Asia/Jerusalem'
    }).format(new Date())
  );
  return Number.isFinite(h) ? h % 24 : new Date().getHours();
}

function createDefaultState() {
  return {
    familyPin: '1234',
    dayKey: todayKey(),
    placesUpdatedAt: new Date(0).toISOString(),
    profiles: {
      myName: 'אלון',
      partnerName: 'דנה',
      guestName: 'סבא/סבתא'
    },
    coupleStatus: {
      state: 'IDLE',
      driverName: 'אני (אלון)',
      statusText: 'ממתין לנסיעה הראשונה היום',
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: 0,
      soloContinueUntil: 0,
      snoozeUntil: 0,
      refuelUntil: 0,
      droppedOffAtDaycareToday: false,
      brokenRoutineAlert: false,
      tempC: null,
      savedVolumePct: 25
    },
    pickupToday: {
      assignee: 'אני',
      updatedAt: new Date().toISOString(),
      updatedBy: 'אני (אלון)'
    },
    savedPlaces: [
      { id: 'home', icon: '🏠', name: 'הבית', address: 'תל אביב', lat: 32.0853, lon: 34.7818, radiusM: 150 },
      { id: 'daycare', icon: '🧸', name: 'הגן של נועה', address: 'תל אביב', lat: 32.0912, lon: 34.7865, radiusM: 150 },
      { id: 'work', icon: '💼', name: 'מקום העבודה', address: 'תל אביב', lat: 32.0731, lon: 34.7922, radiusM: 150 }
    ],
    history: []
  };
}

function loadFamilyState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const def = createDefaultState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(def, null, 2), 'utf8');
      return def;
    }
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const def = createDefaultState();
    return {
      ...def,
      ...parsed,
      profiles: { ...def.profiles, ...(parsed.profiles || {}) },
      coupleStatus: { ...def.coupleStatus, ...(parsed.coupleStatus || {}) },
      pickupToday: { ...def.pickupToday, ...(parsed.pickupToday || {}) },
      savedPlaces: Array.isArray(parsed.savedPlaces)
        ? parsed.savedPlaces.map((p) => ({ address: '', ...p }))
        : def.savedPlaces,
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch {
    return createDefaultState();
  }
}

function saveFamilyState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Ignore disk write issues
  }
}

let familyState = loadFamilyState();

function cleanExpiredTimers(state) {
  const now = Date.now();
  const cs = state.coupleStatus;
  let dirty = false;

  const currentDay = todayKey();
  if (state.dayKey !== currentDay) {
    state.dayKey = currentDay;
    cs.droppedOffAtDaycareToday = false;
    dirty = true;
  }

  if (cs.soloContinueUntil > 0 && now >= cs.soloContinueUntil) {
    cs.soloContinueUntil = 0;
    dirty = true;
  }

  if (cs.snoozeUntil > 0 && now >= cs.snoozeUntil) {
    cs.snoozeUntil = 0;
    if (cs.state === 'SNOOZED_GARAGE') {
      cs.state = 'IDLE';
      cs.statusText = 'מצב מוסך/שטיפה הסתיים – ההגנה חזרה לפעול אוטומטית';
      cs.updatedAt = new Date().toISOString();
    }
    dirty = true;
  }

  if (cs.refuelUntil > 0 && now >= cs.refuelUntil) {
    cs.refuelUntil = 0;
    if (cs.state === 'REFUEL_PAUSE') {
      cs.state = 'ALARM_ACTIVE';
      cs.statusText = 'חלפו 3 דקות תדלוק – חובה לוודא שהרכב נבדק!';
      cs.updatedAt = new Date().toISOString();
    }
    dirty = true;
  }

  if (dirty) saveFamilyState(state);
  return state;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function detectPlace(state, lat, lon, explicitPlaceId) {
  if (explicitPlaceId) {
    return state.savedPlaces.find((p) => p.id === explicitPlaceId) || null;
  }
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  for (const place of state.savedPlaces) {
    if (haversineM(lat, lon, place.lat, place.lon) <= (place.radiusM || 150)) {
      return place;
    }
  }
  return null;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(String(text ?? ''));
}

function resolveShortcutDriverName(state, roleParam) {
  const profiles = state?.profiles || {};
  if (roleParam === 'partner') return `בת הזוג (${profiles.partnerName || 'דנה'})`;
  if (roleParam === 'guest') return `${profiles.guestName || 'סבא/סבתא'} (אורח)`;
  return `אני (${profiles.myName || 'אלון'})`;
}

function parseCoordParam(raw) {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function applyTripStart(familyState, payload, driverName) {
  const cs = familyState.coupleStatus;
  const timeStr = nowTimeHe();
  const originPlace = detectPlace(familyState, payload.lat, payload.lon, payload.originPlaceId);
  familyState.originPlaceId = payload.originPlaceId || originPlace?.id || '';
  cs.driverName = driverName;
  cs.state = 'DRIVING';
  cs.brokenRoutineAlert = false;
  cs.refuelUntil = 0;
  if (typeof payload.savedVolumePct === 'number') {
    cs.savedVolumePct = payload.savedVolumePct;
  }
  cs.statusText = `${driverName} בנסיעה כעת (${timeStr})${originPlace ? ` • מ${originPlace.name}` : ''}`;
  cs.updatedAt = new Date().toISOString();
  return originPlace;
}

function evaluateTripEnd(familyState, payload, driverName, { enforcePrecheck = false } = {}) {
  const now = Date.now();
  const cs = familyState.coupleStatus;
  const timeStr = nowTimeHe();
  cs.driverName = driverName;
  if (typeof payload.tempC === 'number') cs.tempC = payload.tempC;
  if (typeof payload.savedVolumePct === 'number') cs.savedVolumePct = payload.savedVolumePct;

  const place = detectPlace(familyState, payload.lat, payload.lon, payload.placeId);
  familyState.lastEndPlaceId = place?.id || '';
  const originPlaceId = payload.originPlaceId || familyState.originPlaceId || '';
  const hour = nowHourJerusalem();
  const isAfternoon = hour >= 12;
  const assignee = familyState.pickupToday?.assignee || 'אני';

  if (!payload.forceBrokenRoutine && !payload.isDemo && place?.id === 'daycare' && (isAfternoon || cs.droppedOffAtDaycareToday)) {
    cs.soloContinueUntil = 0;
    cs.droppedOffAtDaycareToday = false;
    cs.brokenRoutineAlert = false;
    cs.refuelUntil = 0;
    cs.state = 'IDLE';
    cs.statusText = '🧸 איסוף מהגן זוהה אוטומטית – הגנת מושב אחורי פעילה לנסיעה הביתה!';
    cs.updatedAt = new Date().toISOString();
    return { suppressed: true, suppressReason: 'DAYCARE_PICKUP_ARMED', place, brokenRoutine: false, speakText: '' };
  }

  if (!payload.forceBrokenRoutine && !payload.isDemo && originPlaceId === 'work' && place?.id !== 'daycare') {
    cs.state = 'IDLE';
    cs.brokenRoutineAlert = false;
    cs.refuelUntil = 0;
    cs.statusText = '🚗 יציאה ממקום העבודה לבד – ההתרעה הושתקה אוטומטית';
    cs.updatedAt = new Date().toISOString();
    return { suppressed: true, suppressReason: 'LEFT_WORK_SOLO', place, brokenRoutine: false, speakText: '' };
  }

  const directWorkWithoutDaycare =
    place?.id === 'work' && !cs.droppedOffAtDaycareToday && cs.soloContinueUntil <= now;
  if (!payload.forceBrokenRoutine && !payload.isDemo && directWorkWithoutDaycare && (assignee === 'בת הזוג' || assignee === 'סבא/סבתא')) {
    cs.state = 'IDLE';
    cs.brokenRoutineAlert = false;
    cs.refuelUntil = 0;
    cs.statusText = `🚗 הגעה לעבודה לבד (${assignee} באחריות היום) – הושתק אוטומטית`;
    cs.updatedAt = new Date().toISOString();
    return { suppressed: true, suppressReason: 'PARTNER_RESPONSIBLE_SOLO', place, brokenRoutine: false, speakText: '' };
  }

  const isBrokenRoutine = Boolean(payload.forceBrokenRoutine) || directWorkWithoutDaycare;

  if (!isBrokenRoutine) {
    if (cs.snoozeUntil > now) {
      cs.state = 'SNOOZED_GARAGE';
      cs.statusText = '🔧 מצב מוסך/שטיפה פעיל – ההתרעה דולגה';
      cs.updatedAt = new Date().toISOString();
      return { suppressed: true, suppressReason: 'GARAGE', place, brokenRoutine: false, speakText: '' };
    }
    if (enforcePrecheck && cs.lastVerifiedAt && now - cs.lastVerifiedAt < 5 * 60 * 1000) {
      return { suppressed: true, suppressReason: 'RECENTLY_VERIFIED', place, brokenRoutine: false, speakText: '' };
    }
    if (enforcePrecheck && cs.refuelUntil > now) {
      return { suppressed: true, suppressReason: 'REFUEL_PAUSE', place, brokenRoutine: false, speakText: '' };
    }
    if (cs.soloContinueUntil > now) {
      cs.state = 'IDLE';
      cs.statusText = `${driverName} הגיע/ה ליעד לבד (נסיעת המשך שקטה ✓)`;
      cs.updatedAt = new Date().toISOString();
      return { suppressed: true, suppressReason: 'SOLO_CONTINUE', place, brokenRoutine: false, speakText: '' };
    }
  }

  cs.brokenRoutineAlert = isBrokenRoutine;
  cs.refuelUntil = 0;
  cs.state = isBrokenRoutine || payload.immediateAlarm ? 'ALARM_ACTIVE' : 'GRACE_PERIOD';
  cs.statusText = isBrokenRoutine
    ? `⚠️ חריגת שגרה! ${driverName} חנה/תה בעבודה בלי עצירה בגן (${timeStr})`
    : `${driverName} סיים/ה נסיעה${place ? ` (${place.icon} ${place.name})` : ''} – ממתין לבדיקה`;
  cs.updatedAt = new Date().toISOString();

  const speakText = isBrokenRoutine
    ? 'אזהרה דחופה! הגעת לעבודה בלי עצירה בגן! בדוק מיד את המושב האחורי!'
    : 'הנסיעה הסתיימה! בדוק מיד את המושב האחורי וודא שהרכב ריק.';
  return { suppressed: false, brokenRoutine: isBrokenRoutine, place, speakText };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function handleApi(req, res, reqUrl) {
  cleanExpiredTimers(familyState);
  const pathname = reqUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/state') {
    const publicCopy = {
      ...familyState,
      familyPin: undefined,
      pinConfigured: Boolean(familyState.familyPin)
    };
    sendJson(res, 200, publicCopy);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/should-alarm') {
    const now = Date.now();
    const cs = familyState.coupleStatus;
    let alarmRequired = false;
    let reason = cs.state;

    if (cs.snoozeUntil > now) {
      alarmRequired = false;
      reason = 'SNOOZED_GARAGE';
    } else if (cs.soloContinueUntil > now) {
      alarmRequired = false;
      reason = 'SOLO_CONTINUE';
    } else if (cs.refuelUntil > now) {
      alarmRequired = false;
      reason = 'REFUEL_PAUSE';
    } else if (cs.lastVerifiedAt && now - cs.lastVerifiedAt < 5 * 60 * 1000) {
      alarmRequired = false;
      reason = 'RECENTLY_VERIFIED';
    } else if (cs.state === 'ALARM_ACTIVE' || cs.state === 'GRACE_PERIOD') {
      alarmRequired = true;
      reason = cs.brokenRoutineAlert ? 'BROKEN_ROUTINE' : 'UNVERIFIED_STOP';
    }

    sendJson(res, 200, {
      alarmRequired,
      reason,
      restoreVolumePct: cs.savedVolumePct ?? 25,
      state: cs.state
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/shortcut/start') {
    const providedPin = req.headers['x-family-key'] || reqUrl.searchParams.get('pin');
    const format = reqUrl.searchParams.get('format') || 'json';
    if (providedPin && familyState.familyPin && String(providedPin) !== String(familyState.familyPin)) {
      if (format === 'text') sendText(res, 401, '');
      else sendJson(res, 401, { error: 'מפתח משפחה שגוי (Unauthorized)' });
      return true;
    }
    const driverName = resolveShortcutDriverName(familyState, reqUrl.searchParams.get('role'));
    const originPlace = applyTripStart(
      familyState,
      {
        lat: parseCoordParam(reqUrl.searchParams.get('lat')),
        lon: parseCoordParam(reqUrl.searchParams.get('lon')),
        originPlaceId: reqUrl.searchParams.get('placeId') || undefined
      },
      driverName
    );
    saveFamilyState(familyState);
    if (format === 'text') {
      sendText(res, 200, 'OK');
    } else {
      sendJson(res, 200, { ok: true, state: 'DRIVING', originPlace: originPlace?.id || null });
    }
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/shortcut/exit') {
    const providedPin = req.headers['x-family-key'] || reqUrl.searchParams.get('pin');
    const format = reqUrl.searchParams.get('format') || 'json';
    if (providedPin && familyState.familyPin && String(providedPin) !== String(familyState.familyPin)) {
      if (format === 'text') sendText(res, 401, '');
      else sendJson(res, 401, { error: 'מפתח משפחה שגוי (Unauthorized)' });
      return true;
    }
    const driverName = resolveShortcutDriverName(familyState, reqUrl.searchParams.get('role'));
    const result = evaluateTripEnd(
      familyState,
      {
        lat: parseCoordParam(reqUrl.searchParams.get('lat')),
        lon: parseCoordParam(reqUrl.searchParams.get('lon')),
        placeId: reqUrl.searchParams.get('placeId') || undefined,
        immediateAlarm: true
      },
      driverName,
      { enforcePrecheck: true }
    );
    saveFamilyState(familyState);
    if (format === 'audio') {
      const audioFile = result.suppressed
        ? 'silence.mp3'
        : result.brokenRoutine
          ? 'alert-broken-routine.mp3'
          : 'alert-stop.mp3';
      const filePath = path.join(ROOT_DIR, 'assets', 'audio', audioFile);
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': buf.length,
        'Content-Disposition': 'inline; filename="childguard-alert.mp3"',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
      return true;
    }
    if (result.suppressed) {
      if (format === 'text') sendText(res, 200, '');
      else sendJson(res, 200, { ok: true, alarmRequired: false, reason: result.suppressReason, speakText: '' });
      return true;
    }
    if (format === 'text') {
      sendText(res, 200, result.speakText);
    } else {
      sendJson(res, 200, {
        ok: true,
        alarmRequired: true,
        brokenRoutine: result.brokenRoutine,
        speakText: result.speakText
      });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/tts') {
    readJsonBody(req)
      .then(async (payload) => {
        const apiKey = loadGeminiApiKey();
        if (!apiKey) {
          sendJson(res, 503, { error: 'GEMINI_API_KEY is not configured' });
          return;
        }
        const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 500) : '';
        if (!text) {
          sendJson(res, 400, { error: 'Missing text' });
          return;
        }
        const voice = payload.voice === 'Kore' ? 'Kore' : 'Aoede';
        const style =
          typeof payload.style === 'string' && payload.style.trim()
            ? payload.style.trim()
            : 'warm, clear, natural Israeli female voice speaking Hebrew';

        const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            model: 'gemini-3.8-flash-tts',
            input: [
              {
                type: 'user_input',
                content: [
                  {
                    type: 'text',
                    text,
                    annotations: [{ type: 'speech_metadata', style }]
                  }
                ]
              }
            ],
            response_format: { type: 'audio' },
            generation_config: { speech_config: [{ voice }] }
          })
        });

        const data = await upstream.json();
        if (!upstream.ok) {
          sendJson(res, upstream.status, { error: data?.error?.message || 'Gemini TTS failed' });
          return;
        }

        const outputs = data.steps?.filter((s) => s.type === 'model_output') || [];
        let audioPart = null;
        for (const out of outputs) {
          const found = out.content?.find((c) => c.type === 'audio');
          if (found?.data) audioPart = found;
        }
        if (!audioPart?.data) {
          sendJson(res, 502, { error: 'No audio returned from Gemini TTS' });
          return;
        }
        sendJson(res, 200, {
          audioBase64: audioPart.data,
          mimeType: audioPart.mime_type || 'audio/wav',
          voice
        });
      })
      .catch(() => {
        sendJson(res, 500, { error: 'TTS request error' });
      });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/event') {
    readJsonBody(req)
      .then((payload) => {
        const providedPin = req.headers['x-family-key'] || payload.pin;
        if (providedPin && familyState.familyPin && String(providedPin) !== String(familyState.familyPin)) {
          sendJson(res, 401, { error: 'מפתח משפחה שגוי (Unauthorized)' });
          return;
        }

        const now = Date.now();
        const cs = familyState.coupleStatus;
        const driverName = payload.driverName || cs.driverName || 'אני (אלון)';
        const timeStr = nowTimeHe();
        let meta = {};

        if (Array.isArray(payload.clientPlaces)) {
          const clientPlacesMs = Date.parse(payload.placesUpdatedAt || '') || 0;
          const serverPlacesMs = Date.parse(familyState.placesUpdatedAt || '') || 0;
          if (clientPlacesMs >= serverPlacesMs && clientPlacesMs > 0) {
            familyState.savedPlaces = payload.clientPlaces.slice(0, 20).map((p) => ({
              id: String(p.id || 'p_' + now).slice(0, 48),
              icon: String(p.icon || '📍').slice(0, 16),
              name: String(p.name || 'מקום').slice(0, 48),
              address: String(p.address || '').slice(0, 120),
              lat: typeof p.lat === 'number' && Number.isFinite(p.lat) ? p.lat : 32.0853,
              lon: typeof p.lon === 'number' && Number.isFinite(p.lon) ? p.lon : 34.7818,
              radiusM: typeof p.radiusM === 'number' && Number.isFinite(p.radiusM) ? p.radiusM : 150
            }));
            familyState.placesUpdatedAt = payload.placesUpdatedAt;
          }
        }

        switch (payload.type) {
          case 'TRIP_START': {
            applyTripStart(familyState, payload, driverName);
            break;
          }

          case 'MICRO_TRIP_FILTERED': {
            const dur = payload.durationSec || 40;
            const dist = payload.distanceM || 20;
            cs.driverName = driverName;
            if (cs.state === 'DRIVING') cs.state = 'IDLE';
            cs.statusText = `נסיעת סרק סוננה בשקט (${dur} שנ', ${dist} מ')`;
            cs.updatedAt = new Date().toISOString();
            meta.suppressed = true;
            break;
          }

          case 'TRIP_END': {
            const resEnd = evaluateTripEnd(familyState, payload, driverName, { enforcePrecheck: false });
            meta = resEnd.suppressed
              ? { suppressed: true, suppressReason: resEnd.suppressReason, place: resEnd.place }
              : { suppressed: false, brokenRoutine: resEnd.brokenRoutine, place: resEnd.place };
            break;
          }

          case 'VERIFY_EMPTY': {
            cs.driverName = driverName;
            cs.state = 'VERIFIED_SAFE';
            cs.lastVerifiedAt = now;
            cs.brokenRoutineAlert = false;
            cs.refuelUntil = 0;
            const hour = nowHourJerusalem();
            if (familyState.lastEndPlaceId === 'daycare' && hour < 12) {
              const morningSoloMs = Math.max(5, 15 - hour) * 60 * 60 * 1000;
              cs.droppedOffAtDaycareToday = true;
              cs.soloContinueUntil = Math.max(cs.soloContinueUntil || 0, now + morningSoloMs);
            }
            cs.statusText = `${driverName}: הרכב נבדק וריק ✓ (${timeStr})`;
            cs.updatedAt = new Date().toISOString();
            familyState.history.unshift({
              id: String(now),
              endedAt: new Date().toISOString(),
              driverName,
              method: payload.method || 'אימות מהיר',
              reason: payload.reason || 'סיום נסיעה רגיל',
              maxSpeedKmh: payload.maxSpeedKmh || 0,
              children: Array.isArray(payload.children) ? payload.children : [],
              outcome: 'EMPTY'
            });
            familyState.history = familyState.history.slice(0, 40);
            break;
          }

          case 'VERIFY_DAYCARE_SOLO': {
            const hour = nowHourJerusalem();
            const morningSoloMs = Math.max(5, 15 - hour) * 60 * 60 * 1000;
            cs.driverName = driverName;
            cs.state = 'DROPPED_AT_DAYCARE';
            cs.droppedOffAtDaycareToday = true;
            cs.lastVerifiedAt = now;
            cs.soloContinueUntil = now + morningSoloMs;
            cs.brokenRoutineAlert = false;
            cs.refuelUntil = 0;
            cs.statusText = `${driverName}: הוריד/ה בגן בבטחה ✓ (${timeStr}) • המשך לבד מושתק אוטומטית`;
            cs.updatedAt = new Date().toISOString();
            familyState.history.unshift({
              id: String(now),
              endedAt: new Date().toISOString(),
              driverName,
              method: payload.method || 'אימות מהיר',
              reason: 'הורדה בגן + המשך לבד לעבודה',
              maxSpeedKmh: payload.maxSpeedKmh || 0,
              children: Array.isArray(payload.children) ? payload.children : [],
              outcome: 'DAYCARE_SOLO'
            });
            familyState.history = familyState.history.slice(0, 40);
            break;
          }

          case 'REFUEL_PAUSE': {
            const mins = Number(payload.minutes) || 3;
            cs.driverName = driverName;
            cs.state = 'REFUEL_PAUSE';
            cs.refuelUntil = now + mins * 60 * 1000;
            cs.statusText = `${driverName}: ⛽ בתדלוק / עצירה קצרה (הילד ברכב – בדיקה חוזרת בעוד ${mins} דק')`;
            cs.updatedAt = new Date().toISOString();
            break;
          }

          case 'GARAGE_SNOOZE': {
            if (payload.clear) {
              cs.snoozeUntil = 0;
              cs.state = 'IDLE';
              cs.statusText = 'מצב מוסך/שטיפה בוטל – ההגנה פעילה';
            } else {
              cs.snoozeUntil = now + 3 * 60 * 60 * 1000;
              cs.state = 'SNOOZED_GARAGE';
              cs.statusText = '🔧 מצב מוסך/שטיפה פעיל ל-3 שעות (יחזור אוטומטית)';
            }
            cs.updatedAt = new Date().toISOString();
            break;
          }

          case 'SOLO_DRIVE': {
            if (payload.clear) {
              cs.soloContinueUntil = 0;
              cs.statusText = 'מצב נסיעה לבד בוטל – ההגנה פעילה';
            } else {
              cs.soloContinueUntil = now + 2 * 60 * 60 * 1000;
              cs.statusText = `${driverName}: 🚗 נוסע/ת לבד – התראות מושתקות לשעתיים`;
            }
            cs.updatedAt = new Date().toISOString();
            break;
          }

          case 'SET_PICKUP': {
            familyState.pickupToday = {
              assignee: payload.assignee || 'אני',
              updatedAt: new Date().toISOString(),
              updatedBy: driverName
            };
            cs.updatedAt = new Date().toISOString();
            break;
          }

          case 'UPDATE_PLACE': {
            const target = familyState.savedPlaces.find((p) => p.id === payload.placeId);
            if (target) {
              if (typeof payload.name === 'string' && payload.name.trim()) {
                target.name = payload.name.trim().slice(0, 48);
              }
              if (typeof payload.icon === 'string' && payload.icon.trim()) {
                target.icon = payload.icon.trim().slice(0, 6);
              }
              if (typeof payload.address === 'string') {
                target.address = payload.address.trim().slice(0, 120);
              }
              if (typeof payload.lat === 'number' && Number.isFinite(payload.lat)) {
                target.lat = payload.lat;
              }
              if (typeof payload.lon === 'number' && Number.isFinite(payload.lon)) {
                target.lon = payload.lon;
              }
              const nowIso = new Date().toISOString();
              familyState.placesUpdatedAt = nowIso;
              cs.updatedAt = nowIso;
            }
            break;
          }

          case 'ADD_PLACE': {
            const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 48) : '';
            if (name) {
              const requestedId =
                typeof payload.placeId === 'string' && ['home', 'daycare', 'work'].includes(payload.placeId)
                  ? payload.placeId
                  : '';
              const idTaken = requestedId && familyState.savedPlaces.some((p) => p.id === requestedId);
              familyState.savedPlaces.push({
                id: requestedId && !idTaken ? requestedId : 'p_' + now,
                icon: (typeof payload.icon === 'string' && payload.icon.trim()) || '📍',
                name,
                address: typeof payload.address === 'string' ? payload.address.trim().slice(0, 120) : '',
                lat: typeof payload.lat === 'number' && Number.isFinite(payload.lat) ? payload.lat : 32.0853,
                lon: typeof payload.lon === 'number' && Number.isFinite(payload.lon) ? payload.lon : 34.7818,
                radiusM: 150
              });
              const nowIso = new Date().toISOString();
              familyState.placesUpdatedAt = nowIso;
              cs.updatedAt = nowIso;
            }
            break;
          }

          case 'DELETE_PLACE': {
            if (payload.placeId) {
              familyState.savedPlaces = familyState.savedPlaces.filter((p) => p.id !== payload.placeId);
              const nowIso = new Date().toISOString();
              familyState.placesUpdatedAt = nowIso;
              cs.updatedAt = nowIso;
            }
            break;
          }

          case 'RESET_PLACES': {
            familyState.savedPlaces = createDefaultState().savedPlaces;
            const nowIso = new Date().toISOString();
            familyState.placesUpdatedAt = nowIso;
            cs.updatedAt = nowIso;
            break;
          }

          case 'UPDATE_PROFILES': {
            const myName =
              (typeof payload.myName === 'string' && payload.myName.trim().slice(0, 32)) ||
              familyState.profiles.myName;
            const partnerName =
              (typeof payload.partnerName === 'string' && payload.partnerName.trim().slice(0, 32)) ||
              familyState.profiles.partnerName;
            const guestName =
              (typeof payload.guestName === 'string' && payload.guestName.trim().slice(0, 32)) ||
              familyState.profiles.guestName;
            familyState.profiles = { myName, partnerName, guestName };
            cs.driverName = driverName;
            if (cs.state === 'IDLE') {
              cs.statusText = `ממתין לנסיעה • נהג פעיל: ${driverName}`;
            }
            cs.updatedAt = new Date().toISOString();
            break;
          }

          case 'UPDATE_PIN': {
            if (payload.newPin) {
              familyState.familyPin = String(payload.newPin).slice(0, 12);
            }
            break;
          }

          case 'CLEAR_HISTORY': {
            familyState.history = [];
            break;
          }

          case 'RESET_DAY': {
            cs.state = 'IDLE';
            cs.droppedOffAtDaycareToday = false;
            cs.soloContinueUntil = 0;
            cs.snoozeUntil = 0;
            cs.refuelUntil = 0;
            cs.lastVerifiedAt = 0;
            cs.brokenRoutineAlert = false;
            cs.tempC = null;
            cs.statusText = 'אופס מצב יומי – מוכן לבדיקה מחדש';
            cs.updatedAt = new Date().toISOString();
            break;
          }

          default:
            sendJson(res, 400, { error: 'סוג אירוע לא מוכר' });
            return;
        }

        saveFamilyState(familyState);
        sendJson(res, 200, {
          ok: true,
          meta,
          state: {
            ...familyState,
            familyPin: undefined,
            pinConfigured: Boolean(familyState.familyPin)
          }
        });
      })
      .catch(() => {
        sendJson(res, 400, { error: 'בקשת JSON לא תקינה' });
      });
    return true;
  }

  return false;
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (reqUrl.pathname.startsWith('/api/')) {
    if (!handleApi(req, res, reqUrl)) {
      sendJson(res, 404, { error: 'API route not found' });
    }
    return;
  }

  let relPath = decodeURIComponent(reqUrl.pathname);
  if (relPath === '/') relPath = '/index.html';

  const safePath = path.normalize(path.join(ROOT_DIR, relPath));
  if (!safePath.startsWith(ROOT_DIR) || path.basename(safePath) === 'family-state.json') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(safePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\nChildGuard v2 server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of getLanAddresses()) {
    console.log(`  Network: http://${ip}:${PORT}`);
  }
});
