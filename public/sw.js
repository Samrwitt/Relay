const SHARE_CACHE = "relay-share";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event.request));
    return;
  }
  event.respondWith(fetch(event.request));
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    let files = formData.getAll("files").filter((f) => f instanceof File && f.name);
    const title = String(formData.get("title") || "");
    const text = String(formData.get("text") || "");
    const sharedUrl = String(formData.get("url") || "");
    if (!files.length && (title || text || sharedUrl)) {
      const body = [title, text, sharedUrl].filter(Boolean).join("\n");
      files.push(new File([body], "shared.txt", { type: "text/plain" }));
    }
    const cache = await caches.open(SHARE_CACHE);
    await Promise.all((await cache.keys()).map((key) => cache.delete(key)));
    const index = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = `/__share/${i}`;
      index.push({
        path,
        name: file.name || `file-${i + 1}`,
        type: file.type || "",
        size: file.size,
      });
      await cache.put(
        path,
        new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(file.name || `file-${i + 1}`),
          },
        })
      );
    }
    await cache.put(
      "/__share/index.json",
      new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json" } })
    );
  } catch {
    /* still open the app */
  }
  return Response.redirect("/?share=1", 303);
}
