(() => {
  const STORAGE_KEY = "xuxu-rest-v1";
  const TIMER_KEY = "xuxu-rest-timer-v1";
  const SUBJECTS = ["國文", "數學", "英文"];
  const POINT_MINUTES = 5;
  const SUBJECT_CAP = 20;
  const DAY_CAP = 60;
  const PERFECT_BONUS = 5;

  const defaultState = () => ({
    balance: 0,
    day: todayKey(),
    regularBySubject: Object.fromEntries(SUBJECTS.map((s) => [s, 0])),
    todayRegular: 0,
    todayOvertime: 0,
    todayBonus: 0,
    allowOvertimeEarn: true,
    ledger: [],
  });

  let state = load();
  let selectedSubject = "國文";
  let selectedPurpose = "電視";
  let timer = {
    running: false,
    paused: false,
    endAt: null,
    remainingMs: 0,
    startedWithMs: 0,
    purpose: "電視",
    intervalId: null,
  };
  let finishing = false;
  let audioCtx = null;

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return { ...defaultState(), ...parsed };
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

  function rollDayIfNeeded() {
    const key = todayKey();
    if (state.day === key) return;
    state.day = key;
    state.regularBySubject = Object.fromEntries(SUBJECTS.map((s) => [s, 0]));
    state.todayRegular = 0;
    state.todayOvertime = 0;
    state.todayBonus = 0;
    // balance carries over
    save();
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
      ...entry,
    });
    state.ledger = state.ledger.slice(0, 80);
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

  function unlockAudio() {
    const ctx = ensureAudio();
    if (!ctx) return;
    // Tiny silent blip so mobile browsers unlock audio on this user gesture.
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);
    } catch {
      // ignore unlock failures
    }
  }

  function playTimeUpChime() {
    const ctx = ensureAudio();
    if (!ctx) return;
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

  function syncFromWallClock() {
    if (finishing) return;
    if (!timer.running && !timer.paused) return;

    if (timer.running && timer.endAt != null) {
      timer.remainingMs = Math.max(0, timer.endAt - Date.now());
      persistTimer();
    }

    updateCountdownDisplay();

    if (timer.running && timer.remainingMs <= 0) {
      finishTimer(true);
    }
  }

  function go(screen) {
    document.querySelectorAll(".screen").forEach((el) => {
      el.classList.toggle("active", el.dataset.screen === screen);
    });
    document.querySelectorAll(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.go === screen);
    });
    if (screen === "timer") {
      const input = document.getElementById("timerMinutes");
      if (!timer.running && !timer.paused) {
        input.value = Math.max(1, state.balance || 1);
        input.max = Math.max(1, state.balance);
      }
      syncFromWallClock();
    }
    render();
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
      const text = `含超時已賺 ${todayEarnedTotal()} 分（一般 ${state.todayRegular}＋超時 ${ot}＋加碼 ${state.todayBonus}）· 剩餘可用 ${state.balance} 分`;
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
  }

  function render() {
    rollDayIfNeeded();
    document.getElementById("balanceMinutes").textContent = state.balance;
    document.getElementById("homeBalance").textContent = state.balance;
    document.getElementById("walletBalance").textContent = state.balance;
    document.getElementById("walletTodayRegular").textContent = state.todayRegular;
    document.getElementById("walletTodayBonus").textContent = state.todayBonus;
    document.getElementById("timerAvail").textContent = state.balance;
    updateCapCopy();

    const hint = document.getElementById("homeHint");
    hint.textContent =
      state.balance > 0
        ? "可以按「開始休息」，用計時表倒數使用"
        : "記康軒成績，讓小狐狸尾巴更亮";

    const caps = document.getElementById("subjectCaps");
    caps.innerHTML = SUBJECTS.map((s) => {
      const used = state.regularBySubject[s] || 0;
      const pct = Math.min(100, (used / SUBJECT_CAP) * 100);
      return `<div class="cap-row"><strong>${s}</strong><div class="cap-bar"><span style="width:${pct}%"></span></div><span>${used}/${SUBJECT_CAP}</span></div>`;
    }).join("");

    const ledger = document.getElementById("ledger");
    if (!state.ledger.length) {
      ledger.innerHTML = `<li><div>尚無紀錄<div class="meta">小狐狸靜候第一筆康軒成績</div></div></li>`;
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
    state.balance += award.total;
    addLedger({
      title: `${selectedSubject} ${score} 分`,
      detail: [
        unit || "康軒刷題",
        `${award.points} 點`,
        award.overtimeGranted ? `超時＋${award.overtimeGranted}` : null,
        award.bonus ? `滿分＋${award.bonus}` : null,
        award.hardCapped ? "已套用硬上限" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      delta: award.total,
    });
    save();
    document.getElementById("scoreInput").value = "";
    document.getElementById("unitInput").value = "";
    updatePreview();
    render();
    if (award.total === 0) {
      showToast("logToast", "已記錄，但這次是 0 分休息（未達 85 或已達上限）", true);
    } else if (award.softOvertime) {
      showToast(
        "logToast",
        `已入帳 +${award.total} 分鐘（含超時 ${award.overtimeGranted}）！目前剩餘 ${state.balance} 分`
      );
    } else {
      showToast("logToast", `已入帳 +${award.total} 分鐘！目前剩餘 ${state.balance} 分`);
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
      showToast("timerToast", "還沒有可休息的時間，先去記成績吧", true);
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
    timer.startedWithMs = Math.round(mins * 60) * 1000;
    timer.remainingMs = timer.startedWithMs;
    timer.endAt = Date.now() + timer.remainingMs;
    timer.running = true;
    timer.paused = false;
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

    const wasHidden = document.hidden;
    const remainingMs = getRemainingMs();
    const startedWithMs = timer.startedWithMs;
    const purpose = timer.purpose;

    clearTickInterval();
    timer.running = false;
    timer.paused = false;
    timer.endAt = null;
    timer.remainingMs = 0;
    timer.startedWithMs = 0;
    clearPersistedTimer();

    const usedMs = Math.max(0, startedWithMs - remainingMs);
    const usedMin = usedMs <= 0 ? 0 : Math.max(1, Math.ceil(usedMs / 60000));
    const charge = usedMs <= 0 ? 0 : Math.min(state.balance, usedMin);
    if (charge > 0) {
      state.balance -= charge;
      addLedger({
        title: completed ? "休息時間到" : "結束休息",
        detail: `${purpose} · 用了 ${charge} 分`,
        delta: -charge,
      });
      save();
    }

    showTimerSetupUi();
    render();
    showToast(
      "timerToast",
      completed ? `休息時間到！已扣除 ${charge} 分` : `已結束，扣除 ${charge} 分`
    );
    if (completed) {
      playTimeUpChime();
      if (wasHidden || (typeof Notification !== "undefined" && Notification.permission === "granted")) {
        notifyRestEnded();
      }
    }
    finishing = false;
  }

  function restoreTimerFromStorage() {
    const saved = loadPersistedTimer();
    if (!saved || !saved.startedWithMs) return false;
    timer.purpose = saved.purpose || "電視";
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
    btn.addEventListener("click", () => go(btn.dataset.go));
  });

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
      intervalId: null,
    };
    clearPersistedTimer();
    const keepOvertime = state.allowOvertimeEarn !== false;
    state = defaultState();
    state.allowOvertimeEarn = keepOvertime;
    save();
    showTimerSetupUi();
    render();
    go("home");
  });

  document.addEventListener("visibilitychange", syncFromWallClock);
  window.addEventListener("pageshow", syncFromWallClock);
  window.addEventListener("focus", syncFromWallClock);

  rollDayIfNeeded();
  render();
  updatePreview();
  restoreTimerFromStorage();
})();
