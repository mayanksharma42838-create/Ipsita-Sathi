// Service Worker for WhatsApp-Style Background Notifications
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const title = data.title || "Ipsita-Sathi Message";
    const options = {
      body: data.body || "New message received",
      icon: data.icon || "/static/icons/icon-192.png",
      badge: "/static/icons/icon-192.png",
      vibrate: [100, 50, 100],
      data: { url: "/" },
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error("Error processing push notification:", err);
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("/");
      }
    })
  );
});