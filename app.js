(() => {
  const STORAGE_KEY = "xuxu-rest-v1";
  const TIMER_KEY = "xuxu-rest-timer-v1";
  const END_ALERT_KEY = "xuxu-rest-end-alert-v1";
  const BACKUP_APP_ID = "xuxu-rest-minutes";
  const BACKUP_VERSION = 1;
  const SUBJECTS = ["國文", "數學", "英文"];
  const POINT_MINUTES = 5;
  const SUBJECT_CAP = 20;
  const DAY_CAP = 60;
  const PERFECT_BONUS = 5;
  const LEDGER_LIMIT = 200;
  const DAY_HISTORY_LIMIT = 45;

  const defaultState = () => ({
    balance: 0,
    day: todayKey(),
    regularBySubject: Object.fromEntries(SUBJECTS.map((s) => [s, 0])),
    todayRegular: 0,
    todayOvertime: 0,
    todayBonus: 0,
    todayRedeemed: 0,
    todayManualDeducted: 0,
    allowOvertimeEarn: true,
    endSoundOn: true,
    ledger: [],
    dayHistory: {},
  });

  let pendingDeduct = null;

  let state = load();
  let selectedSubject = "國文";
  let selectedPurpose = "電視";
  let selectedStatsDay = todayKey();
  let timer = {
    running: false,
    paused: false,
    endAt: null,
    remainingMs: 0,
    startedWithMs: 0,
    purpose: "電視",
    sessionId: null,
    intervalId: null,
  };
  let finishing = false;
  let audioCtx = null;
  let audioUnlocked = false;
  let fallbackAudio = null;
  let endAlert = {
    id: null,
    shown: false,
    acked: false,
    effectsPlayed: false,
    notified: false,
    charge: 0,
    purpose: "",
  };

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function dayKeyFromIso(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const merged = { ...defaultState(), ...parsed };
      if (!merged.dayHistory || typeof merged.dayHistory !== "object") {
        merged.dayHistory = {};
      }
      if (!Number.isFinite(merged.todayRedeemed)) merged.todayRedeemed = 0;
      if (!Number.isFinite(merged.todayManualDeducted)) merged.todayManualDeducted = 0;
      if (typeof merged.endSoundOn !== "boolean") merged.endSoundOn = true;
      migrateLedger(merged);
      rebuildDayHistoryFromLedger(merged);
      return merged;
    } catch {
      return defaultState();
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function persistTimer() {
    if (!timer.running && !timer.paused) {
      localStorage.removeItem(TIMER_KEY);
      return;
    }
    localStorage.setItem(
      TIMER_KEY,
      JSON.stringify({
        running: timer.running,
        paused: timer.paused,
        endAt: timer.endAt,
        remainingMs: timer.remainingMs,
        startedWithMs: timer.startedWithMs,
        purpose: timer.purpose,
        sessionId: timer.sessionId,
      })
    );
  }

  function clearPersistedTimer() {
    localStorage.removeItem(TIMER_KEY);
  }

  function loadPersistedTimer() {
    try {
      const raw = localStorage.getItem(TIMER_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function emptyDayBucket() {
    return {
      scores: Object.fromEntries(SUBJECTS.map((s) => [s, []])),
      regular: 0,
      overtime: 0,
      bonus: 0,
      redeemed: 0,
      manualDeducted: 0,
    };
  }

  function ensureDayBucket(target, day) {
    if (!target.dayHistory[day]) {
      target.dayHistory[day] = emptyDayBucket();
    }
    const bucket = target.dayHistory[day];
    if (!bucket.scores) bucket.scores = Object.fromEntries(SUBJECTS.map((s) => [s, []]));
    SUBJECTS.forEach((s) => {
      if (!Array.isArray(bucket.scores[s])) bucket.scores[s] = [];
    });
    bucket.regular = Number(bucket.regular) || 0;
    bucket.overtime = Number(bucket.overtime) || 0;
    bucket.bonus = Number(bucket.bonus) || 0;
    bucket.redeemed = Number(bucket.redeemed) || 0;
    bucket.manualDeducted = Number(bucket.manualDeducted) || 0;
    return bucket;
  }

  function pruneDayHistory(target) {
    const keys = Object.keys(target.dayHistory || {}).sort(compareDayKeysDesc);
    if (keys.length <= DAY_HISTORY_LIMIT) return;
    keys.slice(DAY_HISTORY_LIMIT).forEach((k) => {
      delete target.dayHistory[k];
    });
  }

  function compareDayKeysDesc(a, b) {
    const pa = a.split("-").map(Number);
    const pb = b.split("-").map(Number);
    for (let i = 0; i < 3; i += 1) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i];
    }
    return 0;
  }

  function formatDayLabel(day) {
    const parts = String(day).split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return day;
    const label = `${parts[1]}/${parts[2]}`;
    return day === todayKey() ? `${label}（今天）` : label;
  }

  function migrateLedger(target) {
    target.ledger = (target.ledger || []).map((item) => {
      if (item.kind) return item;
      const day = dayKeyFromIso(item.at) || target.day;
      const title = String(item.title || "");
      const scoreMatch = title.match(/^(國文|數學|英文)\s+(\d+)\s*分$/);
      if (scoreMatch) {
        return {
          ...item,
          kind: "earn",
          subject: scoreMatch[1],
          score: Number(scoreMatch[2]),
          dayKey: day,
          regular: Math.max(0, Number(item.delta) || 0),
          overtime: 0,
          bonus: 0,
        };
      }
      if (title === "休息時間到" || title === "結束休息") {
        const mins = Math.abs(Number(item.delta) || 0);
        return {
          ...item,
          kind: "redeem",
          dayKey: day,
          minutes: mins,
        };
      }
      return { ...item, dayKey: day, kind: item.kind || "other" };
    });
  }

  function rebuildDayHistoryFromLedger(target) {
    const fromLedger = {};
    (target.ledger || []).forEach((item) => {
      const day = item.dayKey || dayKeyFromIso(item.at);
      if (!day) return;
      if (!fromLedger[day]) fromLedger[day] = emptyDayBucket();
      const bucket = fromLedger[day];
      if (item.kind === "earn" && item.subject && SUBJECTS.includes(item.subject)) {
        if (Number.isFinite(item.score)) bucket.scores[item.subject].push(Number(item.score));
        bucket.regular += Number(item.regular) || 0;
        bucket.overtime += Number(item.overtime) || 0;
        bucket.bonus += Number(item.bonus) || 0;
      } else if (item.kind === "redeem") {
        bucket.redeemed += Number(item.minutes) || Math.abs(Number(item.delta) || 0);
      } else if (item.kind === "manual_deduct") {
        bucket.manualDeducted += Number(item.minutes) || Math.abs(Number(item.delta) || 0);
      }
    });

    const merged = {};
    const days = new Set([
      ...Object.keys(target.dayHistory || {}),
      ...Object.keys(fromLedger),
      target.day || todayKey(),
    ]);

    days.forEach((day) => {
      const prev = target.dayHistory?.[day];
      const led = fromLedger[day];
      const bucket = emptyDayBucket();
      SUBJECTS.forEach((s) => {
        const prevScores = Array.isArray(prev?.scores?.[s]) ? prev.scores[s] : [];
        const ledScores = Array.isArray(led?.scores?.[s]) ? led.scores[s] : [];
        // Prefer the richer score list (ledger may be truncated).
        bucket.scores[s] = ledScores.length >= prevScores.length ? [...ledScores] : [...prevScores];
      });
      bucket.regular = Math.max(Number(prev?.regular) || 0, Number(led?.regular) || 0);
      bucket.overtime = Math.max(Number(prev?.overtime) || 0, Number(led?.overtime) || 0);
      bucket.bonus = Math.max(Number(prev?.bonus) || 0, Number(led?.bonus) || 0);
      bucket.redeemed = Math.max(Number(prev?.redeemed) || 0, Number(led?.redeemed) || 0);
      bucket.manualDeducted = Math.max(
        Number(prev?.manualDeducted) || 0,
        Number(led?.manualDeducted) || 0
      );
      merged[day] = bucket;
    });

    // Live today counters are authoritative for the current day totals.
    const today = target.day || todayKey();
    if (!merged[today]) merged[today] = emptyDayBucket();
    merged[today].regular = Number(target.todayRegular) || 0;
    merged[today].overtime = Number(target.todayOvertime) || 0;
    merged[today].bonus = Number(target.todayBonus) || 0;
    merged[today].redeemed = Number(target.todayRedeemed) || 0;
    merged[today].manualDeducted = Number(target.todayManualDeducted) || 0;

    target.dayHistory = merged;
    pruneDayHistory(target);
  }

  function syncTodayIntoHistory() {
    const bucket = ensureDayBucket(state, state.day);
    bucket.regular = state.todayRegular || 0;
    bucket.overtime = state.todayOvertime || 0;
    bucket.bonus = state.todayBonus || 0;
    bucket.redeemed = state.todayRedeemed || 0;
    bucket.manualDeducted = state.todayManualDeducted || 0;
  }

  function rollDayIfNeeded() {
    const key = todayKey();
    if (state.day === key) {
      syncTodayIntoHistory();
      return;
    }
    syncTodayIntoHistory();
    state.day = key;
    state.regularBySubject = Object.fromEntries(SUBJECTS.map((s) => [s, 0]));
    state.todayRegular = 0;
    state.todayOvertime = 0;
    state.todayBonus = 0;
    state.todayRedeemed = 0;
    state.todayManualDeducted = 0;
    ensureDayBucket(state, key);
    pruneDayHistory(state);
    // balance carries over (including negative 預支 debt)
    save();
    if (selectedStatsDay !== key && !state.dayHistory[selectedStatsDay]) {
      selectedStatsDay = key;
    }
  }

  function debtMinutes() {
    return state.balance < 0 ? Math.abs(state.balance) : 0;
  }

  function formatBalanceCopy() {
    const debt = debtMinutes();
    if (debt > 0) {
      return { value: debt, label: "尚欠", unit: "分", isDebt: true };
    }
    return { value: state.balance, label: "剩餘可用", unit: "分", isDebt: false };
  }

  /** Credit earned minutes against outstanding 預支 debt first; balance is the only debt source. */
  function creditMinutesAgainstDebt(earned) {
    const total = Math.max(0, Number(earned) || 0);
    const debtBefore = debtMinutes();
    const repaid = Math.min(debtBefore, total);
    const credited = total - repaid;
    state.balance += total;
    return {
      earned: total,
      debtBefore,
      repaid,
      credited,
      debtAfter: debtMinutes(),
    };
  }

  function recentPrepaidLedger(limit = 5) {
    return (state.ledger || [])
      .filter((item) => item.kind === "manual_deduct")
      .slice(0, limit);
  }

  function todayDebtRepaidFromLedger() {
    const day = state.day || todayKey();
    return (state.ledger || []).reduce((sum, item) => {
      if (item.kind !== "earn") return sum;
      const itemDay = item.dayKey || dayKeyFromIso(item.at);
      if (itemDay !== day) return sum;
      return sum + (Math.max(0, Number(item.repaid) || 0));
    }, 0);
  }

  function debtRepaidForDay(day) {
    if (day === state.day) return todayDebtRepaidFromLedger();
    return (state.ledger || []).reduce((sum, item) => {
      if (item.kind !== "earn") return sum;
      const itemDay = item.dayKey || dayKeyFromIso(item.at);
      if (itemDay !== day) return sum;
      return sum + (Math.max(0, Number(item.repaid) || 0));
    }, 0);
  }

  function scoreToPoints(score) {
    const s = Number(score);
    if (!Number.isFinite(s) || s <= 84) return 0;
    if (s > 100) return 0;
    return 1 + Math.floor((s - 85) / 5);
  }

  function computeAward(subject, score) {
    const points = scoreToPoints(score);
    const regularWanted = points * POINT_MINUTES;
    const subjectLeft = Math.max(0, SUBJECT_CAP - (state.regularBySubject[subject] || 0));
    const dayLeft = Math.max(0, DAY_CAP - state.todayRegular);
    const regularGranted = Math.min(regularWanted, subjectLeft, dayLeft);
    const overtimeWanted = Math.max(0, regularWanted - regularGranted);
    const overtimeGranted = state.allowOvertimeEarn !== false ? overtimeWanted : 0;
    const bonus = Number(score) === 100 ? PERFECT_BONUS : 0;
    return {
      points,
      regularWanted,
      regularGranted,
      overtimeGranted,
      bonus,
      total: regularGranted + overtimeGranted + bonus,
      hardCapped: overtimeWanted > 0 && overtimeGranted === 0,
      softOvertime: overtimeGranted > 0,
    };
  }

  function addLedger(entry) {
    state.ledger.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      dayKey: state.day,
      ...entry,
    });
    state.ledger = state.ledger.slice(0, LEDGER_LIMIT);
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function getRemainingMs() {
    if (timer.running && timer.endAt != null) {
      return Math.max(0, timer.endAt - Date.now());
    }
    return Math.max(0, timer.remainingMs);
  }

  function updateCountdownDisplay() {
    const sec = Math.ceil(getRemainingMs() / 1000);
    document.getElementById("countdown").textContent = formatTime(sec);
    const ring = document.getElementById("timerRingFg");
    if (ring) {
      const total = timer.startedWithMs > 0 ? timer.startedWithMs : 1;
      const frac = Math.min(1, Math.max(0, getRemainingMs() / total));
      ring.style.strokeDashoffset = String(703.7 * (1 - frac));
    }
  }

  function showTimerRunUi() {
    document.getElementById("timerSetup").hidden = true;
    document.getElementById("timerRun").hidden = false;
    document.getElementById("purposeTag").textContent = `用途：${timer.purpose}`;
    document.getElementById("pauseTimerBtn").textContent = timer.paused ? "繼續" : "暫停";
    updateCountdownDisplay();
  }

  function showTimerSetupUi() {
    document.getElementById("timerSetup").hidden = false;
    document.getElementById("timerRun").hidden = true;
  }

  function clearTickInterval() {
    if (timer.intervalId != null) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
    }
  }

  function startTickInterval() {
    clearTickInterval();
    timer.intervalId = setInterval(syncFromWallClock, 250);
  }

  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function ensureFallbackAudio() {
    if (fallbackAudio) return fallbackAudio;
    try {
      // Short sine beep as data-URI; unlocks with play() on user gesture.
      const sampleRate = 22050;
      const seconds = 0.18;
      const samples = Math.floor(sampleRate * seconds);
      const data = new Uint8Array(44 + samples * 2);
      const view = new DataView(data.buffer);
      const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
      };
      writeStr(0, "RIFF");
      view.setUint32(4, 36 + samples * 2, true);
      writeStr(8, "WAVE");
      writeStr(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, "data");
      view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i += 1) {
        const t = i / sampleRate;
        const env = Math.min(1, i / 200) * Math.min(1, (samples - i) / 400);
        const sample = Math.sin(2 * Math.PI * 880 * t) * 0.35 * env;
        view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
      }
      let binary = "";
      for (let i = 0; i < data.length; i += 1) binary += String.fromCharCode(data[i]);
      fallbackAudio = new Audio(`data:audio/wav;base64,${btoa(binary)}`);
      fallbackAudio.preload = "auto";
      return fallbackAudio;
    } catch {
      return null;
    }
  }

  function unlockAudio() {
    const ctx = ensureAudio();
    if (ctx) {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.02);
        audioUnlocked = true;
      } catch {
        // ignore unlock failures
      }
      ctx.resume().then(() => {
        audioUnlocked = true;
      }).catch(() => {});
    }
    const beep = ensureFallbackAudio();
    if (beep) {
      try {
        beep.muted = true;
        const p = beep.play();
        if (p && typeof p.then === "function") {
          p.then(() => {
            beep.pause();
            beep.currentTime = 0;
            beep.muted = false;
            audioUnlocked = true;
          }).catch(() => {
            beep.muted = false;
          });
        } else {
          beep.muted = false;
        }
      } catch {
        // ignore
      }
    }
  }

  function playWebAudioChime() {
    const ctx = ensureAudio();
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
      // Still try; if still suspended the notes may be silent.
    }
    try {
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const t0 = now + i * 0.14;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.34);
      });
      return ctx.state === "running";
    } catch {
      return false;
    }
  }

  function playFallbackBeeps() {
    const beep = ensureFallbackAudio();
    if (!beep) return false;
    try {
      beep.pause();
      beep.currentTime = 0;
      beep.muted = false;
      const p = beep.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {});
      }
      // Two follow-up beeps for a simple chime pattern.
      setTimeout(() => {
        try {
          beep.currentTime = 0;
          beep.play().catch(() => {});
        } catch {
          // ignore
        }
      }, 220);
      setTimeout(() => {
        try {
          beep.currentTime = 0;
          beep.play().catch(() => {});
        } catch {
          // ignore
        }
      }, 440);
      return true;
    } catch {
      return false;
    }
  }

  function playTimeUpChime() {
    if (state.endSoundOn === false) return false;
    const webOk = playWebAudioChime();
    if (webOk) return true;
    return playFallbackBeeps();
  }

  function vibrateTimeUp() {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return false;
    try {
      return Boolean(navigator.vibrate([180, 80, 180, 80, 260]));
    } catch {
      return false;
    }
  }

  function maybeRequestNotification() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  function notifyRestEnded() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try {
      new Notification("休息時間到", {
        body: "煦煦休息時間已結束，回來看看錢包吧。",
        lang: "zh-Hant",
      });
    } catch {
      // ignore notification failures
    }
  }

  function clearPersistedEndAlert() {
    try {
      sessionStorage.removeItem(END_ALERT_KEY);
    } catch {
      // ignore
    }
    try {
      localStorage.removeItem(END_ALERT_KEY);
    } catch {
      // ignore
    }
  }

  function persistEndAlert() {
    if (!endAlert.id || endAlert.acked) {
      clearPersistedEndAlert();
      return;
    }
    const payload = JSON.stringify({
      id: endAlert.id,
      shown: endAlert.shown,
      acked: false,
      effectsPlayed: Boolean(endAlert.effectsPlayed),
      notified: Boolean(endAlert.notified),
      charge: endAlert.charge,
      purpose: endAlert.purpose,
    });
    try {
      sessionStorage.setItem(END_ALERT_KEY, payload);
    } catch {
      // ignore
    }
    // localStorage survives tab discard / some mobile reloads where sessionStorage does not.
    try {
      localStorage.setItem(END_ALERT_KEY, payload);
    } catch {
      // ignore
    }
  }

  function readPersistedEndAlert() {
    const sources = [];
    try {
      sources.push(sessionStorage.getItem(END_ALERT_KEY));
    } catch {
      // ignore
    }
    try {
      sources.push(localStorage.getItem(END_ALERT_KEY));
    } catch {
      // ignore
    }
    for (const raw of sources) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.id && !parsed.acked) return parsed;
      } catch {
        // ignore corrupt
      }
    }
    return null;
  }

  function loadPendingEndAlert() {
    const parsed = readPersistedEndAlert();
    if (!parsed) {
      clearPersistedEndAlert();
      return;
    }
    endAlert = {
      id: parsed.id,
      shown: Boolean(parsed.shown),
      acked: false,
      effectsPlayed: Boolean(parsed.effectsPlayed),
      notified: Boolean(parsed.notified),
      charge: Number(parsed.charge) || 0,
      purpose: parsed.purpose || "",
    };
    // Always show modal; retry effects if they never landed (bg tab / autoplay).
    showEndAlertUi({ playEffects: !endAlert.effectsPlayed });
  }

  function openEndAlertModal() {
    const modal = document.getElementById("endAlert");
    if (!modal) return;
    modal.hidden = false;
    modal.removeAttribute("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function showEndAlertUi({ playEffects } = { playEffects: false }) {
    const modal = document.getElementById("endAlert");
    if (!modal || !endAlert.id || endAlert.acked) return;

    const meta = document.getElementById("endAlertMeta");
    const body = document.getElementById("endAlertBody");
    if (body) body.textContent = "月亮走完這一圈了，回來看看錢包吧。";
    if (meta) {
      meta.textContent = endAlert.charge > 0
        ? `已扣除 ${endAlert.charge} 分${endAlert.purpose ? ` · ${endAlert.purpose}` : ""}`
        : endAlert.purpose
          ? `用途：${endAlert.purpose}`
          : "";
    }

    openEndAlertModal();
    endAlert.shown = true;

    if (playEffects && !endAlert.effectsPlayed) {
      const sounded = playTimeUpChime();
      const vibrated = vibrateTimeUp();
      if (!endAlert.notified) {
        notifyRestEnded();
        endAlert.notified = true;
      }
      // Retry later if still backgrounded / audio locked; stop once something worked
      // or we clearly attempted while unlocked & visible.
      if (
        sounded ||
        vibrated ||
        state.endSoundOn === false ||
        (!document.hidden && audioUnlocked)
      ) {
        endAlert.effectsPlayed = true;
      }
    }

    persistEndAlert();

    const ack = document.getElementById("endAlertAck");
    if (ack) {
      setTimeout(() => {
        try {
          ack.focus();
        } catch {
          // ignore
        }
      }, 30);
    }
  }

  function fireRestEndAlert({ id, charge, purpose }) {
    if (!id) return;
    if (endAlert.acked && endAlert.id === id) return;
    if (endAlert.id === id && endAlert.shown) {
      showEndAlertUi({ playEffects: !endAlert.effectsPlayed });
      return;
    }
    endAlert = {
      id,
      shown: false,
      acked: false,
      effectsPlayed: false,
      notified: false,
      charge: Number(charge) || 0,
      purpose: purpose || "",
    };
    showEndAlertUi({ playEffects: true });
  }

  function acknowledgeEndAlert() {
    if (!endAlert.id) {
      hideEndAlertUi();
      return;
    }
    endAlert.acked = true;
    endAlert.shown = true;
    endAlert.effectsPlayed = true;
    endAlert.notified = true;
    persistEndAlert();
    hideEndAlertUi();
  }

  function hideEndAlertUi() {
    const modal = document.getElementById("endAlert");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("hidden", "");
    modal.setAttribute("aria-hidden", "true");
  }

  function isTimerDue() {
    if (timer.running && timer.endAt != null) {
      return Date.now() >= timer.endAt;
    }
    return false;
  }

  function syncFromWallClock() {
    if (finishing) return;

    if (timer.running && timer.endAt != null) {
      timer.remainingMs = Math.max(0, timer.endAt - Date.now());
      persistTimer();
    }

    if (timer.running || timer.paused) {
      updateCountdownDisplay();
    }

    // Reliable completion: wall-clock due on each tick AND after resume/focus.
    if (isTimerDue()) {
      finishTimer(true);
    }
  }

  function handleVisibilityOrFocus() {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    syncFromWallClock();
    // If time already ended (or alert pending), always re-show modal; retry sound/vibrate once.
    if (endAlert.id && !endAlert.acked) {
      showEndAlertUi({ playEffects: !endAlert.effectsPlayed });
    }
  }

  function go(screen, options = {}) {
    document.querySelectorAll(".screen").forEach((el) => {
      el.classList.toggle("active", el.dataset.screen === screen);
    });
    document.querySelectorAll(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.go === screen);
    });
    if (screen === "timer") {
      const input = document.getElementById("timerMinutes");
      if (!timer.running && !timer.paused) {
        const avail = Math.max(0, state.balance);
        input.value = Math.max(1, avail || 1);
        input.max = Math.max(1, avail || 1);
      }
      syncFromWallClock();
    }
    render();
    if (screen === "wallet" && options.focusDeduct) {
      const panel = document.getElementById("deductPanel");
      const minutesInput = document.getElementById("deductMinutes");
      if (panel) {
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      if (minutesInput) {
        setTimeout(() => minutesInput.focus(), 180);
      }
    }
  }

  function todayEarnedTotal() {
    return state.todayRegular + (state.todayOvertime || 0) + state.todayBonus;
  }

  function updateCapCopy() {
    const overtimeOn = state.allowOvertimeEarn !== false;
    const ot = state.todayOvertime || 0;
    const showOt = overtimeOn && (ot > 0 || todayEarnedTotal() > DAY_CAP);

    document.getElementById("dayCapLine").textContent = overtimeOn
      ? `今日一般上限 ${DAY_CAP} 分（可開超時繼續賺）`
      : `今日一般上限 ${DAY_CAP} 分（已關超時，一般最多 ${DAY_CAP}）`;

    const homeOt = document.getElementById("overtimeLine");
    const walletOt = document.getElementById("walletOvertimeLine");
    if (showOt) {
      const bal = formatBalanceCopy();
      const balText = bal.isDebt ? `尚欠 ${bal.value} 分` : `剩餘可用 ${bal.value} 分`;
      const text = `含超時已賺 ${todayEarnedTotal()} 分（一般 ${state.todayRegular}＋超時 ${ot}＋加碼 ${state.todayBonus}）· ${balText}`;
      homeOt.hidden = false;
      walletOt.hidden = false;
      homeOt.textContent = text;
      walletOt.textContent = text;
    } else {
      homeOt.hidden = true;
      walletOt.hidden = true;
    }

    document.getElementById("walletDayCapLine").textContent = `今日一般上限 ${DAY_CAP} 分`;
    document.getElementById("walletHint").textContent = overtimeOn
      ? "一般換算每科上限 20、全日一般池 60；超過部分可當超時繼續賺，當天就能倒數用。100 加碼可一直累加。"
      : "一般換算每科上限 20、全日一般硬上限 60（超時已關閉）；100 加碼可一直累加。";

    const toggle = document.getElementById("allowOvertimeToggle");
    if (toggle) toggle.checked = overtimeOn;
    const soundToggle = document.getElementById("endSoundToggle");
    if (soundToggle) soundToggle.checked = state.endSoundOn !== false;
  }

  function getStatsForDay(day) {
    const bucket = state.dayHistory[day] || emptyDayBucket();
    if (day === state.day) {
      return {
        scores: bucket.scores,
        regular: state.todayRegular || 0,
        overtime: state.todayOvertime || 0,
        bonus: state.todayBonus || 0,
        redeemed: state.todayRedeemed || 0,
        manualDeducted: state.todayManualDeducted || 0,
      };
    }
    return {
      scores: bucket.scores || Object.fromEntries(SUBJECTS.map((s) => [s, []])),
      regular: Number(bucket.regular) || 0,
      overtime: Number(bucket.overtime) || 0,
      bonus: Number(bucket.bonus) || 0,
      redeemed: Number(bucket.redeemed) || 0,
      manualDeducted: Number(bucket.manualDeducted) || 0,
    };
  }

  function renderStats() {
    const select = document.getElementById("statsDaySelect");
    const scoresEl = document.getElementById("statsScores");
    const restEl = document.getElementById("statsRest");
    if (!select || !scoresEl || !restEl) return;

    const today = todayKey();
    const days = new Set([today, state.day, ...Object.keys(state.dayHistory || {})]);
    // Include days that only appear in ledger (migration edge cases).
    (state.ledger || []).forEach((item) => {
      const day = item.dayKey || dayKeyFromIso(item.at);
      if (day) days.add(day);
    });
    const dayList = [...days].sort(compareDayKeysDesc).slice(0, DAY_HISTORY_LIMIT);
    if (!dayList.includes(selectedStatsDay)) {
      selectedStatsDay = today;
    }

    const prev = select.value;
    select.innerHTML = dayList
      .map((day) => `<option value="${escapeHtml(day)}">${escapeHtml(formatDayLabel(day))}</option>`)
      .join("");
    select.value = selectedStatsDay;
    if (select.value !== selectedStatsDay && dayList.length) {
      selectedStatsDay = dayList[0];
      select.value = selectedStatsDay;
    }
    if (prev && prev !== select.value) {
      // keep selectedStatsDay authoritative
    }

    const stats = getStatsForDay(selectedStatsDay);
    scoresEl.innerHTML = SUBJECTS.map((subject) => {
      const list = Array.isArray(stats.scores?.[subject]) ? stats.scores[subject] : [];
      const text = list.length ? list.join("、") : "尚無成績";
      const cls = list.length ? "" : " empty";
      return `<div class="stats-score-row"><strong>${subject}</strong><span class="${cls.trim()}">${escapeHtml(text)}</span></div>`;
    }).join("");

    const earned = stats.regular + stats.overtime + stats.bonus;
    const manual = stats.manualDeducted || 0;
    const debtNow = debtMinutes();
    const repaid = debtRepaidForDay(selectedStatsDay);
    const isToday = selectedStatsDay === state.day;
    restEl.innerHTML =
      `<p>已賺休息 <strong>${earned}</strong> 分` +
      `（一般 ${stats.regular}＋超時 ${stats.overtime}＋加碼 ${stats.bonus}）</p>` +
      `<p>已兌換休息 <strong>${stats.redeemed}</strong> 分</p>` +
      (manual > 0
        ? `<p>手動扣除／預支 <strong>${manual}</strong> 分</p>`
        : "") +
      (repaid > 0
        ? `<p>已抵扣預支 <strong>${repaid}</strong> 分</p>`
        : "") +
      (isToday && debtNow > 0
        ? `<p class="stats-debt">目前尚欠預支 <strong>${debtNow}</strong> 分（與錢包同一筆餘額）</p>`
        : "");
  }

  function render() {
    rollDayIfNeeded();
    const bal = formatBalanceCopy();
    const chip = document.getElementById("balanceChip");
    document.getElementById("balanceMinutes").textContent = bal.value;
    document.getElementById("balanceUnit").textContent = "分";
    if (chip) {
      chip.classList.toggle("is-debt", bal.isDebt);
      chip.title = bal.isDebt ? `尚欠 ${bal.value} 分` : "剩餘可休息";
      const seal = chip.querySelector(".chip-seal");
      if (seal) seal.textContent = bal.isDebt ? "欠" : "休";
    }

    const homeWrap = document.getElementById("homeBalanceWrap");
    document.getElementById("homeBalance").textContent = bal.value;
    document.getElementById("homeBalanceLabel").textContent = bal.isDebt ? "尚欠" : "分鐘可用";
    if (homeWrap) homeWrap.classList.toggle("is-debt", bal.isDebt);

    const walletStat = document.getElementById("walletBalanceStat");
    document.getElementById("walletBalance").textContent = bal.value;
    document.getElementById("walletBalanceLabel").textContent = bal.isDebt ? "尚欠" : "剩餘可用";
    document.getElementById("walletBalanceUnit").textContent = "分";
    if (walletStat) walletStat.classList.toggle("is-debt", bal.isDebt);

    document.getElementById("walletTodayRegular").textContent = state.todayRegular;
    document.getElementById("walletTodayBonus").textContent = state.todayBonus;
    document.getElementById("timerAvail").textContent = Math.max(0, state.balance);
    updateCapCopy();
    renderStats();
    renderPrepaidPanels();

    const hint = document.getElementById("homeHint");
    if (bal.isDebt) {
      hint.textContent = `尚欠預支 ${bal.value} 分；下次換點數會先自動抵扣`;
    } else if (state.balance > 0) {
      hint.textContent = "可以按「開始休息」，用計時表倒數使用";
    } else {
      hint.textContent = "記康軒成績，讓月下狐火更亮；也可由家長預支";
    }

    const timerDebtHint = document.getElementById("timerDebtHint");
    if (timerDebtHint) {
      if (bal.isDebt) {
        timerDebtHint.hidden = false;
        timerDebtHint.textContent = `目前尚欠預支 ${bal.value} 分。計時只用已有餘額；預支請走錢包「手動扣除／預支」。`;
      } else if (state.balance <= 0) {
        timerDebtHint.hidden = false;
        timerDebtHint.textContent = "沒有可用分鐘時，請先記成績換點，或由家長在錢包預支。";
      } else {
        timerDebtHint.hidden = true;
        timerDebtHint.textContent = "";
      }
    }

    const caps = document.getElementById("subjectCaps");
    caps.innerHTML = SUBJECTS.map((s) => {
      const used = state.regularBySubject[s] || 0;
      const pct = Math.min(100, (used / SUBJECT_CAP) * 100);
      return `<div class="cap-row"><strong>${s}</strong><div class="cap-bar"><span style="width:${pct}%"></span></div><span>${used}/${SUBJECT_CAP}</span></div>`;
    }).join("");

    const ledger = document.getElementById("ledger");
    if (!state.ledger.length) {
      ledger.innerHTML = `<li><div>尚無紀錄<div class="meta">月下九尾靜候第一筆康軒成績</div></div></li>`;
    } else {
      ledger.innerHTML = state.ledger
        .map((item) => {
          const when = new Date(item.at);
          const time = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
          const sign = item.delta >= 0 ? "+" : "";
          const cls = item.delta >= 0 ? "plus" : "minus";
          return `<li><div>${escapeHtml(item.title)}<div class="meta">${time} · ${escapeHtml(item.detail || "")}</div></div><div class="delta ${cls}">${sign}${item.delta} 分</div></li>`;
        })
        .join("");
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderPrepaidPanels() {
    const debt = debtMinutes();
    const homePanel = document.getElementById("prepaidStatusPanel");
    const homeSummary = document.getElementById("prepaidStatusSummary");
    const homeHistory = document.getElementById("prepaidHistory");
    const walletSummary = document.getElementById("walletPrepaidSummary");
    const walletHistory = document.getElementById("walletPrepaidHistory");
    const recent = recentPrepaidLedger(5);

    const historyHtml = recent.length
      ? `<ul class="prepaid-history">${recent
          .map((item) => {
            const when = new Date(item.at);
            const time = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(
              when.getMinutes()
            ).padStart(2, "0")}`;
            const mins = Number(item.minutes) || Math.abs(Number(item.delta) || 0);
            const note = item.note ? escapeHtml(String(item.note)) : "預支";
            return `<li><span>${time} · ${note}</span><strong>${mins} 分</strong></li>`;
          })
          .join("")}</ul>`
      : `<p class="hint tight prepaid-empty">尚無預支紀錄</p>`;

    if (homeSummary) {
      if (debt > 0) {
        homeSummary.innerHTML = `目前尚欠預支 <strong>${debt}</strong> 分。下次記成績換點數時，會先自動抵扣，再把剩下的加入可用餘額。`;
      } else {
        homeSummary.innerHTML = `目前沒有預支欠額。家長可從錢包手動扣除；超過餘額就會變成「尚欠」。`;
      }
    }
    if (homePanel) homePanel.classList.toggle("has-debt", debt > 0);
    if (homeHistory) homeHistory.innerHTML = historyHtml;

    const walletPanel = document.getElementById("deductPanel");
    if (walletSummary) {
      if (debt > 0) {
        walletSummary.innerHTML = `尚欠預支 <strong>${debt}</strong> 分（與上方餘額同一筆；不是另計）。換點數入帳時會先還這筆。`;
      } else {
        walletSummary.innerHTML = `目前無欠額。扣除超過可用餘額時，會以負餘額記為預支。`;
      }
    }
    if (walletPanel) walletPanel.classList.toggle("has-debt", debt > 0);
    if (walletHistory) walletHistory.innerHTML = historyHtml;
  }

  function updatePreview() {
    const score = Number(document.getElementById("scoreInput").value);
    const el = document.getElementById("scorePreview");
    if (!Number.isFinite(score) || document.getElementById("scoreInput").value === "") {
      el.textContent = "輸入分數後，九尾狐會算出可以休息幾分鐘";
      return;
    }
    if (score < 0 || score > 100) {
      el.textContent = "請輸入 0–100 的分數";
      return;
    }
    const award = computeAward(selectedSubject, score);
    if (award.points === 0) {
      el.textContent = `${score} 分 → 0 點（未達 85）`;
      return;
    }
    let text = `${score} 分 → ${award.points} 點 → 一般 ${award.regularGranted} 分`;
    if (award.softOvertime) {
      text += `，超時 +${award.overtimeGranted} 分`;
    } else if (award.hardCapped) {
      text += `（原 ${award.regularWanted}，已套用每科／全日硬上限）`;
    }
    if (award.bonus) {
      text += `，滿分加碼 +${award.bonus} 分`;
    }
    text += `，合計 +${award.total} 分`;
    const debt = debtMinutes();
    if (debt > 0 && award.total > 0) {
      const repaid = Math.min(debt, award.total);
      const net = award.total - repaid;
      text += `（先抵扣預支 ${repaid} 分，實得 ${net} 分）`;
    }
    el.textContent = text;
  }

  function showToast(id, message, warn = false) {
    const el = document.getElementById(id);
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("warn", warn);
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  function hideDeductConfirm() {
    const el = document.getElementById("deductConfirm");
    if (el) el.hidden = true;
    pendingDeduct = null;
  }

  function showDeductConfirm(minutes, note) {
    pendingDeduct = { minutes, note };
    const after = state.balance - minutes;
    const body = document.getElementById("deductConfirmBody");
    const meta = document.getElementById("deductConfirmMeta");
    const dialog = document.getElementById("deductConfirm");
    if (!body || !meta || !dialog) return;

    const noteText = note ? `備註「${note}」` : "無備註";
    body.textContent = `將扣除 ${minutes} 分（${noteText}）。`;
    if (after < 0) {
      meta.textContent = `目前 ${state.balance} 分 → 尚欠 ${Math.abs(after)} 分（預支）`;
    } else {
      meta.textContent = `目前 ${state.balance} 分 → 剩餘 ${after} 分`;
    }
    dialog.hidden = false;
  }

  function requestManualDeduct(event) {
    event.preventDefault();
    rollDayIfNeeded();
    const minutes = Number(document.getElementById("deductMinutes").value);
    const note = document.getElementById("deductNote").value.trim();
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 1) {
      showToast("deductToast", "請輸入至少 1 的整數分鐘", true);
      return;
    }
    if (minutes > 24 * 60) {
      showToast("deductToast", "一次最多扣除 1440 分", true);
      return;
    }
    showDeductConfirm(minutes, note);
  }

  function applyManualDeduct() {
    if (!pendingDeduct) return;
    const { minutes, note } = pendingDeduct;
    rollDayIfNeeded();

    state.balance -= minutes;
    state.todayManualDeducted = (state.todayManualDeducted || 0) + minutes;
    const bucket = ensureDayBucket(state, state.day);
    bucket.manualDeducted = state.todayManualDeducted;

    const noteLabel = note || "預支";
    addLedger({
      kind: "manual_deduct",
      minutes,
      note: noteLabel,
      title: "手動扣除／預支",
      detail: note ? `${note} · 扣 ${minutes} 分` : `扣 ${minutes} 分`,
      delta: -minutes,
    });
    pruneDayHistory(state);
    save();
    selectedStatsDay = state.day;

    document.getElementById("deductMinutes").value = "";
    document.getElementById("deductNote").value = "";
    hideDeductConfirm();
    render();

    const bal = formatBalanceCopy();
    if (bal.isDebt) {
      showToast("deductToast", `已扣除 ${minutes} 分 · 尚欠 ${bal.value} 分`, true);
    } else {
      showToast("deductToast", `已扣除 ${minutes} 分 · 剩餘 ${bal.value} 分`);
    }
  }

  function submitScore(event) {
    event.preventDefault();
    rollDayIfNeeded();
    const score = Number(document.getElementById("scoreInput").value);
    const unit = document.getElementById("unitInput").value.trim();
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      showToast("logToast", "請輸入 0–100 的分數", true);
      return;
    }
    const award = computeAward(selectedSubject, score);
    state.regularBySubject[selectedSubject] =
      (state.regularBySubject[selectedSubject] || 0) + award.regularGranted;
    state.todayRegular += award.regularGranted;
    state.todayOvertime = (state.todayOvertime || 0) + award.overtimeGranted;
    state.todayBonus += award.bonus;
    const settle = creditMinutesAgainstDebt(award.total);

    const bucket = ensureDayBucket(state, state.day);
    bucket.scores[selectedSubject].push(score);
    bucket.regular = state.todayRegular;
    bucket.overtime = state.todayOvertime;
    bucket.bonus = state.todayBonus;

    addLedger({
      kind: "earn",
      subject: selectedSubject,
      score,
      points: award.points,
      regular: award.regularGranted,
      overtime: award.overtimeGranted,
      bonus: award.bonus,
      repaid: settle.repaid,
      credited: settle.credited,
      title: `${selectedSubject} ${score} 分`,
      detail: [
        unit || "康軒刷題",
        `${award.points} 點`,
        award.overtimeGranted ? `超時＋${award.overtimeGranted}` : null,
        award.bonus ? `滿分＋${award.bonus}` : null,
        award.hardCapped ? "已套用硬上限" : null,
        settle.repaid > 0 ? `抵扣預支 ${settle.repaid} · 實得 ${settle.credited}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      delta: award.total,
    });
    pruneDayHistory(state);
    save();
    selectedStatsDay = state.day;
    document.getElementById("scoreInput").value = "";
    document.getElementById("unitInput").value = "";
    updatePreview();
    render();
    if (award.total === 0) {
      showToast("logToast", "已記錄，但這次是 0 分休息（未達 85 或已達上限）", true);
    } else if (settle.repaid > 0) {
      const bal = formatBalanceCopy();
      const tail = bal.isDebt
        ? `仍尚欠 ${bal.value} 分`
        : `目前剩餘 ${bal.value} 分`;
      const ot = award.softOvertime ? `（含超時 ${award.overtimeGranted}）` : "";
      showToast(
        "logToast",
        `已抵扣預支 ${settle.repaid} 分，實得 ${settle.credited} 分${ot} · ${tail}`
      );
    } else if (award.softOvertime) {
      const bal = formatBalanceCopy();
      showToast(
        "logToast",
        `已入帳 +${award.total} 分鐘（含超時 ${award.overtimeGranted}）！目前剩餘 ${bal.value} 分`
      );
    } else {
      const bal = formatBalanceCopy();
      showToast("logToast", `已入帳 +${award.total} 分鐘！目前剩餘 ${bal.value} 分`);
    }
  }

  function startTimer() {
    rollDayIfNeeded();
    unlockAudio();
    if (timer.running || timer.paused) {
      showToast("timerToast", "休息計時進行中", true);
      return;
    }
    if (state.balance <= 0) {
      const debt = debtMinutes();
      if (debt > 0) {
        showToast(
          "timerToast",
          `尚欠預支 ${debt} 分；計時需有可用餘額。請先記成績還債，或由家長在錢包調整預支`,
          true
        );
      } else {
        showToast(
          "timerToast",
          "還沒有可休息時間；請先記成績，或由家長在錢包預支後再倒數",
          true
        );
      }
      return;
    }
    const mins = Number(document.getElementById("timerMinutes").value);
    if (!Number.isFinite(mins) || mins < 1) {
      showToast("timerToast", "請輸入至少 1 分鐘", true);
      return;
    }
    if (mins > state.balance) {
      showToast("timerToast", `最多只能用 ${state.balance} 分`, true);
      return;
    }
    timer.purpose = selectedPurpose;
    timer.sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    timer.startedWithMs = Math.round(mins * 60) * 1000;
    timer.remainingMs = timer.startedWithMs;
    timer.endAt = Date.now() + timer.remainingMs;
    timer.running = true;
    timer.paused = false;
    // New session clears prior end-alert ack state only when starting fresh.
    if (endAlert.acked || !endAlert.id) {
      endAlert = { id: null, shown: false, acked: false, effectsPlayed: false, notified: false, charge: 0, purpose: "" };
      persistEndAlert();
    }
    persistTimer();
    maybeRequestNotification();
    showTimerRunUi();
    startTickInterval();
    syncFromWallClock();
  }

  function pauseTimer() {
    unlockAudio();
    if (timer.paused) {
      timer.endAt = Date.now() + timer.remainingMs;
      timer.running = true;
      timer.paused = false;
      persistTimer();
      document.getElementById("pauseTimerBtn").textContent = "暫停";
      startTickInterval();
      syncFromWallClock();
      return;
    }
    if (!timer.running) return;
    timer.remainingMs = getRemainingMs();
    timer.endAt = null;
    timer.running = false;
    timer.paused = true;
    clearTickInterval();
    persistTimer();
    document.getElementById("pauseTimerBtn").textContent = "繼續";
    updateCountdownDisplay();
  }

  function finishTimer(completed) {
    if (finishing) return;
    if (!timer.running && !timer.paused && timer.startedWithMs <= 0) return;
    finishing = true;

    try {
      const remainingMs = getRemainingMs();
      const startedWithMs = timer.startedWithMs;
      const purpose = timer.purpose;
      const sessionId = timer.sessionId || `${Date.now()}-ended`;

      clearTickInterval();
      timer.running = false;
      timer.paused = false;
      timer.endAt = null;
      timer.remainingMs = 0;
      timer.startedWithMs = 0;
      timer.sessionId = null;
      clearPersistedTimer();

      const usedMs = Math.max(0, startedWithMs - remainingMs);
      const usedMin = usedMs <= 0 ? 0 : Math.max(1, Math.ceil(usedMs / 60000));
      // Allow charge even when balance briefly races; floor at 0 for normal redeem.
      const charge = usedMs <= 0 ? 0 : Math.min(Math.max(0, state.balance), usedMin);
      if (charge > 0) {
        state.balance -= charge;
        state.todayRedeemed = (state.todayRedeemed || 0) + charge;
        const bucket = ensureDayBucket(state, state.day);
        bucket.redeemed = state.todayRedeemed;
        addLedger({
          kind: "redeem",
          minutes: charge,
          purpose,
          title: completed ? "休息時間到" : "結束休息",
          detail: `${purpose} · 用了 ${charge} 分`,
          delta: -charge,
        });
        pruneDayHistory(state);
        save();
      }

      showTimerSetupUi();
      render();
      showToast(
        "timerToast",
        completed ? `休息時間到！已扣除 ${charge} 分` : `已結束，扣除 ${charge} 分`
      );
      if (completed) {
        fireRestEndAlert({ id: sessionId, charge, purpose });
      }
    } finally {
      finishing = false;
    }
  }

  function restoreTimerFromStorage() {
    const saved = loadPersistedTimer();
    if (!saved || !saved.startedWithMs) return false;
    timer.purpose = saved.purpose || "電視";
    timer.sessionId = saved.sessionId || `${Date.now()}-restored`;
    timer.startedWithMs = Number(saved.startedWithMs) || 0;
    timer.remainingMs = Math.max(0, Number(saved.remainingMs) || 0);
    timer.endAt = saved.endAt == null ? null : Number(saved.endAt);
    timer.running = Boolean(saved.running) && timer.endAt != null;
    timer.paused = Boolean(saved.paused) && !timer.running;
    if (!timer.running && !timer.paused) {
      clearPersistedTimer();
      return false;
    }
    if (timer.running && timer.endAt != null) {
      timer.remainingMs = Math.max(0, timer.endAt - Date.now());
    }
    selectedPurpose = timer.purpose;
    showTimerRunUi();
    go("timer");
    if (timer.running) {
      startTickInterval();
    }
    syncFromWallClock();
    return true;
  }

  // Events
  document.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => {
      go(btn.dataset.go, { focusDeduct: btn.dataset.focusDeduct === "1" });
    });
  });

  document.getElementById("deductForm").addEventListener("submit", requestManualDeduct);
  document.getElementById("deductConfirmOk").addEventListener("click", applyManualDeduct);
  document.getElementById("deductConfirmCancel").addEventListener("click", hideDeductConfirm);
  document.getElementById("deductConfirmBackdrop").addEventListener("click", hideDeductConfirm);

  document.querySelectorAll(".seg-btn[data-subject]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedSubject = btn.dataset.subject;
      document.getElementById("subjectInput").value = selectedSubject;
      document.querySelectorAll(".seg-btn[data-subject]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      updatePreview();
    });
  });

  document.querySelectorAll("#purposeSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedPurpose = btn.dataset.purpose;
      document.querySelectorAll("#purposeSeg .seg-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
    });
  });

  document.getElementById("scoreInput").addEventListener("input", updatePreview);
  document.getElementById("scoreForm").addEventListener("submit", submitScore);
  document.getElementById("startTimerBtn").addEventListener("click", startTimer);
  document.getElementById("pauseTimerBtn").addEventListener("click", pauseTimer);
  document.getElementById("stopTimerBtn").addEventListener("click", () => finishTimer(false));
  document.getElementById("allowOvertimeToggle").addEventListener("change", (event) => {
    state.allowOvertimeEarn = Boolean(event.target.checked);
    save();
    updatePreview();
    render();
  });
  document.getElementById("endSoundToggle").addEventListener("change", (event) => {
    state.endSoundOn = Boolean(event.target.checked);
    save();
  });
  document.getElementById("statsDaySelect").addEventListener("change", (event) => {
    selectedStatsDay = event.target.value || todayKey();
    renderStats();
  });
  document.getElementById("endAlertAck").addEventListener("click", acknowledgeEndAlert);
  document.getElementById("endAlertBackdrop").addEventListener("click", acknowledgeEndAlert);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const deductDialog = document.getElementById("deductConfirm");
    if (deductDialog && !deductDialog.hidden) {
      hideDeductConfirm();
      return;
    }
    if (endAlert.id && !endAlert.acked) {
      acknowledgeEndAlert();
    }
  });
  function setBackupStatus(message, isError = false) {
    const el = document.getElementById("backupStatus");
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-error");
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("is-error", isError);
  }

  function buildBackupPayload() {
    let timerSnapshot = null;
    if (timer.running || timer.paused) {
      timerSnapshot = {
        running: timer.running,
        paused: timer.paused,
        endAt: timer.endAt,
        remainingMs: getRemainingMs(),
        startedWithMs: timer.startedWithMs,
        purpose: timer.purpose,
        sessionId: timer.sessionId,
      };
    } else {
      timerSnapshot = loadPersistedTimer();
    }

    let endAlertSnapshot = null;
    if (endAlert.id && !endAlert.acked) {
      endAlertSnapshot = {
        id: endAlert.id,
        shown: endAlert.shown,
        acked: false,
        effectsPlayed: Boolean(endAlert.effectsPlayed),
        notified: Boolean(endAlert.notified),
        charge: endAlert.charge,
        purpose: endAlert.purpose,
      };
    } else {
      endAlertSnapshot = readPersistedEndAlert();
    }

    return {
      app: BACKUP_APP_ID,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      state: {
        balance: state.balance,
        day: state.day,
        regularBySubject: { ...state.regularBySubject },
        todayRegular: state.todayRegular,
        todayOvertime: state.todayOvertime,
        todayBonus: state.todayBonus,
        todayRedeemed: state.todayRedeemed,
        todayManualDeducted: state.todayManualDeducted,
        allowOvertimeEarn: state.allowOvertimeEarn !== false,
        endSoundOn: state.endSoundOn !== false,
        ledger: Array.isArray(state.ledger) ? state.ledger : [],
        dayHistory: state.dayHistory && typeof state.dayHistory === "object" ? state.dayHistory : {},
      },
      timer: timerSnapshot,
      endAlert: endAlertSnapshot,
    };
  }

  function exportBackup() {
    try {
      const payload = buildBackupPayload();
      const json = JSON.stringify(payload, null, 2);
      const stamp = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const filename =
        `xuxu-rest-backup-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
        `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`;
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBackupStatus(`已匯出 ${filename}`);
    } catch {
      setBackupStatus("匯出失敗，請再試一次", true);
    }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function validateBackupPayload(data) {
    if (!isPlainObject(data)) {
      return { ok: false, error: "檔案不是有效的備份物件" };
    }
    if (data.app != null && data.app !== BACKUP_APP_ID) {
      return { ok: false, error: "這不是煦煦休息時間的備份檔" };
    }
    if (data.version != null && (!Number.isFinite(Number(data.version)) || Number(data.version) > BACKUP_VERSION)) {
      return { ok: false, error: "備份版本較新，請先更新 App 再還原" };
    }
    const rawState = data.state != null ? data.state : data;
    if (!isPlainObject(rawState)) {
      return { ok: false, error: "備份缺少 state 資料" };
    }
    if (!Number.isFinite(Number(rawState.balance))) {
      return { ok: false, error: "備份的餘額格式不正確" };
    }
    if (rawState.ledger != null && !Array.isArray(rawState.ledger)) {
      return { ok: false, error: "備份的流水帳格式不正確" };
    }
    if (rawState.dayHistory != null && !isPlainObject(rawState.dayHistory)) {
      return { ok: false, error: "備份的每日紀錄格式不正確" };
    }
    if (rawState.regularBySubject != null && !isPlainObject(rawState.regularBySubject)) {
      return { ok: false, error: "備份的科目點數格式不正確" };
    }
    if (data.timer != null && data.timer !== null && !isPlainObject(data.timer)) {
      return { ok: false, error: "備份的計時狀態格式不正確" };
    }
    if (data.endAlert != null && data.endAlert !== null && !isPlainObject(data.endAlert)) {
      return { ok: false, error: "備份的結束提示格式不正確" };
    }
    return { ok: true, state: rawState, timer: data.timer ?? null, endAlert: data.endAlert ?? null };
  }

  function applyBackup(parsed) {
    clearTickInterval();
    timer = {
      running: false,
      paused: false,
      endAt: null,
      remainingMs: 0,
      startedWithMs: 0,
      purpose: "電視",
      sessionId: null,
      intervalId: null,
    };
    clearPersistedTimer();
    endAlert = { id: null, shown: false, acked: false, effectsPlayed: false, notified: false, charge: 0, purpose: "" };
    clearPersistedEndAlert();
    hideEndAlertUi();

    const merged = { ...defaultState(), ...parsed.state };
    if (!merged.dayHistory || typeof merged.dayHistory !== "object") merged.dayHistory = {};
    if (!Number.isFinite(merged.todayRedeemed)) merged.todayRedeemed = 0;
    if (!Number.isFinite(merged.todayManualDeducted)) merged.todayManualDeducted = 0;
    if (typeof merged.endSoundOn !== "boolean") merged.endSoundOn = true;
    if (typeof merged.allowOvertimeEarn !== "boolean") merged.allowOvertimeEarn = true;
    migrateLedger(merged);
    rebuildDayHistoryFromLedger(merged);
    state = merged;
    save();

    if (parsed.endAlert && parsed.endAlert.id && !parsed.endAlert.acked) {
      try {
        const payload = JSON.stringify({
          id: parsed.endAlert.id,
          shown: Boolean(parsed.endAlert.shown),
          acked: false,
          effectsPlayed: Boolean(parsed.endAlert.effectsPlayed),
          notified: Boolean(parsed.endAlert.notified),
          charge: Number(parsed.endAlert.charge) || 0,
          purpose: parsed.endAlert.purpose || "",
        });
        sessionStorage.setItem(END_ALERT_KEY, payload);
        localStorage.setItem(END_ALERT_KEY, payload);
      } catch {
        // ignore
      }
    }

    if (parsed.timer && isPlainObject(parsed.timer) && parsed.timer.startedWithMs) {
      try {
        localStorage.setItem(TIMER_KEY, JSON.stringify(parsed.timer));
      } catch {
        // ignore
      }
    }

    selectedStatsDay = todayKey();
    selectedSubject = "國文";
    selectedPurpose = "電視";
    showTimerSetupUi();
    render();
    updatePreview();
    loadPendingEndAlert();
    restoreTimerFromStorage();
    go(timer.running || timer.paused ? "timer" : "home");
  }

  function importBackupFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => {
      setBackupStatus("讀取檔案失敗，原有資料未變更", true);
    };
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(String(reader.result || ""));
      } catch {
        setBackupStatus("檔案不是有效的 JSON，原有資料未變更", true);
        return;
      }
      const checked = validateBackupPayload(data);
      if (!checked.ok) {
        setBackupStatus(`${checked.error}，原有資料未變更`, true);
        return;
      }
      const when = data.exportedAt ? `\n備份時間：${data.exportedAt}` : "";
      const ok = confirm(
        `確定用備份覆寫目前本機資料？\n（點數、流水、設定與計時都會被取代）${when}\n\n此動作無法復原。`
      );
      if (!ok) {
        setBackupStatus("已取消還原");
        return;
      }
      try {
        applyBackup(checked);
        setBackupStatus("還原完成");
      } catch (err) {
        setBackupStatus("還原時發生錯誤，請再試一次或換一份備份", true);
        console.error(err);
      }
    };
    reader.readAsText(file, "utf-8");
  }

  document.getElementById("exportBackupBtn").addEventListener("click", exportBackup);
  document.getElementById("importBackupBtn").addEventListener("click", () => {
    setBackupStatus("");
    const input = document.getElementById("importBackupFile");
    if (input) {
      input.value = "";
      input.click();
    }
  });
  document.getElementById("importBackupFile").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    importBackupFromFile(file);
  });

  document.getElementById("resetBtn").addEventListener("click", () => {
    if (!confirm("確定清除本機所有點數與紀錄？")) return;
    clearTickInterval();
    timer = {
      running: false,
      paused: false,
      endAt: null,
      remainingMs: 0,
      startedWithMs: 0,
      purpose: "電視",
      sessionId: null,
      intervalId: null,
    };
    clearPersistedTimer();
    endAlert = { id: null, shown: false, acked: false, effectsPlayed: false, notified: false, charge: 0, purpose: "" };
    persistEndAlert();
    hideEndAlertUi();
    const keepOvertime = state.allowOvertimeEarn !== false;
    const keepSound = state.endSoundOn !== false;
    state = defaultState();
    state.allowOvertimeEarn = keepOvertime;
    state.endSoundOn = keepSound;
    selectedStatsDay = todayKey();
    save();
    showTimerSetupUi();
    render();
    go("home");
  });

  document.addEventListener("visibilitychange", handleVisibilityOrFocus);
  window.addEventListener("pageshow", handleVisibilityOrFocus);
  window.addEventListener("focus", handleVisibilityOrFocus);
  window.addEventListener("pagehide", () => {
    // Flush wall-clock remaining so a later restore sees an accurate endAt.
    if (timer.running && timer.endAt != null) {
      timer.remainingMs = Math.max(0, timer.endAt - Date.now());
      persistTimer();
    }
    persistEndAlert();
  });
  // Test / automation hook: dispatch to force a completed rest end without waiting.
  window.addEventListener("xuxu-rest-force-end", () => {
    if (timer.running || timer.paused) finishTimer(true);
  });
  // Test / automation hook: start an N-second rest (requires balance).
  window.addEventListener("xuxu-rest-start-seconds", (event) => {
    const seconds = Number(event?.detail?.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    unlockAudio();
    if (timer.running || timer.paused) return;
    if (state.balance <= 0) return;
    const minsNeeded = Math.max(1, Math.ceil(seconds / 60));
    if (state.balance < minsNeeded && state.balance < 1) return;
    timer.purpose = selectedPurpose;
    timer.sessionId = `${Date.now()}-sec-${Math.random().toString(16).slice(2)}`;
    timer.startedWithMs = Math.round(seconds * 1000);
    timer.remainingMs = timer.startedWithMs;
    timer.endAt = Date.now() + timer.remainingMs;
    timer.running = true;
    timer.paused = false;
    if (endAlert.acked || !endAlert.id) {
      endAlert = { id: null, shown: false, acked: false, effectsPlayed: false, notified: false, charge: 0, purpose: "" };
      persistEndAlert();
    }
    persistTimer();
    maybeRequestNotification();
    showTimerRunUi();
    go("timer");
    startTickInterval();
    syncFromWallClock();
  });

  rollDayIfNeeded();
  selectedStatsDay = todayKey();
  render();
  updatePreview();
  loadPendingEndAlert();
  restoreTimerFromStorage();
  // Catch overdue timers immediately after restore (in case interval was delayed).
  syncFromWallClock();
})();
