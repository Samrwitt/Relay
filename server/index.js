import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { loadTls } from "./tls.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 3478;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3080;
let listenPort = PORT;
const HOST = process.env.HOST || "0.0.0.0";
const HOSTED = Boolean(
  process.env.RENDER ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.FLY_APP_NAME ||
    process.env.K_SERVICE ||
    process.env.RELAY_HTTP === "1" ||
    (process.env.NODE_ENV === "production" && process.env.RELAY_TLS !== "1")
);
const SCHEME = "https";
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_PEERS = 8;
const MAX_TEXT = 64 * 1024;
const MAX_BINARY = 512 * 1024;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();

function randomCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

function publicUrls(port) {
  const urls = [`${SCHEME}://localhost:${port}`];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`${SCHEME}://${net.address}:${port}`);
      }
    }
  }
  return [...new Set(urls)];
}

function peerView(peer) {
  return {
    id: peer.id,
    name: peer.name,
    platform: peer.platform,
    publicKey: peer.publicKey,
    joinedAt: peer.joinedAt,
  };
}

function getRoom(id) {
  return rooms.get(id.toUpperCase());
}

function destroyRoom(id) {
  rooms.delete(id);
}

function sweepRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.peers.size === 0 && now - room.createdAt > ROOM_TTL_MS) {
      destroyRoom(id);
    }
  }
}

setInterval(sweepRooms, 60_000).unref();

class Room {
  constructor(id) {
    this.id = id;
    this.createdAt = Date.now();
    this.peers = new Map();
  }

  add(peer) {
    this.peers.set(peer.id, peer);
  }

  remove(id) {
    this.peers.delete(id);
  }

  others(exceptId) {
    return [...this.peers.values()]
      .filter((p) => p.id !== exceptId)
      .map(peerView);
  }

  send(id, msg) {
    const peer = this.peers.get(id);
    if (peer?.ws.readyState === 1) {
      peer.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
  }

  sendBinary(id, buf) {
    const peer = this.peers.get(id);
    if (peer?.ws.readyState === 1) peer.ws.send(buf);
  }

  broadcast(exceptId, msg) {
    for (const peer of this.peers.values()) {
      if (peer.id !== exceptId && peer.ws.readyState === 1) {
        peer.ws.send(JSON.stringify(msg));
      }
    }
  }
}

const app = express();
app.disable("x-powered-by");
if (HOSTED) app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));
app.get("/vendor/nacl-fast.min.js", (_req, res) => {
  res.sendFile(path.join(ROOT, "node_modules/tweetnacl/nacl-fast.min.js"));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() });
});

app.get("/api/info", (req, res) => {
  const host = req.headers.host || `localhost:${listenPort}`;
  const proto = String(req.headers["x-forwarded-proto"] || (HOSTED ? "https" : "https")).split(",")[0];
  const publicUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
  const urls = HOSTED ? [publicUrl] : publicUrls(listenPort);
  res.json({
    port: listenPort,
    urls,
    suggested:
      HOSTED
        ? publicUrl
        : urls.find((u) => !u.includes("localhost") && !u.includes("127.0.0.1")) || publicUrl,
  });
});

app.post("/api/rooms", (_req, res) => {
  let id = randomCode();
  while (rooms.has(id)) id = randomCode();
  rooms.set(id, new Room(id));
  res.json({ id });
});

app.get("/api/rooms/:id", (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({
    id: room.id,
    peers: [...room.peers.values()].map(peerView),
  });
});

app.get("/api/qr", async (req, res) => {
  const text = String(req.query.text || "").slice(0, 2048);
  if (!text) return res.status(400).json({ error: "Missing text" });
  try {
    const png = await QRCode.toBuffer(text, {
      type: "png",
      width: 512,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/r/:id", (req, res) => {
  res.redirect(`/?room=${encodeURIComponent(req.params.id.toUpperCase())}`);
});

const tls = HOSTED ? null : loadTls();
const server = HOSTED
  ? http.createServer(app)
  : https.createServer({ key: tls.key, cert: tls.cert }, app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("error", (err) => {
  if (err.code !== "EADDRINUSE") console.warn("WebSocket:", err.message);
});

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws, req) => {
  const ctx = { roomId: null, deviceId: null, ip: clientIp(req), ws };

  ws.on("message", (raw, isBinary) => {
    try {
      if (isBinary) {
        handleBinary(ws, ctx, raw);
        return;
      }
      const text = raw.toString();
      if (text.length > MAX_TEXT) return;
      const msg = JSON.parse(text);
      handleText(ws, ctx, msg);
    } catch {
      send(ws, { type: "error", message: "Bad message" });
    }
  });

  ws.on("close", () => disconnect(ctx));
  ws.on("error", () => disconnect(ctx));
});

const devices = new Map();

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim().replace(/^::ffff:/, "");
  return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "") || "unknown";
}

function netKey(ip) {
  const parts = String(ip).split(".");
  if (parts.length === 4) return parts.slice(0, 3).join(".");
  return ip || "unknown";
}

function presenceView(d) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    publicKey: d.publicKey,
    online: true,
  };
}

function getDevice(id) {
  return devices.get(id);
}

function canRoute(fromId, toId) {
  const a = getDevice(fromId);
  const b = getDevice(toId);
  if (!a || !b) return false;
  if (a.roomId && a.roomId === b.roomId) return true;
  if (a.paired.has(toId) && b.paired.has(fromId)) return true;
  if (a.net && a.net === b.net) return true;
  if (!HOSTED) return true;
  return false;
}

function sendDevice(id, msg) {
  const d = getDevice(id);
  if (d?.ws.readyState === 1) d.ws.send(JSON.stringify(msg));
}

function nearbyList(id) {
  const me = getDevice(id);
  if (!me) return [];
  return [...devices.values()]
    .filter((d) => d.id !== id && (d.net === me.net || !HOSTED))
    .map(presenceView);
}

function pairedOnline(id) {
  const me = getDevice(id);
  if (!me) return [];
  return [...me.paired]
    .map((pid) => getDevice(pid))
    .filter(Boolean)
    .map(presenceView);
}

function pushPresence(id) {
  const me = getDevice(id);
  if (!me) return;
  sendDevice(id, {
    type: "presence",
    nearby: nearbyList(id),
    paired: pairedOnline(id),
  });
}

function notifyNet(net, exceptId, msg) {
  for (const d of devices.values()) {
    const same = d.net === net || !HOSTED;
    if (same && d.id !== exceptId && d.ws.readyState === 1) {
      d.ws.send(JSON.stringify(msg));
    }
  }
}

function disconnect(ctx) {
  leaveRoom(ctx);
  if (!ctx.deviceId) return;
  const d = getDevice(ctx.deviceId);
  if (d && d.ws === ctx.ws) {
    const net = d.net;
    const paired = [...d.paired];
    devices.delete(ctx.deviceId);
    notifyNet(net, ctx.deviceId, { type: "nearby-left", id: ctx.deviceId });
    for (const pid of paired) {
      sendDevice(pid, { type: "paired-offline", id: ctx.deviceId });
    }
  }
  ctx.deviceId = null;
}

function leaveRoom(ctx) {
  if (!ctx.roomId || !ctx.deviceId) return;
  const room = getRoom(ctx.roomId);
  const d = getDevice(ctx.deviceId);
  if (d) d.roomId = null;
  if (room) {
    room.remove(ctx.deviceId);
    room.broadcast(ctx.deviceId, { type: "peer-left", id: ctx.deviceId });
    if (room.peers.size === 0) destroyRoom(room.id);
  }
  ctx.roomId = null;
}

function handleText(ws, ctx, msg) {
  switch (msg.type) {
    case "hello":
      return onHello(ws, ctx, msg);
    case "join":
      return onJoin(ws, ctx, msg);
    case "leave-room":
      return leaveRoom(ctx);
    case "pair-ask":
      return onPairAsk(ctx, msg);
    case "pair-ok":
      return onPairOk(ctx, msg);
    case "pair-forget":
      return onPairForget(ctx, msg);
    case "signal":
      return onSignal(ctx, msg);
    case "control":
      return onControl(ctx, msg);
    case "ping":
      return send(ws, { type: "pong", t: Date.now() });
    default:
      send(ws, { type: "error", message: "Unknown message" });
  }
}

function onHello(ws, ctx, msg) {
  const id = String(msg.deviceId || "").slice(0, 40);
  const name = String(msg.name || "Device").slice(0, 64);
  const platform = String(msg.platform || "unknown").slice(0, 64);
  const publicKey = String(msg.publicKey || "").slice(0, 512);
  const pairedIds = Array.isArray(msg.pairedIds)
    ? msg.pairedIds.map((x) => String(x).slice(0, 40)).slice(0, 24)
    : [];
  if (!id) {
    send(ws, { type: "error", message: "Invalid hello" });
    return;
  }

  const existing = getDevice(id);
  if (existing && existing.ws !== ws) {
    try {
      existing.ws.close();
    } catch {
      /* ignore */
    }
  }

  const device = {
    id,
    name,
    platform,
    publicKey,
    ws,
    ip: ctx.ip,
    net: netKey(ctx.ip),
    roomId: existing?.roomId || ctx.roomId || null,
    paired: new Set(pairedIds),
    joinedAt: Date.now(),
  };
  devices.set(id, device);
  ctx.deviceId = id;
  ctx.ws = ws;

  send(ws, {
    type: "hello-ok",
    you: presenceView(device),
    nearby: nearbyList(id),
    paired: pairedOnline(id),
  });
  notifyNet(device.net, id, { type: "nearby-joined", peer: presenceView(device) });
  for (const pid of device.paired) {
    const other = getDevice(pid);
    if (other?.paired.has(id)) {
      sendDevice(pid, { type: "paired-online", peer: presenceView(device) });
    }
  }
}

function onPairAsk(ctx, msg) {
  const to = String(msg.to || "");
  if (!ctx.deviceId || !canRoute(ctx.deviceId, to)) return;
  const from = getDevice(ctx.deviceId);
  sendDevice(to, { type: "pair-ask", from: ctx.deviceId, peer: presenceView(from) });
}

function onPairOk(ctx, msg) {
  const to = String(msg.to || "");
  const a = getDevice(ctx.deviceId);
  const b = getDevice(to);
  if (!a || !b) return;
  a.paired.add(to);
  b.paired.add(ctx.deviceId);
  sendDevice(ctx.deviceId, { type: "paired", peer: presenceView(b) });
  sendDevice(to, { type: "paired", peer: presenceView(a) });
}

function onPairForget(ctx, msg) {
  const to = String(msg.to || "");
  const a = getDevice(ctx.deviceId);
  if (a) a.paired.delete(to);
  const b = getDevice(to);
  if (b) b.paired.delete(ctx.deviceId);
  sendDevice(to, { type: "unpaired", id: ctx.deviceId });
  sendDevice(ctx.deviceId, { type: "unpaired", id: to });
}

function onJoin(ws, ctx, msg) {
  const roomId = String(msg.roomId || "").toUpperCase();
  const id = String(msg.deviceId || "").slice(0, 40);
  const name = String(msg.name || "Device").slice(0, 64);
  const platform = String(msg.platform || "unknown").slice(0, 64);
  const publicKey = String(msg.publicKey || "").slice(0, 512);

  if (!/^[A-Z0-9]{4,12}$/.test(roomId) || !id) {
    send(ws, { type: "error", message: "Invalid join" });
    return;
  }

  if (ctx.roomId) leaveRoom(ctx);

  let room = getRoom(roomId);
  if (!room) {
    room = new Room(roomId);
    rooms.set(roomId, room);
  }
  if (room.peers.size >= MAX_PEERS && !room.peers.has(id)) {
    send(ws, { type: "error", message: "Room is full (8 devices)" });
    return;
  }

  const existing = room.peers.get(id);
  if (existing && existing.ws !== ws) {
    try {
      existing.ws.close();
    } catch {
      /* ignore */
    }
  }

  const peer = {
    id,
    name,
    platform,
    publicKey,
    ws,
    joinedAt: Date.now(),
  };
  room.add(peer);
  ctx.roomId = room.id;
  ctx.deviceId = id;
  const live = getDevice(id);
  if (live) live.roomId = room.id;
  else {
    devices.set(id, {
      id,
      name,
      platform,
      publicKey,
      ws,
      ip: ctx.ip,
      net: netKey(ctx.ip),
      roomId: room.id,
      paired: new Set(),
      joinedAt: Date.now(),
    });
  }

  send(ws, {
    type: "joined",
    roomId: room.id,
    you: peerView(peer),
    peers: room.others(id),
  });
  room.broadcast(id, { type: "peer-joined", peer: peerView(peer) });
}

function onSignal(ctx, msg) {
  const to = String(msg.to || "");
  if (!ctx.deviceId || !canRoute(ctx.deviceId, to)) return;
  sendDevice(to, {
    type: "signal",
    from: ctx.deviceId,
    data: msg.data,
  });
}

function onControl(ctx, msg) {
  const to = String(msg.to || "");
  if (!ctx.deviceId) return;
  if (to === "*") {
    const room = ctx.roomId && getRoom(ctx.roomId);
    if (!room) return;
    room.broadcast(ctx.deviceId, {
      type: "control",
      from: ctx.deviceId,
      data: msg.data,
    });
    return;
  }
  if (!canRoute(ctx.deviceId, to)) return;
  sendDevice(to, {
    type: "control",
    from: ctx.deviceId,
    data: msg.data,
  });
}

function handleBinary(ws, ctx, raw) {
  const buf = raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
  if (buf.length > MAX_BINARY || buf.length < 8) return;
  if (!ctx.deviceId) return;

  const headerLen = buf.readUInt32BE(0);
  if (headerLen <= 0 || headerLen > 4096 || 4 + headerLen > buf.length) return;

  let header;
  try {
    header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8"));
  } catch {
    return;
  }

  const to = String(header.to || "");
  if (!canRoute(ctx.deviceId, to)) return;

  header.from = ctx.deviceId;
  const packed = packBinary(header, buf.subarray(4 + headerLen));
  const dest = getDevice(to);
  if (dest?.ws.readyState === 1) dest.ws.send(packed);
}

function packBinary(header, payload) {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const out = Buffer.allocUnsafe(4 + h.length + payload.length);
  out.writeUInt32BE(h.length, 0);
  h.copy(out, 4);
  payload.copy(out, 4 + h.length);
  return out;
}

function listenHttps(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

function startRedirect(httpsPort) {
  const redirect = http.createServer((req, res) => {
    const host = String(req.headers.host || `localhost:${HTTP_PORT}`).replace(/:\d+$/, `:${httpsPort}`);
    res.writeHead(301, { Location: `https://${host}${req.url || "/"}` });
    res.end();
  });
  redirect.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`HTTP redirect port ${HTTP_PORT} is busy; HTTPS is still up.`);
      return;
    }
    console.warn("HTTP redirect failed:", err.message);
  });
  redirect.listen(HTTP_PORT, HOST);
}

if (HOSTED) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
  listenPort = PORT;
  const publicUrl =
    process.env.PUBLIC_URL ||
    (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : `https://localhost:${PORT}`);
  console.log(`\n  RELAY  ·  ${publicUrl}\n`);
} else {
  const fallbackPorts = [...new Set([PORT, 3443, 8443])];
  for (const port of fallbackPorts) {
    try {
      listenPort = await listenHttps(port);
      break;
    } catch (err) {
      if (err.code !== "EADDRINUSE" || port === fallbackPorts[fallbackPorts.length - 1]) {
        if (err.code === "EADDRINUSE") {
          console.error(`Ports ${fallbackPorts.join(", ")} are in use. Try PORT=9443 npm start`);
          process.exit(1);
        }
        throw err;
      }
      console.warn(`Port ${port} is in use, trying the next one…`);
    }
  }

  startRedirect(listenPort);
  const urls = publicUrls(listenPort);
  console.log("\n  RELAY  ·  https\n");
  for (const url of urls) console.log(`    ${url}`);
  console.log("\n  First visit: accept the certificate warning on each device.");
  console.log("  Phones: Advanced → Proceed / Visit website.\n");
}
