const LS = "relay.pairs";

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || "[]");
    return Array.isArray(raw) ? raw.filter((p) => p && p.id) : [];
  } catch {
    return [];
  }
}

function write(list) {
  localStorage.setItem(LS, JSON.stringify(list.slice(0, 24)));
}

export function listPairs() {
  return read();
}

export function pairIds() {
  return read().map((p) => p.id);
}

export function getPair(id) {
  return read().find((p) => p.id === id) || null;
}

export function upsertPair(peer) {
  const list = read().filter((p) => p.id !== peer.id);
  list.unshift({
    id: peer.id,
    name: peer.name || "Device",
    platform: peer.platform || "",
    publicKey: peer.publicKey || "",
    pairedAt: Date.now(),
  });
  write(list);
}

export function removePair(id) {
  write(read().filter((p) => p.id !== id));
}

export function isPaired(id) {
  return read().some((p) => p.id === id);
}
