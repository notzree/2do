// The worker can read this local marker while the planner is closed.
export async function rememberPushScope(scope: string) {
  if (
    typeof caches === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  )
    return;
  const cache = await caches.open("2do-notification-device");
  await cache.put("/.2do-push-scope", new Response(scope));
}
