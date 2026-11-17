const FIREBASE_PROJECT_ID = 'child-guard-e0744';
const FIREBASE_API_KEY = 'AIzaSyAnmp4FhIY5JlFk0Zis7fMbY5r7VGmmGqY';

let memoryFallbackState = null;

function sanitizePin(raw) {
  const cleaned = String(raw || '1234').replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.length >= 4 ? cleaned.slice(0, 24) : '1234';
}

function firestoreDocUrl(pin) {
  const safePin = sanitizePin(pin);
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/families/family_${safePin}?key=${FIREBASE_API_KEY}`;
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(fv) {
  if (!fv || typeof fv !== 'object') return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return Boolean(fv.booleanValue);
  if ('integerValue' in fv) return Number(fv.integerValue);
  if ('doubleValue' in fv) return Number(fv.doubleValue);
  if ('stringValue' in fv) return fv.stringValue;
  if ('timestampValue' in fv) return fv.timestampValue;
  if ('arrayValue' in fv) {
    return (fv.arrayValue.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in fv) {
    const out = {};
    for (const [k, v] of Object.entries(fv.mapValue.fields || {})) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return null;
}

function buildFirestoreFields(state) {
  const cleanPayload = {
    dayKey: state.dayKey,
    profiles: state.profiles,
    coupleStatus: state.coupleStatus,
    pickupToday: state.pickupToday,
    savedPlaces: state.savedPlaces,
    history: state.history,
    updatedAt: new Date().toISOString(),
    pinConfigured: true
  };
  return toFirestoreValue(cleanPayload).mapValue.fields;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nowTimeHe() {
  return new Date().toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem'
  });
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
      updatedAt: new Date(0).toISOString(),
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

async function loadState(env, pin = '1234') {
  let state = null;
  if (env?.CHILDGUARD_KV) {
    try {
      state = await env.CHILDGUARD_KV.get(`family_state_${sanitizePin(pin)}`, 'json');
    } catch {
      state = null;
    }
  }
  if (!state) {
    try {
      const res = await fetch(firestoreDocUrl(pin));
      if (res.ok) {
        const docJson = await res.json();
        if (docJson?.fields) {
          state = fromFirestoreValue({ mapValue: { fields: docJson.fields } });
        }
      }
    } catch {
      // Fall back to isolate memory if Firestore isn't ready yet
    }
  }
  if (!state) {
    state = memoryFallbackState || createDefaultState();
  } else if (memoryFallbackState) {
    const memPlacesMs = Date.parse(memoryFallbackState.placesUpdatedAt || '') || 0;
    const statePlacesMs = Date.parse(state.placesUpdatedAt || '') || 0;
    if (memPlacesMs > statePlacesMs) {
      state.savedPlaces = memoryFallbackState.savedPlaces;
      state.placesUpdatedAt = memoryFallbackState.placesUpdatedAt;
    }
    const memUpdatedMs = Date.parse(memoryFallbackState.coupleStatus?.updatedAt || '') || 0;
    const stateUpdatedMs = Date.parse(state.coupleStatus?.updatedAt || '') || 0;
    if (memUpdatedMs > stateUpdatedMs) {
      state.profiles = memoryFallbackState.profiles;
      state.coupleStatus = memoryFallbackState.coupleStatus;
      state.pickupToday = memoryFallbackState.pickupToday;
      state.history = memoryFallbackState.history;
    }
  }
  const def = createDefaultState();
  const normalized = {
    ...def,
    ...state,
    profiles: { ...def.profiles, ...(state.profiles || {}) },
    coupleStatus: { ...def.coupleStatus, ...(state.coupleStatus || {}) },
    pickupToday: { ...def.pickupToday, ...(state.pickupToday || {}) },
    savedPlaces: Array.isArray(state.savedPlaces)
      ? state.savedPlaces.map((p) => ({ address: '', ...p }))
      : def.savedPlaces,
    history: Array.isArray(state.history) ? state.history : []
  };
  return normalized;
}

async function saveState(env, state, pin = '1234') {
  memoryFallbackState = state;
  if (env?.CHILDGUARD_KV) {
    try {
      await env.CHILDGUARD_KV.put(`family_state_${sanitizePin(pin)}`, JSON.stringify(state));
    } catch {
      // Ignore KV write failure
    }
  }
  try {
    const res = await fetch(firestoreDocUrl(pin), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: buildFirestoreFields(state) })
    });
    return res.ok;
  } catch {
    return false;
  }
}

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
  return dirty;
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function sanitizePublicState(state) {
  return {
    ...state,
    familyPin: undefined,
    pinConfigured: Boolean(state.familyPin)
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const reqPin = sanitizePin(request.headers.get('x-family-key') || url.searchParams.get('pin') || '1234');

  const familyState = await loadState(env, reqPin);
  if (cleanExpiredTimers(familyState)) {
    await saveState(env, familyState, reqPin);
  }

  if (request.method === 'GET' && pathname === '/api/state') {
    return jsonResponse(sanitizePublicState(familyState));
  }

  if (request.method === 'GET' && pathname === '/api/should-alarm') {
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

    return jsonResponse({
      alarmRequired,
      reason,
      restoreVolumePct: cs.savedVolumePct ?? 25,
      state: cs.state
    });
  }

  if (request.method === 'POST' && pathname === '/api/event') {
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'בקשת JSON לא תקינה' }, 400);
    }

    const providedPin = request.headers.get('x-family-key') || payload.pin;
    if (providedPin && familyState.familyPin && String(providedPin) !== String(familyState.familyPin)) {
      return jsonResponse({ error: 'מפתח משפחה שגוי (Unauthorized)' }, 401);
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
          meta = { suppressed: true, suppressReason: 'DAYCARE_PICKUP_ARMED', place };
          break;
        }

        if (!payload.forceBrokenRoutine && !payload.isDemo && originPlaceId === 'work' && place?.id !== 'daycare') {
          cs.state = 'IDLE';
          cs.brokenRoutineAlert = false;
          cs.refuelUntil = 0;
          cs.statusText = '🚗 יציאה ממקום העבודה לבד – ההתרעה הושתקה אוטומטית';
          cs.updatedAt = new Date().toISOString();
          meta = { suppressed: true, suppressReason: 'LEFT_WORK_SOLO', place };
          break;
        }

        const directWorkWithoutDaycare =
          place?.id === 'work' && !cs.droppedOffAtDaycareToday && cs.soloContinueUntil <= now;
        if (!payload.forceBrokenRoutine && !payload.isDemo && directWorkWithoutDaycare && (assignee === 'בת הזוג' || assignee === 'סבא/סבתא')) {
          cs.state = 'IDLE';
          cs.brokenRoutineAlert = false;
          cs.refuelUntil = 0;
          cs.statusText = `🚗 הגעה לעבודה לבד (${assignee} באחריות היום) – הושתק אוטומטית`;
          cs.updatedAt = new Date().toISOString();
          meta = { suppressed: true, suppressReason: 'PARTNER_RESPONSIBLE_SOLO', place };
          break;
        }

        const isBrokenRoutine = Boolean(payload.forceBrokenRoutine) || directWorkWithoutDaycare;

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
        }
        const nowIso = new Date().toISOString();
        familyState.placesUpdatedAt = nowIso;
        cs.updatedAt = nowIso;
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
        return jsonResponse({ error: 'סוג אירוע לא מוכר' }, 400);
    }

    const savePin = payload.type === 'UPDATE_PIN' && payload.newPin ? sanitizePin(payload.newPin) : reqPin;
    await saveState(env, familyState, savePin);
    return jsonResponse({
      ok: true,
      meta,
      state: sanitizePublicState(familyState)
    });
  }

  if (request.method === 'POST' && pathname === '/api/tts') {
    const apiKey = env?.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'GEMINI_API_KEY is not configured' }, 503);
    }
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'בקשת JSON לא תקינה' }, 400);
    }
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 500) : '';
    if (!text) {
      return jsonResponse({ error: 'Missing text' }, 400);
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
      return jsonResponse({ error: data?.error?.message || 'Gemini TTS failed' }, upstream.status);
    }
    const outputs = data.steps?.filter((s) => s.type === 'model_output') || [];
    let audioPart = null;
    for (const out of outputs) {
      const found = out.content?.find((c) => c.type === 'audio');
      if (found?.data) audioPart = found;
    }
    if (!audioPart?.data) {
      return jsonResponse({ error: 'No audio returned from Gemini TTS' }, 502);
    }
    return jsonResponse({
      audioBase64: audioPart.data,
      mimeType: audioPart.mime_type || 'audio/wav',
      voice
    });
  }

  return jsonResponse({ error: 'API route not found' }, 404);
}
