let memoryFallbackState = null;

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

function createDefaultState() {
  return {
    familyPin: '1234',
    dayKey: todayKey(),
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

async function loadState(env) {
  let state = null;
  if (env?.CHILDGUARD_KV) {
    try {
      state = await env.CHILDGUARD_KV.get('family_state', 'json');
    } catch {
      state = null;
    }
  }
  if (!state) {
    state = memoryFallbackState || createDefaultState();
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

async function saveState(env, state) {
  memoryFallbackState = state;
  if (env?.CHILDGUARD_KV) {
    try {
      await env.CHILDGUARD_KV.put('family_state', JSON.stringify(state));
    } catch {
      // Ignore KV write failure and retain isolate memory
    }
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

  const familyState = await loadState(env);
  if (cleanExpiredTimers(familyState)) {
    await saveState(env, familyState);
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
        break;
      }

      case 'ADD_PLACE': {
        const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 48) : '';
        if (name) {
          familyState.savedPlaces.push({
            id: 'p_' + now,
            icon: (typeof payload.icon === 'string' && payload.icon.trim()) || '📍',
            name,
            address: typeof payload.address === 'string' ? payload.address.trim().slice(0, 120) : '',
            lat: typeof payload.lat === 'number' && Number.isFinite(payload.lat) ? payload.lat : 32.0853,
            lon: typeof payload.lon === 'number' && Number.isFinite(payload.lon) ? payload.lon : 34.7818,
            radiusM: 150
          });
        }
        break;
      }

      case 'DELETE_PLACE': {
        if (payload.placeId) {
          familyState.savedPlaces = familyState.savedPlaces.filter((p) => p.id !== payload.placeId);
        }
        break;
      }

      case 'UPDATE_PROFILES': {
        familyState.profiles = {
          myName:
            (typeof payload.myName === 'string' && payload.myName.trim().slice(0, 32)) ||
            familyState.profiles.myName,
          partnerName:
            (typeof payload.partnerName === 'string' && payload.partnerName.trim().slice(0, 32)) ||
            familyState.profiles.partnerName,
          guestName:
            (typeof payload.guestName === 'string' && payload.guestName.trim().slice(0, 32)) ||
            familyState.profiles.guestName
        };
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

    await saveState(env, familyState);
    return jsonResponse({
      ok: true,
      meta,
      state: sanitizePublicState(familyState)
    });
  }

  return jsonResponse({ error: 'API route not found' }, 404);
}
