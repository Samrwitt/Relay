import {
  CHUNK_SIZE,
  WINDOW_SIZE,
  uid,
  missingIndices,
  rangesFromSet,
  setFromRanges,
  downloadBlob,
  snapshotFiles,
} from "./utils.js";
import { encryptChunk, decryptChunk } from "./crypto.js";
import { zipFiles } from "./zip.js";
import * as idb from "./idb.js";

export class TransferEngine {
  constructor({ mesh, signaling, keys, localId, onChange }) {
    this.mesh = mesh;
    this.signaling = signaling;
    this.keys = keys;
    this.localId = localId;
    this.onChange = onChange;
    this.transfers = new Map();
    this.peers = new Map();
    this.files = new Map();

    signaling.on("control", (msg) => this.onControl(msg.from, msg.data));
  }

  setPeer(peer) {
    this.peers.set(peer.id, peer);
  }

  removePeer(id) {
    this.peers.delete(id);
  }

  list() {
    return [...this.transfers.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    return this.transfers.get(id);
  }

  notify() {
    this.onChange?.(this.list());
  }

  async sendFiles(fileList, targetIds) {
    const files = snapshotFiles(fileList);
    if (!files.length || !targetIds.length) return [];

    const created = [];
    const groupId = targetIds.length > 1 ? uid("grp") : null;
    for (const to of targetIds) {
      const transferId = uid("tx");
      const metaFiles = files.map((file) => {
        const fileId = uid("f");
        this.files.set(`${transferId}:${fileId}`, file);
        return {
          id: fileId,
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
          chunkSize: CHUNK_SIZE,
          totalChunks: Math.max(1, Math.ceil(file.size / CHUNK_SIZE) || 1),
        };
      });

      const tx = {
        id: transferId,
        direction: "send",
        to,
        from: this.localId,
        peerName: this.peers.get(to)?.name || "Device",
        groupId,
        groupSize: targetIds.length,
        files: metaFiles,
        status: "offering",
        mode: this.mesh.modeOf(to),
        createdAt: Date.now(),
        bytes: 0,
        totalBytes: metaFiles.reduce((s, f) => s + f.size, 0),
        acked: new Map(metaFiles.map((f) => [f.id, new Set()])),
        paused: false,
        error: null,
        speed: 0,
        _window: new Map(),
        _lastTick: { t: Date.now(), b: 0 },
      };
      this.transfers.set(transferId, tx);
      created.push(tx);

      this.signaling.control(to, {
        kind: "offer",
        transferId,
        files: metaFiles,
      });
    }
    this.notify();
    return created;
  }

  accept(transferId) {
    const tx = this.transfers.get(transferId);
    if (!tx || tx.direction !== "receive") return;
    tx.status = "transferring";
    const resume = {};
    for (const file of tx.files) {
      resume[file.id] = rangesFromSet(tx.received.get(file.id) || new Set());
    }
    this.signaling.control(tx.from, {
      kind: "accept",
      transferId,
      resume,
    });
    this.notify();
  }

  reject(transferId) {
    const tx = this.transfers.get(transferId);
    if (!tx) return;
    this.signaling.control(tx.direction === "receive" ? tx.from : tx.to, {
      kind: "reject",
      transferId,
    });
    tx.status = "rejected";
    this.notify();
  }

  pause(transferId) {
    const tx = this.transfers.get(transferId);
    if (!tx) return;
    tx.paused = true;
    tx.status = "paused";
    const other = tx.direction === "send" ? tx.to : tx.from;
    this.signaling.control(other, { kind: "pause", transferId });
    this.notify();
  }

  resume(transferId) {
    const tx = this.transfers.get(transferId);
    if (!tx) return;
    tx.paused = false;
    tx.status = "transferring";
    const other = tx.direction === "send" ? tx.to : tx.from;
    this.signaling.control(other, { kind: "resume", transferId });
    if (tx.direction === "send") this.pump(tx);
    this.notify();
  }

  cancel(transferId) {
    const tx = this.transfers.get(transferId);
    if (!tx) return;
    tx.status = "cancelled";
    tx.paused = true;
    const other = tx.direction === "send" ? tx.to : tx.from;
    this.signaling.control(other, { kind: "cancel", transferId });
    idb.chunksDeleteFor(transferId).catch(() => {});
    this.notify();
  }

  onControl(from, data) {
    if (!data?.kind) return;
    switch (data.kind) {
      case "offer":
        return this.onOffer(from, data);
      case "accept":
        return this.onAccept(from, data);
      case "reject":
        return this.onReject(data.transferId);
      case "pause":
        return this.onRemotePause(data.transferId, true);
      case "resume":
        return this.onRemotePause(data.transferId, false);
      case "cancel":
        return this.onReject(data.transferId, "cancelled");
      default:
    }
  }

  onOffer(from, data) {
    const existing = this.transfers.get(data.transferId);
    if (existing) return;
    const tx = {
      id: data.transferId,
      direction: "receive",
      from,
      to: this.localId,
      peerName: this.peers.get(from)?.name || "Device",
      files: data.files,
      status: "incoming",
      mode: this.mesh.modeOf(from),
      createdAt: Date.now(),
      bytes: 0,
      totalBytes: data.files.reduce((s, f) => s + f.size, 0),
      received: new Map(data.files.map((f) => [f.id, new Set()])),
      paused: false,
      error: null,
      speed: 0,
      _lastTick: { t: Date.now(), b: 0 },
    };
    this.transfers.set(tx.id, tx);
    idb
      .transferGet(tx.id)
      .then(async (saved) => {
        if (!saved?.received) return;
        for (const file of tx.files) {
          const set = setFromRanges(saved.received[file.id]);
          const live = await idb.chunkKeysFor(tx.id, file.id);
          for (const i of live) set.add(i);
          tx.received.set(file.id, set);
          tx.bytes += [...set].reduce((s, i) => {
            const last = i === file.totalChunks - 1;
            return s + (last ? file.size - i * file.chunkSize : file.chunkSize);
          }, 0);
        }
        this.notify();
      })
      .catch(() => {});
    this.notify();
  }

  onAccept(from, data) {
    const tx = this.transfers.get(data.transferId);
    if (!tx || tx.direction !== "send" || tx.to !== from) return;
    tx.status = "transferring";
    tx.paused = false;
    for (const file of tx.files) {
      const got = setFromRanges(data.resume?.[file.id]);
      tx.acked.set(file.id, got);
      tx.bytes += [...got].reduce((s, i) => {
        const last = i === file.totalChunks - 1;
        return s + (last ? file.size - i * file.chunkSize : file.chunkSize);
      }, 0);
    }
    this.notify();
    this.pump(tx);
  }

  onReject(transferId, status = "rejected") {
    const tx = this.transfers.get(transferId);
    if (!tx) return;
    tx.status = status;
    tx.paused = true;
    this.notify();
  }

  onRemotePause(transferId, paused) {
    const tx = this.transfers.get(transferId);
    if (!tx) return;
    tx.paused = paused;
    tx.status = paused ? "paused" : "transferring";
    if (!paused && tx.direction === "send") this.pump(tx);
    this.notify();
  }

  async onPacket(from, header, payload, mode) {
    if (!header?.type) return;
    if (header.type === "chunk") {
      await this.onChunk(from, header, payload, mode);
    } else if (header.type === "ack") {
      this.onAck(from, header, mode);
    }
  }

  async onChunk(from, header, payload, mode) {
    const tx = this.transfers.get(header.transferId);
    if (!tx || tx.direction !== "receive" || tx.from !== from) return;
    if (tx.status === "incoming") return;
    if (tx.paused || tx.status === "cancelled") return;
    tx.mode = mode;
    const file = tx.files.find((f) => f.id === header.fileId);
    if (!file) return;
    const got = tx.received.get(file.id);
    if (got.has(header.index)) {
      await this.ack(tx, file.id, header.index);
      return;
    }
    try {
      const peer = this.peers.get(from);
      const plain = decryptChunk(this.keys, peer.publicKey, header.nonce, payload);
      await idb.chunkPut(tx.id, file.id, header.index, plain);
      got.add(header.index);
      tx.bytes += plain.byteLength;
      this.tickSpeed(tx);
      await this.persistReceive(tx);
      await this.ack(tx, file.id, header.index);
      if (got.size >= file.totalChunks) await this.finishFile(tx, file);
      this.notify();
    } catch (err) {
      tx.error = err.message;
      tx.status = "failed";
      this.notify();
    }
  }

  async persistReceive(tx) {
    const received = {};
    for (const file of tx.files) {
      received[file.id] = rangesFromSet(tx.received.get(file.id));
    }
    await idb.transferPut({
      id: tx.id,
      files: tx.files,
      from: tx.from,
      received,
      createdAt: tx.createdAt,
    });
  }

  async ack(tx, fileId, index) {
    const link = await this.mesh.ensure(tx.from);
    await link.send({ type: "ack", transferId: tx.id, fileId, index }, new Uint8Array());
  }

  onAck(from, header, mode) {
    const tx = this.transfers.get(header.transferId);
    if (!tx || tx.direction !== "send" || tx.to !== from) return;
    tx.mode = mode;
    const file = tx.files.find((f) => f.id === header.fileId);
    if (!file) return;
    const set = tx.acked.get(file.id);
    if (set.has(header.index)) return;
    set.add(header.index);
    const last = header.index === file.totalChunks - 1;
    const size = last ? file.size - header.index * file.chunkSize : file.chunkSize;
    tx.bytes += Math.max(0, size);
    this.tickSpeed(tx);
    const inflight = tx._window.get(file.id);
    inflight?.delete(header.index);
    if (set.size >= file.totalChunks) {
      file.done = true;
      if (tx.files.every((f) => f.done)) this.completeSend(tx);
    }
    this.notify();
  }

  tickSpeed(tx) {
    const now = Date.now();
    const dt = (now - tx._lastTick.t) / 1000;
    if (dt >= 0.4) {
      tx.speed = (tx.bytes - tx._lastTick.b) / dt;
      tx._lastTick = { t: now, b: tx.bytes };
    }
  }

  async pump(tx) {
    if (tx._pumping) return;
    tx._pumping = true;
    try {
      const link = await this.mesh.ensure(tx.to);
      const peer = this.peers.get(tx.to);
      if (!peer?.publicKey) throw new Error("Peer has no key");

      for (const file of tx.files) {
        if (tx.paused || tx.status !== "transferring") return;
        const acked = tx.acked.get(file.id);
        const source = this.files.get(`${tx.id}:${file.id}`);
        if (!source) {
          tx.error = "File handle lost — drop the file again to resume";
          tx.status = "failed";
          this.notify();
          return;
        }
        if (!tx._window.has(file.id)) tx._window.set(file.id, new Set());
        const inflight = tx._window.get(file.id);
        const sendIndex = async (index) => {
          const start = index * file.chunkSize;
          const end = Math.min(start + file.chunkSize, file.size);
          const slice =
            source.size === 0 ? new Uint8Array() : new Uint8Array(await source.slice(start, end).arrayBuffer());
          const { nonce, cipher } = encryptChunk(this.keys, peer.publicKey, slice);
          inflight.add(index);
          const used = await link.send(
            { type: "chunk", transferId: tx.id, fileId: file.id, index, nonce },
            cipher
          );
          tx.mode = used;
        };

        let rounds = 0;
        while (acked.size < file.totalChunks && rounds < 12) {
          if (tx.paused || tx.status !== "transferring") return;
          const missing = missingIndices(file.totalChunks, acked).filter((i) => !inflight.has(i));
          for (const index of missing) {
            if (tx.paused || tx.status !== "transferring") return;
            while (inflight.size >= WINDOW_SIZE) {
              await new Promise((r) => setTimeout(r, 20));
              if (tx.paused || tx.status !== "transferring") return;
            }
            await sendIndex(index);
          }
          const waitUntil = Date.now() + 4000;
          while (acked.size < file.totalChunks && Date.now() < waitUntil) {
            if (tx.paused || tx.status !== "transferring") return;
            await new Promise((r) => setTimeout(r, 40));
            if (![...inflight].some((i) => !acked.has(i))) break;
          }
          for (const index of [...inflight]) {
            if (!acked.has(index)) inflight.delete(index);
          }
          rounds += 1;
        }
        if (acked.size < file.totalChunks && !tx.paused) {
          tx.error = "Transfer stalled — tap Resume to retry missing chunks";
          tx.status = "paused";
          tx.paused = true;
          this.notify();
          return;
        }
      }
    } catch (err) {
      tx.error = err.message;
      tx.status = "failed";
      this.notify();
    } finally {
      tx._pumping = false;
    }
  }

  saveFile(transferId, fileId) {
    const tx = this.transfers.get(transferId);
    const file = tx?.files.find((f) => f.id === fileId);
    if (file?.blob) downloadBlob(file.blob, file.name);
  }

  async saveAll(transferId) {
    const tx = this.transfers.get(transferId);
    if (!tx) return;
    const ready = tx.files.filter((f) => f.blob);
    if (!ready.length) return;
    if (ready.length === 1) {
      downloadBlob(ready[0].blob, ready[0].name);
      return;
    }
    const zip = await zipFiles(ready);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(zip, `relay-${ready.length}-files-${stamp}.zip`);
  }

  async finishFile(tx, file) {
    try {
      const blob = await idb.assembleBlob(tx.id, file.id, file.totalChunks, file.type);
      file.blob = blob;
      file.done = true;
      if (tx.files.every((f) => f.done)) await this.completeReceive(tx);
      else this.notify();
    } catch (err) {
      tx.error = err.message;
      tx.status = "failed";
    }
  }

  async completeReceive(tx) {
    tx.status = "completed";
    tx.finishedAt = Date.now();
    await idb.historyAdd({
      id: tx.id,
      direction: "received",
      names: tx.files.map((f) => f.name),
      size: tx.totalBytes,
      peerName: tx.peerName,
      peerId: tx.from,
      status: "completed",
      mode: tx.mode,
      createdAt: tx.createdAt,
      finishedAt: tx.finishedAt,
    });
    await idb.chunksDeleteFor(tx.id);
    await idb.transferDelete(tx.id);
    this.notify();
  }

  async completeSend(tx) {
    tx.status = "completed";
    tx.finishedAt = Date.now();
    await idb.historyAdd({
      id: tx.id,
      direction: "sent",
      names: tx.files.map((f) => f.name),
      size: tx.totalBytes,
      peerName: tx.peerName,
      peerId: tx.to,
      status: "completed",
      mode: tx.mode,
      createdAt: tx.createdAt,
      finishedAt: tx.finishedAt,
    });
    this.notify();
  }
}
