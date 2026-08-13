import { packMessage, unpackMessage, sleep } from "./utils.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const P2P_TIMEOUT_MS = 9000;
const MAX_BUFFER = 1024 * 1024;

export class PeerLink {
  constructor({ signaling, localId, remoteId, onPacket, onMode }) {
    this.signaling = signaling;
    this.localId = localId;
    this.remoteId = remoteId;
    this.onPacket = onPacket;
    this.onMode = onMode;
    this.pc = null;
    this.channel = null;
    this.mode = "connecting";
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.polite = localId < remoteId;
    this.ready = null;
    this._resolveReady = null;
    this.bufferWaiters = [];
    this.unsub = signaling.on("signal", (msg) => {
      if (msg.from === this.remoteId) this.onSignal(msg.data);
    });
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onMode?.(mode, this.remoteId);
  }

  async connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.createPc();
    if (!this.polite) {
      try {
        this.channel = this.pc.createDataChannel("relay-files", { ordered: true });
        this.bindChannel(this.channel);
        await this.negotiate();
      } catch (err) {
        console.warn("offer failed", err);
      }
    }
    const winner = await Promise.race([
      this.ready.then(() => "p2p"),
      sleep(P2P_TIMEOUT_MS).then(() => "timeout"),
    ]);
    if (winner === "timeout" && this.mode !== "p2p") {
      this.setMode("relay");
      this._resolveReady?.();
    }
    return this.ready;
  }

  createPc() {
    if (this.pc) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.signaling.signal(this.remoteId, { kind: "ice", candidate: ev.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected" && this.channel?.readyState === "open") {
        this.setMode("p2p");
        this._resolveReady?.();
      }
      if (s === "failed" || s === "disconnected") {
        if (this.mode !== "p2p") this.setMode("relay");
        this._resolveReady?.();
      }
    };
    pc.ondatachannel = (ev) => {
      this.channel = ev.channel;
      this.bindChannel(this.channel);
    };
    pc.onnegotiationneeded = () => this.negotiate();
  }

  async negotiate() {
    const pc = this.pc;
    if (!pc) return;
    try {
      this.makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      this.signaling.signal(this.remoteId, { kind: "sdp", description: pc.localDescription });
    } catch (err) {
      console.warn("negotiate", err);
    } finally {
      this.makingOffer = false;
    }
  }

  async onSignal(data) {
    if (!data) return;
    this.createPc();
    const pc = this.pc;
    try {
      if (data.kind === "sdp") {
        const desc = data.description;
        const offerCollision = desc.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          this.signaling.signal(this.remoteId, { kind: "sdp", description: pc.localDescription });
        }
      } else if (data.kind === "ice" && data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!this.ignoreOffer) console.warn("ice", err);
        }
      }
    } catch (err) {
      console.warn("signal", err);
    }
  }

  bindChannel(channel) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => {
      this.setMode("p2p");
      this._resolveReady?.();
    };
    channel.onclose = () => {
      if (this.mode === "p2p") this.setMode("relay");
    };
    channel.onerror = () => {
      if (this.mode === "p2p") this.setMode("relay");
    };
    channel.onbufferedamountlow = () => {
      const waiters = this.bufferWaiters.splice(0);
      for (const w of waiters) w();
    };
    channel.onmessage = (ev) => {
      try {
        const { header, payload } = unpackMessage(ev.data);
        this.onPacket(this.remoteId, header, payload, "p2p");
      } catch (err) {
        console.warn("packet", err);
      }
    };
  }

  waitBuffer() {
    const ch = this.channel;
    if (!ch || ch.readyState !== "open" || ch.bufferedAmount < MAX_BUFFER) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.bufferWaiters.push(resolve));
  }

  async send(header, payload) {
    await this.connect();
    const packed = packMessage(header, payload);
    if (this.mode === "p2p" && this.channel?.readyState === "open") {
      await this.waitBuffer();
      this.channel.send(packed);
      return "p2p";
    }
    this.setMode("relay");
    this.signaling.relay(this.remoteId, header, payload);
    return "relay";
  }

  close() {
    this.unsub?.();
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.channel = null;
  }
}

export class Mesh {
  constructor({ signaling, localId, onPacket, onMode }) {
    this.signaling = signaling;
    this.localId = localId;
    this.onPacket = onPacket;
    this.onMode = onMode;
    this.links = new Map();
    signaling.on("relay", ({ header, payload }) => {
      const from = header.from;
      if (from) this.onPacket(from, header, payload, "relay");
    });
  }

  link(remoteId) {
    let peer = this.links.get(remoteId);
    if (!peer) {
      peer = new PeerLink({
        signaling: this.signaling,
        localId: this.localId,
        remoteId,
        onPacket: this.onPacket,
        onMode: this.onMode,
      });
      this.links.set(remoteId, peer);
    }
    return peer;
  }

  async ensure(remoteId) {
    const peer = this.link(remoteId);
    await peer.connect();
    return peer;
  }

  modeOf(remoteId) {
    return this.links.get(remoteId)?.mode || "connecting";
  }

  drop(remoteId) {
    this.links.get(remoteId)?.close();
    this.links.delete(remoteId);
  }

  close() {
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }
}
