import {
  $,
  $$,
  copyText,
  detectDevice,
  deviceId,
  formatBytes,
  formatTime,
  initials,
  on,
  roomFromLocation,
  shareUrl,
  loadShareOrigin,
  snapshotFiles,
  filesFromDataTransfer,
} from "./js/utils.js";
import { loadKeyPair, exportPublicKey } from "./js/crypto.js";
import { Signaling } from "./js/signaling.js";
import { Mesh } from "./js/webrtc.js";
import { TransferEngine } from "./js/transfer.js";
import * as idb from "./js/idb.js";
import * as pairs from "./js/pairs.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const state = {
  view: "landing",
  roomId: null,
  you: null,
  peers: [],
  target: "*",
  nearby: [],
  pairedLive: new Set(),
  sendTo: null,
  pairAsks: [],
  history: [],
  toast: null,
};

const keys = loadKeyPair();
const me = { id: deviceId(), ...detectDevice() };
let signaling = null;
let mesh = null;
let engine = null;
let entering = false;
let pendingShare = [];
let deferredInstall = null;

const SHARE_CACHE = "relay-share";

const els = {
  landing: $("#landing"),
  room: $("#room"),
  createBtn: $("#create-room"),
  joinForm: $("#join-form"),
  joinCode: $("#join-code"),
  roomCode: $("#room-code"),
  shareLink: $("#share-link"),
  copyLink: $("#copy-link"),
  copyCode: $("#copy-code"),
  qrImg: $("#qr-img"),
  qrModal: $("#qr-modal"),
  openQr: $("#open-qr"),
  closeQr: $("#close-qr"),
  leave: $("#leave"),
  devices: $("#devices"),
  drop: $("#drop"),
  fileInput: $("#file-input"),
  pickFiles: $("#pick-files"),
  dropTitle: $("#drop-title"),
  dropHint: $("#drop-hint"),
  transfers: $("#transfers"),
  historyList: $("#history-list"),
  historyPanel: $("#history-panel"),
  openHistory: $("#open-history"),
  closeHistory: $("#close-history"),
  clearHistory: $("#clear-history"),
  incoming: $("#incoming"),
  pairAsk: $("#pair-ask"),
  sharePending: $("#share-pending"),
  nearbyOrbit: $("#nearby-orbit"),
  nearbyHint: $("#nearby-hint"),
  remembered: $("#remembered"),
  rememberedEmpty: $("#remembered-empty"),
  toast: $("#toast"),
  statusDot: $("#status-dot"),
  peerCount: $("#peer-count"),
  lanHint: $("#lan-hint"),
  waiting: $("#waiting"),
  ready: $("#ready"),
  qrInline: $("#qr-inline"),
  installApp: $("#install-app"),
  installHint: $("#install-hint"),
  installHintText: $("#install-hint-text"),
  installHintHide: $("#install-hint-hide"),
};

function roomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

function showToast(message, ms = 2400) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function setView(view) {
  state.view = view;
  els.landing.hidden = view !== "landing";
  els.room.hidden = view !== "room";
  document.body.dataset.view = view;
}

function selectedIds() {
  if (state.target === "*" || !state.target) return state.peers.map((p) => p.id);
  if (Array.isArray(state.target)) return state.target.filter((id) => state.peers.some((p) => p.id === id));
  return state.peers.some((p) => p.id === state.target) ? [state.target] : state.peers.map((p) => p.id);
}

function isEveryone() {
  const ids = selectedIds();
  return state.peers.length > 0 && ids.length === state.peers.length;
}

function toggleRecipient(id) {
  if (id === "*") {
    state.target = "*";
  } else if (isEveryone()) {
    state.target = [id];
  } else {
    const set = new Set(selectedIds());
    if (set.has(id)) set.delete(id);
    else set.add(id);
    state.target = set.size === 0 || set.size === state.peers.length ? "*" : [...set];
  }
  renderPeers();
}

function recipientLabel() {
  const n = selectedIds().length;
  if (!n) return "Wait for someone to join";
  if (n === 1 && state.peers.length === 1) return "They will get the files";
  if (isEveryone()) return `Everyone in the room will get the same files · ${n} devices`;
  return `Sending to ${n} device${n === 1 ? "" : "s"}`;
}

function renderPeers() {
  const peers = state.peers;
  const connected = peers.length > 0;
  els.peerCount.textContent = String(peers.length + (state.you ? 1 : 0));
  if (els.waiting) els.waiting.hidden = connected;
  if (els.ready) els.ready.hidden = !connected;
  if (els.openQr) els.openQr.hidden = false;

  const ids = new Set(selectedIds());
  if (state.target !== "*" && ids.size !== (Array.isArray(state.target) ? state.target.length : 1)) {
    state.target = "*";
  }

  els.devices.innerHTML = "";
  if (peers.length >= 2) {
    const everyone = document.createElement("button");
    everyone.type = "button";
    everyone.className = `device ${isEveryone() ? "is-selected" : ""}`;
    everyone.innerHTML = `<div class="avatar">All</div><div class="device-name">Everyone</div>`;
    everyone.addEventListener("click", () => toggleRecipient("*"));
    els.devices.appendChild(everyone);
  }

  const all = state.you ? [state.you, ...peers] : peers;
  for (const peer of all) {
    const mine = peer.id === state.you?.id;
    const selected = !mine && (isEveryone() || ids.has(peer.id));
    const card = document.createElement(mine ? "article" : "button");
    if (!mine) card.type = "button";
    card.className = `device ${mine ? "is-you" : ""} ${selected ? "is-selected" : ""}`;
    card.innerHTML = `
      <div class="avatar">${initials(peer.name)}</div>
      <div class="device-name">${escapeHtml(shortName(peer.name))}${mine ? " <span>you</span>" : ""}</div>
    `;
    if (!mine) card.addEventListener("click", () => toggleRecipient(peer.id));
    els.devices.appendChild(card);
  }

  const more = (engine?.list() || []).some((t) => t.status !== "incoming");
  if (els.dropHint && !more) els.dropHint.textContent = recipientLabel();
  if (pendingShare.length) renderShareBar();
}

function shortName(name) {
  return String(name || "Device").replace(/\s*·\s*.+$/, "");
}

function ensureSession() {
  if (signaling) return;
  signaling = new Signaling();
  mesh = new Mesh({
    signaling,
    localId: me.id,
    onPacket: (from, header, payload, mode) => engine?.onPacket(from, header, payload, mode),
    onMode: () => {
      renderPeers();
      renderHome();
    },
  });
  engine = new TransferEngine({
    mesh,
    signaling,
    keys,
    localId: me.id,
    onChange: () => {
      renderTransfers();
      pingIncomingNotice();
    },
  });
  engine.setPeer({ id: me.id, name: me.name, platform: me.platform, publicKey: exportPublicKey(keys) });

  signaling.on("hello-ok", (msg) => {
    state.you = msg.you;
    mergeNearby(msg.nearby || []);
    state.pairedLive = new Set();
    for (const p of msg.paired || []) {
      engine.setPeer(p);
      state.pairedLive.add(p.id);
    }
    els.statusDot.classList.add("on");
    renderHome();
  });
  signaling.on("nearby-joined", (msg) => {
    if (!msg.peer || msg.peer.id === me.id) return;
    mergeNearby([msg.peer]);
    engine.setPeer(msg.peer);
    renderHome();
  });
  signaling.on("nearby-left", (msg) => {
    state.nearby = state.nearby.filter((p) => p.id !== msg.id);
    if (state.sendTo === msg.id) state.sendTo = null;
    renderHome();
  });
  signaling.on("presence", (msg) => {
    mergeNearby(msg.nearby || []);
    for (const p of msg.paired || []) {
      engine.setPeer(p);
      state.pairedLive.add(p.id);
    }
    renderHome();
  });
  signaling.on("pair-ask", (msg) => {
    if (!msg.peer || state.pairAsks.some((p) => p.id === msg.peer.id)) return;
    engine.setPeer(msg.peer);
    state.pairAsks.push(msg.peer);
    renderPairAsks();
    desktopNotice("Stay connected?", `${shortName(msg.peer.name)} wants to remember this device`);
  });
  signaling.on("paired", (msg) => {
    if (!msg.peer) return;
    engine.setPeer(msg.peer);
    pairs.upsertPair(msg.peer);
    state.pairedLive.add(msg.peer.id);
    state.pairAsks = state.pairAsks.filter((p) => p.id !== msg.peer.id);
    renderPairAsks();
    renderHome();
    showToast(`Remembered ${shortName(msg.peer.name)}`);
  });
  signaling.on("unpaired", (msg) => {
    pairs.removePair(msg.id);
    renderHome();
  });
  signaling.on("paired-online", (msg) => {
    if (msg.peer) {
      engine.setPeer(msg.peer);
      pairs.upsertPair(msg.peer);
      state.pairedLive.add(msg.peer.id);
    }
    renderHome();
  });
  signaling.on("paired-offline", (msg) => {
    state.pairedLive.delete(msg.id);
    renderHome();
  });
  signaling.on("joined", (msg) => {
    state.you = msg.you;
    state.peers = msg.peers || [];
    for (const p of state.peers) {
      engine.setPeer(p);
      mesh.ensure(p.id);
    }
    els.statusDot.classList.add("on");
    renderPeers();
    showToast(`Joined room ${msg.roomId}`);
  });
  signaling.on("peer-joined", (msg) => {
    const peer = msg.peer;
    if (!peer || peer.id === me.id) return;
    state.peers = state.peers.filter((p) => p.id !== peer.id).concat(peer);
    engine.setPeer(peer);
    mesh.ensure(peer.id);
    renderPeers();
    showToast(`${shortName(peer.name)} joined`);
  });
  signaling.on("peer-left", (msg) => {
    state.peers = state.peers.filter((p) => p.id !== msg.id);
    renderPeers();
  });
  signaling.on("error", (msg) => showToast(msg.message || "Connection error"));
  signaling.on("close", () => els.statusDot.classList.remove("on"));
  signaling.on("open", () => els.statusDot.classList.add("on"));
}

function mergeNearby(list) {
  const byId = new Map(state.nearby.map((p) => [p.id, p]));
  for (const p of list) {
    if (p.id !== me.id) {
      byId.set(p.id, p);
      engine?.setPeer(p);
    }
  }
  state.nearby = [...byId.values()];
}

function helloPayload() {
  return {
    deviceId: me.id,
    name: me.name,
    platform: me.platform,
    publicKey: exportPublicKey(keys),
    pairedIds: pairs.pairIds(),
  };
}

async function connectPresence() {
  ensureSession();
  try {
    await signaling.hello(helloPayload());
  } catch {
    showToast("Could not reach the relay server");
  }
}

function askNotify() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") Notification.requestPermission().catch(() => {});
}

function desktopNotice(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!document.hidden) return;
  try {
                new Notification(title, { body, icon: "/icons/icon-192.png" });
  } catch {
    /* ignore */
  }
}

const seenIncoming = new Set();
function pingIncomingNotice() {
  const fresh = (engine?.list() || []).filter((t) => t.status === "incoming" && !seenIncoming.has(t.id));
  for (const tx of fresh) {
    seenIncoming.add(tx.id);
    desktopNotice(
      `${shortName(tx.peerName)} wants to send files`,
      tx.files.map((f) => f.name).join(", ")
    );
    showToast(`${shortName(tx.peerName)} wants to send files`);
  }
}

function renderHome() {
  renderNearby();
  renderRemembered();
  renderShareBar();
}

function renderShareBar() {
  const el = els.sharePending;
  if (!el) return;
  if (!pendingShare.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const names = pendingShare
    .slice(0, 8)
    .map((f) => `<li>${escapeHtml(f.name)} · ${formatBytes(f.size)}</li>`)
    .join("");
  const extra = pendingShare.length > 8 ? `<li>+${pendingShare.length - 8} more</li>` : "";
  const roomSend = state.view === "room" && state.peers.length > 0;
  el.hidden = false;
  el.innerHTML = `
    <div class="incoming-card">
      <div>
        <strong>Ready to send</strong>
        <div class="tx-sub">${
          roomSend
            ? "Tap a device, or send to everyone in this room"
            : "Tap a nearby or remembered device"
        }</div>
        <ul class="incoming-files">${names}${extra}</ul>
      </div>
      <div class="incoming-actions">
        <button class="btn ghost" data-share="cancel" type="button">Cancel</button>
        ${roomSend ? `<button class="btn primary" data-share="room" type="button">Send to room</button>` : ""}
      </div>
    </div>`;
  el.querySelector('[data-share="cancel"]')?.addEventListener("click", () => {
    pendingShare = [];
    renderHome();
  });
  el.querySelector('[data-share="room"]')?.addEventListener("click", () => {
    const files = pendingShare;
    pendingShare = [];
    renderShareBar();
    sendPicked(files);
  });
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIos() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

async function registerPwa() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    /* ignore */
  }
}

function installHintText() {
  if (isIos()) return "Tap Share, then Add to Home Screen.";
  if (/Android/i.test(navigator.userAgent || "")) {
    return "Tap Install, or open the Chrome menu (⋮) and choose Install app.";
  }
  return "Tap Install, or use the install icon in the address bar. In the menu: Install Relay / Apps → Install this site as an app.";
}

function showInstallHint() {
  if (!els.installHint) return;
  if (els.installHintText) els.installHintText.textContent = installHintText();
  els.installHint.hidden = false;
}

function hideInstallUi() {
  if (els.installApp) els.installApp.hidden = true;
  if (els.installHint) els.installHint.hidden = true;
}

function wireInstall() {
  const btn = els.installApp;
  if (isStandalone()) {
    hideInstallUi();
    return;
  }
  if (btn) btn.hidden = false;
  on(window, "beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (btn) btn.hidden = false;
  });
  on(window, "appinstalled", () => {
    deferredInstall = null;
    hideInstallUi();
    showToast("Relay is installed");
  });
  if (btn) {
    on(btn, "click", async () => {
      if (deferredInstall) {
        deferredInstall.prompt();
        const choice = await deferredInstall.userChoice.catch(() => null);
        deferredInstall = null;
        if (choice?.outcome === "accepted") hideInstallUi();
        else showInstallHint();
        return;
      }
      showInstallHint();
    });
  }
  if (isIos()) showInstallHint();
  on(els.installHintHide, "click", () => {
    if (els.installHint) els.installHint.hidden = true;
  });
}

async function takeSharedFiles() {
  const wanted = new URLSearchParams(location.search).has("share");
  const read = async () => {
    try {
      const cache = await caches.open(SHARE_CACHE);
      const indexRes = await cache.match("/__share/index.json");
      if (!indexRes) return [];
      const index = await indexRes.json();
      const files = [];
      for (const item of index) {
        const res = await cache.match(item.path);
        if (!res) continue;
        const blob = await res.blob();
        files.push(new File([blob], item.name, { type: item.type || blob.type || "" }));
      }
      await caches.delete(SHARE_CACHE);
      return files;
    } catch {
      return [];
    }
  };
  let files = await read();
  if (files.length || !wanted) return files;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 60));
    files = await read();
    if (files.length) return files;
  }
  return [];
}

function stripShareParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has("share")) return;
  url.searchParams.delete("share");
  const q = url.searchParams.toString();
  history.replaceState({}, "", `${url.pathname}${q ? `?${q}` : ""}${url.hash}`);
}

function renderNearby() {
  const nodes = state.nearby.filter((p) => !pairs.isPaired(p.id));
  const orbit = els.nearbyOrbit;
  if (!orbit) return;
  orbit.innerHTML = "";
  if (els.nearbyHint) {
    els.nearbyHint.textContent = nodes.length
      ? pendingShare.length
        ? "Tap a device to send the shared files."
        : "Tap a device to send. Use Remember to stay connected."
      : "Looking for devices on this Wi‑Fi… Keep Relay open on the other phone.";
  }
  nodes.forEach((peer, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(nodes.length, 1) - Math.PI / 2;
    const r = 38;
    const x = 50 + r * Math.cos(angle);
    const y = 50 + r * Math.sin(angle);
    const wrap = document.createElement("div");
    wrap.className = `radar-node ${state.sendTo === peer.id ? "is-selected" : ""}`;
    wrap.style.left = `${x}%`;
    wrap.style.top = `${y}%`;
    wrap.innerHTML = `
      <button type="button" class="radar-send">
        <div class="avatar">${initials(peer.name)}</div>
        <span>${escapeHtml(shortName(peer.name))}</span>
      </button>
      <button type="button" class="pin">Remember</button>
    `;
    wrap.querySelector(".radar-send").addEventListener("click", () => pickDevice(peer));
    wrap.querySelector(".pin").addEventListener("click", () => rememberDevice(peer));
    orbit.appendChild(wrap);
  });
}

function renderRemembered() {
  const saved = pairs.listPairs();
  if (els.rememberedEmpty) els.rememberedEmpty.hidden = saved.length > 0;
  if (!els.remembered) return;
  els.remembered.innerHTML = "";
  for (const peer of saved) {
    const live = state.nearby.find((p) => p.id === peer.id);
    const on = Boolean(live) || state.pairedLive.has(peer.id);
    const card = document.createElement("article");
    card.className = `remember-card ${on ? "online" : "offline"} ${state.sendTo === peer.id ? "is-selected" : ""}`;
    card.innerHTML = `
      <button type="button" class="remember-main">
        <div class="avatar">${initials(peer.name)}</div>
        <div>
          <div class="device-name">${escapeHtml(shortName(peer.name))}</div>
          <div class="tx-sub">${on ? "Online — tap to send" : "Offline"}</div>
        </div>
      </button>
      <button type="button" class="text-btn forget">Forget</button>
    `;
    card.querySelector(".remember-main").addEventListener("click", () => {
      if (!on) {
        showToast("Open Relay on that device first");
        return;
      }
      pickDevice(live || peer);
    });
    card.querySelector(".forget").addEventListener("click", () => forgetDevice(peer.id));
    els.remembered.appendChild(card);
  }
}

function pickDevice(peer) {
  if (!peer?.id) return;
  engine.setPeer(peer);
  state.sendTo = peer.id;
  askNotify();
  renderHome();
  if (pendingShare.length) {
    const files = pendingShare;
    pendingShare = [];
    renderShareBar();
    sendPicked(files);
    return;
  }
  els.fileInput.click();
}

function rememberDevice(peer) {
  if (!peer?.id) return;
  engine.setPeer(peer);
  askNotify();
  signaling.send({ type: "pair-ask", to: peer.id });
  showToast(`Asked ${shortName(peer.name)} to stay connected`);
}

function acceptPair(peer) {
  signaling.send({ type: "pair-ok", to: peer.id });
  pairs.upsertPair(peer);
  state.pairAsks = state.pairAsks.filter((p) => p.id !== peer.id);
  renderPairAsks();
  renderHome();
}

function forgetDevice(id) {
  pairs.removePair(id);
  signaling?.send({ type: "pair-forget", to: id });
  if (state.sendTo === id) state.sendTo = null;
  renderHome();
  showToast("Disconnected");
}

function renderPairAsks() {
  if (!els.pairAsk) return;
  if (!state.pairAsks.length) {
    els.pairAsk.hidden = true;
    els.pairAsk.innerHTML = "";
    return;
  }
  els.pairAsk.hidden = false;
  els.pairAsk.innerHTML = state.pairAsks
    .map(
      (peer) => `
      <div class="incoming-card">
        <div>
          <strong>${escapeHtml(shortName(peer.name))}</strong> wants to stay connected
          <div class="incoming-files">You can send files anytime without a room.</div>
        </div>
        <div class="incoming-actions">
          <button class="btn ghost" data-act="pair-no" data-id="${peer.id}">Not now</button>
          <button class="btn primary" data-act="pair-yes" data-id="${peer.id}">Remember</button>
        </div>
      </div>`
    )
    .join("");
  for (const btn of $$("[data-act]", els.pairAsk)) {
    btn.addEventListener("click", () => {
      const peer = state.pairAsks.find((p) => p.id === btn.dataset.id);
      if (btn.dataset.act === "pair-yes" && peer) acceptPair(peer);
      if (btn.dataset.act === "pair-no") {
        state.pairAsks = state.pairAsks.filter((p) => p.id !== btn.dataset.id);
        renderPairAsks();
      }
    });
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTransfers() {
  const items = engine?.list() || [];
  const active = items.filter((t) => t.status !== "incoming");
  const groups = [];
  const seen = new Set();
  for (const tx of active) {
    const key = tx.direction === "send" && tx.groupId ? tx.groupId : tx.id;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(active.filter((t) => (t.groupId && t.groupId === key) || t.id === key));
  }
  els.transfers.innerHTML = groups.map(transferCard).join("");
  renderIncoming(items.filter((t) => t.status === "incoming"));
  const more = active.length > 0;
  els.drop?.classList.toggle("compact", more);
  if (els.dropTitle) els.dropTitle.textContent = more ? "Send more files" : "Drop files here";
  if (els.dropHint) {
    els.dropHint.textContent = more
      ? `${recipientLabel()} · add another batch anytime`
      : recipientLabel();
  }
  if (els.pickFiles) els.pickFiles.textContent = more ? "Send more files" : "Choose files";

  for (const btn of $$("[data-act]", els.transfers)) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const ids = (btn.dataset.ids || id || "").split(",").filter(Boolean);
      if (act === "pause") ids.forEach((i) => engine.pause(i));
      if (act === "resume") ids.forEach((i) => engine.resume(i));
      if (act === "cancel") ids.forEach((i) => engine.cancel(i));
      if (act === "reject") engine.reject(id);
      if (act === "save") engine.saveFile(id, btn.dataset.file);
      if (act === "save-all") engine.saveAll(id);
    });
  }
}

function filePct(tx, file) {
  if (file.done || tx.status === "completed") return 100;
  const set = tx.direction === "send" ? tx.acked?.get(file.id) : tx.received?.get(file.id);
  if (!file.totalChunks) return 0;
  return Math.min(100, Math.round(((set?.size || 0) / file.totalChunks) * 100));
}

function statusText(tx) {
  const pct = tx.totalBytes ? Math.min(100, Math.round((tx.bytes / tx.totalBytes) * 100)) : 0;
  if (tx.status === "completed") return "Done";
  if (tx.status === "failed") return "Failed";
  if (tx.status === "paused") return "Paused";
  if (tx.status === "offering") return "Waiting";
  if (tx.status === "rejected") return "Declined";
  if (tx.status === "cancelled") return "Cancelled";
  return `${pct}%`;
}

function transferCard(group) {
  const list = Array.isArray(group) ? group : [group];
  const tx = list[0];
  const many = list.length > 1;
  const bytes = list.reduce((s, t) => s + t.bytes, 0);
  const total = list.reduce((s, t) => s + t.totalBytes, 0);
  const pct = total ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
  const allDone = list.every((t) => t.status === "completed");
  const dir = tx.direction === "send" ? "Sending" : "Receiving";
  const who = many
    ? `to ${list.length} devices`
    : tx.direction === "send"
      ? `to ${escapeHtml(shortName(tx.peerName))}`
      : `from ${escapeHtml(shortName(tx.peerName))}`;
  const actions = actionsFor(list);
  const fileRows = tx.files
    .map((file) => {
      const fp = filePct(tx, file);
      return `<li class="tx-file">
        <span class="tx-file-name">${escapeHtml(file.name)}</span>
        <span class="tx-file-meta">${formatBytes(file.size)} · ${file.done || tx.status === "completed" ? "Done" : `${fp}%`}</span>
      </li>`;
    })
    .join("");
  const people = many
    ? `<ul class="tx-people">${list
        .map(
          (t) =>
            `<li><span>${escapeHtml(shortName(t.peerName))}</span><span>${statusText(t)}</span></li>`
        )
        .join("")}</ul>`
    : "";
  return `
    <article class="tx status-${allDone ? "completed" : tx.status}">
      <div class="tx-top">
        <div>
          <div class="tx-name">${tx.files.length} file${tx.files.length === 1 ? "" : "s"} ${who}</div>
          <div class="tx-sub">${dir} · ${formatBytes(tx.totalBytes)}</div>
        </div>
        <div class="tx-pct">${allDone ? "Done" : many ? `${pct}%` : statusText(tx)}</div>
      </div>
      <div class="bar"><i style="width:${allDone ? 100 : pct}%"></i></div>
      <ul class="tx-files">${fileRows}</ul>
      ${people}
      ${actions ? `<div class="tx-foot"><span class="tx-actions">${actions}</span></div>` : ""}
      ${list
        .filter((t) => t.error)
        .map((t) => `<div class="tx-error">${escapeHtml(shortName(t.peerName))}: ${escapeHtml(t.error)}</div>`)
        .join("")}
    </article>
  `;
}

function actionsFor(list) {
  const txs = Array.isArray(list) ? list : [list];
  const tx = txs[0];
  const ids = txs.map((t) => t.id).join(",");
  const id = `data-id="${tx.id}" data-ids="${ids}"`;
  const ready = tx.direction === "receive" ? tx.files.filter((f) => f.blob) : [];
  const save =
    ready.length > 1
      ? `<button class="btn primary" data-act="save-all" ${id}>Save all</button>`
      : ready.length === 1
        ? `<button class="btn primary" data-act="save" ${id} data-file="${ready[0].id}">Save</button>`
        : "";
  const anyTransfer = txs.some((t) => t.status === "transferring");
  const anyPaused = txs.some((t) => t.status === "paused");
  const anyOffer = txs.some((t) => t.status === "offering");
  if (anyTransfer) {
    return `${save}<button class="text-btn" data-act="pause" ${id}>Pause</button><button class="text-btn" data-act="cancel" ${id}>Cancel</button>`;
  }
  if (anyPaused) {
    return `${save}<button class="text-btn" data-act="resume" ${id}>Resume</button><button class="text-btn" data-act="cancel" ${id}>Cancel</button>`;
  }
  if (anyOffer) {
    return `<button class="text-btn" data-act="cancel" ${id}>Cancel</button>`;
  }
  if (save) return save;
  return "";
}

function renderIncoming(items) {
  if (!items.length) {
    els.incoming.hidden = true;
    els.incoming.innerHTML = "";
    return;
  }
  els.incoming.hidden = false;
  els.incoming.innerHTML = items
    .map((tx) => {
      const names = tx.files
        .map((f) => `<li>${escapeHtml(f.name)} · ${formatBytes(f.size)}</li>`)
        .join("");
      return `
        <div class="incoming-card">
          <div>
            <strong>${escapeHtml(shortName(tx.peerName))}</strong> wants to send ${tx.files.length} file${tx.files.length === 1 ? "" : "s"}
            <ul class="incoming-files">${names}</ul>
          </div>
          <div class="incoming-actions">
            <button class="btn ghost" data-act="reject" data-id="${tx.id}">Decline</button>
            <button class="btn ghost" data-act="remember-accept" data-id="${tx.id}">Accept & remember</button>
            <button class="btn primary" data-act="accept" data-id="${tx.id}">Accept</button>
          </div>
        </div>`;
    })
    .join("");
  for (const btn of $$("[data-act]", els.incoming)) {
    btn.addEventListener("click", () => {
      if (btn.dataset.act === "accept") engine.accept(btn.dataset.id);
      if (btn.dataset.act === "reject") engine.reject(btn.dataset.id);
      if (btn.dataset.act === "remember-accept") {
        const tx = engine.get(btn.dataset.id);
        if (tx) {
          const peer = engine.peers.get(tx.from) || { id: tx.from, name: tx.peerName };
          rememberDevice(peer);
          engine.accept(btn.dataset.id);
        }
      }
    });
  }
}

async function renderHistory() {
  state.history = await idb.historyList();
  if (!state.history.length) {
    els.historyList.innerHTML = `<p class="empty-transfers">No transfers yet.</p>`;
    return;
  }
  els.historyList.innerHTML = state.history
    .map((h) => {
      const names = (h.names || [h.name]).filter(Boolean).join(", ");
      return `
        <article class="hist">
          <div class="hist-dir ${h.direction}">${h.direction === "sent" ? "↑" : "↓"}</div>
          <div>
            <div class="tx-name">${escapeHtml(names)}</div>
            <div class="tx-sub">${escapeHtml(shortName(h.peerName || ""))} · ${formatBytes(h.size || 0)} · ${formatTime(h.createdAt)}</div>
          </div>
        </article>`;
    })
    .join("");
}

function bindRoomUi(roomId) {
  const url = shareUrl(roomId);
  els.roomCode.textContent = roomId;
  els.shareLink.value = url;
  const qrSrc = `/api/qr?text=${encodeURIComponent(url)}`;
  els.qrImg.src = qrSrc;
  els.qrImg.alt = `QR code for room ${roomId}`;
  if (els.qrInline) {
    els.qrInline.src = qrSrc;
    els.qrInline.alt = `Scan to join room ${roomId}`;
  }
  if (els.lanHint) {
    els.lanHint.hidden = !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  }
}

async function enterRoom(roomId) {
  roomId = roomId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (roomId.length < 4) {
    showToast("Enter a valid room code");
    return;
  }
  if (entering) return;
  entering = true;

  ensureSession();
  setView("room");
  state.roomId = roomId;
  state.peers = [];
  bindRoomUi(roomId);
  history.replaceState({}, "", `/?room=${roomId}`);

  try {
    await signaling.join({
      roomId,
      deviceId: me.id,
      name: me.name,
      platform: me.platform,
      publicKey: exportPublicKey(keys),
    });
  } catch {
    showToast("Could not reach the relay server");
    leaveRoom();
    entering = false;
    return;
  }

  renderPeers();
  renderTransfers();
  renderShareBar();
  entering = false;
}

function leaveRoom() {
  signaling?.leaveRoom();
  state.roomId = null;
  state.peers = [];
  setView("landing");
  history.replaceState({}, "", "/");
  els.joinCode.value = "";
  renderHome();
}

async function sendPicked(files) {
  if (!files?.length) return;
  if (state.view !== "room" && state.sendTo) {
    const peer = engine.peers.get(state.sendTo) || state.nearby.find((p) => p.id === state.sendTo) || pairs.getPair(state.sendTo);
    if (peer) engine.setPeer(peer);
    await engine.sendFiles(files, [state.sendTo]);
    showToast(`Sent to ${shortName(peer?.name || "device")} — they need to accept`);
    askNotify();
    return;
  }
  if (!state.peers.length) {
    showToast("Pick a nearby device, or wait for someone to join a room");
    return;
  }
  const targets = selectedIds();
  if (!targets.length) {
    showToast("Wait for another device to join");
    return;
  }
  await engine.sendFiles(files, targets);
  const n = targets.length;
  showToast(
    n > 1
      ? `Sending ${files.length} file${files.length > 1 ? "s" : ""} to ${n} devices`
      : `Offering ${files.length} file${files.length > 1 ? "s" : ""}`
  );
}

function wireEvents() {
  on(els.createBtn, "click", () => enterRoom(roomCode()));
  on(els.joinForm, "submit", (e) => {
    e.preventDefault();
    enterRoom(els.joinCode.value);
  });
  on(els.joinCode, "input", () => {
    els.joinCode.value = els.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (els.joinCode.value.length === 6) els.joinForm.requestSubmit();
  });
  on(els.leave, "click", leaveRoom);
  on(els.copyCode, "click", async () => {
    if (state.roomId && (await copyText(state.roomId))) showToast("Room code copied");
  });
  on(els.copyLink, "click", async () => {
    if (state.roomId && (await copyText(shareUrl(state.roomId)))) showToast("Link copied");
  });
  on(els.openQr, "click", () => {
    els.qrModal.hidden = false;
  });
  on(els.closeQr, "click", () => {
    els.qrModal.hidden = true;
  });
  on(els.qrModal, "click", (e) => {
    if (e.target === els.qrModal) els.qrModal.hidden = true;
  });
  on(els.openHistory, "click", async () => {
    els.historyPanel.classList.add("open");
    await renderHistory();
  });
  on(els.closeHistory, "click", () => els.historyPanel.classList.remove("open"));
  on(els.clearHistory, "click", async () => {
    await idb.historyClear();
    await renderHistory();
  });
  on(els.pickFiles, "click", () => els.fileInput.click());
  on(els.fileInput, "change", () => {
    const files = snapshotFiles(els.fileInput.files);
    els.fileInput.value = "";
    sendPicked(files);
  });
  on(els.drop, "click", (e) => {
    if (e.target.closest("button, select, a")) return;
    els.fileInput.click();
  });
  on(els.drop, "dragover", (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  });
  on(els.drop, "dragleave", () => els.drop.classList.remove("over"));
  on(els.drop, "drop", (e) => {
    e.preventDefault();
    els.drop.classList.remove("over");
    sendPicked(filesFromDataTransfer(e.dataTransfer));
  });
  on(document, "paste", (e) => {
    if (state.view !== "room" && !state.sendTo) return;
    const files = snapshotFiles(e.clipboardData?.files || []);
    if (files.length) sendPicked(files);
  });
  on(document, "keydown", (e) => {
    if (e.key === "Escape") {
      els.qrModal.hidden = true;
      els.historyPanel.classList.remove("open");
    }
  });
}

async function boot() {
  wireEvents();
  wireInstall();
  await registerPwa();
  await loadShareOrigin();
  await renderHistory();
  renderHome();
  const shared = await takeSharedFiles();
  stripShareParam();
  if (shared.length) {
    pendingShare = shared;
    renderShareBar();
    showToast(`${shared.length} file${shared.length === 1 ? "" : "s"} ready — tap a device`);
  }
  await connectPresence();
  const existing = roomFromLocation();
  if (existing) enterRoom(existing);
}

boot();
