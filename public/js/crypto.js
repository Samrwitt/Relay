const LS_KEYS = "relay.naclKeys";

function b64encode(u8) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function hex(u8, n = 8) {
  return [...u8.slice(0, n)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function nacl() {
  const lib = window.nacl;
  if (!lib) throw new Error("tweetnacl failed to load");
  return lib;
}

export function loadKeyPair() {
  const lib = nacl();
  try {
    const raw = localStorage.getItem(LS_KEYS);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        publicKey: b64decode(parsed.publicKey),
        secretKey: b64decode(parsed.secretKey),
      };
    }
  } catch {
    /* regenerate */
  }
  const kp = lib.box.keyPair();
  try {
    localStorage.setItem(
      LS_KEYS,
      JSON.stringify({
        publicKey: b64encode(kp.publicKey),
        secretKey: b64encode(kp.secretKey),
      })
    );
  } catch {
    /* ignore */
  }
  return kp;
}

export function exportPublicKey(kp) {
  return b64encode(kp.publicKey);
}

export function importPublicKey(b64) {
  return b64decode(b64);
}

const sharedCache = new Map();

export function sharedKey(kp, theirPublicB64) {
  if (sharedCache.has(theirPublicB64)) return sharedCache.get(theirPublicB64);
  const lib = nacl();
  const their = importPublicKey(theirPublicB64);
  const key = lib.box.before(their, kp.secretKey);
  sharedCache.set(theirPublicB64, key);
  return key;
}

export function fingerprint(kp, theirPublicB64) {
  const lib = nacl();
  const key = sharedKey(kp, theirPublicB64);
  const hash = lib.hash(key);
  const h = hex(hash, 8);
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

export function encryptChunk(kp, theirPublicB64, plain) {
  const lib = nacl();
  const key = sharedKey(kp, theirPublicB64);
  const nonce = lib.randomBytes(24);
  const data = plain instanceof Uint8Array ? plain : new Uint8Array(plain);
  const cipher = lib.secretbox(data, nonce, key);
  return { nonce: b64encode(nonce), cipher };
}

export function decryptChunk(kp, theirPublicB64, nonceB64, cipherU8) {
  const lib = nacl();
  const key = sharedKey(kp, theirPublicB64);
  const nonce = b64decode(nonceB64);
  const opened = lib.secretbox.open(cipherU8, nonce, key);
  if (!opened) throw new Error("Decrypt failed — keys may not match");
  return opened;
}

export { b64encode, b64decode };
