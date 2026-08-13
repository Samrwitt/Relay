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

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const state = {
  view: "landing",
  roomId: null,
  you: null,
  peers: [],
  target: "*",
  history: [],
  toast: null,
};

const keys = loadKeyPair();
const me = { id: deviceId(), ...detectDevice() };
let signaling = null;
let mesh = null;
let engine = null;
let entering = false;

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
  target: $("#target"),
  transfers: $("#transfers"),
  historyList: $("#history-list"),
  historyPanel: $("#history-panel"),
  openHistory: $("#open-history"),
  closeHistory: $("#close-history"),
  clearHistory: $("#clear-history"),
  incoming: $("#incoming"),
  toast: $("#toast"),
  statusDot: $("#status-dot"),
  peerCount: $("#peer-count"),
  lanHint: $("#lan-hint"),
  waiting: $("#waiting"),
  ready: $("#ready"),
  qrInline: $("#qr-inline"),
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

function renderPeers() {
  const peers = state.peers;
  const connected = peers.length > 0;
  els.peerCount.textContent = String(peers.length + (state.you ? 1 : 0));
  if (els.waiting) els.waiting.hidden = connected;
  if (els.ready) els.ready.hidden = !connected;
  if (els.openQr) els.openQr.hidden = !connected;

  els.devices.innerHTML = "";
  const all = state.you ? [state.you, ...peers] : peers;
  for (const peer of all) {
    const mine = peer.id === state.you?.id;
    const card = document.createElement("article");
    card.className = `device ${mine ? "is-you" : ""}`;
    card.innerHTML = `
      <div class="avatar">${initials(peer.name)}</div>
      <div class="device-name">${escapeHtml(shortName(peer.name))}${mine ? " <span>you</span>" : ""}</div>
    `;
    els.devices.appendChild(card);
  }

  const select = els.target;
  const prev = select.value || state.target;
  select.innerHTML = `<option value="*">Everyone</option>`;
  for (const peer of peers) {
    const opt = document.createElement("option");
    opt.value = peer.id;
    opt.textContent = shortName(peer.name);
    select.appendChild(opt);
  }
  select.hidden = peers.length < 2;
  select.value = [...select.options].some((o) => o.value === prev) ? prev : "*";
  state.target = select.value;
}

function shortName(name) {
  return String(name || "Device").replace(/\s*·\s*.+$/, "");
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
  els.transfers.innerHTML = active.map(transferCard).join("");
  renderIncoming(items.filter((t) => t.status === "incoming"));

  for (const btn of $$("[data-act]", els.transfers)) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "pause") engine.pause(id);
      if (act === "resume") engine.resume(id);
      if (act === "cancel") engine.cancel(id);
      if (act === "reject") engine.reject(id);
      if (act === "save") engine.saveFile(id, btn.dataset.file);
    });
  }
}

function filePct(tx, file) {
  if (file.done || tx.status === "completed") return 100;
  const set = tx.direction === "send" ? tx.acked?.get(file.id) : tx.received?.get(file.id);
  if (!file.totalChunks) return 0;
  return Math.min(100, Math.round(((set?.size || 0) / file.totalChunks) * 100));
}

function transferCard(tx) {
  const pct = tx.totalBytes ? Math.min(100, Math.round((tx.bytes / tx.totalBytes) * 100)) : 0;
  const dir = tx.direction === "send" ? "Sending" : "Receiving";
  const actions = actionsFor(tx);
  const label =
    tx.status === "completed"
      ? "Done"
      : tx.status === "failed"
        ? "Failed"
        : tx.status === "paused"
          ? "Paused"
          : tx.status === "offering"
            ? "Waiting"
            : tx.status === "rejected"
              ? "Declined"
              : tx.status === "cancelled"
                ? "Cancelled"
                : `${pct}%`;
  const fileRows = tx.files
    .map((file) => {
      const fp = filePct(tx, file);
      const save =
        file.blob && tx.direction === "receive"
          ? `<button class="text-btn" data-act="save" data-id="${tx.id}" data-file="${file.id}">Save</button>`
          : "";
      return `<li class="tx-file">
        <span class="tx-file-name">${escapeHtml(file.name)}</span>
        <span class="tx-file-meta">${formatBytes(file.size)} · ${file.done || tx.status === "completed" ? "Done" : `${fp}%`}${save}</span>
      </li>`;
    })
    .join("");
  return `
    <article class="tx status-${tx.status}">
      <div class="tx-top">
        <div>
          <div class="tx-name">${tx.files.length} file${tx.files.length === 1 ? "" : "s"}</div>
          <div class="tx-sub">${dir} · ${formatBytes(tx.totalBytes)}</div>
        </div>
        <div class="tx-pct">${label}</div>
      </div>
      <div class="bar"><i style="width:${tx.status === "completed" ? 100 : pct}%"></i></div>
      <ul class="tx-files">${fileRows}</ul>
      ${actions ? `<div class="tx-foot"><span class="tx-actions">${actions}</span></div>` : ""}
      ${tx.error ? `<div class="tx-error">${escapeHtml(tx.error)}</div>` : ""}
    </article>
  `;
}

function actionsFor(tx) {
  const id = `data-id="${tx.id}"`;
  if (tx.status === "transferring") {
    return `<button class="text-btn" data-act="pause" ${id}>Pause</button><button class="text-btn" data-act="cancel" ${id}>Cancel</button>`;
  }
  if (tx.status === "paused") {
    return `<button class="text-btn" data-act="resume" ${id}>Resume</button><button class="text-btn" data-act="cancel" ${id}>Cancel</button>`;
  }
  if (tx.status === "offering") {
    return `<button class="text-btn" data-act="cancel" ${id}>Cancel</button>`;
  }
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
            <button class="btn primary" data-act="accept" data-id="${tx.id}">Accept</button>
          </div>
        </div>`;
    })
    .join("");
  for (const btn of $$("[data-act]", els.incoming)) {
    btn.addEventListener("click", () => {
      if (btn.dataset.act === "accept") engine.accept(btn.dataset.id);
      if (btn.dataset.act === "reject") engine.reject(btn.dataset.id);
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

  teardownSession();
  setView("room");
  state.roomId = roomId;
  state.peers = [];
  bindRoomUi(roomId);
  history.replaceState({}, "", `/?room=${roomId}`);

  signaling = new Signaling();
  mesh = new Mesh({
    signaling,
    localId: me.id,
    onPacket: (from, header, payload, mode) => engine?.onPacket(from, header, payload, mode),
    onMode: () => renderPeers(),
  });

  engine = new TransferEngine({
    mesh,
    signaling,
    keys,
    localId: me.id,
    onChange: () => renderTransfers(),
  });

  signaling.on("joined", (msg) => {
    state.you = msg.you;
    state.peers = msg.peers || [];
    for (const p of state.peers) {
      engine.setPeer(p);
      mesh.ensure(p.id);
    }
    engine.setPeer(state.you);
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
    showToast(`${peer.name} joined`);
  });

  signaling.on("peer-left", (msg) => {
    state.peers = state.peers.filter((p) => p.id !== msg.id);
    engine.removePeer(msg.id);
    mesh.drop(msg.id);
    renderPeers();
  });

  signaling.on("error", (msg) => {
    showToast(msg.message || "Room error");
  });

  signaling.on("close", () => els.statusDot.classList.remove("on"));
  signaling.on("open", () => {
    if (state.view === "room") els.statusDot.classList.add("on");
  });

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
  entering = false;
}

function teardownSession() {
  signaling?.close();
  signaling = null;
  mesh?.close();
  mesh = null;
  engine = null;
  state.you = null;
  state.peers = [];
  els.statusDot.classList.remove("on");
}

function leaveRoom() {
  teardownSession();
  state.roomId = null;
  setView("landing");
  history.replaceState({}, "", "/");
  els.joinCode.value = "";
}

async function sendPicked(files) {
  if (!files?.length) return;
  if (!state.peers.length) {
    showToast("Wait for another device to join");
    return;
  }
  const targets = state.target === "*" ? state.peers.map((p) => p.id) : [state.target];
  await engine.sendFiles(files, targets);
  showToast(`Offering ${files.length} file${files.length > 1 ? "s" : ""}`);
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
  on(els.target, "change", () => {
    state.target = els.target.value;
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
    if (state.view !== "room") return;
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
  await loadShareOrigin();
  await renderHistory();
  const existing = roomFromLocation();
  if (existing) enterRoom(existing);
}

boot();
