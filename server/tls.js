import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CERT_DIR = path.join(ROOT, ".certs");
const KEY_PATH = process.env.SSL_KEY || path.join(CERT_DIR, "key.pem");
const CERT_PATH = process.env.SSL_CERT || path.join(CERT_DIR, "cert.pem");
const META_PATH = path.join(CERT_DIR, "meta.json");

export function lanIPv4s() {
  const ips = ["127.0.0.1"];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  return [...new Set(ips)];
}

function altNames(ips) {
  return [
    { type: 2, value: "localhost" },
    { type: 2, value: "relay.local" },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
}

function generate(ips) {
  const pems = selfsigned.generate([{ name: "commonName", value: "Relay" }], {
    days: 825,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", c: true },
      {
        name: "keyUsage",
        keyCertSign: false,
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: "subjectAltName", altNames: altNames(ips) },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  } catch {
    return null;
  }
}

function certsCover(ips) {
  const meta = readMeta();
  if (!meta?.ips) return false;
  return ips.every((ip) => meta.ips.includes(ip));
}

export function loadTls() {
  const envKey = process.env.SSL_KEY;
  const envCert = process.env.SSL_CERT;
  if (envKey && envCert && fs.existsSync(envKey) && fs.existsSync(envCert)) {
    return {
      key: fs.readFileSync(envKey),
      cert: fs.readFileSync(envCert),
      generated: false,
    };
  }

  const ips = lanIPv4s();
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH) && certsCover(ips)) {
    return {
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
      generated: true,
    };
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const pems = generate(ips);
  fs.writeFileSync(KEY_PATH, pems.key, { mode: 0o600 });
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(META_PATH, JSON.stringify({ ips, createdAt: Date.now() }, null, 2));
  return { key: pems.key, cert: pems.cert, generated: true };
}
