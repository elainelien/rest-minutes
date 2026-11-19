/* 煦煦休息時間 — background end alert (best-effort).
 * setTimeout in a service worker is unreliable when the browser kills the worker;
 * the page also fires Notification / showNotification when a tick finds the timer overdue while hidden.
 */
const SCHEDULE_DB = "xuxu-rest-sw";
const SCHEDULE_STORE = "schedule";
const SCHEDULE_KEY = "active";
const NOTIFY_TAG_PREFIX = "xuxu-rest-end-";

let scheduleTimerId = null;
let activeSchedule = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SCHEDULE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SCHEDULE_STORE)) {
        db.createObjectStore(SCHEDULE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("idb open failed"));
  });
}

async function writeSchedule(payload) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCHEDULE_STORE, "readwrite");
    tx.objectStore(SCHEDULE_STORE).put(payload, SCHEDULE_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("idb write failed"));
    };
  });
}

async function readSchedule() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCHEDULE_STORE, "readonly");
    const req = tx.objectStore(SCHEDULE_STORE).get(SCHEDULE_KEY);
    req.onsuccess = () => {
      db.close();
      resolve(req.result || null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error || new Error("idb read failed"));
    };
  });
}

async function clearScheduleStore() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCHEDULE_STORE, "readwrite");
    tx.objectStore(SCHEDULE_STORE).delete(SCHEDULE_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("idb clear failed"));
    };
  });
}

function clearLocalTimer() {
  if (scheduleTimerId != null) {
    clearTimeout(scheduleTimerId);
    scheduleTimerId = null;
  }
}

function notifyTag(sessionId) {
  return `${NOTIFY_TAG_PREFIX}${sessionId || "unknown"}`;
}

async function showEndNotification(schedule) {
  if (!schedule || !schedule.sessionId) return;
  const title = schedule.title || "休息時間到";
  const body = schedule.body || "煦煦的休息時間結束了";
  const tag = notifyTag(schedule.sessionId);
  try {
    await self.registration.showNotification(title, {
      body,
      lang: "zh-Hant",
      tag,
      renotify: false,
      vibrate: [180, 80, 180, 80, 260],
      data: {
        sessionId: schedule.sessionId,
        url: "./",
      },
    });
  } catch {
    // ignore — page may still notify
  }
}

function armTimeout(schedule) {
  clearLocalTimer();
  activeSchedule = schedule;
  if (!schedule || !schedule.endAt) return;
  const delay = Math.max(0, Number(schedule.endAt) - Date.now());
  // Browsers often clamp long timeouts; still best-effort for short rests.
  scheduleTimerId = setTimeout(async () => {
    scheduleTimerId = null;
    const current = activeSchedule;
    if (!current || current.sessionId !== schedule.sessionId) return;
    if (Date.now() + 500 < Number(current.endAt || 0)) {
      armTimeout(current);
      return;
    }
    await showEndNotification(current);
    activeSchedule = null;
    try {
      await clearScheduleStore();
    } catch {
      // ignore
    }
  }, delay);
}

async function applySchedule(schedule) {
  if (!schedule || !schedule.sessionId || !schedule.endAt) {
    clearLocalTimer();
    activeSchedule = null;
    try {
      await clearScheduleStore();
    } catch {
      // ignore
    }
    return;
  }
  await writeSchedule(schedule);
  if (Date.now() >= Number(schedule.endAt)) {
    await showEndNotification(schedule);
    activeSchedule = null;
    clearLocalTimer();
    try {
      await clearScheduleStore();
    } catch {
      // ignore
    }
    return;
  }
  armTimeout(schedule);
}

async function cancelSchedule(sessionId) {
  if (sessionId && activeSchedule && activeSchedule.sessionId !== sessionId) {
    return;
  }
  clearLocalTimer();
  activeSchedule = null;
  try {
    await clearScheduleStore();
  } catch {
    // ignore
  }
}

async function restoreAndCheck() {
  try {
    const saved = await readSchedule();
    if (!saved) return;
    if (Date.now() >= Number(saved.endAt)) {
      await showEndNotification(saved);
      await clearScheduleStore();
      activeSchedule = null;
      return;
    }
    armTimeout(saved);
  } catch {
    // ignore
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await restoreAndCheck();
    })()
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const reply = (payload) => {
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(payload);
    }
  };

  if (data.type === "schedule") {
    event.waitUntil(
      applySchedule({
        endAt: Number(data.endAt),
        sessionId: String(data.sessionId || ""),
        purpose: data.purpose || "",
        title: data.title || "休息時間到",
        body: data.body || "煦煦的休息時間結束了",
      })
        .then(() => reply({ ok: true }))
        .catch(() => reply({ ok: false }))
    );
    return;
  }

  if (data.type === "cancel") {
    event.waitUntil(
      cancelSchedule(data.sessionId ? String(data.sessionId) : null)
        .then(() => reply({ ok: true }))
        .catch(() => reply({ ok: false }))
    );
    return;
  }

  if (data.type === "notify-now") {
    event.waitUntil(
      showEndNotification({
        sessionId: String(data.sessionId || ""),
        title: data.title || "休息時間到",
        body: data.body || "煦煦的休息時間結束了",
        purpose: data.purpose || "",
      })
        .then(() => reply({ ok: true }))
        .catch(() => reply({ ok: false }))
    );
    return;
  }

  if (data.type === "ping") {
    reply({ ok: true, hasSchedule: Boolean(activeSchedule) });
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL("./", self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientsList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(targetUrl);
            } catch {
              // ignore navigate failures
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});
