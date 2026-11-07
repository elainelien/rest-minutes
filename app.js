(() => {
  const STORAGE_KEY = "xuxu-rest-v1";
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
    todayBonus: 0,
    ledger: [],
  });

  let state = load();
  let selectedSubject = "國文";
  let selectedPurpose = "電視";
  let timer = {
    running: false,
    remainingSec: 0,
    startedWithSec: 0,
    purpose: "電視",
    intervalId: null,
  };

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

  function rollDayIfNeeded() {
    const key = todayKey();
    if (state.day === key) return;
    state.day = key;
    state.regularBySubject = Object.fromEntries(SUBJECTS.map((s) => [s, 0]));
    state.todayRegular = 0;
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
    let regularWanted = points * POINT_MINUTES;
    const subjectLeft = Math.max(0, SUBJECT_CAP - (state.regularBySubject[subject] || 0));
    const dayLeft = Math.max(0, DAY_CAP - state.todayRegular);
    const regularGranted = Math.min(regularWanted, subjectLeft, dayLeft);
    const bonus = Number(score) === 100 ? PERFECT_BONUS : 0;
    return {
      points,
      regularWanted,
      regularGranted,
      bonus,
      total: regularGranted + bonus,
      capped: regularGranted < regularWanted,
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

  function go(screen) {
    document.querySelectorAll(".screen").forEach((el) => {
      el.classList.toggle("active", el.dataset.screen === screen);
    });
    document.querySelectorAll(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.go === screen);
    });
    if (screen === "timer") {
      const input = document.getElementById("timerMinutes");
      if (!timer.running) {
        input.value = Math.max(1, state.balance || 1);
        input.max = Math.max(1, state.balance);
      }
    }
    render();
  }

  function render() {
    rollDayIfNeeded();
    document.getElementById("balanceMinutes").textContent = state.balance;
    document.getElementById("homeBalance").textContent = state.balance;
    document.getElementById("walletBalance").textContent = state.balance;
    document.getElementById("walletTodayRegular").textContent = state.todayRegular;
    document.getElementById("walletTodayBonus").textContent = state.todayBonus;
    document.getElementById("timerAvail").textContent = state.balance;

    const hint = document.getElementById("homeHint");
    hint.textContent =
      state.balance > 0
        ? "可以按「開始休息」，用計時表倒數使用"
        : "記康軒成績來賺休息時間";

    const caps = document.getElementById("subjectCaps");
    caps.innerHTML = SUBJECTS.map((s) => {
      const used = state.regularBySubject[s] || 0;
      const pct = Math.min(100, (used / SUBJECT_CAP) * 100);
      return `<div class="cap-row"><strong>${s}</strong><div class="cap-bar"><span style="width:${pct}%"></span></div><span>${used}/${SUBJECT_CAP}</span></div>`;
    }).join("");

    const ledger = document.getElementById("ledger");
    if (!state.ledger.length) {
      ledger.innerHTML = `<li><div>還沒有紀錄<div class="meta">先去記一筆康軒成績吧</div></div></li>`;
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
      el.textContent = "輸入分數後會顯示可拿幾分鐘";
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
    if (award.capped) {
      text += `（原 ${award.regularWanted}，已套用每科／全日上限）`;
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
    state.todayBonus += award.bonus;
    state.balance += award.total;
    addLedger({
      title: `${selectedSubject} ${score} 分`,
      detail: [
        unit || "康軒刷題",
        `${award.points} 點`,
        award.bonus ? `滿分＋${award.bonus}` : null,
        award.capped ? "已套用上限" : null,
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
    } else {
      showToast("logToast", `已入帳 +${award.total} 分鐘！目前剩餘 ${state.balance} 分`);
    }
  }

  function startTimer() {
    rollDayIfNeeded();
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
    timer.startedWithSec = Math.round(mins * 60);
    timer.remainingSec = timer.startedWithSec;
    timer.running = true;
    document.getElementById("timerSetup").hidden = true;
    document.getElementById("timerRun").hidden = false;
    document.getElementById("purposeTag").textContent = `用途：${timer.purpose}`;
    document.getElementById("pauseTimerBtn").textContent = "暫停";
    tickTimer();
    timer.intervalId = setInterval(tickTimer, 1000);
  }

  function tickTimer() {
    document.getElementById("countdown").textContent = formatTime(timer.remainingSec);
    if (timer.remainingSec <= 0) {
      finishTimer(true);
      return;
    }
    timer.remainingSec -= 1;
  }

  function pauseTimer() {
    if (!timer.running && timer.remainingSec > 0) {
      timer.running = true;
      document.getElementById("pauseTimerBtn").textContent = "暫停";
      timer.intervalId = setInterval(tickTimer, 1000);
      return;
    }
    timer.running = false;
    clearInterval(timer.intervalId);
    document.getElementById("pauseTimerBtn").textContent = "繼續";
  }

  function finishTimer(completed) {
    clearInterval(timer.intervalId);
    timer.running = false;
    const usedSec = timer.startedWithSec - Math.max(0, timer.remainingSec);
    const usedMin = Math.max(1, Math.ceil(usedSec / 60));
    // If user ends immediately with almost no time, still charge at least the intention?
    // Better: charge actual elapsed, minimum 1 min if any second passed; 0 if never started tick
    const charge = usedSec <= 0 ? 0 : Math.min(state.balance, usedMin);
    if (charge > 0) {
      state.balance -= charge;
      addLedger({
        title: completed ? "休息時間到" : "結束休息",
        detail: `${timer.purpose} · 用了 ${charge} 分`,
        delta: -charge,
      });
      save();
    }
    document.getElementById("timerSetup").hidden = false;
    document.getElementById("timerRun").hidden = true;
    timer.remainingSec = 0;
    timer.startedWithSec = 0;
    render();
    showToast(
      "timerToast",
      completed ? `休息結束！已扣除 ${charge} 分` : `已結束，扣除 ${charge} 分`
    );
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
  document.getElementById("resetBtn").addEventListener("click", () => {
    if (!confirm("確定清除本機所有點數與紀錄？")) return;
    clearInterval(timer.intervalId);
    state = defaultState();
    save();
    document.getElementById("timerSetup").hidden = false;
    document.getElementById("timerRun").hidden = true;
    render();
    go("home");
  });

  rollDayIfNeeded();
  render();
  updatePreview();
})();
