const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CHUNK_SIZE = 64 * 1024;
export const WINDOW_SIZE = 12;

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

export function uid(prefix = "") {
  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return prefix ? `${prefix}_${id}` : id;
}

export function loadOrCreate(key, factory) {
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
  } catch {
    /* private mode */
  }
  const value = factory();
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  return value;
}

export function deviceId() {
  return loadOrCreate("relay.deviceId", () => uid("dev").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32));
}

export function detectDevice() {
  const ua = navigator.userAgent;
  let platform = "Desktop";
  if (/iPhone|iPad|iPod/i.test(ua)) platform = "iOS";
  else if (/Android/i.test(ua)) platform = "Android";
  else if (/Win/i.test(ua)) platform = "Windows";
  else if (/Mac/i.test(ua)) platform = "macOS";
  else if (/Linux/i.test(ua)) platform = "Linux";

  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
  else if (/Firefox\//.test(ua)) browser = "Firefox";

  const isPhone = /Mobi|Android|iPhone/i.test(ua);
  const name = isPhone ? `${browser} on ${platform}` : `${browser} · ${platform}`;
  return { name, platform, browser, isPhone };
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatRate(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds === Infinity) return "—";
  if (seconds < 5) return "seconds";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function hueFromId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name) {
  const parts = String(name || "D")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function packMessage(header, payload = new Uint8Array()) {
  const h = encoder.encode(JSON.stringify(header));
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(4 + h.length + body.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(body, 4 + h.length);
  return out;
}

export function unpackMessage(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const header = JSON.parse(decoder.decode(bytes.subarray(4, 4 + headerLen)));
  const payload = bytes.subarray(4 + headerLen);
  return { header, payload };
}

export function rangesFromSet(set) {
  const nums = [...set].sort((a, b) => a - b);
  const ranges = [];
  for (const n of nums) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

export function setFromRanges(ranges) {
  const set = new Set();
  for (const [a, b] of ranges || []) {
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

export function missingIndices(total, received) {
  const missing = [];
  for (let i = 0; i < total; i++) {
    if (!received.has(i)) missing.push(i);
  }
  return missing;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "download";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  }
}

import { isNativeApp, relayOrigin } from "./config.js";

let shareOrigin = location.origin;

export async function loadShareOrigin() {
  const origin = relayOrigin();
  shareOrigin = origin;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return shareOrigin;
  }
  if (isNativeApp() || !/^(localhost|127\.0\.0\.1)$/.test(host)) {
    return shareOrigin;
  }
  try {
    const info = await fetch(`${origin}/api/info`).then((r) => r.json());
    if (info.suggested) shareOrigin = info.suggested.replace(/\/$/, "");
  } catch {
    shareOrigin = origin;
  }
  return shareOrigin;
}

export function shareUrl(roomId) {
  return `${shareOrigin}/r/${roomId}`;
}

export function roomFromLocation() {
  const q = new URLSearchParams(location.search).get("room");
  if (q) return q.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return null;
}

export function on(el, ev, fn, opts) {
  el.addEventListener(ev, fn, opts);
  return () => el.removeEventListener(ev, fn, opts);
}

export function snapshotFiles(list) {
  return [...(list || [])]
    .filter((file) => file && typeof file.size === "number")
    .map(
      (file) =>
        new File([file.slice(0, file.size, file.type || "")], file.name, {
          type: file.type,
          lastModified: file.lastModified,
        })
    );
}

export function filesFromDataTransfer(dt) {
  const fromItems = [];
  for (const item of dt.items || []) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) fromItems.push(file);
    }
  }
  return snapshotFiles(fromItems.length ? fromItems : dt.files);
}
