/* Загружается через workbox importScripts; показывает push и открывает комнату. */
self.addEventListener("push", function (event) {
  let data = { title: "TatarChat", body: "", room: "", kind: "", tag: "", messageId: "" };
  try {
    if (event.data) Object.assign(data, event.data.json());
  } catch (_) {}
  const title = data.title || "TatarChat";
  const body = data.body || "";
  const tag = data.tag || "tatarchat-" + (data.messageId || Date.now());
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/pwa-192.png",
      badge: "/pwa-192.png",
      tag,
      renotify: true,
      data: { room: data.room || "", kind: data.kind || "" },
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const room = (event.notification.data && event.notification.data.room) || "";
  const scope = self.registration.scope || "/";
  const openUrl = room ? scope.replace(/\/?$/, "/") + "?tc_room=" + encodeURIComponent(room) : scope;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        var url = c.url || "";
        if (url.indexOf(new URL(scope).origin) === 0 && "focus" in c) {
          c.focus();
          c.postMessage({ type: "TATARCHAT_OPEN_ROOM", room: room });
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(openUrl);
    })
  );
});
