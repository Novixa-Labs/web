/* TapDesk Connect — LAN-parity console over Secure Link (MQTT) */
const BROKER = "wss://ffcc655fc92742cc88ae9b659f0bef6c.s1.eu.hivemq.cloud:8884/mqtt";

const roomGate = document.getElementById("roomGate");
const loginGate = document.getElementById("loginGate");
const consoleApp = document.getElementById("consoleApp");
const roomStatus = document.getElementById("roomStatus");
const loginError = document.getElementById("loginError");
const statusLine = document.getElementById("statusLine");
const screen = document.getElementById("screen");
const appList = document.getElementById("appList");
const appFilter = document.getElementById("appFilter");
const btnJoin = document.getElementById("btnJoin");

let mqttClient = null;
let clientId = "web-" + Math.random().toString(36).slice(2, 10);
let room = "";
let phoneReady = false;
let authed = false;
let waitTimer = null;
let statusTimer = null;
let pointerDown = null;
let apps = [];
let pending = new Map();
let reqSeq = 0;
let lastOrientation = "";
let deviceAspect = "9 / 20";
/** Skip painting video while user is tapping/swiping so control stays snappy. */
let interactUntil = 0;
let frameObjectUrl = null;
let lastFrameAt = 0; // when the last JPEG frame arrived (fallback video is live)

/* WebRTC upgrade: P2P screen video + control DataChannel. JPEG-over-MQTT stays as the automatic
   fallback, so if WebRTC can't connect (or the browser is old) the session still works. */
const rtcVideo = document.getElementById("rtcVideo");
let pc = null;
let controlChannel = null;
let rtcActive = false;
let rtcRemoteSet = false;
let rtcReadyTimer = null;
let rtcTries = 0;
let sawRelay = false; // did WE gather a TURN "relay" candidate? (needed across networks)
let sawRemoteRelay = false; // did the PHONE send a relay candidate?
let rtcConnectTimer = null;
let rtcDiagTimer = null;
let localCandCount = 0; // ICE candidates we generated
let remoteCandCount = 0; // ICE candidates received from the phone
let rtcTrackSeen = false; // did ontrack fire (media arriving)?
let offerReceived = false; // did the phone's rtc_offer arrive?
let lastRtcFrameAt = 0; // when the WebRTC <video> last decoded a new frame
let rtcStalled = false; // WebRTC connected but frames froze → showing JPEG fallback instead
let rtcStallTimer = null;
let lastInteractAt = 0; // when the user last tapped/swiped (used to detect a real video stall)
let rtcHealthy = false; // did WebRTC deliver a SUSTAINED stream? Until then, control stays on MQTT.
let rtcFrameCount = 0; // frames decoded since the current ICE connection came up
let rtcStartupTimer = null;
const rtcPending = [];

// Vercel route /api/tapdesk-turn. Cloudflare TURN when those env vars are set, otherwise
// the static relay below.
const TURN_ENDPOINT = "/api/tapdesk-turn";

// Fallback static ICE (used only if TURN_ENDPOINT is empty or unreachable).
const RTC_TURN_USER = "246e7ed24965223aed07607b";
const RTC_TURN_PASS = "SunvaF+ENb/YXCp7";
const RTC_ICE = {
  iceServers: [
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "turn:global.relay.metered.ca:80", username: RTC_TURN_USER, credential: RTC_TURN_PASS },
    { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: RTC_TURN_USER, credential: RTC_TURN_PASS },
    { urls: "turn:global.relay.metered.ca:443", username: RTC_TURN_USER, credential: RTC_TURN_PASS },
    { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: RTC_TURN_USER, credential: RTC_TURN_PASS },
  ],
};
let cachedIce = null;
async function getIceConfig() {
  if (cachedIce) return cachedIce;
  // Keep the static relay, and add any servers the Vercel route returns.
  let servers = RTC_ICE.iceServers.slice();
  if (TURN_ENDPOINT) {
    try {
      const r = await fetch(TURN_ENDPOINT, { cache: "no-store" });
      if (r.ok) {
        const fetched = await r.json();
        if (Array.isArray(fetched) && fetched.length) servers = fetched.concat(servers);
      }
    } catch (_) {}
  }
  cachedIce = { iceServers: servers };
  return cachedIce;
}

/* Remember the session in this browser so a refresh resumes (like Same Wi‑Fi) instead of
   creating a second session. Stored: { room, token, ts }. */
const SESSION_KEY = "tapdesk_connect_session";
const SESSION_TTL_MS = 20 * 60 * 60 * 1000; // stay under the phone's 24h session TTL
let joinAlerted = false;
let resuming = false;
let smartConnectActive = false;
/** QR / Same network link (?auto=1 or legacy ?smart=1): join room silently, PIN only. */
let autoConnectMode = false;
let sameWifiBridge = false;
let directHandoffTimer = null;
let smartPort = 8765;

function saveSession(roomCode, token) {
  if (!roomCode || !token) return;
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ room: roomCode, token, ts: Date.now() })
    );
  } catch (_) {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.room || !s.token) return null;
    if (Date.now() - (s.ts || 0) > SESSION_TTL_MS) {
      clearSession();
      return null;
    }
    return s;
  } catch (_) {
    return null;
  }
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (_) {}
  resumeToken = "";
  resuming = false;
}

function topic() {
  return "tapdesk/v1/rooms/" + room;
}
function topicVideo() {
  return topic() + "/v";
}
function setRoomStatus(t, kind) {
  roomStatus.textContent = t;
  roomStatus.classList.remove("is-error", "is-ok");
  if (kind === "error") roomStatus.classList.add("is-error");
  if (kind === "ok") roomStatus.classList.add("is-ok");
}
function hardFail(message) {
  if (autoConnectMode) {
    autoConnectMode = false;
    ["roomFormBlock", "roomIntro"].forEach((id) => {
      document.getElementById(id)?.classList.remove("hidden");
    });
  }
  setRoomStatus(message, "error");
  setJoinBusy(false);
  if (!joinAlerted) {
    joinAlerted = true;
    window.alert(message);
  }
}
function setStatus(t) {
  statusLine.textContent = t;
}
function mediaPathLabel() {
  if (!sameWifiBridge) return "";
  if (sawRelay || sawRemoteRelay) return " · relay (bridge)";
  if (rtcActive) return " · direct path";
  return " · bridge";
}
function smartDirectUrls() {
  const p = new URLSearchParams(location.search);
  const port = parseInt(p.get("port") || String(smartPort), 10) || 8765;
  const urls = [];
  const hosts = (p.get("hosts") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  hosts.forEach((h) => {
    if (/^https?:\/\//i.test(h)) urls.push(h.replace(/\/$/, ""));
    else urls.push("http://" + h.replace(/\/$/, "") + ":" + port);
  });
  const mdns = (p.get("mdns") || "").trim();
  if (mdns) urls.push(mdns.replace(/\/$/, ""));
  const seen = new Set();
  return urls.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}
function openDirectDesk(url) {
  const base = (url || "").replace(/\/$/, "");
  if (!base) return;
  window.location.assign(base + "/");
}
function hideManualRoomForm() {
  ["directLinkBox", "roomBridgeDivider", "roomFormBlock", "roomIntro"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
}
function setupDirectFirstUI() {
  if (autoConnectMode) {
    hideManualRoomForm();
    return;
  }
  const box = document.getElementById("directLinkBox");
  const btn = document.getElementById("btnTryDirect");
  const list = document.getElementById("directLinkUrls");
  const divider = document.getElementById("roomBridgeDivider");
  const urls = smartDirectUrls();
  if (!box || !btn || !urls.length) {
    if (box) box.classList.add("hidden");
    if (divider) divider.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  if (divider) divider.classList.remove("hidden");
  btn.onclick = () => openDirectDesk(urls[0]);
  if (list) {
    if (urls.length === 1) {
      list.innerHTML =
        'Opens <a href="' +
        urls[0] +
        '/" rel="noopener">' +
        urls[0] +
        "</a> — enter the pairing PIN on that page.";
    } else {
      list.innerHTML =
        "Other links: " +
        urls
          .map(
            (u) =>
              '<a href="' + u + '/" rel="noopener">' + u.replace(/^https?:\/\//, "") + "</a>"
          )
          .join(" · ");
    }
  }
}
function attemptDirectHandoff(urls, token) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!list.length || !token) {
    showConsole();
    return;
  }
  const target = list[0].replace(/\/$/, "") + "/?tk=" + encodeURIComponent(token);
  setRoomStatus("Connecting…", "ok");
  let fellBack = false;
  const fallback = () => {
    if (fellBack) return;
    fellBack = true;
    setRoomStatus("Connected.", "ok");
    showConsole();
  };
  if (directHandoffTimer) clearTimeout(directHandoffTimer);
  directHandoffTimer = setTimeout(fallback, 5000);
  try {
    location.assign(target);
  } catch (_) {
    fallback();
  }
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

/* ---- WebRTC stall detection → JPEG/MQTT is the default Other-network video --------------
 * Same Wi‑Fi: direct LAN → WebRTC is smooth. Other-network: a bad TURN/relay path often
 * "connects" then freezes on the first frame. So for Other-network:
 *   1) Phone keeps sending JPEG until the browser proves sustained WebRTC frames.
 *   2) Browser only reveals <video> + sends want_rtc after N real frames.
 *   3) If frames stop, hide <video>, keep JPEG, send want_jpeg.
 *
 * BUG FIXED: the old stall timer cleared itself while ICE was still connecting
 * (`if (!rtcActive) clearInterval`), so fallback never ran after ICE connected. */
const RTC_STALL_MS = 1500;
const RTC_STARTUP_MS = 2500; // after ICE connected, must become healthy or stay on JPEG
const RTC_MIN_FRAMES = 8; // require a real stream before trusting WebRTC (not 1–4 frozen frames)
function markRtcFrame() {
  lastRtcFrameAt = Date.now();
  rtcFrameCount += 1;
  // Other-network does not upgrade the visible video to WebRTC (MQTT JPEG owns the picture).
  // Frames are only used for diagnostics; never call exitJpegFallback / want_rtc here.
}
function pumpRtcFrameCallback() {
  if (!rtcVideo || typeof rtcVideo.requestVideoFrameCallback !== "function") return;
  try {
    rtcVideo.requestVideoFrameCallback(function onVf() {
      markRtcFrame();
      // Keep pumping while the peer exists — do NOT gate on rtcActive (frames can arrive before
      // ICE "connected"; gating here used to stop the chain forever).
      if (pc && rtcVideo) {
        try { rtcVideo.requestVideoFrameCallback(onVf); } catch (_) {}
      }
    });
  } catch (_) {}
}
function startRtcStallWatch() {
  lastRtcFrameAt = Date.now();
  rtcStalled = true; // Other-network: MQTT JPEG is always the picture
  rtcHealthy = false;
  rtcFrameCount = 0;
  if (rtcVideo) {
    rtcVideo.classList.remove("is-live");
    try { rtcVideo.srcObject = null; } catch (_) {}
  }
  try { publish("want_jpeg", {}, 1); } catch (_) {}
  clearTimeout(rtcStartupTimer);
  rtcStartupTimer = null;
  clearInterval(rtcStallTimer);
  rtcStallTimer = null; // no media-stall watch needed — video is MQTT-only
}
function armRtcStartupGuard() {
  // Call when ICE becomes connected/completed. If WebRTC doesn't deliver a sustained stream
  // quickly, stay on JPEG (want_jpeg already sent) and never flip the video overlay on.
  clearTimeout(rtcStartupTimer);
  rtcStartupTimer = setTimeout(() => {
    if (!rtcActive || rtcHealthy) return;
    enterJpegFallback();
  }, RTC_STARTUP_MS);
}
function stopRtcStallWatch() {
  clearInterval(rtcStallTimer);
  rtcStallTimer = null;
  clearTimeout(rtcStartupTimer);
  rtcStartupTimer = null;
  rtcStalled = false;
  rtcHealthy = false;
  rtcFrameCount = 0;
}
function enterJpegFallback() {
  rtcStalled = true;
  rtcHealthy = false;
  rtcFrameCount = 0;
  // Detach any WebRTC media so a frozen first frame can never cover the MQTT JPEG image.
  if (rtcVideo) {
    rtcVideo.classList.remove("is-live");
    try { rtcVideo.srcObject = null; } catch (_) {}
  }
  try { publish("want_jpeg", {}, 1); } catch (_) {}
  setStatus("Connected · live video (MQTT)");
}
function exitJpegFallback() {
  // Other-network: stay on MQTT JPEG. (Same Wi‑Fi uses app.js for WebRTC video.)
  enterJpegFallback();
}
function publish(type, payload = {}, qos = 0) {
  if (!mqttClient || !mqttClient.connected) return;
  mqttClient.publish(
    topic(),
    JSON.stringify({ from: clientId, type, payload }),
    { qos }
  );
}

// Signaling + lifecycle messages must use MQTT (they set up the DataChannel or run pre-auth).
// Everything else (control + API) goes over the encrypted DataChannel when it's open, so it never
// touches the public broker; if the channel isn't up yet, it falls back to MQTT automatically.
const MQTT_ONLY = new Set([
  "hello", "auth", "rtc_ready", "rtc_answer", "rtc_ice", "leave",
  "want_jpeg", "want_rtc", // video-mode switches must not depend on a possibly-dead DataChannel
]);
function dcReady() {
  // "open" isn't enough over a bad relay — the channel can report open while the transport is dead.
  // Only trust the DataChannel once WebRTC has proven a sustained stream and isn't stalled; until
  // then (and whenever stalled) control falls back to MQTT so clicks ALWAYS get through.
  return (
    controlChannel &&
    controlChannel.readyState === "open" &&
    rtcHealthy &&
    !rtcStalled
  );
}
function sendMsg(type, payload = {}) {
  if (!MQTT_ONLY.has(type) && dcReady()) {
    try {
      controlChannel.send(JSON.stringify({ from: clientId, type, payload }));
      return;
    } catch (_) {
      /* fall back to MQTT */
    }
  }
  publish(type, payload);
}
function reqId() {
  reqSeq += 1;
  return "r" + reqSeq + "-" + Date.now().toString(36);
}
function request(type, payload = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const id = reqId();
    const body = { ...payload, reqId: id };
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sendMsg(type, body);
  });
}
// Chunked upload over the DataChannel (E2E) with automatic MQTT fallback. Files never traverse
// the public broker when the encrypted channel is up.
function uploadFile(name, mime, data, timeoutMs = 30000) {
  if (dcReady()) {
    return new Promise((resolve, reject) => {
      const id = reqId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        const send = (o) => controlChannel.send(JSON.stringify({ from: clientId, ...o }));
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
  return request("upload", { name, mime, data }, timeoutMs);
}
function resolvePending(payload) {
  const id = payload && payload.reqId;
  if (!id || !pending.has(id)) return false;
  const p = pending.get(id);
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(payload);
  return true;
}
function cleanupMqtt() {
  clearInterval(waitTimer);
  waitTimer = null;
  teardownRtc(true);
  try {
    mqttClient && mqttClient.end(true);
  } catch (_) {}
  mqttClient = null;
  pending.forEach((p) => {
    clearTimeout(p.timer);
    p.reject(new Error("closed"));
  });
  pending.clear();
}

/* ---- WebRTC upgrade ---------------------------------------------------- */
function startRtcUpgrade() {
  if (typeof RTCPeerConnection === "undefined") return; // old browser → JPEG only
  rtcTries = 0;
  stopRtcReadyTimer();
  const ask = () => {
    if (rtcActive || !authed) { stopRtcReadyTimer(); return; }
    rtcTries += 1;
    // Reliable (QoS 1) so the phone definitely gets at least one ready. We stop pinging as soon as
    // the phone's offer arrives (see rtc_offer handler), so we never restart an in-flight connect.
    publish("rtc_ready", {}, 1);
    if (rtcTries >= 8) stopRtcReadyTimer();
  };
  ask();
  rtcReadyTimer = setInterval(ask, 2500);
}
function stopRtcReadyTimer() {
  if (rtcReadyTimer) clearInterval(rtcReadyTimer);
  rtcReadyTimer = null;
}
async function startRtcAnswer(offerSdp) {
  teardownRtc(false);
  const cfg = await getIceConfig();
  try {
    pc = new RTCPeerConnection(cfg);
  } catch (_) {
    return;
  }
  rtcRemoteSet = false;
  rtcPending.length = 0;
  sawRelay = false;
  sawRemoteRelay = false;
  localCandCount = 0;
  remoteCandCount = 0;
  rtcTrackSeen = false;

  pc.ontrack = (ev) => {
    // Other-network offers are DataChannel-only (no video track). If a track arrives anyway, ignore
    // it for display — MQTT JPEG owns the picture so the JPEG capturer is never starved.
    rtcTrackSeen = true;
  };
  startRtcStallWatch();
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      localCandCount += 1;
      // A "typ relay" candidate means TURN is working — required for cross-network video.
      if ((ev.candidate.candidate || "").indexOf(" typ relay") >= 0) sawRelay = true;
      publish("rtc_ice", {
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      }, 1);
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.iceConnectionState;
    if (s === "connected" || s === "completed") {
      rtcActive = true;
      stopRtcReadyTimer();
      clearTimeout(rtcConnectTimer);
      clearInterval(rtcDiagTimer);
      hideScreenLoading();
      // Keep JPEG visible. Only upgrade to WebRTC video after a sustained stream (markRtcFrame).
      // Re-arm pump + startup guard now that ICE is actually up (old bug: timers died before this).
      pumpRtcFrameCallback();
      armRtcStartupGuard();
      try { publish("want_jpeg", {}, 1); } catch (_) {}
      setStatus("Connected · live video (MQTT)" + mediaPathLabel());
    } else if (s === "failed") {
      rtcActive = false;
      if (rtcVideo) rtcVideo.classList.remove("is-live");
      showScreenLoading(
        "Reconnecting the secure video…",
        "The encrypted link dropped. Retrying — controls still work."
      );
      startRtcUpgrade(); // re-ask the phone for a fresh offer
    } else if (s === "disconnected") {
      rtcActive = false;
      if (rtcVideo) rtcVideo.classList.remove("is-live");
    }
  };
  pc.ondatachannel = (ev) => {
    if (ev.channel && ev.channel.label === "control") {
      controlChannel = ev.channel;
      // Responses to DataChannel requests come back here — route them through the same handler.
      controlChannel.onmessage = (e) => {
        try { onMessage(JSON.parse(e.data)); } catch (_) {}
      };
    }
  };

  try {
    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    rtcRemoteSet = true;
    for (const c of rtcPending.splice(0)) {
      try { await pc.addIceCandidate(c); } catch (_) {}
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    publish("rtc_answer", { sdp: answer.sdp }, 1);

    // Live diagnostic while connecting — but ONLY when there's no video at all. If JPEG fallback
    // frames are flowing, don't cover them; WebRTC keeps trying to upgrade in the background.
    clearInterval(rtcDiagTimer);
    rtcDiagTimer = setInterval(() => {
      if (rtcActive) { clearInterval(rtcDiagTimer); return; }
      if (Date.now() - lastFrameAt < 3000) return; // fallback video is live — leave it alone
      showScreenLoading("Connecting…", "Setting up your secure link.");
    }, 1500);

    // After ~15s still not up (and no fallback video), add a plain-language hint.
    clearTimeout(rtcConnectTimer);
    rtcConnectTimer = setTimeout(() => {
      if (rtcActive || Date.now() - lastFrameAt < 3000) return;
      showScreenLoading(
        "Still connecting…",
        "Keep the room open on the phone and check both devices have internet."
      );
    }, 15000);
  } catch (_) {
    teardownRtc(false);
  }
}
async function addRtcIce(payload) {
  remoteCandCount += 1;
  if ((payload.candidate || "").indexOf(" typ relay") >= 0) sawRemoteRelay = true;
  const cand = {
    candidate: payload.candidate,
    sdpMid: payload.sdpMid,
    sdpMLineIndex: payload.sdpMLineIndex,
  };
  if (pc && rtcRemoteSet) {
    try { await pc.addIceCandidate(cand); } catch (_) {}
  } else {
    rtcPending.push(cand);
  }
}
function teardownRtc(clearVideo) {
  stopRtcReadyTimer();
  clearTimeout(rtcConnectTimer);
  clearInterval(rtcDiagTimer);
  stopRtcStallWatch();
  rtcActive = false;
  rtcRemoteSet = false;
  rtcPending.length = 0;
  if (controlChannel) { try { controlChannel.close(); } catch (_) {} controlChannel = null; }
  if (pc) { try { pc.close(); } catch (_) {} pc = null; }
  if (rtcVideo) {
    rtcVideo.classList.remove("is-live");
    if (clearVideo) { try { rtcVideo.srcObject = null; } catch (_) {} }
  }
}

function setJoinBusy(busy, label) {
  btnJoin.disabled = busy;
  btnJoin.classList.toggle("is-busy", busy);
  btnJoin.textContent = label || (busy ? "Connecting…" : "Continue");
}
function showRoom() {
  authed = false;
  phoneReady = false;
  // Closing a session must not leave the room code or PIN behind — wipe both the entry fields and
  // the in-memory room so the next person has to type them in fresh.
  room = "";
  const roomIn = document.getElementById("roomInput");
  if (roomIn) roomIn.value = "";
  const pinIn = document.getElementById("pairingInput");
  if (pinIn) pinIn.value = "";
  roomGate.classList.remove("hidden");
  roomGate.hidden = false;
  loginGate.hidden = true;
  loginGate.classList.add("hidden");
  consoleApp.hidden = true;
  consoleApp.style.display = "none";
  document.body.classList.remove("logged-in");
  setJoinBusy(false);
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  cleanupMqtt();
}
function showPin() {
  setJoinBusy(false);
  roomGate.classList.add("hidden");
  roomGate.hidden = true;
  loginGate.hidden = false;
  loginGate.classList.remove("hidden");
  consoleApp.hidden = true;
  consoleApp.style.display = "none";
  document.getElementById("pairingInput")?.focus();
}
function showConsole() {
  roomGate.classList.add("hidden");
  roomGate.hidden = true;
  loginGate.hidden = true;
  loginGate.classList.add("hidden");
  consoleApp.hidden = false;
  consoleApp.style.display = "";
  document.body.classList.add("logged-in");
  setStatus("Connected · live session");
  showScreenLoading("Starting the live view…", "Waking the screen and preparing the stream.");
  publish("stream_start", { reqId: reqId() });
  publish("want_jpeg", {}, 1); // Other-network default: MQTT JPEG until WebRTC proves healthy
  startRtcUpgrade(); // try to upgrade video to P2P WebRTC; JPEG keeps working meanwhile
  // Defer heavy MQTT traffic so first taps/frames are not blocked by apps list.
  setTimeout(() => {
    if (authed) refreshStatus();
  }, 400);
  setTimeout(() => {
    if (authed) loadApps();
  }, 1800);
  if (!statusTimer) statusTimer = setInterval(refreshStatus, 5000);
}

function onMessage(msg) {
  if (!msg || msg.from === clientId) return;
  const type = msg.type;
  const payload = msg.payload || {};

  if (type === "ended") {
    const reason = String(payload.reason || "stopped").toLowerCase();
    // Brief MQTT drops used to publish a false "ended" — never kick a live session for that.
    if (authed && reason === "offline") {
      showScreenLoading(
        "Phone link paused",
        "Keep TapDesk open on the phone. Video may return — controls still work when the link is back."
      );
      setStatus("Connected · waiting for phone" + mediaPathLabel());
      return;
    }
    teardownRtc(true);
    clearSession();
    showRoom();
    setRoomStatus("Session ended on the phone. Enter the room code to reconnect.");
    return;
  }

  if (type === "presence" && payload.online === false && authed) {
    setStatus("Connected · phone link paused" + mediaPathLabel());
    return;
  }

  // WebRTC upgrade signaling (phone is the offerer).
  if (type === "rtc_offer") {
    // An offer arrived — stop pinging rtc_ready so the phone doesn't restart the connection.
    // Cross-network ICE (TURN relay) needs a few seconds; let this negotiation finish.
    offerReceived = true;
    stopRtcReadyTimer();
    startRtcAnswer(payload.sdp);
    return;
  }
  if (type === "rtc_ice") {
    addRtcIce(payload);
    return;
  }
  if (type === "rtc_unavailable") {
    // Phone has no screen projection to mirror yet. Video is WebRTC-only (end-to-end encrypted),
    // so guide the user; the browser keeps retrying and upgrades as soon as it's available.
    if (!rtcActive) {
      showScreenLoading(
        "Turn on screen sharing on the phone",
        "Open TapDesk on the phone and allow screen capture. Controls still work."
      );
    }
    return;
  }

  if (type === "ready") {
    if (!phoneReady) {
      phoneReady = true;
      clearInterval(waitTimer);
      waitTimer = null;
      setRoomStatus("Phone found.", "ok");
      if (resuming && resumeToken) {
        // Silent resume after a refresh — reuse the saved token, no PIN needed.
        setRoomStatus("Resuming your session…", "ok");
        publish("auth", { token: resumeToken }, 1);
      } else {
        showPin();
      }
    }
    return;
  }

  if (type === "auth") {
    if (payload.ok) {
      authed = true;
      resuming = false;
      loginError.hidden = true;
      sameWifiBridge = !!payload.same_wifi;
      if (payload.token) {
        resumeToken = payload.token;
        saveSession(room, payload.token);
      }
      const btn = document.getElementById("btnPinSubmit");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Start controlling";
      }
      if (sameWifiBridge && payload.lan_urls && payload.token) {
        attemptDirectHandoff(payload.lan_urls, payload.token);
        return;
      }
      showConsole();
    } else if (resuming) {
      // Saved token expired / phone restarted — fall back to entering the PIN.
      resuming = false;
      clearSession();
      showPin();
      loginError.hidden = false;
      loginError.textContent = "Your session expired — please enter the PIN again.";
    } else {
      loginError.hidden = false;
      loginError.textContent = "Incorrect or expired PIN";
      const btn = document.getElementById("btnPinSubmit");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Start controlling";
      }
    }
    return;
  }

  if (
    type === "status" ||
    type === "apps" ||
    type === "launch_result" ||
    type === "settings_result" ||
    type === "time_result" ||
    type === "unlock_result" ||
    type === "upload_result" ||
    type === "action_result" ||
    type === "stream_result"
  ) {
    resolvePending(payload);
    if (type === "status") applyStatus(payload);
    if (type === "apps" && payload.apps) {
      apps = payload.apps;
      renderApps();
    }
  }
}

function joinRoom(opts) {
  if (btnJoin.disabled) return;

  room = (document.getElementById("roomInput").value || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
  document.getElementById("roomInput").value = room;

  if (room.length < 4) {
    setRoomStatus("Enter the room code from your phone", "error");
    return;
  }
  if (typeof mqtt === "undefined" || !mqtt.connect) {
    hardFail("Connect page failed to load. Hard-refresh (Ctrl+F5) and try again.");
    return;
  }

  // Only a page-load resume uses the saved token; a manual "Continue" always asks for the PIN.
  resuming = !!(opts && opts.resume && resumeToken);
  if (!resuming) resumeToken = "";
  joinAlerted = false;

  authed = false;
  phoneReady = false;
  cleanupMqtt();
  clientId = "web-" + Math.random().toString(36).slice(2, 10);
  setJoinBusy(true, "Connecting…");
  setRoomStatus(autoConnectMode ? "Connecting…" : "Connecting…");

  let connectedOk = false;
  const connectWatch = setTimeout(() => {
    if (connectedOk || phoneReady) return;
    setRoomStatus("Still connecting… check internet, keep the phone room open.", "error");
  }, 8000);

  try {
    mqttClient = mqtt.connect(BROKER, {
      clientId,
      username: "tapdesk-remote-device",
      password: "tapDesk##@@",
      clean: true,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      keepalive: 30,
      resubscribe: true,
      protocolVersion: 4,
    });
  } catch (err) {
    clearTimeout(connectWatch);
    hardFail("Couldn’t start the connection. Hard-refresh and try again.");
    return;
  }

  mqttClient.on("connect", () => {
    connectedOk = true;
    clearTimeout(connectWatch);
    setJoinBusy(true, "Looking for phone…");
    setRoomStatus("Connecting…");
    let pendingSubs = 2;
    const onSub = (err) => {
      if (err) {
        setRoomStatus("Couldn’t join room. Check your internet.", "error");
        setJoinBusy(false);
        return;
      }
      pendingSubs -= 1;
      if (pendingSubs > 0) return;
      publish("hello");
      let tries = 0;
      waitTimer = setInterval(() => {
        if (phoneReady) return;
        tries += 1;
        publish("hello");
        setRoomStatus("Connecting…");
        if (tries >= 25) {
          clearInterval(waitTimer);
          waitTimer = null;
          hardFail(
            autoConnectMode
              ? "Could not reach this phone. On the phone, open Same network again, or use Different network."
              : "Phone not found. Check the room code on the phone and try again."
          );
        }
      }, 1000);
    };
    mqttClient.subscribe(topic(), { qos: 0 }, onSub);
    mqttClient.subscribe(topicVideo(), { qos: 0 }, onSub);
  });

  mqttClient.on("message", (t, payload) => {
    // Video topic carries raw binary JPEG (no JSON) for speed; control topic carries JSON.
    if (t === topicVideo()) {
      handleVideoFrame(payload);
      return;
    }
    try {
      onMessage(JSON.parse(String(payload)));
    } catch (_) {}
  });

  mqttClient.on("error", (err) => {
    clearTimeout(connectWatch);
    hardFail(
      "Couldn’t reach the connection service. Check the computer’s internet" +
        (err && err.message ? " (" + err.message + ")" : "") +
        ". Same Wi-Fi control does not use this page."
    );
  });

  mqttClient.on("close", () => {
    if (!phoneReady && !authed && btnJoin.disabled) {
      /* reconnectPeriod may recover; keep busy until timeout loop ends */
    }
  });
}

btnJoin.onclick = () => joinRoom();
document.getElementById("roomInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    joinRoom();
  }
});
document.getElementById("roomInput").addEventListener("input", (e) => {
  const el = e.target;
  const start = el.selectionStart;
  el.value = el.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  try {
    el.setSelectionRange(start, start);
  } catch (_) {}
});

document.getElementById("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const pin = (document.getElementById("pairingInput").value || "").replace(/\D/g, "");
  const btn = document.getElementById("btnPinSubmit");
  if (pin.length !== 6) {
    loginError.hidden = false;
    return;
  }
  if (!mqttClient || !mqttClient.connected) {
    loginError.hidden = false;
    loginError.textContent = "Connection lost. Go back and enter the room code again.";
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking PIN…";
  }
  loginError.hidden = true;
  publish("auth", { pin, password: pin }, 1);
  setTimeout(() => {
    if (!authed && btn) {
      btn.disabled = false;
      btn.textContent = "Start controlling";
      loginError.hidden = false;
      loginError.textContent = "Incorrect or expired PIN";
    }
  }, 8000);
});

document.getElementById("btnPasswordLogin").onclick = () => {
  const password = document.getElementById("passwordInput").value || "";
  if (!password) {
    loginError.hidden = false;
    return;
  }
  publish("auth", { password, pin: "" }, 1);
};

document.getElementById("btnLogout").onclick = () => {
  // Tell the phone to end the room too (mirrors the phone's Stop button), then leave.
  // Send it three ways so it can't be missed: over the reliable DataChannel (instant, if open),
  // and over MQTT at QoS 1 (guaranteed delivery). Only then tear down the transports.
  try {
    if (controlChannel && controlChannel.readyState === "open") {
      controlChannel.send(JSON.stringify({ from: clientId, type: "leave", payload: {} }));
    }
  } catch (_) {}
  try { publish("leave", {}, 1); } catch (_) {}
  clearSession();
  // Let the QoS-1 "leave" flush to the broker before we close MQTT, then leave the UI.
  setTimeout(() => {
    teardownRtc(true);
    showRoom();
    setRoomStatus("Disconnected. Enter a room code to connect again.");
  }, 600);
};

// Auto connect (?auto=1 or legacy ?smart=1&room=…) or resume saved session.
(function initSmartOrResume() {
  const p = new URLSearchParams(location.search);
  const autoFlag = p.get("auto") === "1" || p.get("smart") === "1";
  if (autoFlag) {
    smartPort = parseInt(p.get("port") || "8765", 10) || 8765;
    const r = (p.get("room") || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (r.length >= 4) {
      smartConnectActive = true;
      autoConnectMode = true;
      const input = document.getElementById("roomInput");
      if (input) input.value = r;
      room = r;
      hideManualRoomForm();
      setRoomStatus("Connecting…", "ok");
      setTimeout(() => joinRoom(), 80);
      return;
    }
  }
  const s = loadSession();
  if (!s) return;
  const input = document.getElementById("roomInput");
  if (input) input.value = s.room;
  room = s.room;
  resumeToken = s.token;
  resuming = true;
  setRoomStatus("Resuming your last session…");
  joinRoom({ resume: true });
})();

function applyPhoneOrientation(mode, screenW, screenH) {
  const frame = document.getElementById("screenWrap");
  if (!frame) return;
  const next = mode === "landscape" ? "landscape" : "portrait";
  if (next !== lastOrientation) {
    frame.classList.remove("portrait", "landscape");
    frame.classList.add(next);
    consoleApp.classList.toggle("device-landscape", next === "landscape");
    consoleApp.classList.toggle("device-portrait", next === "portrait");
    lastOrientation = next;
  }
  const w = Number(screenW) || 0;
  const h = Number(screenH) || 0;
  deviceAspect = w > 0 && h > 0 ? `${w} / ${h}` : next === "landscape" ? "16 / 9" : "9 / 20";
  frame.style.aspectRatio = deviceAspect;
}

function applyStatus(s) {
  const streaming = s.streaming ? "Live" : "Waiting";
  setStatus(s.streaming ? "Connected · live session" : "Connected · waiting for stream");
  const d = s.device || {};
  document.getElementById("infoModel").textContent =
    [d.manufacturer, d.model].filter(Boolean).join(" ") || "—";
  document.getElementById("infoAndroid").textContent = d.android ? String(d.android) : "—";
  document.getElementById("infoScreen").textContent =
    d.screenWidth && d.screenHeight ? `${d.screenWidth} × ${d.screenHeight}` : "—";
  document.getElementById("infoStream").textContent = streaming;
  applyPhoneOrientation(d.orientation === "landscape" ? "landscape" : "portrait", d.screenWidth, d.screenHeight);
}

async function refreshStatus() {
  if (!authed) return;
  try {
    const s = await request("status_req", {});
    applyStatus(s);
  } catch (_) {
    setStatus("Waiting for phone…");
  }
}

async function loadApps() {
  if (!authed) return;
  try {
    const r = await request("apps_req", {}, 20000);
    apps = r.apps || [];
    renderApps();
  } catch (_) {}
}

function renderApps() {
  const q = (appFilter.value || "").toLowerCase();
  appList.innerHTML = "";
  apps
    .filter(
      (a) =>
        !q ||
        (a.name || "").toLowerCase().includes(q) ||
        (a.packageName || "").toLowerCase().includes(q)
    )
    .slice(0, 200)
    .forEach((a) => {
      const row = document.createElement("div");
      row.className = "app-row";
      row.innerHTML = `<div><span>${escapeHtml(a.name)}</span><small>${escapeHtml(
        a.packageName
      )}</small></div>`;
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn-open";
      openBtn.textContent = "Open";
      openBtn.onclick = () => request("launch", { package: a.packageName }).catch(() => {});
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
appFilter.addEventListener("input", renderApps);

let pendingFrameUrl = null;

function setPendingFrame(url) {
  if (pendingFrameUrl) {
    try {
      URL.revokeObjectURL(pendingFrameUrl);
    } catch (_) {}
  }
  pendingFrameUrl = url;
}

function handleVideoFrame(payload) {
  // Other-network: MQTT JPEG is always the picture. Never ignore frames for WebRTC overlay.
  // payload is a binary Buffer/Uint8Array of JPEG bytes.
  let url;
  try {
    url = URL.createObjectURL(new Blob([payload], { type: "image/jpeg" }));
  } catch (_) {
    return;
  }
  // During / right after input, or while a previous image is still decoding, hold the newest
  // frame so we never fight the UI thread — older pending frames are dropped and revoked.
  if (Date.now() < interactUntil || screen.dataset.busy === "1") {
    setPendingFrame(url);
    return;
  }
  applyFrameUrl(url);
}

function applyFrameUrl(url) {
  lastFrameAt = Date.now();
  screen.dataset.busy = "1";
  const prev = frameObjectUrl;
  screen.onload = screen.onerror = () => {
    screen.dataset.busy = "0";
    hideScreenLoading();
    if (prev) {
      try {
        URL.revokeObjectURL(prev);
      } catch (_) {}
    }
    if (Date.now() < interactUntil) return;
    if (pendingFrameUrl) {
      const next = pendingFrameUrl;
      pendingFrameUrl = null;
      applyFrameUrl(next);
    }
  };
  frameObjectUrl = url;
  screen.src = url;
}

function markInteract(ms) {
  interactUntil = Date.now() + (ms || 180);
  lastInteractAt = Date.now();
}

function sendCommand(obj) {
  if (!authed) return;
  markInteract(obj.type === "swipe" ? 260 : 180);
  // Fire-and-forget control over the encrypted DataChannel when open (else MQTT). Never awaited,
  // so clicks stay snappy.
  if (obj.type === "tap") sendMsg("tap", { x: obj.x, y: obj.y });
  else if (obj.type === "swipe")
    sendMsg("swipe", {
      x1: obj.x1,
      y1: obj.y1,
      x2: obj.x2,
      y2: obj.y2,
      duration: obj.duration || 220,
    });
  else if (obj.type === "key") sendMsg("key", { key: obj.key });
  else sendMsg("action", obj);
}

function normPoint(evt) {
  const rect = screen.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (evt.clientX - rect.left) / rect.width;
  const y = (evt.clientY - rect.top) / rect.height;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

screen.addEventListener("pointerdown", (e) => {
  screen.setPointerCapture(e.pointerId);
  pointerDown = normPoint(e);
  markInteract(400);
});
screen.addEventListener("pointerup", (e) => {
  const end = normPoint(e);
  if (!pointerDown || !end || !authed) {
    pointerDown = null;
    return;
  }
  const dx = end.x - pointerDown.x;
  const dy = end.y - pointerDown.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.02) sendCommand({ type: "tap", x: end.x, y: end.y });
  else
    sendCommand({
      type: "swipe",
      x1: pointerDown.x,
      y1: pointerDown.y,
      x2: end.x,
      y2: end.y,
      duration: 220,
    });
  pointerDown = null;
  // Flush newest frame after input settles.
  setTimeout(() => {
    if (pendingFrameUrl && screen.dataset.busy !== "1" && Date.now() >= interactUntil) {
      const next = pendingFrameUrl;
      pendingFrameUrl = null;
      applyFrameUrl(next);
    }
  }, 200);
});

document.querySelectorAll("[data-key]").forEach((btn) => {
  btn.addEventListener("click", () => {
    markInteract(160);
    sendCommand({ type: "key", key: btn.dataset.key });
  });
});
document.querySelectorAll("[data-settings]").forEach((btn) => {
  btn.addEventListener("click", () =>
    request("settings", { page: btn.dataset.settings || "" }).catch(() => {})
  );
});

const unlockStatus = document.getElementById("unlockStatus");
function setUnlockStatus(message, kind) {
  if (!message) {
    unlockStatus.hidden = true;
    unlockStatus.textContent = "";
    return;
  }
  unlockStatus.hidden = false;
  unlockStatus.textContent = message;
  unlockStatus.classList.toggle("is-ok", kind === "ok");
  unlockStatus.classList.toggle("is-error", kind === "error");
}

document.getElementById("btnWake").onclick = async () => {
  setUnlockStatus("Waking…");
  try {
    const r = await request("action", { type: "wake" });
    setUnlockStatus(r.ok ? "Wake sent" : r.message || "Failed", r.ok ? "ok" : "error");
  } catch (_) {
    setUnlockStatus("Failed", "error");
  }
};
document.getElementById("btnSwipeUnlock").onclick = async () => {
  setUnlockStatus("Swipe…");
  try {
    const r = await request("action", { type: "swipe_unlock" });
    setUnlockStatus(r.ok ? "Swipe sent" : r.message || "Failed", r.ok ? "ok" : "error");
  } catch (_) {
    setUnlockStatus("Failed", "error");
  }
};
document.getElementById("btnPreferPin").onclick = async () => {
  setUnlockStatus("Prefer PIN…");
  try {
    const r = await request("unlock", { preferPin: true });
    setUnlockStatus(r.ok ? "Prefer PIN sent" : r.message || "Failed", r.ok ? "ok" : "error");
  } catch (_) {
    setUnlockStatus("Failed", "error");
  }
};

const pinTyped = document.getElementById("pinTyped");
let pinBuffer = "";
function renderPinTyped() {
  pinTyped.textContent = pinBuffer.length ? pinBuffer : "—";
}
document.getElementById("pinPad").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-digit]");
  if (!btn) return;
  const digit = Number(btn.getAttribute("data-digit"));
  pinBuffer += String(digit);
  renderPinTyped();
  try {
    const r = await request("unlock", { digit });
    setUnlockStatus(r.ok ? `Sent ${digit}` : r.message || "Failed", r.ok ? "ok" : "error");
  } catch (_) {
    setUnlockStatus("Failed", "error");
  }
});
document.getElementById("btnPinClear").onclick = () => {
  pinBuffer = "";
  renderPinTyped();
  setUnlockStatus("Cleared", "ok");
};
document.getElementById("btnPinSend").onclick = async () => {
  try {
    const r = await request("unlock", { enter: true });
    setUnlockStatus(r.ok ? "Enter sent" : r.message || "Failed", r.ok ? "ok" : "error");
  } catch (_) {
    setUnlockStatus("Failed", "error");
  }
};

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
  if (file.size > 220000) {
    setUploadStatus("Too large for Secure Link — keep it under 220 KB.", "error");
    return;
  }
  btnUpload.disabled = true;
  const originalLabel = btnUpload.textContent;
  btnUpload.textContent = "Sending…";
  setUploadStatus("Sending to phone…", null);
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const data = btoa(binary);
    const r = await uploadFile(
      file.name,
      file.type || "application/octet-stream",
      data,
      30000
    );
    if (r.ok) {
      setUploadStatus("Saved to Downloads on the phone.", "ok");
      fileInput.value = "";
      onFileChosen();
    } else setUploadStatus(r.message || "Send failed.", "error");
  } catch (_) {
    setUploadStatus("Send failed.", "error");
  } finally {
    btnUpload.textContent = originalLabel;
    btnUpload.disabled = !(fileInput.files && fileInput.files[0]);
  }
};
