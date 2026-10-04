/* TapDesk Same Wi‑Fi desk — edit in novixa-labs-website/web/tapdesk/lan → Vercel …/tapdesk/lan */
/* Pairing code login + session remembered in this browser (24h). */
let authToken = "";

const loginGate = document.getElementById("loginGate");
const consoleApp = document.getElementById("consoleApp");
const loginForm = document.getElementById("loginForm");
const pairingInput = document.getElementById("pairingInput");
const passwordInput = document.getElementById("passwordInput");
const loginError = document.getElementById("loginError");
const screen = document.getElementById("screen");
const statusLine = document.getElementById("statusLine");
const transportTech = document.getElementById("transportTech");
const appList = document.getElementById("appList");
const appFilter = document.getElementById("appFilter");

let ws = null;
let rtcReadySent = false;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;
const WS_RECONNECT_MAX = 15;
let apps = [];
let pointerDown = null;
let gotWsFrame = false;
let wsOpenAt = 0;
let wsFrameCount = 0;
let rtcVideoUpgradeSent = false;
let rtcHdWanted = false;
let rtcHdUpgradeTimer = null;
const RTC_HD_TIMEOUT_MS = 18000;
let phoneVideoCapable = false;
const LAN_WS_STALL_MS = 4500;
/** HD WebRTC video is manual only — auto-upgrade renegotiates ICE and drops the control DC. */
const LAN_AUTO_RTC_VIDEO_MS = 0;
let mjpegTimer = null;
let statusTimer = null;

/* WebRTC upgrade: smooth P2P screen video over the LAN. JPEG-over-WS stays as the fallback. */
const rtcVideo = document.getElementById("rtcVideo");
let pc = null;
/** ICE up (control / DC). Must not hide JPEG until real WebRTC screen video is proven. */
let rtcActive = false;
let rtcScreenVideoOffered = false;
let rtcVideoLive = false;
let rtcVideoFrameCount = 0;
const RTC_HD_SUSTAIN_MS = 5000;
const RTC_HD_FRAME_GAP_MS = 700;
let rtcHdStreamSince = 0;
let rtcHdLastFrameAt = 0;
let rtcHdBlockedSession = false;
let rtcRemoteSet = false;
const rtcPending = [];
const RTC_ICE = {
  iceServers: [
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "turn:global.relay.metered.ca:80", username: "246e7ed24965223aed07607b", credential: "SunvaF+ENb/YXCp7" },
    { urls: "turn:global.relay.metered.ca:443", username: "246e7ed24965223aed07607b", credential: "SunvaF+ENb/YXCp7" },
    { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "246e7ed24965223aed07607b", credential: "SunvaF+ENb/YXCp7" },
  ],
};

function storageKey() {
  return "remote_device_session_" + location.host + location.pathname;
}

function getToken() {
  return authToken || "";
}

function setToken(token, persist = true) {
  authToken = token || "";
  if (persist && authToken) {
    try {
      localStorage.setItem(storageKey(), authToken);
    } catch (_) {}
  }
}

function clearToken(clearStorage = true) {
  authToken = "";
  if (clearStorage) {
    try {
      localStorage.removeItem(storageKey());
    } catch (_) {}
  }
}

function setStatus(text) {
  statusLine.textContent = text;
  refreshTransportTech();
}

function refreshTransportTech() {
  if (!transportTech) return;
  if (!getToken() || consoleApp.hidden) {
    transportTech.hidden = true;
    return;
  }
  const v = rtcVideoLive ? "v:rtc" : gotWsFrame ? "v:ws-jpeg" : "v:idle";
  const c = dcReady() ? "c:dc" : ws && ws.readyState === WebSocket.OPEN ? "c:ws" : "c:http";
  transportTech.textContent = `tech · ${v} · ${c}`;
  transportTech.hidden = false;
}
function showScreenLoading(title, sub) {
  const el = document.getElementById("screenLoading");
  if (!el) return;
  const t = document.getElementById("screenLoadingText");
  const s = document.getElementById("screenLoadingSub");
  if (title && t) t.textContent = title;
  if (sub !== undefined && s) s.textContent = sub;
  el.classList.remove("is-hidden");
}
function hideScreenLoading() {
  const el = document.getElementById("screenLoading");
  if (el) el.classList.add("is-hidden");
}

function showLogin(clearStorage = true, message = "") {
  if (clearStorage) clearToken(true);
  else clearToken(false);
  loginGate.hidden = false;
  loginGate.style.display = "";
  consoleApp.hidden = true;
  consoleApp.style.display = "none";
  document.body.classList.remove("logged-in");
  hideScreenLoading();
  stopMjpegFallback();
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  if (pairingInput) pairingInput.value = "";
  if (passwordInput) passwordInput.value = "";
  if (message) {
    loginError.textContent = message;
    loginError.hidden = false;
  } else {
    loginError.hidden = true;
  }
  setTimeout(() => pairingInput?.focus(), 50);
}

function showConsole() {
  loginGate.hidden = true;
  loginGate.style.display = "none";
  consoleApp.hidden = false;
  consoleApp.style.display = "";
  document.body.classList.add("logged-in");
  setStatus("Connecting to device…");
  showScreenLoading("Connecting to your phone…", "Starting the live view. This only takes a moment.");
  refreshStatus();
  loadApps();
  startStreamAndConnect();
  if (!statusTimer) statusTimer = setInterval(refreshStatus, 1500);
}

/* ---- Encrypted DataChannel RPC (Same Wi‑Fi) ---------------------------
 * Control + API + file uploads travel inside the WebRTC DTLS DataChannel when it's up, so nothing
 * crosses the LAN in the clear. Everything falls back to REST/WS automatically when it isn't. */
let controlChannel = null;
const pending = new Map();
let reqSeq = 0;
function nextReqId() {
  reqSeq += 1;
  return "r" + reqSeq + "-" + Date.now().toString(36);
}
function dcReady() {
  return controlChannel && controlChannel.readyState === "open";
}
function onDcMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch (_) { return; }
  const payload = msg.payload || {};
  const id = payload.reqId;
  if (id && pending.has(id)) {
    const p = pending.get(id);
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(payload);
  }
}
function dcRequest(type, payload = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const id = nextReqId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      controlChannel.send(JSON.stringify({ type, payload: { ...payload, reqId: id } }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}
function clearDcPending() {
  pending.forEach((p) => {
    clearTimeout(p.timer);
    p.reject(new Error("closed"));
  });
  pending.clear();
}
// Chunked file upload over the DataChannel (E2E). base64 is split so no single message is too big.
function dcUpload(name, mime, data, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextReqId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      const send = (o) => controlChannel.send(JSON.stringify(o));
      send({ type: "upload_begin", payload: { reqId: id, name, mime } });
      const CH = 16000;
      for (let i = 0; i < data.length; i += CH) {
        send({ type: "upload_chunk", payload: { reqId: id, data: data.slice(i, i + CH) } });
      }
      send({ type: "upload_end", payload: { reqId: id } });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}
// Map a REST call to a DataChannel request. Returns undefined when the path isn't DC-routable
// (login/logout/stream/frame/upload) so api() falls back to REST.
async function tryDcRoute(path, options) {
  let body = {};
  if (options.body) {
    try { body = JSON.parse(options.body); } catch (_) { body = {}; }
  }
  let type;
  if (path === "/api/status") type = "status_req";
  else if (path === "/api/apps") type = "apps_req";
  else if (path === "/api/launch") type = "launch";
  else if (path === "/api/settings") type = "settings";
  else if (path === "/api/time") type = "time";
  else if (path === "/api/unlock") type = "unlock";
  else if (path === "/api/action") type = body.type; // wake / swipe_unlock (taps go via sendCommand)
  else return undefined;
  if (!type) return undefined;
  try {
    const resp = await dcRequest(type, body);
    if (path === "/api/apps") return resp.apps || [];
    return resp;
  } catch (_) {
    return undefined; // fall back to REST
  }
}

async function api(path, options = {}) {
  // Prefer the encrypted DataChannel when it's connected; REST stays as the fallback.
  if (dcReady()) {
    const routed = await tryDcRoute(path, options);
    if (routed !== undefined) return routed;
  }
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const token = getToken();
  if (token) headers["X-Auth-Token"] = token;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && path !== "/api/login") {
    showLogin(true);
    throw new Error("unauthorized");
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: res.ok, message: text };
  }
}

async function doLogin(body) {
  loginError.hidden = true;
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || !data.ok || !data.token) {
    loginError.hidden = false;
    return false;
  }
  setToken(data.token, true);
  if (pairingInput) pairingInput.value = "";
  if (passwordInput) passwordInput.value = "";
  showConsole();
  return true;
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = loginForm.querySelector("button[type=submit]");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Connecting…";
  }
  try {
    const code = (pairingInput?.value || "").replace(/\D/g, "");
    if (code.length !== 6) {
      loginError.hidden = false;
      pairingInput?.focus();
      return;
    }
    await doLogin({ pairingCode: code });
  } catch (_) {
    loginError.hidden = false;
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Connect";
    }
  }
});

document.getElementById("btnPasswordLogin")?.addEventListener("click", async () => {
  const pwd = passwordInput?.value || "";
  if (!pwd) {
    loginError.hidden = false;
    passwordInput?.focus();
    return;
  }
  try {
    await doLogin({ password: pwd });
  } catch (_) {
    loginError.hidden = false;
  }
});

const btnRtcVideoEl = document.getElementById("btnRtcVideo");
if (btnRtcVideoEl) {
  btnRtcVideoEl.onclick = () => onRtcHdToggle();
}

document.getElementById("btnLogout").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } catch (_) {}
  showLogin(true);
};

async function tryRestoreSession() {
  const params = new URLSearchParams(location.search);
  const handed = params.get("tk") || params.get("token");
  if (handed) {
    setToken(handed, true);
    try {
      const s = await api("/api/status");
      if (s.ok) {
        showConsole();
        return;
      }
    } catch (_) {}
  }
  let saved = "";
  try {
    saved = localStorage.getItem(storageKey()) || "";
  } catch (_) {}
  if (!saved) {
    showLogin(false);
    return;
  }
  setToken(saved, false);
  try {
    const s = await api("/api/status");
    if (s.ok) {
      showConsole();
      return;
    }
  } catch (_) {}
  showLogin(true);
}

async function startStreamAndConnect() {
  try {
    await api("/api/stream/start", { method: "POST", body: "{}" });
  } catch (_) {}
  connectWs();
  startMjpegFallback();
}

let deviceAspect = "9 / 20";
let lastOrientation = "";

function applyPhoneOrientation(mode, screenW, screenH) {
  const frame = document.getElementById("screenWrap");
  const app = document.getElementById("consoleApp");
  if (!frame) return;
  const next = mode === "landscape" ? "landscape" : "portrait";
  if (next !== lastOrientation) {
    frame.classList.remove("portrait", "landscape");
    frame.classList.add(next);
    if (app) {
      app.classList.toggle("device-landscape", next === "landscape");
      app.classList.toggle("device-portrait", next === "portrait");
    }
    lastOrientation = next;
  }

  const w = Number(screenW) || 0;
  const h = Number(screenH) || 0;
  if (w > 0 && h > 0) {
    // Real device pixels — never invent / stretch aspect.
    deviceAspect = `${w} / ${h}`;
  } else {
    deviceAspect = next === "landscape" ? "16 / 9" : "9 / 20";
  }
  frame.style.aspectRatio = deviceAspect;
}

async function refreshStatus() {
  try {
    const s = await api("/api/status");
    const streaming = s.streaming ? "Live" : "Waiting";
    setStatus(s.streaming ? "Connected · live session" : "Connected · waiting for stream");
    const d = s.device || {};
    const modelEl = document.getElementById("infoModel");
    const androidEl = document.getElementById("infoAndroid");
    const screenEl = document.getElementById("infoScreen");
    const streamEl = document.getElementById("infoStream");
    if (modelEl) modelEl.textContent = [d.manufacturer, d.model].filter(Boolean).join(" ") || "—";
    if (androidEl) androidEl.textContent = d.android ? String(d.android) : "—";
    if (screenEl) {
      screenEl.textContent = d.screenWidth && d.screenHeight
        ? `${d.screenWidth} × ${d.screenHeight}`
        : "—";
    }
    if (streamEl) streamEl.textContent = streaming;

    const auto = d.orientation === "landscape" ? "landscape" : "portrait";
    applyPhoneOrientation(auto, d.screenWidth, d.screenHeight);

    if (!s.streaming || !s.hasFrame) {
      startMjpegFallback();
      showScreenLoading(
        "Waiting for screen sharing",
        "Controls still work. Approve sharing on the phone if the screen is blank."
      );
    } else {
      hideScreenLoading();
    }
  } catch (e) {
    if (e.message === "unauthorized") {
      showLogin(true, "Session ended on the phone. Enter the code again.");
      return;
    }
    setStatus("Connected · waiting for phone");
    if (!ws || ws.readyState !== WebSocket.OPEN) scheduleWsReconnect();
  }
}

function showFrameBlob(blob) {
  const url = URL.createObjectURL(blob);
  const prev = screen.dataset.url;
  screen.src = url;
  screen.dataset.url = url;
  if (prev) URL.revokeObjectURL(prev);
  hideScreenLoading();
}

function startMjpegFallback() {
  if (mjpegTimer) return;
  mjpegTimer = setInterval(async () => {
    if (!getToken()) return;
    if (!rtcHdWanted && gotWsFrame) return;
    try {
      const res = await fetch("/api/frame.jpg?ts=" + Date.now() + "&token=" + encodeURIComponent(getToken()), {
        cache: "no-store",
        headers: { "X-Auth-Token": getToken() },
      });
      if (res.status === 401) {
        showLogin();
        return;
      }
      if (!res.ok) return;
      const blob = await res.blob();
      if (blob.size > 0) showFrameBlob(blob);
    } catch (_) {}
  }, 80);
}

function stopMjpegFallback() {
  if (mjpegTimer) {
    clearInterval(mjpegTimer);
    mjpegTimer = null;
  }
}

function normalizeAppsList(raw) {
  const list = Array.isArray(raw) ? raw : raw?.apps || [];
  return list
    .map((a) => ({
      name: a?.name || a?.packageName || a?.package || "App",
      packageName: a?.packageName || a?.package || "",
    }))
    .filter((a) => a.packageName);
}

async function loadApps() {
  try {
    apps = normalizeAppsList(await api("/api/apps"));
    renderApps();
  } catch (_) {}
}

function renderApps() {
  const q = (appFilter.value || "").toLowerCase();
  appList.innerHTML = "";
  apps
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q))
    .slice(0, 200)
    .forEach((a) => {
      const row = document.createElement("div");
      row.className = "app-row";
      row.innerHTML = `<div><span>${escapeHtml(a.name)}</span><small>${escapeHtml(a.packageName)}</small></div>`;
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn-open";
      openBtn.textContent = "Open";
      openBtn.onclick = () =>
        api("/api/launch", { method: "POST", body: JSON.stringify({ package: a.packageName }) });
      row.appendChild(openBtn);
      appList.appendChild(row);
    });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  if (wsReconnectAttempts >= WS_RECONNECT_MAX) {
    setStatus("Connection unstable — refresh this page");
    showScreenLoading(
      "Connection paused",
      "Your PIN is still saved. Refresh the page or re-open the link from the phone."
    );
    return;
  }
  wsReconnectAttempts += 1;
  const delay = Math.min(800 + wsReconnectAttempts * 400, 6000);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    if (getToken() && (!ws || ws.readyState === WebSocket.CLOSED)) connectWs();
  }, delay);
}

let rtcUpgradeTimer = null;

function maybeStartRtcUpgrade() {
  if (rtcReadySent || rtcActive) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (typeof RTCPeerConnection === "undefined") return;
  if (rtcUpgradeTimer) return;
  // Let WS JPEG run first so the desk never looks frozen while the phone probes WebRTC.
  rtcUpgradeTimer = setTimeout(() => {
    rtcUpgradeTimer = null;
    if (rtcReadySent || rtcActive) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    rtcReadySent = true;
    wsSend({ type: "rtc_ready" });
  }, 1500);
}

function connectWs() {
  if (!getToken()) return;
  if (ws) {
    try { ws.close(); } catch (_) {}
  }
  gotWsFrame = false;
  wsFrameCount = 0;
  rtcReadySent = false;
  rtcVideoUpgradeSent = false;
  rtcHdWanted = false;
  clearRtcHdUpgradeTimer();
  if (rtcUpgradeTimer) {
    clearTimeout(rtcUpgradeTimer);
    rtcUpgradeTimer = null;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    wsReconnectAttempts = 0;
    wsOpenAt = performance.now();
    hideScreenLoading();
    setStatus("Connected · live");
    startMjpegFallback();
  };
  ws.onclose = (ev) => {
    teardownRtc(true);
    rtcReadySent = false;
    // Code 1008 (policy violation) is the phone deliberately ending this session — Stop was
    // pressed, or the session expired. Reflect that immediately instead of saying "Reconnecting…"
    // and waiting for the next status poll to notice.
    if (ev && ev.code === 1008) {
      showLogin(true, "Session ended on the phone. Enter the code again to reconnect.");
      return;
    }
    if (getToken()) {
      setStatus("Reconnecting…");
      showScreenLoading(
        "Reconnecting…",
        "Session still active — keep TapDesk open on the phone. Video returns in a moment."
      );
      scheduleWsReconnect();
    }
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      if (rtcVideoLive) return; // sustained WebRTC screen video only
      gotWsFrame = true;
      wsFrameCount += 1;
      stopMjpegFallback();
      showFrameBlob(new Blob([ev.data], { type: "image/jpeg" }));
      refreshTransportTech();
      maybeStartRtcUpgrade();
      return;
    }
    if (typeof ev.data === "string") {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.type === "video_lane") {
        if (m.videoCapable === true) phoneVideoCapable = true;
        if (m.videoError && rtcHdWanted && !rtcVideoLive) {
          abortRtcHdAttempt(hdErrorMessage(m.videoError), true, true);
          return;
        }
        if (m.carrier === "ws_jpeg" || m.screenVideo === false) {
          rtcScreenVideoOffered = false;
          if (rtcVideoLive || rtcHdWanted) {
            abortRtcHdAttempt(
              m.videoError ? hdErrorMessage(m.videoError) : "Using standard video (JPEG)",
              true,
              rtcHdWanted && !rtcVideoLive,
            );
          } else {
            hideRtcVideoOverlay();
          }
        }
        refreshRtcVideoButton();
        return;
      }
      if (m.type === "rtc_offer") {
        if (m.videoCapable === true) phoneVideoCapable = true;
        startRtcAnswer(m.sdp, m.screenVideo === true);
        refreshRtcVideoButton();
      }
      else if (m.type === "rtc_ice") addRtcIce(m);
      else if (m.type === "rtc_unavailable") {
        rtcReadySent = true;
        teardownRtc(true);
        refreshTransportTech();
      }
    }
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function showHdLoader() {
  const el = document.getElementById("hdUpgradeLoader");
  if (el) el.classList.remove("is-hidden");
}
function hideHdLoader() {
  const el = document.getElementById("hdUpgradeLoader");
  if (el) el.classList.add("is-hidden");
}
function hdErrorMessage(code) {
  if (code === "egl_unavailable") return "HD not supported on this phone — using standard video";
  if (code === "no_frames") return "HD frames unavailable — using standard video";
  return "HD unavailable — using standard video";
}
function clearRtcHdUpgradeTimer() {
  if (rtcHdUpgradeTimer) {
    clearTimeout(rtcHdUpgradeTimer);
    rtcHdUpgradeTimer = null;
  }
}
/** @param blockSession if true, HD stays off until user reconnects. */
function abortRtcHdAttempt(message, sendWantJpeg = true, blockSession = false) {
  clearRtcHdUpgradeTimer();
  hideHdLoader();
  rtcHdWanted = false;
  rtcVideoUpgradeSent = false;
  rtcScreenVideoOffered = false;
  rtcHdStreamSince = 0;
  rtcHdLastFrameAt = 0;
  hideRtcVideoOverlay();
  if (sendWantJpeg) wsSend({ type: "want_jpeg" });
  if (blockSession) {
    rtcHdBlockedSession = true;
    if (message) setStatus(message + " HD is off for this session.");
  } else if (message) setStatus(message);
  refreshRtcVideoButton();
  refreshTransportTech();
}
function onRtcHdToggle() {
  if (rtcHdBlockedSession) {
    setStatus("HD is off for this session — reconnect to try again.");
    return;
  }
  if (rtcVideoLive) {
    abortRtcHdAttempt("Using standard video (JPEG)", true, false);
    return;
  }
  if (rtcHdWanted) return;
  if (!rtcActive || !dcReady()) {
    setStatus("HD needs encrypted control first — wait until tech shows c:dc.");
    return;
  }
  if (rtcVideoUpgradeSent) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus("HD unavailable — connection to phone is not open.");
    return;
  }
  rtcHdWanted = true;
  rtcVideoUpgradeSent = true;
  rtcHdStreamSince = 0;
  rtcHdLastFrameAt = 0;
  startMjpegFallback();
  showHdLoader();
  setStatus("Connecting HD stream… keep TapDesk open on the phone.");
  wsSend({ type: "rtc_video_upgrade" });
  clearRtcHdUpgradeTimer();
  rtcHdUpgradeTimer = setTimeout(() => {
    if (!rtcVideoLive) abortRtcHdAttempt(hdErrorMessage("no_frames"), true, true);
  }, RTC_HD_TIMEOUT_MS);
  refreshRtcVideoButton();
}

function scheduleLanAutoWebRtcVideo() {
  if (LAN_AUTO_RTC_VIDEO_MS <= 0) return;
  if (!phoneVideoCapable || rtcVideoUpgradeSent || rtcVideoLive) return;
  setTimeout(() => {
    if (rtcActive && dcReady() && phoneVideoCapable && !rtcVideoLive && !rtcVideoUpgradeSent) {
      requestWebRtcScreenVideo();
    }
  }, LAN_AUTO_RTC_VIDEO_MS);
}

function refreshRtcVideoButton() {
  const btn = document.getElementById("btnRtcVideo");
  if (!btn) return;
  if (rtcHdBlockedSession) {
    btn.hidden = true;
    return;
  }
  const show = rtcActive && dcReady() && !rtcHdBlockedSession;
  btn.hidden = !show;
  if (rtcHdWanted && !rtcVideoLive) {
    btn.disabled = true;
    btn.textContent = "HD connecting…";
    btn.classList.remove("is-active");
    return;
  }
  btn.disabled = false;
  btn.textContent = rtcVideoLive ? "HD stream: On (tap for standard video)" : "HD stream (WebRTC)";
  btn.classList.toggle("is-active", rtcVideoLive);
}
function hideRtcVideoOverlay() {
  rtcVideoLive = false;
  rtcVideoFrameCount = 0;
  if (rtcVideo) {
    rtcVideo.classList.remove("is-live");
    try { rtcVideo.srcObject = null; } catch (_) {}
  }
  startMjpegFallback();
}

function noteRtcHdFrame() {
  if (!rtcScreenVideoOffered || rtcVideoLive) return;
  const now = Date.now();
  if (rtcHdLastFrameAt && now - rtcHdLastFrameAt > RTC_HD_FRAME_GAP_MS) {
    rtcHdStreamSince = now;
  }
  rtcHdLastFrameAt = now;
  if (!rtcHdStreamSince) rtcHdStreamSince = now;
  rtcVideoFrameCount += 1;
  showHdLoader();
  if (now - rtcHdStreamSince >= RTC_HD_SUSTAIN_MS) maybePromoteRtcVideo();
}
function maybePromoteRtcVideo() {
  if (!rtcScreenVideoOffered || rtcVideoLive) return;
  if (!rtcHdStreamSince || Date.now() - rtcHdStreamSince < RTC_HD_SUSTAIN_MS) return;
  rtcVideoLive = true;
  rtcHdWanted = false;
  clearRtcHdUpgradeTimer();
  hideHdLoader();
  if (rtcVideo) rtcVideo.classList.add("is-live");
  stopMjpegFallback();
  setStatus("Connected · HD video (WebRTC)");
  refreshTransportTech();
  refreshRtcVideoButton();
}

async function startRtcAnswer(sdp, screenVideo) {
  teardownRtc(false);
  rtcScreenVideoOffered = screenVideo === true;
  rtcVideoFrameCount = 0;
  rtcHdStreamSince = 0;
  rtcHdLastFrameAt = 0;
  try { pc = new RTCPeerConnection(RTC_ICE); } catch (_) { return; }
  rtcRemoteSet = false;
  rtcPending.length = 0;
  pc.ontrack = (e) => {
    if (!rtcScreenVideoOffered) return;
    if (rtcVideo && e.streams && e.streams[0]) rtcVideo.srcObject = e.streams[0];
    pumpRtcVideoFrames();
  };
  pc.ondatachannel = (ev) => {
    if (ev.channel && ev.channel.label === "control") {
      controlChannel = ev.channel;
      controlChannel.onmessage = (e) => onDcMessage(e.data);
      controlChannel.onopen = () => {
        refreshTransportTech();
        refreshRtcVideoButton();
      };
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      wsSend({
        type: "rtc_ice",
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      });
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.iceConnectionState;
    if (s === "connected" || s === "completed") {
      rtcActive = true;
      hideScreenLoading();
      if (!rtcScreenVideoOffered) {
        hideRtcVideoOverlay();
        setStatus("Connected · live (control encrypted)");
      } else {
        setStatus("Connected · securing video…");
      }
      refreshTransportTech();
      refreshRtcVideoButton();
    } else if (s === "failed" || s === "disconnected") {
      rtcActive = false;
      hideRtcVideoOverlay();
      refreshTransportTech();
      refreshRtcVideoButton();
    }
  };
  try {
    await pc.setRemoteDescription({ type: "offer", sdp });
    rtcRemoteSet = true;
    for (const c of rtcPending.splice(0)) {
      try { await pc.addIceCandidate(c); } catch (_) {}
    }
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    wsSend({ type: "rtc_answer", sdp: ans.sdp });
  } catch (_) {
    teardownRtc(false);
  }
}
async function addRtcIce(m) {
  const c = { candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex };
  if (pc && rtcRemoteSet) {
    try { await pc.addIceCandidate(c); } catch (_) {}
  } else {
    rtcPending.push(c);
  }
}
function pumpRtcVideoFrames() {
  if (!rtcVideo || typeof rtcVideo.requestVideoFrameCallback !== "function") return;
  try {
    rtcVideo.requestVideoFrameCallback(function onFrame() {
      noteRtcHdFrame();
      if (pc && rtcScreenVideoOffered && rtcVideo) {
        try { rtcVideo.requestVideoFrameCallback(onFrame); } catch (_) {}
      }
    });
  } catch (_) {}
}

function teardownRtc(clearVideo) {
  rtcActive = false;
  rtcScreenVideoOffered = false;
  rtcRemoteSet = false;
  rtcPending.length = 0;
  if (controlChannel) { try { controlChannel.close(); } catch (_) {} controlChannel = null; }
  clearDcPending();
  if (pc) { try { pc.close(); } catch (_) {} pc = null; }
  if (clearVideo) hideRtcVideoOverlay();
}

function sendCommand(obj) {
  // Fire-and-forget control over the encrypted DataChannel when open, else WS, else REST.
  if (dcReady()) {
    try {
      controlChannel.send(JSON.stringify({ type: obj.type, payload: obj }));
      return;
    } catch (_) {
      /* fall through */
    }
  }
  const text = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(text);
  } else {
    api("/api/action", { method: "POST", body: text });
  }
}

function normPoint(evt) {
  const rect = screen.getBoundingClientRect();
  const nw = screen.naturalWidth || 0;
  const nh = screen.naturalHeight || 0;
  if (!rect.width || !rect.height) return null;
  if (!nw || !nh) {
    const x = (evt.clientX - rect.left) / rect.width;
    const y = (evt.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }
  const scale = Math.min(rect.width / nw, rect.height / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  const ox = (rect.width - dw) / 2;
  const oy = (rect.height - dh) / 2;
  const x = (evt.clientX - rect.left - ox) / dw;
  const y = (evt.clientY - rect.top - oy) / dh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

screen.addEventListener("pointerdown", (e) => {
  screen.setPointerCapture(e.pointerId);
  pointerDown = normPoint(e);
});

screen.addEventListener("pointerup", (e) => {
  const end = normPoint(e);
  if (!pointerDown || !end) return;
  const dx = end.x - pointerDown.x;
  const dy = end.y - pointerDown.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.02) {
    sendCommand({ type: "tap", x: end.x, y: end.y });
  } else {
    sendCommand({
      type: "swipe",
      x1: pointerDown.x,
      y1: pointerDown.y,
      x2: end.x,
      y2: end.y,
      duration: 280,
    });
  }
  pointerDown = null;
});

document.querySelectorAll("[data-key]").forEach((btn) => {
  btn.addEventListener("click", () => sendCommand({ type: "key", key: btn.dataset.key }));
});

document.querySelectorAll("[data-settings]").forEach((btn) => {
  btn.addEventListener("click", () =>
    api("/api/settings", { method: "POST", body: JSON.stringify({ page: btn.dataset.settings }) })
  );
});

const fileInput = document.getElementById("fileInput");
const uploadStatus = document.getElementById("uploadStatus");
const dropZone = document.getElementById("dropZone");
const dropZoneLabel = document.getElementById("dropZoneLabel");
const btnUpload = document.getElementById("btnUpload");

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function setUploadStatus(message, kind) {
  if (!uploadStatus) return;
  if (!message) {
    uploadStatus.hidden = true;
    uploadStatus.textContent = "";
    uploadStatus.classList.remove("is-ok", "is-error");
    return;
  }
  uploadStatus.hidden = false;
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("is-ok", kind === "ok");
  uploadStatus.classList.toggle("is-error", kind === "error");
}

function onFileChosen() {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    dropZone.classList.remove("has-file");
    dropZoneLabel.textContent = "Tap to choose a file";
    btnUpload.disabled = true;
    return;
  }
  dropZone.classList.add("has-file");
  dropZoneLabel.textContent = `${file.name} · ${formatFileSize(file.size)}`;
  btnUpload.disabled = false;
  setUploadStatus("", null);
}
fileInput.addEventListener("change", onFileChosen);

// Drag-and-drop onto the zone (desktop browsers), same premium feel as a native file picker.
["dragover", "dragenter"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("is-dragging");
  })
);
["dragleave", "dragend"].forEach((evt) =>
  dropZone.addEventListener(evt, () => dropZone.classList.remove("is-dragging"))
);
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    fileInput.files = e.dataTransfer.files;
    onFileChosen();
  }
});

btnUpload.onclick = async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    setUploadStatus("Choose a file first.", "error");
    return;
  }
  if (!getToken()) {
    showLogin();
    return;
  }
  btnUpload.disabled = true;
  const originalLabel = btnUpload.textContent;
  btnUpload.textContent = "Sending…";
  setUploadStatus("Sending to phone…", null);
  try {
    // Encrypted DataChannel upload (chunked, E2E) when it's up; REST multipart otherwise.
    if (dcReady()) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const data = btoa(binary);
      const r = await dcUpload(
        file.name,
        file.type || "application/octet-stream",
        data
      );
      if (r.ok) {
        setUploadStatus("Saved to Downloads on the phone.", "ok");
        fileInput.value = "";
        onFileChosen();
      } else {
        setUploadStatus(r.message || "Send failed.", "error");
      }
      return;
    }
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "X-Auth-Token": getToken() },
      body: form,
    });
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    if (data.ok) {
      setUploadStatus("Saved to Downloads on the phone.", "ok");
      fileInput.value = "";
      onFileChosen();
    } else {
      setUploadStatus(data.message || "Send failed.", "error");
    }
  } catch (e) {
    setUploadStatus("Send failed.", "error");
  } finally {
    btnUpload.textContent = originalLabel;
    btnUpload.disabled = !(fileInput.files && fileInput.files[0]);
  }
};

const unlockStatus = document.getElementById("unlockStatus");
function setUnlockStatus(message, kind) {
  if (!unlockStatus) return;
  if (!message) {
    unlockStatus.hidden = true;
    unlockStatus.textContent = "";
    unlockStatus.classList.remove("is-ok", "is-error");
    return;
  }
  unlockStatus.hidden = false;
  unlockStatus.textContent = message;
  unlockStatus.classList.toggle("is-ok", kind === "ok");
  unlockStatus.classList.toggle("is-error", kind === "error");
}

document.getElementById("btnWake").onclick = async () => {
  setUnlockStatus("Waking screen…", null);
  const r = await api("/api/action", { method: "POST", body: JSON.stringify({ type: "wake" }) });
  setUnlockStatus(
    r.ok ? "Woke + swipe. If face prompt shows on device, tap Prefer PIN." : (r.message || "Wake failed"),
    r.ok ? "ok" : "error"
  );
};

document.getElementById("btnSwipeUnlock").onclick = async () => {
  setUnlockStatus("Swipe up…", null);
  const r = await api("/api/action", { method: "POST", body: JSON.stringify({ type: "swipe_unlock" }) });
  setUnlockStatus(r.ok ? "Swipe sent." : (r.message || "Swipe failed"), r.ok ? "ok" : "error");
};

document.getElementById("btnPreferPin").onclick = async () => {
  setUnlockStatus("Opening PIN entry…", null);
  const r = await api("/api/unlock", { method: "POST", body: JSON.stringify({ preferPin: true }) });
  setUnlockStatus(r.ok ? "Prefer PIN sent — use pad below." : (r.message || "Failed"), r.ok ? "ok" : "error");
};

const pinTyped = document.getElementById("pinTyped");
let pinBuffer = "";

function renderPinTyped() {
  if (!pinTyped) return;
  pinTyped.textContent = pinBuffer.length ? pinBuffer : "—";
}

document.getElementById("pinPad").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-digit]");
  if (!btn) return;
  const digit = Number(btn.getAttribute("data-digit"));
  if (Number.isNaN(digit)) return;
  pinBuffer += String(digit);
  renderPinTyped();
  setUnlockStatus(`Tapping ${digit}…`, null);
  const r = await api("/api/unlock", { method: "POST", body: JSON.stringify({ digit }) });
  setUnlockStatus(r.ok ? `Sent ${digit}` : (r.message || "Digit failed"), r.ok ? "ok" : "error");
});

document.getElementById("btnPinClear").onclick = () => {
  pinBuffer = "";
  renderPinTyped();
  setUnlockStatus("Cleared", "ok");
};

document.getElementById("btnPinSend").onclick = async () => {
  setUnlockStatus("Enter/OK…", null);
  const r = await api("/api/unlock", { method: "POST", body: JSON.stringify({ enter: true }) });
  setUnlockStatus(r.ok ? "Enter sent" : (r.message || "Enter failed"), r.ok ? "ok" : "error");
};

appFilter.addEventListener("input", renderApps);

// Restore saved session or show pairing login.
tryRestoreSession();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!consoleApp || consoleApp.hidden || !getToken()) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) scheduleWsReconnect();
  else refreshStatus();
});

window.setInterval(() => {
  if (!consoleApp || consoleApp.hidden || !getToken()) return;
  if (!ws || ws.readyState === WebSocket.CLOSED) scheduleWsReconnect();
}, 3500);