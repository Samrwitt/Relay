#!/usr/bin/env node
/**
 * Writes public/native-config.js so the Capacitor shell can ship a default server URL.
 * Usage: RELAY_SERVER=http://192.168.1.19:3478 node scripts/write-native-config.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "native-config.js");
const server = String(process.env.RELAY_SERVER || "").trim().replace(/\/$/, "");
const body = `window.__RELAY_SERVER__ = ${JSON.stringify(server)};\n`;
fs.writeFileSync(out, body);
console.log(`Wrote ${path.relative(root, out)} → ${server || "(empty)"}`);
