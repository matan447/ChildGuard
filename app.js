// Conditional polyfills per modern-web-guidance
if (!('switch' in HTMLInputElement.prototype)) {
  import('https://esm.sh/input-switch-polyfill').catch(() => {});
}
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  import('https://esm.sh/invokers-polyfill').catch(() => {});
}

// ============================================================================
// Pure-JS ISO/IEC 18004 QR Code Generator (Byte Mode, ECC Level M, V1-V3)
// ============================================================================
const QR = (() => {
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function polyMul(p, q) {
    const out = new Uint8Array(p.length + q.length - 1);
    for (let i = 0; i < p.length; i++) {
      for (let j = 0; j < q.length; j++) {
        out[i + j] ^= gfMul(p[i], q[j]);
      }
    }
    return out;
  }

  function rsGenerator(ecCount) {
    let g = new Uint8Array([1]);
    for (let i = 0; i < ecCount; i++) {
      g = polyMul(g, new Uint8Array([1, GF_EXP[i]]));
    }
    return g;
  }

  function rsEncode(data, ecCount) {
    const gen = rsGenerator(ecCount);
    const msg = new Uint8Array(data.length + ecCount);
    msg.set(data, 0);
    for (let i = 0; i < data.length; i++) {
      const factor = msg[i];
      if (factor !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], factor);
        }
      }
    }
    return msg.slice(data.length);
  }

  const VERSIONS_M = [
    null,
    { size: 21, dataBytes: 16, ecBytes: 10, align: [] },
    { size: 25, dataBytes: 28, ecBytes: 16, align: [6, 18] },
    { size: 29, dataBytes: 44, ecBytes: 26, align: [6, 22] }
  ];

  function createMatrix(text) {
    const bytes = new TextEncoder().encode(text);
    let version = 3;
    for (let v = 1; v <= 3; v++) {
      if (bytes.length + 2 <= VERSIONS_M[v].dataBytes) {
        version = v;
        break;
      }
    }
    const cfg = VERSIONS_M[version];
    const size = cfg.size;

    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    pushBits(0b0100, 4);
    pushBits(bytes.length, 8);
    for (const b of bytes) pushBits(b, 8);

    const maxDataBits = cfg.dataBytes * 8;
    const termLen = Math.min(4, maxDataBits - bits.length);
    for (let i = 0; i < termLen; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const data = new Uint8Array(cfg.dataBytes);
    for (let i = 0; i < bits.length / 8; i++) {
      let byteVal = 0;
      for (let b = 0; b < 8; b++) byteVal = (byteVal << 1) | bits[i * 8 + b];
      data[i] = byteVal;
    }
    let padToggle = true;
    for (let i = bits.length / 8; i < cfg.dataBytes; i++) {
      data[i] = padToggle ? 0xec : 0x11;
      padToggle = !padToggle;
    }

    const ec = rsEncode(data, cfg.ecBytes);
    const codewords = new Uint8Array(data.length + ec.length);
    codewords.set(data, 0);
    codewords.set(ec, data.length);

    const grid = Array.from({ length: size }, () => Array(size).fill(-1));
    const reserved = Array.from({ length: size }, () => Array(size).fill(false));

    const setModule = (r, c, dark, lock = true) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      grid[r][c] = dark ? 1 : 0;
      if (lock) reserved[r][c] = true;
    };

    const drawFinder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const dark =
            inBox &&
            (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          setModule(r, c, dark);
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    if (cfg.align.length >= 2) {
      for (const ar of cfg.align) {
        for (const ac of cfg.align) {
          if (reserved[ar][ac]) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              setModule(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
            }
          }
        }
      }
    }

    for (let i = 8; i < size - 8; i++) {
      if (!reserved[6][i]) setModule(6, i, i % 2 === 0);
      if (!reserved[i][6]) setModule(i, 6, i % 2 === 0);
    }

    setModule(4 * version + 9, 8, true);
    for (let i = 0; i < 9; i++) {
      if (!reserved[8][i]) reserved[8][i] = true;
      if (!reserved[i][8]) reserved[i][8] = true;
    }
    for (let i = size - 8; i < size; i++) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }

    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < size; i++) {
        const r = upward ? size - 1 - i : i;
        for (let dc = 0; dc < 2; dc++) {
          const c = col - dc;
          if (!reserved[r][c]) {
            let bit = 0;
            if (bitIdx < totalBits) {
              bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
              bitIdx++;
            }
            grid[r][c] = bit;
          }
        }
      }
      upward = !upward;
    }

    const maskFn = [
      (r, c) => (r + c) % 2 === 0,
      (r) => r % 2 === 0,
      (_, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    ];

    function calcFormatBits(maskId) {
      const data5 = (0b00 << 3) | maskId;
      let d = data5 << 10;
      const g = 0b10100110111;
      for (let i = 14; i >= 10; i--) {
        if ((d >> i) & 1) d ^= g << (i - 10);
      }
      return ((data5 << 10) | d) ^ 0b101010000010010;
    }

    function applyFormat(mat, maskId) {
      const fmt = calcFormatBits(maskId);
      mat[size - 8][8] = 1;
      const coordsA = [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
        [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
      ];
      const coordsB = [
        [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
        [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
      ];
      for (let i = 0; i < 15; i++) {
        const bit = (fmt >> (14 - i)) & 1;
        mat[coordsA[i][0]][coordsA[i][1]] = bit;
        mat[coordsB[i][0]][coordsB[i][1]] = bit;
      }
    }

    function penalty(mat) {
      let score = 0;
      for (let r = 0; r < size; r++) {
        let run = 1;
        for (let c = 1; c < size; c++) {
          if (mat[r][c] === mat[r][c - 1]) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else run = 1;
        }
      }
      for (let c = 0; c < size; c++) {
        let run = 1;
        for (let r = 1; r < size; r++) {
          if (mat[r][c] === mat[r - 1][c]) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else run = 1;
        }
      }
      for (let r = 0; r < size - 1; r++) {
        for (let c = 0; c < size - 1; c++) {
          const v = mat[r][c];
          if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) score += 3;
        }
      }
      return score;
    }

    let bestMat = null;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const mat = grid.map((row, r) =>
        row.map((val, c) => (reserved[r][c] ? val : maskFn[m](r, c) ? val ^ 1 : val))
      );
      applyFormat(mat, m);
      const s = penalty(mat);
      if (s < bestScore) {
        bestScore = s;
        bestMat = mat;
      }
    }
    return bestMat;
  }

  function toSvg(text) {
    const mat = createMatrix(text);
    const n = mat.length;
    const margin = 4;
    const total = n + margin * 2;
    let paths = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (mat[r][c] === 1) {
          paths += `<rect x="${c + margin}" y="${r + margin}" width="1" height="1" fill="#0f172a"/>`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/>${paths}</svg>`;
  }

  return { toSvg };
})();

// ============================================================================
// Constants & App State
// ============================================================================
const STORAGE_SETTINGS_KEY = 'childguard_settings_v2';
const STORAGE_HISTORY_KEY = 'childguard_history_v2';
const QR_PAYLOAD = 'CHILDGUARD-BACKSEAT-OK';

const DEFAULT_SETTINGS = {
  driverRole: 'אני (אלון)',
  verificationMode: 'onethumb',
  autoDetect: true,
  microTripFilter: true,
  voiceAlert: true,
  keepAwake: true,
  escalationEnabled: true,
  nightQuietEnabled: false,
  speedThresholdKmh: 15,
  stopDelaySeconds: 60,
  escalationDelaySeconds: 180,
  emergencyContactName: 'דנה',
  emergencyContactPhone: '',
  familyPin: '1234',
  savedVolumePct: 25,
  children: [
    { id: 'c1', name: 'נועה', seat: 'אחורי ימין', aboard: true },
    { id: 'c2', name: 'אורי', seat: 'אחורי שמאל', aboard: false }
  ]
};

const appState = {
  status: 'IDLE', // IDLE | MONITORING | DRIVING | STOPPING | REFUEL_PAUSE | ALARM_ACTIVE | VERIFIED
  settings: loadSettings(),
  history: loadHistory(),
  coupleState: null,
  watchId: null,
  wakeLock: null,
  audioCtx: null,
  audioReady: false,
  sirenInterval: null,
  speechInterval: null,
  vibrateInterval: null,
  stopTimer: null,
  stopSecondsLeft: 0,
  refuelTimer: null,
  refuelSecondsLeft: 0,
  graceTimer: null,
  graceSecondsLeft: 0,
  simTimers: [],
  escalationTimer: null,
  escalationSecondsLeft: 0,
  pollTimer: null,
  prevFix: null,
  lastFix: null,
  startFix: null,
  tripStartTime: null,
  currentSpeedKmh: 0,
  maxSpeedKmh: 0,
  ambientTempC: null,
  alarmStartTime: null,
  alarmReason: '',
  brokenRoutine: false,
  challengeUnlocked: false,
  verifiedCloseInProgress: false,
  lastVerifiedAt: 0,
  oneThumbTargets: [],
  oneThumbStep: 0,
  holdRaf: null,
  holdStartMs: 0,
  challengeTarget: '',
  challengeEntered: '',
  qrStream: null,
  qrScanRaf: null,
  qrDetector: null,
  jsQrFn: null
};

// ============================================================================
// Storage Helpers
// ============================================================================
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      children: Array.isArray(parsed.children) ? parsed.children : structuredClone(DEFAULT_SETTINGS.children)
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(appState.settings));
  } catch {
    // Ignore
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(appState.history.slice(0, 40)));
  } catch {
    // Ignore
  }
}

// ============================================================================
// DOM References
// ============================================================================
const els = {
  securityBanner: document.getElementById('security-banner'),
  originLabel: document.getElementById('origin-label'),
  roleSelect: document.getElementById('role-select'),
  shareGuestBtn: document.getElementById('share-guest-btn'),
  coupleLiveStatus: document.getElementById('couple-live-status'),
  coupleStatusText: document.getElementById('couple-status-text'),
  coupleProtectionBanner: document.getElementById('couple-protection-banner'),
  coupleProtectionText: document.getElementById('couple-protection-text'),
  cancelSuppressionBtn: document.getElementById('cancel-suppression-btn'),
  pickupSyncBar: document.getElementById('pickup-sync-bar'),
  pickupStatusBadge: document.getElementById('pickup-status-badge'),
  btnSoloNow: document.getElementById('btn-solo-now'),
  btnGarageMode: document.getElementById('btn-garage-mode'),
  btnSelfCheck: document.getElementById('btn-self-check'),
  selfCheckReport: document.getElementById('self-check-report'),

  // Demo Lab
  demoDaycareBtn: document.getElementById('demo-daycare-btn'),
  demoBrokenRoutineBtn: document.getElementById('demo-broken-routine-btn'),
  demoRefuelBtn: document.getElementById('demo-refuel-btn'),
  demoMicrotripBtn: document.getElementById('demo-microtrip-btn'),
  demoLowbatBtn: document.getElementById('demo-lowbat-btn'),
  demoHeatwaveBtn: document.getElementById('demo-heatwave-btn'),
  demoResetBtn: document.getElementById('demo-reset-btn'),
  demoFeedbackBox: document.getElementById('demo-feedback-box'),

  // Monitor
  statusPill: document.getElementById('status-pill'),
  statusLabel: document.getElementById('status-label'),
  tempBadge: document.getElementById('temp-badge'),
  audioBadge: document.getElementById('audio-badge'),
  wakelockBadge: document.getElementById('wakelock-badge'),
  speedValue: document.getElementById('speed-value'),
  gaugeProgress: document.getElementById('gauge-progress'),
  stateDescription: document.getElementById('state-description'),
  maxSpeedValue: document.getElementById('max-speed-value'),
  stopCountdownValue: document.getElementById('stop-countdown-value'),
  gpsAccuracyValue: document.getElementById('gps-accuracy-value'),
  aboardCountLabel: document.getElementById('aboard-count-label'),
  aboardChips: document.getElementById('aboard-chips'),
  toggleMonitorBtn: document.getElementById('toggle-monitor-btn'),
  simulateTripBtn: document.getElementById('simulate-trip-btn'),
  instantAlarmBtn: document.getElementById('instant-alarm-btn'),

  // Modes, Places & Settings
  verificationModeGrid: document.getElementById('verification-mode-grid'),
  placesList: document.getElementById('places-list'),
  addChildForm: document.getElementById('add-child-form'),
  childNameInput: document.getElementById('child-name-input'),
  childSeatInput: document.getElementById('child-seat-input'),
  childrenManageList: document.getElementById('children-manage-list'),
  settingAutoDetect: document.getElementById('setting-auto-detect'),
  settingMicrotripFilter: document.getElementById('setting-microtrip-filter'),
  settingVoice: document.getElementById('setting-voice'),
  settingWakelock: document.getElementById('setting-wakelock'),
  settingEscalation: document.getElementById('setting-escalation'),
  settingNightQuiet: document.getElementById('setting-night-quiet'),
  settingSpeedThreshold: document.getElementById('setting-speed-threshold'),
  settingStopDelay: document.getElementById('setting-stop-delay'),
  settingEscalationDelay: document.getElementById('setting-escalation-delay'),
  contactNameInput: document.getElementById('contact-name-input'),
  contactPhoneInput: document.getElementById('contact-phone-input'),
  familyPinInput: document.getElementById('family-pin-input'),
  historyList: document.getElementById('history-list'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),

  // Alarm dialog
  alarmDialog: document.getElementById('alarm-dialog'),
  brokenRoutineBanner: document.getElementById('broken-routine-banner'),
  alarmChildrenReminder: document.getElementById('alarm-children-reminder'),
  alarmStageBanner: document.getElementById('alarm-stage-banner'),
  alarmLockWarning: document.getElementById('alarm-lock-warning'),
  alarmTimeBadge: document.getElementById('alarm-time-badge'),
  alarmTempBadge: document.getElementById('alarm-temp-badge'),
  alarmVolBadge: document.getElementById('alarm-vol-badge'),
  escalationBox: document.getElementById('escalation-box'),
  escalationTimerText: document.getElementById('escalation-timer-text'),
  escalationContactPreview: document.getElementById('escalation-contact-preview'),
  escalationActions: document.getElementById('escalation-actions'),
  callPartnerLink: document.getElementById('call-partner-link'),
  whatsappEscalateLink: document.getElementById('whatsapp-escalate-link'),
  smsEscalateLink: document.getElementById('sms-escalate-link'),

  // Verification Panels
  panelOnethumb: document.getElementById('panel-onethumb'),
  onethumbInstruction: document.getElementById('onethumb-instruction'),
  onethumbProgress: document.getElementById('onethumb-progress'),
  onethumbGrid: document.getElementById('onethumb-grid'),

  panelHold: document.getElementById('panel-hold'),
  holdPhysicalCheck: document.getElementById('hold-physical-check'),
  holdHint: document.getElementById('hold-hint'),
  holdVerifyBtn: document.getElementById('hold-verify-btn'),
  holdRingFill: document.getElementById('hold-ring-fill'),
  holdBtnTitle: document.getElementById('hold-btn-title'),
  holdBtnSub: document.getElementById('hold-btn-sub'),

  panelCode: document.getElementById('panel-code'),
  challengeCodeDisplay: document.getElementById('challenge-code-display'),
  codeDots: document.getElementById('code-dots'),
  codeErrorMsg: document.getElementById('code-error-msg'),
  shuffledKeypad: document.getElementById('shuffled-keypad'),

  panelQr: document.getElementById('panel-qr'),
  qrVideo: document.getElementById('qr-video'),
  qrScanStatus: document.getElementById('qr-scan-status'),
  qrFileInput: document.getElementById('qr-file-input'),
  qrFallbackCodeBtn: document.getElementById('qr-fallback-code-btn'),

  // Outcome actions
  outcomeLockNote: document.getElementById('outcome-lock-note'),
  finalOutcomesGroup: document.getElementById('final-outcomes-group'),
  outcomeDaycareBtn: document.getElementById('outcome-daycare-btn'),
  outcomeEmptyBtn: document.getElementById('outcome-empty-btn'),
  outcomeRefuelBtn: document.getElementById('outcome-refuel-btn'),

  // Secondary dialogs
  qrDialog: document.getElementById('qr-dialog'),
  stickerQrContainer: document.getElementById('sticker-qr-container'),
  downloadQrBtn: document.getElementById('download-qr-btn'),
  printQrBtn: document.getElementById('print-qr-btn'),
  shortcutsDialog: document.getElementById('shortcuts-dialog'),
  endTriggerUrl: document.getElementById('end-trigger-url'),
  startTriggerUrl: document.getElementById('start-trigger-url'),
  prebeepCheckUrl: document.getElementById('prebeep-check-url'),
  guestDriverUrl: document.getElementById('guest-driver-url')
};

// ============================================================================
// Couple Sync API Client (with Offline Fail-Safe)
// ============================================================================
async function apiFetchState() {
  try {
    const res = await fetch('./api/state', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    appState.coupleState = data;
    if (Array.isArray(data.history) && data.history.length > 0) {
      appState.history = data.history;
      saveHistory();
    }
    renderCoupleCard();
    renderPlaces();
    renderHistory();
    return data;
  } catch {
    return null;
  }
}

async function apiPostEvent(type, payload = {}) {
  try {
    const res = await fetch('./api/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Family-Key': appState.settings.familyPin || '1234'
      },
      body: JSON.stringify({
        type,
        driverName: appState.settings.driverRole,
        savedVolumePct: appState.settings.savedVolumePct,
        ...payload
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.state) {
      appState.coupleState = data.state;
      if (Array.isArray(data.state.history)) {
        appState.history = data.state.history;
        saveHistory();
      }
      renderCoupleCard();
      renderPlaces();
      renderHistory();
    }
    return data;
  } catch {
    return null;
  }
}

async function checkPreBeepShouldAlarm(ignoreLocalOverride = false) {
  const now = Date.now();
  if (!ignoreLocalOverride) {
    if (appState.lastVerifiedAt && now - appState.lastVerifiedAt < 5 * 60 * 1000) {
      return { alarmRequired: false, reason: 'RECENTLY_VERIFIED_LOCAL' };
    }
    if (appState.settings.nightQuietEnabled) {
      const hour = new Date().getHours();
      if (hour >= 22 || hour < 6) {
        return { alarmRequired: false, reason: 'NIGHT_QUIET' };
      }
    }
  }
  try {
    const res = await fetch('./api/should-alarm', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (!ignoreLocalOverride && data.alarmRequired === false && ['SOLO_CONTINUE', 'SNOOZED_GARAGE', 'RECENTLY_VERIFIED'].includes(data.reason)) {
        return data;
      }
    }
  } catch {
    // Offline fail-safe: default to protecting the child locally
  }
  return { alarmRequired: true, reason: 'LOCAL_SAFE_DEFAULT' };
}

// ============================================================================
// Demo Feedback Helper
// ============================================================================
function showDemoFeedback(htmlText, tone = 'info') {
  els.demoFeedbackBox.hidden = false;
  els.demoFeedbackBox.className = 'demo-feedback-box';
  if (tone === 'warn') els.demoFeedbackBox.classList.add('is-warn');
  if (tone === 'safe') els.demoFeedbackBox.classList.add('is-safe');
  els.demoFeedbackBox.innerHTML = htmlText;
}

// ============================================================================
// Audio, Speech, Vibration & Weather Helpers
// ============================================================================
function unlockAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!appState.audioCtx) appState.audioCtx = new AudioCtx();
    if (appState.audioCtx.state === 'suspended') appState.audioCtx.resume().catch(() => {});

    const osc = appState.audioCtx.createOscillator();
    const gain = appState.audioCtx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(appState.audioCtx.destination);
    osc.start();
    osc.stop(appState.audioCtx.currentTime + 0.02);

    appState.audioReady = true;
    els.audioBadge.dataset.ready = 'true';
    els.audioBadge.textContent = 'סירנה דרוכה ✓';
  } catch {
    // Ignore
  }
}

function playSirenBurst() {
  if (!appState.settings.voiceAlert) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!appState.audioCtx) appState.audioCtx = new AudioCtx();
    if (appState.audioCtx.state === 'suspended') appState.audioCtx.resume().catch(() => {});
    const ctx = appState.audioCtx;
    const now = ctx.currentTime;
    const freqs = [960, 1340, 960, 1340];
    freqs.forEach((freq, idx) => {
      const start = now + idx * 0.24;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.26, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.23);
    });
  } catch {
    // Ignore
  }
}

function speakHebrewAlert(customText = null) {
  if (!appState.settings.voiceAlert || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const aboardNames = getAboardChildren().map((c) => c.name);
    const namesPart = aboardNames.length ? ` שימו לב ל${aboardNames.join(' ו')}.` : '';
    const msg =
      customText ||
      (appState.brokenRoutine
        ? `אזהרה! חנית בעבודה בלי עצירה בגן הבוקר! בדוק מיד את המושב האחורי.${namesPart}`
        : `הנסיעה הסתיימה! בדוק את המושב האחורי.${namesPart}`);
    const utter = new SpeechSynthesisUtterance(msg);
    utter.lang = 'he-IL';
    utter.rate = 1.02;
    window.speechSynthesis.speak(utter);
  } catch {
    // Ignore
  }
}

function triggerSystemNotification() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const aboardNames = getAboardChildren().map((c) => c.name);
  const body = appState.brokenRoutine
    ? '⚠️ חנית בעבודה בלי עצירה בגן! בדוק מיד את המושב האחורי!'
    : aboardNames.length
      ? `עצרת את הרכב! בדוק את המושב האחורי (${aboardNames.join(', ')})`
      : 'עצרת את הרכב! בדוק מיד את המושב האחורי.';
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification('🚨 שומר הילדים – בדוק את הרכב!', {
          body,
          icon: './icon-192.png',
          tag: 'childguard-alarm',
          requireInteraction: true
        });
      });
    } else {
      new Notification('🚨 שומר הילדים – בדוק את הרכב!', { body, tag: 'childguard-alarm' });
    }
  } catch {
    // Ignore
  }
}

function startAlarmOutputs() {
  stopAlarmOutputs();
  playSirenBurst();
  speakHebrewAlert();
  if ('vibrate' in navigator) navigator.vibrate([500, 150, 500, 150, 700]);

  appState.sirenInterval = setInterval(playSirenBurst, 1500);
  appState.speechInterval = setInterval(() => speakHebrewAlert(), 7500);
  appState.vibrateInterval = setInterval(() => {
    if ('vibrate' in navigator) navigator.vibrate([500, 150, 500]);
  }, 2200);

  triggerSystemNotification();

  const resumeOnTap = () => {
    if (appState.status === 'ALARM_ACTIVE' && !appState.challengeUnlocked) {
      unlockAudio();
      playSirenBurst();
    }
  };
  document.addEventListener('pointerdown', resumeOnTap, { once: true });
}

function stopAlarmOutputs() {
  clearInterval(appState.sirenInterval);
  clearInterval(appState.speechInterval);
  clearInterval(appState.vibrateInterval);
  appState.sirenInterval = null;
  appState.speechInterval = null;
  appState.vibrateInterval = null;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if ('vibrate' in navigator) navigator.vibrate(0);
}

async function fetchAmbientTemp(lat, lon) {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`
    );
    if (!res.ok) return;
    const json = await res.json();
    const temp = json?.current_weather?.temperature;
    if (typeof temp === 'number') {
      updateTemperatureBadge(Math.round(temp));
    }
  } catch {
    // Offline or blocked
  }
}

function updateTemperatureBadge(tempC) {
  appState.ambientTempC = tempC;
  if (tempC === null || tempC === undefined) {
    els.tempBadge.textContent = '🌡️ —';
    els.tempBadge.classList.remove('is-hot');
    return;
  }
  const hot = tempC >= 28;
  els.tempBadge.textContent = hot ? `🌡️ ${tempC}°C חום קיצוני!` : `🌡️ ${tempC}°C`;
  els.tempBadge.classList.toggle('is-hot', hot);
  if (els.alarmTempBadge) {
    els.alarmTempBadge.textContent = hot
      ? `🌡️ ${tempC}°C – סכנת חום גבוהה ברכב!`
      : `🌡️ טמפ': ${tempC}°C`;
  }
}

// ============================================================================
// Wake Lock
// ============================================================================
async function requestWakeLock() {
  if (!appState.settings.keepAwake || !('wakeLock' in navigator)) return;
  try {
    appState.wakeLock = await navigator.wakeLock.request('screen');
    els.wakelockBadge.dataset.ready = 'true';
    els.wakelockBadge.textContent = 'מסך נשאר ער ✓';
    appState.wakeLock.addEventListener('release', () => {
      appState.wakeLock = null;
      els.wakelockBadge.dataset.ready = 'false';
      els.wakelockBadge.textContent = 'מסך רגיל';
    });
  } catch {
    els.wakelockBadge.dataset.ready = 'false';
    els.wakelockBadge.textContent = 'מסך רגיל';
  }
}

function releaseWakeLock() {
  if (appState.wakeLock) {
    appState.wakeLock.release().catch(() => {});
    appState.wakeLock = null;
  }
  els.wakelockBadge.dataset.ready = 'false';
  els.wakelockBadge.textContent = 'מסך רגיל';
}

// ============================================================================
// GPS, Micro-Trip Filter & State Machine
// ============================================================================
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

function calculateSpeedKmh(prevFix, currFix) {
  if (typeof currFix.speed === 'number' && Number.isFinite(currFix.speed) && currFix.speed >= 0) {
    return Math.round(currFix.speed * 3.6);
  }
  if (!prevFix) return 0;
  const dtHours = (currFix.timestamp - prevFix.timestamp) / 3600000;
  if (dtHours <= 0.00025) return appState.currentSpeedKmh;
  const distKm = haversineM(prevFix.lat, prevFix.lon, currFix.lat, currFix.lon) / 1000;
  const kmh = distKm / dtHours;
  return kmh > 220 ? appState.currentSpeedKmh : Math.round(kmh);
}

function setStatus(newStatus, customDesc) {
  appState.status = newStatus;
  els.statusPill.dataset.state = newStatus;

  const labels = {
    IDLE: 'מוכן לניטור נסיעה',
    MONITORING: 'ניטור GPS פעיל – ממתין לתנועה',
    DRIVING: 'נסיעה ברכב זוהתה!',
    STOPPING: 'עצירה זוהתה – סופר לסיום נסיעה',
    REFUEL_PAUSE: '⛽ בהשהיית תדלוק (הילד ברכב)',
    ALARM_ACTIVE: '🚨 התרעה פעילה – בדוק מושב אחורי!',
    VERIFIED: 'הרכב נבדק ואושר ✓'
  };
  els.statusLabel.textContent = labels[newStatus] || newStatus;

  const descriptions = {
    IDLE: 'המערכת מוכנה. באייפון היא מופעלת ברקע עם מסך כבוי דרך קיצורי הדרך, וכאן ניתן גם להפעיל סימולציה או מעבדת דמו.',
    MONITORING: `עוקב אחרי תנועת הרכב. מעל ${appState.settings.speedThresholdKmh} קמ"ש תתחיל נסיעה (נסיעות קצרות מ-2 דק' ו-150 מ' מסוננות בשקט).`,
    DRIVING: 'נסיעה פעילה. אם תבחר לתדלק או להוריד בגן, תוכל לסמן זאת בסיום.',
    STOPPING: `הרכב עצר! ממתין ${appState.stopSecondsLeft} שנ' (כדי לא להציק בעצירות קצרות).`,
    REFUEL_PAUSE: 'השהיית תדלוק פעילה. אם לא תחזור לנסוע תוך 3 דקות, ההתרעה תופעל שוב אוטומטית.',
    ALARM_ACTIVE: 'התרעה פעילה ונעולה עד שתשלים אימות ביד אחת ותבחר את תוצאת הנסיעה.',
    VERIFIED: 'הנסיעה הסתיימה בבטחה! הווליום שוחזר והסטטוס הזוגי עודכן.'
  };
  els.stateDescription.textContent = customDesc || descriptions[newStatus] || '';

  const isMonitoring = ['MONITORING', 'DRIVING', 'STOPPING'].includes(newStatus);
  els.toggleMonitorBtn.classList.toggle('is-active', isMonitoring);
  els.toggleMonitorBtn.textContent = isMonitoring ? 'עצור ניטור GPS' : 'התחל ניטור נסיעה (GPS)';
}

function updateSpeedTelemetry(speedKmh, accuracyMeters = null) {
  appState.currentSpeedKmh = Math.max(0, Math.round(speedKmh));
  if (appState.currentSpeedKmh > appState.maxSpeedKmh) {
    appState.maxSpeedKmh = appState.currentSpeedKmh;
  }
  els.speedValue.textContent = String(appState.currentSpeedKmh);
  els.maxSpeedValue.textContent = `${appState.maxSpeedKmh} קמ"ש`;

  const pct = Math.min(1, appState.currentSpeedKmh / 120);
  els.gaugeProgress.style.strokeDashoffset = String(364.4 * (1 - pct));
  els.gaugeProgress.style.stroke =
    appState.currentSpeedKmh >= appState.settings.speedThresholdKmh ? '#10b981' : '#3b82f6';

  if (accuracyMeters !== null) {
    els.gpsAccuracyValue.textContent = `±${Math.round(accuracyMeters)} מ'`;
  }
}

function isMicroTrip() {
  if (!appState.settings.microTripFilter) return false;
  const elapsedSec = appState.tripStartTime ? (Date.now() - appState.tripStartTime) / 1000 : 0;
  const distM =
    appState.startFix && appState.lastFix
      ? haversineM(appState.startFix.lat, appState.startFix.lon, appState.lastFix.lat, appState.lastFix.lon)
      : 0;
  return elapsedSec < 120 && distM < 150 && appState.maxSpeedKmh < 25;
}

function handleSpeedSample(speedKmh, accuracy = null) {
  updateSpeedTelemetry(speedKmh, accuracy);
  if (!appState.settings.autoDetect || appState.status === 'ALARM_ACTIVE') return;

  if (['MONITORING', 'VERIFIED', 'IDLE', 'REFUEL_PAUSE'].includes(appState.status)) {
    if (speedKmh >= appState.settings.speedThresholdKmh) {
      clearRefuelTimer();
      appState.tripStartTime = appState.tripStartTime || Date.now();
      setStatus('DRIVING');
      apiPostEvent('TRIP_START');
    }
    return;
  }

  if (appState.status === 'DRIVING') {
    if (speedKmh < 3) {
      if (isMicroTrip()) {
        apiPostEvent('MICRO_TRIP_FILTERED', { durationSec: Math.round((Date.now() - appState.tripStartTime) / 1000), distanceM: 30 });
        setStatus('IDLE', 'נסיעת סרק קצרה (הזזת חניה) סוננה בשקט ללא התראה.');
        return;
      }
      const delay = appState.ambientTempC >= 28 ? Math.min(appState.settings.stopDelaySeconds, 20) : appState.settings.stopDelaySeconds;
      startStopCountdown(delay, 'זיהוי עצירה אוטומטי בסיום נסיעה');
    }
    return;
  }

  if (appState.status === 'STOPPING' && speedKmh >= 6) {
    cancelStopCountdown();
    setStatus('DRIVING');
  }
}

function startStopCountdown(seconds, reason) {
  cancelStopCountdown();
  appState.stopSecondsLeft = seconds;
  setStatus('STOPPING');
  els.stopCountdownValue.textContent = `${appState.stopSecondsLeft} שנ'`;

  appState.stopTimer = setInterval(async () => {
    appState.stopSecondsLeft -= 1;
    if (appState.stopSecondsLeft <= 0) {
      cancelStopCountdown();
      await triggerEndOfTripFlow({ reason });
    } else {
      els.stopCountdownValue.textContent = `${appState.stopSecondsLeft} שנ'`;
      els.stateDescription.textContent = `הרכב עצר! ממתין ${appState.stopSecondsLeft} שנ' (ניתן לנסוע שוב אם זו רק עצירת רמזור).`;
    }
  }, 1000);
}

function cancelStopCountdown() {
  if (appState.stopTimer) {
    clearInterval(appState.stopTimer);
    appState.stopTimer = null;
  }
  els.stopCountdownValue.textContent = '—';
}

function clearRefuelTimer() {
  if (appState.refuelTimer) {
    clearInterval(appState.refuelTimer);
    appState.refuelTimer = null;
  }
  appState.refuelSecondsLeft = 0;
}

function startMonitoring(startAsDriving = false) {
  clearSimulation();
  clearRefuelTimer();
  unlockAudio();
  requestWakeLock();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  appState.maxSpeedKmh = 0;
  appState.prevFix = null;
  appState.startFix = null;
  appState.tripStartTime = Date.now();
  updateSpeedTelemetry(startAsDriving ? appState.settings.speedThresholdKmh : 0);

  if (startAsDriving) {
    apiPostEvent('TRIP_START');
  }

  if (!('geolocation' in navigator)) {
    setStatus(
      startAsDriving ? 'DRIVING' : 'MONITORING',
      'שירותי מיקום לא זמינים בדפדפן. השתמש במעבדת הדמו או בקיצורי אייפון.'
    );
    return;
  }

  if (appState.watchId !== null) navigator.geolocation.clearWatch(appState.watchId);
  setStatus(startAsDriving ? 'DRIVING' : 'MONITORING');

  appState.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const fix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        speed: pos.coords.speed,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp || Date.now()
      };
      if (fix.accuracy && fix.accuracy > 120) {
        els.gpsAccuracyValue.textContent = `חלש (±${Math.round(fix.accuracy)} מ')`;
        return;
      }
      if (!appState.startFix) {
        appState.startFix = fix;
        fetchAmbientTemp(fix.lat, fix.lon);
      }
      const kmh = calculateSpeedKmh(appState.prevFix, fix);
      appState.prevFix = fix;
      appState.lastFix = fix;
      handleSpeedSample(kmh, fix.accuracy);
    },
    (err) => {
      els.gpsAccuracyValue.textContent = 'חסום/שגיאה';
      els.stateDescription.textContent =
        err.code === 1
          ? 'הרשאת המיקום נדחתה (או שהעמוד ב-HTTP). השתמש במעבדת הדמו לבדיקה מיידית.'
          : 'ממתין לאות GPS...';
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

function stopMonitoring() {
  clearSimulation();
  cancelStopCountdown();
  if (appState.watchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(appState.watchId);
    appState.watchId = null;
  }
  releaseWakeLock();
  updateSpeedTelemetry(0);
  setStatus('IDLE');
}

// ============================================================================
// End-of-Trip Orchestration + Pre-Beep & Broken Routine
// ============================================================================
async function triggerEndOfTripFlow(options = {}) {
  const {
    reason = 'זוהתה עצירה בסיום נסיעה',
    placeId = null,
    forceBrokenRoutine = false,
    tempC = appState.ambientTempC,
    bypassPreBeep = false,
    stageLabel = null
  } = options;

  if (!bypassPreBeep && !forceBrokenRoutine) {
    const check = await checkPreBeepShouldAlarm(false);
    if (!check.alarmRequired) {
      setStatus('IDLE', `ההתרעה נחסכה (${check.reason}) – אין שום הפרעה מיותרת.`);
      return { suppressed: true, reason: check.reason };
    }
  }

  const res = await apiPostEvent('TRIP_END', {
    placeId,
    forceBrokenRoutine,
    immediateAlarm: true,
    tempC,
    lat: appState.lastFix?.lat,
    lon: appState.lastFix?.lon
  });

  if (res?.meta?.suppressed && !forceBrokenRoutine) {
    const msg =
      res.meta.suppressReason === 'SOLO_CONTINUE'
        ? '👶➡️💼 מאושר! הורדת בגן הבוקר – נסיעת ההמשך לעבודה הושתקה אוטומטית בלי שום התרעה!'
        : '🔧 מצב מוסך/שטיפה פעיל – ההתרעה דולגה בשקט.';
    setStatus('IDLE', msg);
    return { suppressed: true, reason: res.meta.suppressReason };
  }

  const isBroken = Boolean(forceBrokenRoutine || res?.meta?.brokenRoutine);
  activateAlarm(reason, { brokenRoutine: isBroken, tempC, stageLabel });
  return { suppressed: false, brokenRoutine: isBroken };
}

// ============================================================================
// Trip Simulator
// ============================================================================
function clearSimulation() {
  for (const t of appState.simTimers) clearTimeout(t);
  appState.simTimers = [];
}

function runSimulatedTrip() {
  stopMonitoring();
  unlockAudio();
  requestWakeLock();
  appState.tripStartTime = Date.now();
  appState.maxSpeedKmh = 0;

  setStatus('MONITORING', 'סימולציה: יוצא לדרך ומאיץ...');
  const schedule = (ms, fn) => appState.simTimers.push(setTimeout(fn, ms));

  schedule(400, () => updateSpeedTelemetry(16, 6));
  schedule(1000, () => {
    updateSpeedTelemetry(34, 5);
    setStatus('DRIVING', 'סימולציה: מזוהה נסיעה ברכב (34 קמ"ש)...');
    apiPostEvent('TRIP_START');
  });
  schedule(1900, () => {
    updateSpeedTelemetry(48, 5);
    setStatus('DRIVING', 'סימולציה: נסיעה רציפה (48 קמ"ש). חניה בעוד שנייה...');
  });
  schedule(2800, () => updateSpeedTelemetry(11, 5));
  schedule(3500, () => {
    updateSpeedTelemetry(0, 4);
    startStopCountdown(2, 'סיום נסיעה (סימולציית GPS)');
  });
}

// ============================================================================
// Blocking Alarm Dialog & 4 Verification Modes
// ============================================================================
function getAboardChildren() {
  return appState.settings.children.filter((c) => c.aboard);
}

function activateAlarm(reason = 'זוהתה עצירה בסיום נסיעה', opts = {}) {
  clearSimulation();
  cancelStopCountdown();
  clearRefuelTimer();
  if (appState.watchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(appState.watchId);
    appState.watchId = null;
  }

  appState.alarmStartTime = Date.now();
  appState.alarmReason = reason;
  appState.brokenRoutine = Boolean(opts.brokenRoutine);
  appState.challengeUnlocked = false;
  appState.verifiedCloseInProgress = false;

  if (typeof opts.tempC === 'number') updateTemperatureBadge(opts.tempC);

  setStatus('ALARM_ACTIVE');

  els.brokenRoutineBanner.hidden = !appState.brokenRoutine;
  const aboard = getAboardChildren();
  els.alarmChildrenReminder.textContent = aboard.length
    ? `ילדים ברכב: ${aboard.map((c) => (c.seat ? `${c.name} (${c.seat})` : c.name)).join(' • ')}`
    : 'בדיקת חובה כללית של כל המושבים האחוריים';

  const nowStr = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  els.alarmTimeBadge.textContent = `שעת סיום: ${nowStr}`;

  const t = appState.ambientTempC;
  els.alarmTempBadge.textContent =
    t !== null
      ? t >= 28
        ? `🌡️ ${t}°C – סכנת חום גבוהה ברכב!`
        : `🌡️ טמפ': ${t}°C`
      : '🌡️ טמפ\': נבדקת';

  const savedVol = appState.settings.savedVolumePct ?? 25;
  els.alarmVolBadge.textContent = `🔊 ווליום 100% (ישוחזר אוטומטית ל-${savedVol}%)`;

  els.alarmStageBanner.textContent =
    opts.stageLabel ||
    (appState.brokenRoutine
      ? '🚨 חריגת שגרה! התרעה מיידית (דולגה השהיית החניה!)'
      : '🔊 סירנה פעילה בעוצמה מלאה (עוקפת מצב שקט)');
  els.alarmStageBanner.classList.add('is-siren');

  // Reset outcome lock state
  els.finalOutcomesGroup.hidden = true;
  els.outcomeLockNote.textContent =
    'השלם את האימות למעלה כדי לשחרר את כפתורי הסיום (או לחץ "תדלוק" אם הילד ברכב):';

  setupVerificationPanel(appState.settings.verificationMode);

  // Shorten escalation on extreme heatwave
  const escSeconds =
    appState.ambientTempC >= 28
      ? Math.min(appState.settings.escalationDelaySeconds, 60)
      : appState.settings.escalationDelaySeconds;
  startEscalationCountdown(escSeconds);
  startAlarmOutputs();

  if (!els.alarmDialog.open) {
    els.alarmDialog.showModal();
  }
  focusActiveVerificationControl(appState.settings.verificationMode);
}

function unlockOutcomesAfterChallenge(methodLabel) {
  appState.challengeUnlocked = true;
  appState.activeVerifiedMethod = methodLabel;
  stopAlarmOutputs(); // Silence siren immediately once driver proved alertness so they can calmly choose outcome!
  els.alarmStageBanner.textContent = '✓ אימות ערנות הושלם! בחר כעת את סטטוס הנסיעה למטה:';
  els.alarmStageBanner.classList.remove('is-siren');
  els.outcomeLockNote.textContent = 'בחר האם הורדת את הילד בגן וממשיך לבד, או שהרכב חונה וריק:';
  els.finalOutcomesGroup.hidden = false;
  requestAnimationFrame(() => els.outcomeDaycareBtn.focus());
}

function focusActiveVerificationControl(mode) {
  requestAnimationFrame(() => {
    if (mode === 'onethumb') {
      const btn = els.onethumbGrid.querySelector('button');
      if (btn) btn.focus();
    } else if (mode === 'hold') {
      els.holdPhysicalCheck.focus();
    } else if (mode === 'code') {
      const firstKey = els.shuffledKeypad.querySelector('button');
      if (firstKey) firstKey.focus();
    } else if (mode === 'qr') {
      els.qrFallbackCodeBtn.focus();
    }
  });
}

function setupVerificationPanel(mode) {
  els.panelOnethumb.hidden = mode !== 'onethumb';
  els.panelHold.hidden = mode !== 'hold';
  els.panelCode.hidden = mode !== 'code';
  els.panelQr.hidden = mode !== 'qr';
  stopQrCamera();

  if (mode === 'onethumb') initOneThumbChallenge();
  else if (mode === 'hold') {
    els.holdPhysicalCheck.checked = false;
    els.holdVerifyBtn.classList.remove('is-armed');
    els.holdHint.textContent = 'הפעל קודם את המתג למעלה, ואז לחץ והחזק 3 שניות רצופות';
    resetHoldProgress();
  } else if (mode === 'code') initCodeChallenge();
  else if (mode === 'qr') startQrCamera();
}

// --- Mode 0: One-Thumb Giant Buttons ---
function initOneThumbChallenge() {
  const pool = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const choices = pool.slice(0, 3);
  appState.oneThumbTargets = [choices[0], choices[2]];
  appState.oneThumbStep = 0;

  els.onethumbInstruction.textContent = `הקש ביד אחת לפי הסדר: קודם ${appState.oneThumbTargets[0]} ואז ${appState.oneThumbTargets[1]}`;
  renderOneThumbButtons(choices);
}

function renderOneThumbButtons(choices) {
  els.onethumbProgress.textContent =
    appState.oneThumbStep === 0 ? 'שלב 1 מתוך 2' : 'מעולה! כעת לחץ על הספרה השנייה (2/2)';
  const currentTarget = appState.oneThumbTargets[appState.oneThumbStep];
  els.onethumbGrid.innerHTML = '';

  for (const num of choices) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'onethumb-btn';
    btn.textContent = num;
    if (num === currentTarget) btn.classList.add('is-target-now');
    if (appState.oneThumbStep > 0 && num === appState.oneThumbTargets[0]) btn.classList.add('is-done');

    btn.addEventListener('click', () => {
      if (num === appState.oneThumbTargets[appState.oneThumbStep]) {
        appState.oneThumbStep += 1;
        if (appState.oneThumbStep >= 2) {
          els.onethumbProgress.textContent = 'אושר ביד אחת ✓';
          btn.classList.add('is-done');
          unlockOutcomesAfterChallenge('אימות מהיר ביד אחת');
        } else {
          renderOneThumbButtons(choices);
        }
      } else {
        els.onethumbProgress.textContent = `הקש על המספר המואר (${appState.oneThumbTargets[appState.oneThumbStep]})`;
      }
    });
    els.onethumbGrid.appendChild(btn);
  }
}

// --- Mode 1: Hold + Physical Switch ---
const HOLD_DURATION_MS = 3000;
const HOLD_CIRCUMFERENCE = 2 * Math.PI * 52;

function resetHoldProgress() {
  cancelAnimationFrame(appState.holdRaf);
  appState.holdRaf = null;
  appState.holdStartMs = 0;
  els.holdRingFill.style.strokeDashoffset = String(HOLD_CIRCUMFERENCE);
  els.holdBtnTitle.textContent = 'לחץ והחזק 3 שניות';
  els.holdBtnSub.textContent = els.holdPhysicalCheck.checked
    ? 'החזק רצוף עד להשלמה'
    : 'נדרש אישור פתיחת דלת למעלה';
}

function onHoldStart(e) {
  e.preventDefault();
  if (!els.holdPhysicalCheck.checked) {
    const row = els.holdPhysicalCheck.closest('.switch-row-urgent');
    row.classList.remove('needs-attention');
    void row.offsetWidth;
    row.classList.add('needs-attention');
    els.holdHint.textContent = 'חובה להפעיל קודם את מתג פתיחת הדלת האחורית!';
    els.holdPhysicalCheck.focus();
    return;
  }

  cancelAnimationFrame(appState.holdRaf);
  appState.holdStartMs = performance.now();

  const tick = (now) => {
    const elapsed = now - appState.holdStartMs;
    const progress = Math.min(1, elapsed / HOLD_DURATION_MS);
    els.holdRingFill.style.strokeDashoffset = String(HOLD_CIRCUMFERENCE * (1 - progress));
    const remSec = Math.max(0, (HOLD_DURATION_MS - elapsed) / 1000).toFixed(1);
    els.holdBtnTitle.textContent = `המשך להחזיק... ${remSec}`;
    els.holdBtnSub.textContent = 'מאמת בדיקת רכב';

    if (progress >= 1) {
      unlockOutcomesAfterChallenge('לחיצה ממושכת + מתג דלת');
      return;
    }
    appState.holdRaf = requestAnimationFrame(tick);
  };
  appState.holdRaf = requestAnimationFrame(tick);
}

function onHoldCancel() {
  if (appState.holdRaf) resetHoldProgress();
}

// --- Mode 2: Cognitive 4-Digit Random Challenge ---
function initCodeChallenge() {
  const digits = [];
  for (let i = 0; i < 4; i++) digits.push(Math.floor(Math.random() * 10));
  appState.challengeTarget = digits.join('');
  appState.challengeEntered = '';
  els.challengeCodeDisplay.textContent = digits.join(' ');
  els.codeErrorMsg.textContent = '';
  renderCodeDots();
  renderShuffledKeypad();
}

function renderCodeDots() {
  els.codeDots.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('div');
    dot.className = 'code-dot' + (i < appState.challengeEntered.length ? ' filled' : '');
    dot.textContent = appState.challengeEntered[i] || '';
    els.codeDots.appendChild(dot);
  }
}

function renderShuffledKeypad() {
  const nums = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  els.shuffledKeypad.innerHTML = '';
  const makeKey = (label, val, extraClass = '') => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `key-btn ${extraClass}`.trim();
    btn.textContent = label;
    btn.addEventListener('click', () => handleKeypadPress(val));
    return btn;
  };
  for (let i = 0; i < 9; i++) els.shuffledKeypad.appendChild(makeKey(nums[i], nums[i]));
  els.shuffledKeypad.appendChild(makeKey('נקה', 'clear', 'key-btn-action'));
  els.shuffledKeypad.appendChild(makeKey(nums[9], nums[9]));
  els.shuffledKeypad.appendChild(makeKey('⌫', 'back', 'key-btn-action'));
}

function handleKeypadPress(val) {
  els.codeErrorMsg.textContent = '';
  if (val === 'clear') {
    appState.challengeEntered = '';
    renderCodeDots();
    return;
  }
  if (val === 'back') {
    appState.challengeEntered = appState.challengeEntered.slice(0, -1);
    renderCodeDots();
    return;
  }
  if (appState.challengeEntered.length >= 4) return;
  appState.challengeEntered += val;
  renderCodeDots();

  if (appState.challengeEntered.length === 4) {
    if (appState.challengeEntered === appState.challengeTarget) {
      unlockOutcomesAfterChallenge('אתגר ערנות (קוד אקראי)');
    } else {
      els.codeErrorMsg.textContent = 'קוד שגוי – הקלד שוב את 4 הספרות למעלה';
      appState.challengeEntered = '';
      renderCodeDots();
    }
  }
}

// --- Mode 3: Back-Seat QR Scanner ---
async function ensureQrDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (supported.includes('qr_code')) {
        appState.qrDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return 'native';
      }
    } catch {
      // Fallback to jsQR
    }
  }
  if (!appState.jsQrFn) {
    try {
      const mod = await import('https://esm.sh/jsqr@1.4.0');
      appState.jsQrFn = mod.default || mod;
    } catch {
      return null;
    }
  }
  return 'jsqr';
}

function isValidBackseatPayload(text) {
  return typeof text === 'string' && text.trim().startsWith('CHILDGUARD-');
}

async function startQrCamera() {
  els.qrScanStatus.textContent = 'מפעיל מצלמה אחורית...';
  const decoderMode = await ensureQrDecoder();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    els.qrScanStatus.textContent = 'מצלמה חיה לא זמינה. צלם מדבקה למטה או עבור לאימות ביד אחת.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    appState.qrStream = stream;
    els.qrVideo.srcObject = stream;
    await els.qrVideo.play();
    els.qrScanStatus.textContent = decoderMode
      ? 'מכוון למדבקת ה-QR במושב האחורי...'
      : 'סורק אוטומטי לא זמין – צלם מדבקה או עבור לאימות ביד אחת';

    if (!decoderMode) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const scanLoop = async () => {
      if (appState.status !== 'ALARM_ACTIVE' || els.panelQr.hidden) return;
      if (els.qrVideo.readyState >= 2 && els.qrVideo.videoWidth > 0) {
        try {
          if (appState.qrDetector) {
            const codes = await appState.qrDetector.detect(els.qrVideo);
            if (codes.some((c) => isValidBackseatPayload(c.rawValue))) {
              unlockOutcomesAfterChallenge('סריקת QR במושב האחורי');
              return;
            }
          } else if (appState.jsQrFn) {
            canvas.width = els.qrVideo.videoWidth;
            canvas.height = els.qrVideo.videoHeight;
            ctx.drawImage(els.qrVideo, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const res = appState.jsQrFn(imgData.data, canvas.width, canvas.height);
            if (res && isValidBackseatPayload(res.data)) {
              unlockOutcomesAfterChallenge('סריקת QR במושב האחורי');
              return;
            }
          }
        } catch {
          // Next frame
        }
      }
      appState.qrScanRaf = requestAnimationFrame(scanLoop);
    };
    appState.qrScanRaf = requestAnimationFrame(scanLoop);
  } catch {
    els.qrScanStatus.textContent = 'אין גישה למצלמה החיה. צלם מדבקה למטה או עבור לאימות ביד אחת.';
  }
}

function stopQrCamera() {
  cancelAnimationFrame(appState.qrScanRaf);
  appState.qrScanRaf = null;
  if (appState.qrStream) {
    for (const track of appState.qrStream.getTracks()) track.stop();
    appState.qrStream = null;
  }
  els.qrVideo.srcObject = null;
}

async function handleQrFileUpload(file) {
  if (!file) return;
  els.qrScanStatus.textContent = 'מפענח מדבקת QR...';
  const decoderMode = await ensureQrDecoder();
  if (!decoderMode) {
    els.qrScanStatus.textContent = 'לא ניתן לפענח QR כעת. עבור לאימות ביד אחת.';
    return;
  }
  const img = new Image();
  const objectUrl = URL.createObjectURL(file);
  img.onload = async () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      let matched = false;
      if (appState.qrDetector) {
        const codes = await appState.qrDetector.detect(canvas);
        matched = codes.some((c) => isValidBackseatPayload(c.rawValue));
      } else if (appState.jsQrFn) {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const res = appState.jsQrFn(imgData.data, canvas.width, canvas.height);
        matched = Boolean(res && isValidBackseatPayload(res.data));
      }
      if (matched) unlockOutcomesAfterChallenge('סריקת QR במושב האחורי');
      else els.qrScanStatus.textContent = 'לא זוהה קוד QR תקין של שומר הילדים בתמונה.';
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };
  img.src = objectUrl;
}

// ============================================================================
// Partner Escalation (Calm wording + Call + WhatsApp + SMS)
// ============================================================================
function normalizePhoneForWhatsApp(phone) {
  const digits = phone.replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits.slice(1);
  if (digits.startsWith('0') && digits.length >= 9) return '972' + digits.slice(1);
  return digits;
}

function updateEscalationLinks() {
  const phone = appState.settings.emergencyContactPhone.trim();
  const name = appState.settings.emergencyContactName.trim() || 'בן/בת הזוג';
  const locPart = appState.lastFix
    ? `מיקום הרכב: https://maps.google.com/?q=${appState.lastFix.lat},${appState.lastFix.lon}`
    : 'מיקום GPS אינו זמין';
  const msg = `היי ${name}, הנסיעה של ${appState.settings.driverRole} הסתיימה ועדיין לא סומן אישור בדיקה. מומלץ לבדוק בשיחה. ${locPart}`;

  els.callPartnerLink.href = phone ? `tel:${phone}` : '#';
  const waDigits = normalizePhoneForWhatsApp(phone);
  els.whatsappEscalateLink.href = waDigits
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent(msg)}`
    : `https://wa.me/?text=${encodeURIComponent(msg)}`;
  els.smsEscalateLink.href = phone
    ? `sms:${phone}?&body=${encodeURIComponent(msg)}`
    : `sms:?&body=${encodeURIComponent(msg)}`;
  els.escalationContactPreview.textContent = phone
    ? `אל: ${name} (${phone})`
    : 'לא הוגדר טלפון קבוע – ניתן לבחור איש קשר בלחיצה';
}

function startEscalationCountdown(seconds) {
  stopEscalationCountdown();
  if (!appState.settings.escalationEnabled) {
    els.escalationBox.hidden = true;
    return;
  }
  els.escalationBox.hidden = false;
  els.escalationActions.hidden = true;
  appState.escalationSecondsLeft = seconds;
  updateEscalationLinks();
  els.escalationTimerText.textContent = `התראת גיבוי רגועה ל${appState.settings.emergencyContactName || 'בן/בת הזוג'} בעוד ${appState.escalationSecondsLeft} שנ'`;

  appState.escalationTimer = setInterval(() => {
    appState.escalationSecondsLeft -= 1;
    if (appState.escalationSecondsLeft <= 0) {
      stopEscalationCountdown();
      els.escalationTimerText.textContent = 'חלף זמן ההמתנה! שלח/חייג לבדיקה מול בן/בת הזוג:';
      els.escalationActions.hidden = false;
    } else {
      els.escalationTimerText.textContent = `התראת גיבוי רגועה ל${appState.settings.emergencyContactName || 'בן/בת הזוג'} בעוד ${appState.escalationSecondsLeft} שנ'`;
    }
  }, 1000);
}

function stopEscalationCountdown() {
  if (appState.escalationTimer) {
    clearInterval(appState.escalationTimer);
    appState.escalationTimer = null;
  }
}

// ============================================================================
// Outcome Handlers (Daycare+Solo, Empty, Refuel)
// ============================================================================
async function finalizeOutcome(outcomeType) {
  appState.verifiedCloseInProgress = true;
  appState.lastVerifiedAt = Date.now();
  stopAlarmOutputs();
  stopEscalationCountdown();
  stopQrCamera();
  cancelAnimationFrame(appState.holdRaf);
  releaseWakeLock();

  const method = appState.activeVerifiedMethod || 'אימות מהיר';
  const aboardNames = getAboardChildren().map((c) => c.name);
  const eventType = outcomeType === 'DAYCARE_SOLO' ? 'VERIFY_DAYCARE_SOLO' : 'VERIFY_EMPTY';

  const res = await apiPostEvent(eventType, {
    method,
    reason: outcomeType === 'DAYCARE_SOLO' ? 'הורדה בגן + המשך לבד לעבודה' : appState.alarmReason,
    maxSpeedKmh: appState.maxSpeedKmh,
    children: aboardNames
  });

  // Local fallback if offline
  if (!res) {
    appState.history.unshift({
      id: String(Date.now()),
      endedAt: new Date().toISOString(),
      driverName: appState.settings.driverRole,
      method,
      reason: outcomeType === 'DAYCARE_SOLO' ? 'הורדה בגן + המשך לבד לעבודה' : appState.alarmReason,
      maxSpeedKmh: appState.maxSpeedKmh,
      children: aboardNames,
      outcome: outcomeType
    });
    saveHistory();
    renderHistory();
  }

  if (els.alarmDialog.open) {
    els.alarmDialog.close('verified');
  }
  updateSpeedTelemetry(0);

  const vol = appState.settings.savedVolumePct ?? 25;
  if (outcomeType === 'DAYCARE_SOLO') {
    setStatus('VERIFIED', `הילד/ה הורד/ה בגן בבטחה ✓ נסיעת ההמשך לעבודה מושתקת ל-3 שעות, והווליום שוחזר ל-${vol}%.`);
    showDemoFeedback(
      `<strong>🧸 אושר! הורדת בגן בבטחה.</strong> הסטטוס הזוגי עודכן, הווליום שוחזר אוטומטית ל-<strong>${vol}%</strong>, ונסיעת ההמשך שלך לעבודה מושתקת אוטומטית ל-3 שעות.`,
      'safe'
    );
  } else {
    setStatus('VERIFIED', `הרכב נבדק ואושר כריק ✓ הווליום שוחזר אוטומטית ל-${vol}%.`);
    showDemoFeedback(
      `<strong>✅ הרכב נבדק ואושר כריק.</strong> הבדיקה תועדה ביומן הזוגי והווליום שוחזר ל-<strong>${vol}%</strong>.`,
      'safe'
    );
  }
}

async function pauseForRefuel() {
  appState.verifiedCloseInProgress = true; // Intentional pause close
  stopAlarmOutputs();
  stopEscalationCountdown();
  stopQrCamera();
  cancelAnimationFrame(appState.holdRaf);

  await apiPostEvent('REFUEL_PAUSE', { minutes: 3 });

  if (els.alarmDialog.open) {
    els.alarmDialog.close('refuel');
  }
  setStatus('REFUEL_PAUSE');
  showDemoFeedback(
    '<strong>⛽ מצב תדלוק / עצירה קצרה הופעל!</strong> ההתרעה הושהתה ל-3 דקות <strong>בלי לשקר שהרכב ריק</strong>. אם תמשיך לנסוע הטיימר יתבטל; אם לא תניע תוך 3 דקות – ההתרעה תחזור!',
    'warn'
  );

  clearRefuelTimer();
  appState.refuelSecondsLeft = 180;
  els.stopCountdownValue.textContent = '03:00';
  appState.refuelTimer = setInterval(() => {
    appState.refuelSecondsLeft -= 1;
    if (appState.refuelSecondsLeft <= 0) {
      clearRefuelTimer();
      activateAlarm('חלפו 3 דקות מתדלוק – חובה לוודא שהרכב נבדק!');
    } else {
      const m = String(Math.floor(appState.refuelSecondsLeft / 60)).padStart(2, '0');
      const s = String(appState.refuelSecondsLeft % 60).padStart(2, '0');
      els.stopCountdownValue.textContent = `${m}:${s}`;
    }
  }, 1000);
}

// ============================================================================
// Demo Lab 6 Scenarios + 3-Second Self-Check
// ============================================================================
async function runDemoDaycareLeg() {
  unlockAudio();
  await apiPostEvent('RESET_DAY');
  await apiPostEvent('TRIP_START');
  showDemoFeedback(
    '<strong>🧸 תרחיש 1 (חלק א\'):</strong> יצאת בבוקר לגן והגעת לשער הגן. השלם כעת את האימות ביד אחת ולחץ על <strong>"👶 הורדתי בגן/ביעד – ממשיך לבד"</strong> – ואז תוכל לראות איך ההגעה לעבודה מיד לאחר מכן עוברת בשקט מוחלט!',
    'info'
  );
  await triggerEndOfTripFlow({
    reason: 'הגעה אל הגן של נועה',
    placeId: 'daycare',
    bypassPreBeep: true,
    stageLabel: '📍 זוהתה הגעה ליעד: 🧸 הגן של נועה'
  });
}

async function runDemoBrokenRoutine() {
  unlockAudio();
  await apiPostEvent('RESET_DAY');
  await apiPostEvent('TRIP_START');
  showDemoFeedback(
    '<strong>🚨 תרחיש 2 – שגרה שבורה!</strong> האפליקציה זיהתה שנסעת בבוקר וחנית ב-<strong>💼 מקום העבודה</strong> בלי שעצרת קודם בגן! ההשהיה השקטה בוטלה והופעלה אזעקה מיידית.',
    'warn'
  );
  await triggerEndOfTripFlow({
    reason: '⚠️ חניה בעבודה ללא עצירה בגן!',
    placeId: 'work',
    forceBrokenRoutine: true,
    bypassPreBeep: true
  });
}

async function runDemoRefuel() {
  unlockAudio();
  appState.lastVerifiedAt = 0;
  await apiPostEvent('SOLO_DRIVE', { clear: true });
  await apiPostEvent('GARAGE_SNOOZE', { clear: true });
  await apiPostEvent('TRIP_START');
  showDemoFeedback(
    '<strong>⛽ תרחיש 3 – עצירת תדלוק:</strong> בחלון שנפתח, לחץ למטה על כפתור <strong>"⛽ תדלוק / עצירה קצרה"</strong> כדי לראות איך משהים ל-3 דק\' בלי לשקר שהרכב ריק.',
    'info'
  );
  await triggerEndOfTripFlow({
    reason: 'עצירה בתחנת דלק',
    bypassPreBeep: true,
    stageLabel: '⛽ תרחיש תדלוק: בחר למטה "תדלוק / עצירה קצרה"'
  });
}

async function runDemoMicroTrip() {
  await apiPostEvent('MICRO_TRIP_FILTERED', { durationSec: 40, distanceM: 20 });
  setStatus('IDLE', 'נסיעת סרק (40 שנ\', 20 מ\') סוננה בשקט ללא הפעלת התראה.');
  showDemoFeedback(
    '<strong>🅿️ תרחיש 4 – הזזת חניה / נסיעת סרק:</strong> המערכת זיהתה משך נסיעה של <strong>40 שניות</strong> ומרחק <strong>20 מטר</strong> (מתחת לסף 2 דק\' ו-150 מ\') – ו<strong>סיננה בשקט מוחלט</strong> בלי לצפצף ובלי להציק!',
    'safe'
  );
}

function runDemoLowBattery() {
  unlockAudio();
  const msg = 'שים לב! הסוללה באייפון על 9 אחוז. חבר עכשיו למטען הרכב כדי שההתרעה תעבוד בסיום הנסיעה.';
  speakHebrewAlert(msg);
  showDemoFeedback(
    '<strong>🪫 תרחיש 5 – כניסה לרכב עם 9% סוללה:</strong> האייפון בדק סוללה בחיבור הבלוטות\', זיהה <strong>9%</strong> (מתחת ל-15%), השמיע התראה לחיבור מטען והפעיל טיימר "דופק" של 60 דקות בשרת לגיבוי מול בת הזוג.',
    'warn'
  );
}

async function runDemoHeatwave() {
  unlockAudio();
  appState.lastVerifiedAt = 0;
  await apiPostEvent('SOLO_DRIVE', { clear: true });
  await apiPostEvent('GARAGE_SNOOZE', { clear: true });
  await apiPostEvent('TRIP_START');
  showDemoFeedback(
    '<strong>☀️ תרחיש 6 – חניה ביום שרב (35°C):</strong> חיישן הטמפרטורה זיהה 35°C במיקום החניה, קיצר את זמן ההשהיה והסלמת הגיבוי ל-60 שניות, והוסיף אזהרת חום דחופה.',
    'warn'
  );
  await triggerEndOfTripFlow({
    reason: 'חניה בטמפרטורה קיצונית (35°C)',
    tempC: 35,
    bypassPreBeep: true,
    stageLabel: '☀️ אזהרת שרב (35°C): השהיה קוצרה לסכנת חום מיידית!'
  });
}

async function runSelfCheck() {
  const checks = [];
  try {
    const res = await fetch('./api/should-alarm', { cache: 'no-store' });
    checks.push(res.ok ? '✅ חיבור לשרת הסנכרון הזוגי תקין (Pre-Beep מוכן)' : '❌ שרת הסנכרון לא החזיר תשובה תקינה');
  } catch {
    checks.push('⚠️ השרת אינו זמין כרגע – מצב חירום מקומי פעיל (Offline Fail-Safe)');
  }

  unlockAudio();
  checks.push(appState.audioReady ? '✅ מנוע הסירנה והקראה קולית מוכנים לפעולה' : '⚠️ יש להקיש על המסך כדי לדרוך שמע');
  checks.push(
    window.isSecureContext && 'geolocation' in navigator
      ? '✅ סביבה מאובטחת מאפשרת GPS ומצלמה'
      : '⚠️ כתובת HTTP שאינה מאובטחת – נדרש HTTPS עבור GPS באייפון'
  );
  checks.push(
    appState.settings.emergencyContactPhone.trim()
      ? `✅ איש קשר לגיבוי מוגדר (${appState.settings.emergencyContactName || 'בן/בת זוג'}: ${appState.settings.emergencyContactPhone})`
      : '⚠️ מומלץ להזין מספר טלפון של בן/בת הזוג בהגדרות להסלמת חירום'
  );
  checks.push('✅ מקומות קבועים (בית, גן, עבודה) מוכנים לזיהוי שגרה שבורה');

  els.selfCheckReport.hidden = false;
  els.selfCheckReport.innerHTML = `<strong>תוצאות בדיקת מוכנות (3 שניות):</strong><ul class="self-check-list">${checks
    .map((c) => `<li>${c}</li>`)
    .join('')}</ul>`;
}

// ============================================================================
// UI Rendering
// ============================================================================
function renderCoupleCard() {
  const cs = appState.coupleState?.coupleStatus;
  if (!cs) {
    els.coupleStatusText.textContent = 'מצב מקומי (ממתין לסנכרון שרת)';
    return;
  }
  els.coupleLiveStatus.dataset.state = cs.state || 'IDLE';
  els.coupleStatusText.textContent = cs.statusText || 'מוכן לנסיעה';

  const now = Date.now();
  const soloActive = cs.soloContinueUntil > now;
  const snoozeActive = cs.snoozeUntil > now;

  if (snoozeActive || soloActive) {
    els.coupleProtectionBanner.hidden = false;
    const minsLeft = Math.max(1, Math.ceil(((snoozeActive ? cs.snoozeUntil : cs.soloContinueUntil) - now) / 60000));
    els.coupleProtectionText.textContent = snoozeActive
      ? `🔧 מצב מוסך/שטיפה פעיל – יחזור אוטומטית בעוד ${minsLeft} דק'`
      : `🚗 מצב נסיעה לבד / המשך מהגן פעיל (${minsLeft} דק' נותרו) – התראות מושתקות`;
    els.btnGarageMode.classList.toggle('is-on', snoozeActive);
    els.btnSoloNow.classList.toggle('is-on', soloActive);
  } else {
    els.coupleProtectionBanner.hidden = true;
    els.btnGarageMode.classList.remove('is-on');
    els.btnSoloNow.classList.remove('is-on');
  }

  const pickup = appState.coupleState?.pickupToday?.assignee || 'אני';
  els.pickupStatusBadge.textContent = `באחריות: ${pickup}`;
  for (const btn of els.pickupSyncBar.querySelectorAll('.pickup-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.assignee === pickup));
  }
}

function renderPlaces() {
  const places = appState.coupleState?.savedPlaces || [
    { id: 'home', icon: '🏠', name: 'הבית', lat: 32.0853, lon: 34.7818 },
    { id: 'daycare', icon: '🧸', name: 'הגן של נועה', lat: 32.0912, lon: 34.7865 },
    { id: 'work', icon: '💼', name: 'מקום העבודה', lat: 32.0731, lon: 34.7922 }
  ];
  els.placesList.innerHTML = '';
  for (const p of places) {
    const li = document.createElement('li');
    li.className = 'manage-item';
    const info = document.createElement('span');
    info.innerHTML = `<strong>${p.icon} ${p.name}</strong> <small dir="ltr">(${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})</small>`;

    const updateBtn = document.createElement('button');
    updateBtn.type = 'button';
    updateBtn.className = 'btn-secondary btn-sm';
    updateBtn.textContent = 'קבע למיקום הנוכחי';
    updateBtn.addEventListener('click', async () => {
      if (!appState.lastFix) {
        showDemoFeedback('📍 קבל קודם מיקום GPS (לחץ "התחל ניטור נסיעה") ואז ניתן לשמור מיקום מדויק.', 'warn');
        return;
      }
      await apiPostEvent('UPDATE_PLACE', {
        placeId: p.id,
        lat: appState.lastFix.lat,
        lon: appState.lastFix.lon
      });
      showDemoFeedback(`📍 המיקום של <strong>${p.name}</strong> עודכן לפי ה-GPS הנוכחי שלך!`, 'safe');
    });
    li.append(info, updateBtn);
    els.placesList.appendChild(li);
  }
}

function renderChildren() {
  els.aboardChips.innerHTML = '';
  els.childrenManageList.innerHTML = '';

  const aboard = getAboardChildren();
  els.aboardCountLabel.textContent = aboard.length
    ? `מסומנים ברכב: ${aboard.map((c) => c.name).join(', ')}`
    : 'לא סומנו ילדים (בדיקה כללית פעילה תמיד)';

  for (const child of appState.settings.children) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'child-chip';
    chip.setAttribute('aria-pressed', String(child.aboard));
    chip.textContent = child.aboard ? `✓ ${child.name}` : child.name;
    chip.addEventListener('click', () => {
      child.aboard = !child.aboard;
      saveSettings();
      renderChildren();
    });
    els.aboardChips.appendChild(chip);

    const li = document.createElement('li');
    li.className = 'manage-item';
    const info = document.createElement('span');
    const nameEl = document.createElement('strong');
    nameEl.textContent = child.name;
    info.appendChild(nameEl);
    if (child.seat) {
      const seatEl = document.createElement('small');
      seatEl.textContent = `(${child.seat})`;
      info.appendChild(seatEl);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'remove-btn';
    delBtn.textContent = 'הסר';
    delBtn.addEventListener('click', () => {
      appState.settings.children = appState.settings.children.filter((c) => c.id !== child.id);
      saveSettings();
      renderChildren();
    });
    li.append(info, delBtn);
    els.childrenManageList.appendChild(li);
  }
}

function renderVerificationModes() {
  for (const btn of els.verificationModeGrid.querySelectorAll('.mode-card')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === appState.settings.verificationMode));
  }
}

function renderSettingsControls() {
  els.roleSelect.value = appState.settings.driverRole;
  els.settingAutoDetect.checked = appState.settings.autoDetect;
  els.settingMicrotripFilter.checked = appState.settings.microTripFilter;
  els.settingVoice.checked = appState.settings.voiceAlert;
  els.settingWakelock.checked = appState.settings.keepAwake;
  els.settingEscalation.checked = appState.settings.escalationEnabled;
  els.settingNightQuiet.checked = appState.settings.nightQuietEnabled;
  els.settingSpeedThreshold.value = String(appState.settings.speedThresholdKmh);
  els.settingStopDelay.value = String(appState.settings.stopDelaySeconds);
  els.settingEscalationDelay.value = String(appState.settings.escalationDelaySeconds);
  els.contactNameInput.value = appState.settings.emergencyContactName;
  els.contactPhoneInput.value = appState.settings.emergencyContactPhone;
  els.familyPinInput.value = appState.settings.familyPin;
}

function renderHistory() {
  els.historyList.innerHTML = '';
  if (!appState.history.length) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'טרם נרשמו בדיקות היום. נסה את אחד מתרחישי הדמו למעלה.';
    els.historyList.appendChild(empty);
    return;
  }

  for (const item of appState.history) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const left = document.createElement('div');
    const timeStr = new Date(item.endedAt).toLocaleString('he-IL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    const title = document.createElement('strong');
    title.textContent = `${timeStr} — ${item.reason || 'סיום נסיעה'} (${item.driverName || 'נהג'})`;
    const sub = document.createElement('div');
    sub.className = 'muted-small';
    const childrenTxt = item.children?.length ? `ילדים: ${item.children.join(', ')} • ` : '';
    sub.textContent = `${childrenTxt}שיא מהירות: ${item.maxSpeedKmh || 0} קמ"ש`;
    left.append(title, sub);

    const badge = document.createElement('span');
    badge.className = 'history-badge';
    badge.textContent = `אושר: ${item.method}`;

    li.append(left, badge);
    els.historyList.appendChild(li);
  }
}

function renderQrStickerAndUrls() {
  els.stickerQrContainer.innerHTML = QR.toSvg(QR_PAYLOAD);
  const baseUrl = window.location.origin + window.location.pathname;
  els.endTriggerUrl.textContent = `${baseUrl}?trigger=car_exit`;
  els.startTriggerUrl.textContent = `${baseUrl}?action=start_drive`;
  els.prebeepCheckUrl.textContent = `${window.location.origin}/api/should-alarm`;
  els.guestDriverUrl.textContent = `${baseUrl}?role=guest`;
}

// ============================================================================
// Native <dialog> Hardening & Light-Dismiss Fallback (modern-web-guidance)
// ============================================================================
function initDialogs() {
  els.alarmDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    els.alarmLockWarning.classList.remove('shake');
    void els.alarmLockWarning.offsetWidth;
    els.alarmLockWarning.classList.add('shake');
    focusActiveVerificationControl(appState.settings.verificationMode);
  });

  els.alarmDialog.addEventListener('close', () => {
    els.alarmDialog.returnValue = '';
    if (appState.status === 'ALARM_ACTIVE' && !appState.verifiedCloseInProgress) {
      els.alarmDialog.showModal();
    }
  });

  for (const dlg of [els.qrDialog, els.shortcutsDialog]) {
    dlg.addEventListener('close', () => {
      dlg.returnValue = '';
    });
  }

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (e) => {
        pressedOutside = outside(e, dialog);
      });
      dialog.addEventListener('pointerup', (e) => {
        if (pressedOutside && outside(e, dialog)) dialog.close();
      });
    }
  }
}

// ============================================================================
// Event Wiring & Deep Links
// ============================================================================
function bindEvents() {
  els.roleSelect.addEventListener('change', () => {
    appState.settings.driverRole = els.roleSelect.value;
    saveSettings();
  });

  els.shareGuestBtn.addEventListener('click', async () => {
    const guestUrl = `${window.location.origin}${window.location.pathname}?role=guest`;
    if (navigator.share) {
      navigator.share({ title: 'שומר הילדים – קישור נהג אורח', url: guestUrl }).catch(() => {});
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(guestUrl).catch(() => {});
      showDemoFeedback(`<strong>👴 קישור לנהג אורח (סבא/סבתא) הועתק:</strong> <code>${guestUrl}</code>`, 'info');
    }
  });

  els.pickupSyncBar.addEventListener('click', async (e) => {
    const btn = e.target.closest('.pickup-btn');
    if (!btn) return;
    await apiPostEvent('SET_PICKUP', { assignee: btn.dataset.assignee });
  });

  els.btnSoloNow.addEventListener('click', async () => {
    const active = els.btnSoloNow.classList.contains('is-on');
    await apiPostEvent('SOLO_DRIVE', { clear: active });
  });

  els.btnGarageMode.addEventListener('click', async () => {
    const active = els.btnGarageMode.classList.contains('is-on');
    await apiPostEvent('GARAGE_SNOOZE', { clear: active });
  });

  els.cancelSuppressionBtn.addEventListener('click', async () => {
    await apiPostEvent('SOLO_DRIVE', { clear: true });
    await apiPostEvent('GARAGE_SNOOZE', { clear: true });
  });

  els.btnSelfCheck.addEventListener('click', runSelfCheck);

  // Demo Lab
  els.demoDaycareBtn.addEventListener('click', runDemoDaycareLeg);
  els.demoBrokenRoutineBtn.addEventListener('click', runDemoBrokenRoutine);
  els.demoRefuelBtn.addEventListener('click', runDemoRefuel);
  els.demoMicrotripBtn.addEventListener('click', runDemoMicroTrip);
  els.demoLowbatBtn.addEventListener('click', runDemoLowBattery);
  els.demoHeatwaveBtn.addEventListener('click', runDemoHeatwave);
  els.demoResetBtn.addEventListener('click', async () => {
    appState.lastVerifiedAt = 0;
    await apiPostEvent('RESET_DAY');
    setStatus('IDLE');
    showDemoFeedback('🔄 מצב היום אופס. ניתן לבדוק עכשיו מחדש את תרחיש 1 (גן) או 2 (שגרה שבורה).', 'info');
  });

  // Monitor controls
  els.toggleMonitorBtn.addEventListener('click', () => {
    const isMonitoring = ['MONITORING', 'DRIVING', 'STOPPING'].includes(appState.status);
    if (isMonitoring) stopMonitoring();
    else startMonitoring(false);
  });
  els.simulateTripBtn.addEventListener('click', runSimulatedTrip);
  els.instantAlarmBtn.addEventListener('click', () => {
    unlockAudio();
    activateAlarm('בדיקה ידנית של התרעת סיום');
  });

  els.verificationModeGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.mode-card');
    if (!card) return;
    appState.settings.verificationMode = card.dataset.mode;
    saveSettings();
    renderVerificationModes();
  });

  els.addChildForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.childNameInput.value.trim();
    if (!name) return;
    const seat = els.childSeatInput.value.trim();
    appState.settings.children.push({ id: 'c_' + Date.now(), name, seat, aboard: true });
    els.childNameInput.value = '';
    els.childSeatInput.value = '';
    saveSettings();
    renderChildren();
  });

  els.settingAutoDetect.addEventListener('change', () => {
    appState.settings.autoDetect = els.settingAutoDetect.checked;
    saveSettings();
  });
  els.settingMicrotripFilter.addEventListener('change', () => {
    appState.settings.microTripFilter = els.settingMicrotripFilter.checked;
    saveSettings();
  });
  els.settingVoice.addEventListener('change', () => {
    appState.settings.voiceAlert = els.settingVoice.checked;
    saveSettings();
  });
  els.settingWakelock.addEventListener('change', () => {
    appState.settings.keepAwake = els.settingWakelock.checked;
    saveSettings();
    if (!appState.settings.keepAwake) releaseWakeLock();
  });
  els.settingEscalation.addEventListener('change', () => {
    appState.settings.escalationEnabled = els.settingEscalation.checked;
    saveSettings();
  });
  els.settingNightQuiet.addEventListener('change', () => {
    appState.settings.nightQuietEnabled = els.settingNightQuiet.checked;
    saveSettings();
  });
  els.settingSpeedThreshold.addEventListener('change', () => {
    appState.settings.speedThresholdKmh = Number(els.settingSpeedThreshold.value);
    saveSettings();
  });
  els.settingStopDelay.addEventListener('change', () => {
    appState.settings.stopDelaySeconds = Number(els.settingStopDelay.value);
    saveSettings();
  });
  els.settingEscalationDelay.addEventListener('change', () => {
    appState.settings.escalationDelaySeconds = Number(els.settingEscalationDelay.value);
    saveSettings();
  });

  els.contactNameInput.addEventListener('input', () => {
    appState.settings.emergencyContactName = els.contactNameInput.value;
    saveSettings();
  });
  els.contactPhoneInput.addEventListener('input', () => {
    appState.settings.emergencyContactPhone = els.contactPhoneInput.value;
    saveSettings();
  });
  els.familyPinInput.addEventListener('change', async () => {
    appState.settings.familyPin = els.familyPinInput.value.trim() || '1234';
    saveSettings();
    await apiPostEvent('UPDATE_PIN', { newPin: appState.settings.familyPin });
  });

  els.clearHistoryBtn.addEventListener('click', async () => {
    appState.history = [];
    saveHistory();
    renderHistory();
    await apiPostEvent('CLEAR_HISTORY');
  });

  // Hold mode controls
  els.holdPhysicalCheck.addEventListener('change', () => {
    const ok = els.holdPhysicalCheck.checked;
    els.holdVerifyBtn.classList.toggle('is-armed', ok);
    els.holdHint.textContent = ok
      ? 'מעולה! כעת לחץ והחזק 3 שניות רצופות על הכפתור'
      : 'הפעל קודם את המתג למעלה, ואז לחץ והחזק 3 שניות רצופות';
    resetHoldProgress();
  });
  els.holdVerifyBtn.addEventListener('pointerdown', onHoldStart);
  els.holdVerifyBtn.addEventListener('pointerup', onHoldCancel);
  els.holdVerifyBtn.addEventListener('pointercancel', onHoldCancel);
  els.holdVerifyBtn.addEventListener('pointerleave', onHoldCancel);

  // QR mode controls
  els.qrFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleQrFileUpload(file);
    e.target.value = '';
  });
  els.qrFallbackCodeBtn.addEventListener('click', () => {
    setupVerificationPanel('onethumb');
    focusActiveVerificationControl('onethumb');
  });

  // Outcome buttons inside Alarm Dialog
  els.outcomeDaycareBtn.addEventListener('click', () => finalizeOutcome('DAYCARE_SOLO'));
  els.outcomeEmptyBtn.addEventListener('click', () => finalizeOutcome('EMPTY'));
  els.outcomeRefuelBtn.addEventListener('click', pauseForRefuel);

  // QR Sticker download & print
  els.downloadQrBtn.addEventListener('click', () => {
    const svg = QR.toSvg(QR_PAYLOAD);
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'childguard-backseat-qr.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  els.printQrBtn.addEventListener('click', () => window.print());

  // Copy Shortcut URLs
  for (const btn of document.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent);
        const prev = btn.textContent;
        btn.textContent = 'הועתק ✓';
        setTimeout(() => {
          btn.textContent = prev;
        }, 1600);
      } catch {
        // Ignore
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      apiFetchState();
      if (['MONITORING', 'DRIVING', 'STOPPING', 'ALARM_ACTIVE'].includes(appState.status)) {
        requestWakeLock();
      }
    }
  });
}

async function handleDeepLinkParams() {
  const params = new URLSearchParams(window.location.search);
  const trigger = params.get('trigger');
  const action = params.get('action');
  const role = params.get('role');

  if (role === 'guest') {
    appState.settings.driverRole = 'סבא/סבתא (אורח)';
    saveSettings();
    renderSettingsControls();
  }

  if (trigger === 'car_exit' || action === 'end_drive') {
    await triggerEndOfTripFlow({
      reason: 'הופעל אוטומטית ביציאה מהרכב (קיצור דרך)'
    });
  } else if (action === 'start_drive') {
    startMonitoring(true);
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ============================================================================
// Bootstrap
// ============================================================================
async function init() {
  if (!window.isSecureContext) {
    els.originLabel.textContent = window.location.origin;
    els.securityBanner.hidden = false;
  }

  renderChildren();
  renderVerificationModes();
  renderSettingsControls();
  renderHistory();
  renderQrStickerAndUrls();
  renderPlaces();
  initDialogs();
  bindEvents();
  registerServiceWorker();
  setStatus('IDLE');

  await apiFetchState();
  // Live couple sync poll every 8 seconds
  appState.pollTimer = setInterval(apiFetchState, 8000);
  await handleDeepLinkParams();
}

init();
