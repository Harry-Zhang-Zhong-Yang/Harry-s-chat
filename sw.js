const CACHE_NAME = 'harrys-chat-shell-v1';

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (error) { payload = {}; }
    const title = payload.title || 'Harry 的聊天室';
    const options = {
        body: payload.body || '你有一条新消息',
        icon: payload.icon || '/icon-192.png',
        badge: payload.badge || '/icon-192.png',
        tag: payload.tag || 'chat-message',
        data: { url: payload.url || '/', roomCode: payload.roomCode || '' },
        renotify: true
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            const existing = clients.find((client) => 'focus' in client);
            if (existing) {
                existing.navigate(targetUrl);
                return existing.focus();
            }
            return self.clients.openWindow(targetUrl);
        })
    );
});
