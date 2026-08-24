/* global caches, Response, self, URL */

const updateCacheName = `rustyera-pwa-update-${self.registration.scope}`;
const updateMarker = new URL("pwa-update-marker", self.registration.scope).href;

self.addEventListener("install", (event) => {
  if (!self.registration.active) return;
  event.waitUntil(
    caches.open(updateCacheName).then((cache) => cache.put(updateMarker, new Response())),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(updateCacheName);
      const isUpdate = Boolean(await cache.match(updateMarker));
      await caches.delete(updateCacheName);
      if (!isUpdate) return;

      await self.clients.claim();
      const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope)) void client.navigate(client.url);
      }
    })(),
  );
});
