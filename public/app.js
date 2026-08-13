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
  dropTitle: $("#drop-title"),
  dropHint: $("#drop-hint"),
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
