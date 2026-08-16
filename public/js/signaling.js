import { packMessage, unpackMessage } from "./utils.js";
import { relayWsUrl } from "./config.js";

export class Signaling {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.ready = null;
    this.reconnectTimer = null;
    this.closed = false;
    this.joinPayload = null;
    this.binaryWait = null;
    this.heartbeat = null;
  }

  on(type, fn) {
    const list = this.handlers.get(type) || [];
    list.push(fn);
    this.handlers.set(type, list);
    return () => {
      this.handlers.set(
        type,
        (this.handlers.get(type) || []).filter((h) => h !== fn)
      );
    };
  }

  emit(type, data) {
    for (const fn of this.handlers.get(type) || []) fn(data);
    for (const fn of this.handlers.get("*") || []) fn({ type, data });
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return this.ready;
    }
    this.closed = false;
    const url = relayWsUrl();
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        this.startHeartbeat();
        this.emit("open");
        resolve();
      };
      ws.onerror = () => {
        this.emit("error", new Error("Socket error"));
        reject(new Error("Socket error"));
      };
      ws.onclose = () => {
        this.stopHeartbeat();
        this.emit("close");
        if (!this.closed) this.scheduleReconnect();
      };
      ws.onmessage = (ev) => this.onMessage(ev);
    });
    return this.ready;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (this.closed) return;
      try {
        await this.connect();
        if (this.helloPayload) this.send(this.helloPayload);
        if (this.joinPayload) this.send(this.joinPayload);
      } catch {
        this.scheduleReconnect();
      }
    }, 1200);
  }

  async hello(payload) {
    this.helloPayload = { type: "hello", ...payload };
    await this.connect();
    this.send(this.helloPayload);
  }

  async join(payload) {
    this.joinPayload = { type: "join", ...payload };
    await this.connect();
    if (this.helloPayload) this.send(this.helloPayload);
    this.send(this.joinPayload);
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  signal(to, data) {
    this.send({ type: "signal", to, data });
  }

  control(to, data) {
    this.send({ type: "control", to, data });
  }

  relay(to, header, payload) {
    if (this.ws?.readyState !== 1) return;
    const packed = packMessage({ ...header, to }, payload);
    this.ws.send(packed);
  }

  onMessage(ev) {
    if (typeof ev.data !== "string") {
      const { header, payload } = unpackMessage(ev.data);
      this.emit("relay", { header, payload });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    this.emit(msg.type, msg);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ type: "ping" }), 20000);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  leaveRoom() {
    this.joinPayload = null;
    this.send({ type: "leave-room" });
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.helloPayload = null;
    this.joinPayload = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
