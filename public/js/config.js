const STORAGE_KEY = "relay.serverUrl";

export function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export function getStoredServerUrl() {
  try {
    return (localStorage.getItem(STORAGE_KEY) || "").trim().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function setStoredServerUrl(url) {
  const clean = String(url || "")
    .trim()
    .replace(/\/$/, "");
  try {
    if (clean) localStorage.setItem(STORAGE_KEY, clean);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return clean;
}

/** Origin the UI and WebSocket should use (native apps need an explicit Relay server). */
export function relayOrigin() {
  const stored = getStoredServerUrl();
  if (stored) return stored;
  if (isNativeApp()) {
    const injected = String(window.__RELAY_SERVER__ || "").trim().replace(/\/$/, "");
    if (injected) return injected;
  }
  return location.origin;
}

export function relayWsUrl() {
  const origin = relayOrigin();
  try {
    const u = new URL(origin);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${u.host}/ws`;
  } catch {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }
}

export function needsServerSetup() {
  return isNativeApp() && !getStoredServerUrl() && !String(window.__RELAY_SERVER__ || "").trim();
}
