self.addEventListener("push", (event) => {
  if (!event.data) return;
  let notice;
  try {
    notice = event.data.json();
  } catch {
    return;
  }
  if (typeof notice.id !== "string" || !notice.id) return;
  const url = new URL("/app", self.location.origin);
  url.searchParams.set("inbox", notice.id);
  event.waitUntil(
    (async () => {
      const cache = await caches.open("2do-notification-device");
      const active = await cache.match("/.2do-push-scope");
      if (!active || typeof notice.scope !== "string" || (await active.text()) !== notice.scope)
        return;
      await self.registration.showNotification(notice.title || "2do", {
        body: notice.body || "",
        tag: notice.tag || notice.id,
        icon: "/icon-192.png",
        data: { url: url.href },
      });
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/app", self.location.origin);
  if (url.origin !== self.location.origin || url.pathname !== "/app") return;
  event.waitUntil(self.clients.openWindow(url.href));
});
