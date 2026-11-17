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
  '.ico': 'image/x-icon'
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nowTimeHe() {
  return new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

function createDefaultState() {
  return {
    familyPin: '1234',
    dayKey: todayKey(),
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
      { id: 'home', icon: '🏠', name: 'הבית', lat: 32.0853, lon: 34.7818, radiusM: 150 },
      { id: 'daycare', icon: '🧸', name: 'הגן של נועה', lat: 32.0912, lon: 34.7865, radiusM: 150 },
      { id: 'work', icon: '💼', name: 'מקום העבודה', lat: 32.0731, lon: 34.7922, radiusM: 150 }
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
    return {
      ...createDefaultState(),
      ...parsed,
      coupleStatus: { ...createDefaultState().coupleStatus, ...(parsed.coupleStatus || {}) },
      pickupToday: { ...createDefaultState().pickupToday, ...(parsed.pickupToday || {}) },
      savedPlaces: Array.isArray(parsed.savedPlaces) ? parsed.savedPlaces : createDefaultState().savedPlaces,
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

        switch (payload.type) {
          case 'TRIP_START': {
            cs.driverName = driverName;
            cs.state = 'DRIVING';
            cs.brokenRoutineAlert = false;
            cs.refuelUntil = 0;
            if (typeof payload.savedVolumePct === 'number') {
              cs.savedVolumePct = payload.savedVolumePct;
            }
            cs.statusText = `${driverName} בנסיעה כעת (${timeStr})`;
            cs.updatedAt = new Date().toISOString();
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
            cs.driverName = driverName;
            if (typeof payload.tempC === 'number') cs.tempC = payload.tempC;
            if (typeof payload.savedVolumePct === 'number') cs.savedVolumePct = payload.savedVolumePct;

            const place = detectPlace(familyState, payload.lat, payload.lon, payload.placeId);
            const isBrokenRoutine =
              Boolean(payload.forceBrokenRoutine) ||
              (place?.id === 'work' && !cs.droppedOffAtDaycareToday && cs.soloContinueUntil <= now);

            if (!isBrokenRoutine && (cs.snoozeUntil > now || cs.soloContinueUntil > now)) {
              cs.state = cs.snoozeUntil > now ? 'SNOOZED_GARAGE' : 'IDLE';
              cs.statusText =
                cs.snoozeUntil > now
                  ? '🔧 מצב מוסך/שטיפה פעיל – ההתרעה דולגה'
                  : `${driverName} הגיע/ה ליעד לבד (נסיעת המשך שקטה ✓)`;
              cs.updatedAt = new Date().toISOString();
              meta = { suppressed: true, suppressReason: cs.snoozeUntil > now ? 'GARAGE' : 'SOLO_CONTINUE', place };
              break;
            }

            cs.brokenRoutineAlert = isBrokenRoutine;
            cs.refuelUntil = 0;
            cs.state = isBrokenRoutine || payload.immediateAlarm ? 'ALARM_ACTIVE' : 'GRACE_PERIOD';
            cs.statusText = isBrokenRoutine
              ? `⚠️ חריגת שגרה! ${driverName} חנה/תה בעבודה בלי עצירה בגן (${timeStr})`
              : `${driverName} סיים/ה נסיעה${place ? ` (${place.icon} ${place.name})` : ''} – ממתין לבדיקה`;
            cs.updatedAt = new Date().toISOString();
            meta = { suppressed: false, brokenRoutine: isBrokenRoutine, place };
            break;
          }

          case 'VERIFY_EMPTY': {
            cs.driverName = driverName;
            cs.state = 'VERIFIED_SAFE';
            cs.lastVerifiedAt = now;
            cs.brokenRoutineAlert = false;
            cs.refuelUntil = 0;
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
            cs.driverName = driverName;
            cs.state = 'DROPPED_AT_DAYCARE';
            cs.droppedOffAtDaycareToday = true;
            cs.lastVerifiedAt = now;
            cs.soloContinueUntil = now + 3 * 60 * 60 * 1000;
            cs.brokenRoutineAlert = false;
            cs.refuelUntil = 0;
            cs.statusText = `${driverName}: הוריד/ה בגן בבטחה ✓ (${timeStr}) • המשך לבד מושתק ל-3 שעות`;
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
            break;
          }

          case 'UPDATE_PLACE': {
            const target = familyState.savedPlaces.find((p) => p.id === payload.placeId);
            if (target && typeof payload.lat === 'number' && typeof payload.lon === 'number') {
              target.lat = payload.lat;
              target.lon = payload.lon;
            }
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
