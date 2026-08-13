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
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));
app.get("/vendor/nacl-fast.min.js", (_req, res) => {
  res.sendFile(path.join(ROOT, "node_modules/tweetnacl/nacl-fast.min.js"));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() });
});

app.get("/api/info", (req, res) => {
  const urls = publicUrls(listenPort);
  const host = req.headers.host || `localhost:${listenPort}`;
  res.json({
    port: listenPort,
    urls,
    suggested:
      urls.find((u) => !u.includes("localhost") && !u.includes("127.0.0.1")) ||
      `https://${host}`,
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

const tls = loadTls();
const server = https.createServer({ key: tls.key, cert: tls.cert }, app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("error", (err) => {
  if (err.code !== "EADDRINUSE") console.warn("WebSocket:", err.message);
});

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  const ctx = { roomId: null, deviceId: null };

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

  ws.on("close", () => leave(ctx));
  ws.on("error", () => leave(ctx));
});

function leave(ctx) {
  if (!ctx.roomId || !ctx.deviceId) return;
  const room = getRoom(ctx.roomId);
  if (!room) return;
  room.remove(ctx.deviceId);
  room.broadcast(ctx.deviceId, { type: "peer-left", id: ctx.deviceId });
  if (room.peers.size === 0) destroyRoom(room.id);
  ctx.roomId = null;
  ctx.deviceId = null;
}

function handleText(ws, ctx, msg) {
  switch (msg.type) {
    case "join":
      return onJoin(ws, ctx, msg);
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

  if (ctx.roomId) leave(ctx);

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

  send(ws, {
    type: "joined",
    roomId: room.id,
    you: peerView(peer),
    peers: room.others(id),
  });
  room.broadcast(id, { type: "peer-joined", peer: peerView(peer) });
}

function onSignal(ctx, msg) {
  const room = ctx.roomId && getRoom(ctx.roomId);
  if (!room || !ctx.deviceId) return;
  const to = String(msg.to || "");
  if (!room.peers.has(to)) return;
  room.send(to, {
    type: "signal",
    from: ctx.deviceId,
    data: msg.data,
  });
}

function onControl(ctx, msg) {
  const room = ctx.roomId && getRoom(ctx.roomId);
  if (!room || !ctx.deviceId) return;
  const to = String(msg.to || "");
  if (to === "*") {
    room.broadcast(ctx.deviceId, {
      type: "control",
      from: ctx.deviceId,
      data: msg.data,
    });
    return;
  }
  if (!room.peers.has(to)) return;
  room.send(to, {
    type: "control",
    from: ctx.deviceId,
    data: msg.data,
  });
}

function handleBinary(ws, ctx, raw) {
  const buf = raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
  if (buf.length > MAX_BINARY || buf.length < 8) return;
  const room = ctx.roomId && getRoom(ctx.roomId);
  if (!room || !ctx.deviceId) return;

  const headerLen = buf.readUInt32BE(0);
  if (headerLen <= 0 || headerLen > 4096 || 4 + headerLen > buf.length) return;

  let header;
  try {
    header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8"));
  } catch {
    return;
  }

  const to = String(header.to || "");
  if (!room.peers.has(to)) return;

  header.from = ctx.deviceId;
  const packed = packBinary(header, buf.subarray(4 + headerLen));
  room.sendBinary(to, packed);
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
