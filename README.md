# Relay

Open a link on two devices and transfer huge files directly between them.

Laptop ↔ phone. Browser ↔ browser. No accounts, no cloud storage.

## What it does

- **Transfer rooms** — create a six-character room, share the link
- **QR pairing** — scan from a phone camera to join
- **WebRTC peer-to-peer** — files move device-to-device when NAT allows
- **Encrypted transfers** — X25519 key exchange, XSalsa20-Poly1305 per chunk
- **Chunked + resumable** — 64 KB slices, acknowledgements, pause/resume, IndexedDB replay
- **Fallback relay** — if ICE fails, the server forwards ciphertext only
- **Multi-device** — up to 8 peers; send to one device or everyone
- **Transfer history** — local log in IndexedDB

The signaling/relay server never sees plaintext. It only exchanges SDP/ICE and opaque binary frames.

## Android app wrapper

Relay includes a Capacitor Android shell in `android/`. The UI is the same web app; the phone talks to your Relay server over the network.

### Run the server for the app

Self-signed HTTPS is awkward in Android WebView. For local testing use HTTP:

```bash
npm run start:native
```

Note the LAN URL printed in the terminal, e.g. `http://192.168.1.19:3478`.

### Sync & open Android Studio

```bash
# optional default server baked into the APK
RELAY_SERVER=http://192.168.1.19:3478 npm run cap:sync

npm run cap:android
```

In Android Studio: run on a phone/emulator. First launch opens **Server** — paste the LAN URL (or a hosted `https://…` Relay), then tap **Save & reconnect**.

### After web UI changes

```bash
npm run cap:sync
```

Then rebuild/run from Android Studio.

### Desktop

Use Chrome/Edge **Install** for a desktop app shell for now. A Tauri/Windows wrapper can come next if you want system share sheet + offline discovery.

## Deploy

The app listens on HTTP in production (`RELAY_HTTP=1`). Fly, Render, or Railway terminate HTTPS in front.

```bash
# Fly.io
fly launch --copy-config --yes
fly deploy
```

Or connect this GitHub repo to [Render](https://render.com) — `render.yaml` is already in the repo.

## Run it locally

```bash
npm install
npm start
```

Then open the printed URL on a laptop and a phone (same Wi-Fi is easiest).

```
https://localhost:3478
https://YOUR-LAN-IP:3478
```

If 3478 is already taken, Relay moves to **3443** (that is the case right now).

The first visit shows a certificate warning (self-signed). Accept it on the laptop and on the phone (`Advanced` → `Proceed` / `Visit website`). After that, WebSockets and WebRTC run in a secure context.

`npm run dev` restarts the server on file changes. Use `PORT=8443 npm start` if you want a different port.

To use your own certificate:

```bash
SSL_CERT=/path/to/fullchain.pem SSL_KEY=/path/to/privkey.pem npm start
```

## How a transfer works

1. Each device generates a durable X25519 keypair and joins a room over WebSocket.
2. Peers try WebRTC (STUN). If the data channel is not open in ~9s, they switch to the relay.
3. The sender offers file metadata. The receiver accepts and reports any chunks already stored.
4. Each chunk is encrypted to the recipient’s public key, sent, decrypted, stored, and acked.
5. When every chunk is present, the browser assembles a Blob and downloads it.

Pause, reload, or a dropped link can resume from the last acknowledged chunk.

## Notes

- Relay serves **HTTPS** (and `wss://`) on port 3478, or 3443 if that port is busy. HTTP on 3080 redirects to HTTPS.
- On a phone, open the `https://LAN-IP:…` link once and trust the cert before scanning a QR.
- Optional: `PORT=8443 npm start`
