const CACHE_NAME = 'harrys-chat-v2';
const STATIC_ASSETS = [
    '/',
    '/index.html'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            await self.skipWaiting();
            try {
                const cache = await caches.open(CACHE_NAME);
                await cache.addAll(STATIC_ASSETS);
            } catch (e) {
                console.warn('[sw] 预缓存失败:', e.message);
            }
        })()
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            await self.clients.claim();
            const keys = await caches.keys();
            await Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })()
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    if (event.request.url.includes('supabase')) return;
    event.respondWith(
        caches.match(event.request).then((cached) => {
            const fetchPromise = fetch(event.request).then((response) => {
                if (!response || response.status !== 200 || response.type !== 'basic') return response;
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            }).catch(() => cached);
            return cached || fetchPromise;
        })
    );
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        try {
            const text = event.data ? event.data.text() : '';
            payload = { body: text, title: 'Harry 的聊天室' };
        } catch (e2) {
            payload = {};
        }
    }

    const title = payload.title || 'Harry 的聊天室';
    const roomCode = payload.roomCode || '';
    const sender = payload.sender || '';

    event.waitUntil(
        (async () => {
            let iconUrl = payload.icon || '/icon-192.png';
            try {
                const canvas = new OffscreenCanvas(192, 192);
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#2563eb';
                const r = 42;
                ctx.beginPath();
                ctx.moveTo(r, 0);
                ctx.lineTo(192 - r, 0);
                ctx.quadraticCurveTo(192, 0, 192, r);
                ctx.lineTo(192, 192 - r);
                ctx.quadraticCurveTo(192, 192, 192 - r, 192);
                ctx.lineTo(r, 192);
                ctx.quadraticCurveTo(0, 192, 0, 192 - r);
                ctx.lineTo(0, r);
                ctx.quadraticCurveTo(0, 0, r, 0);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 92px -apple-system, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('💬', 96, 96);
                const blob = await canvas.convertToBlob({ type: 'image/png' });
                iconUrl = self.registration.scope + 'icon-192.png';
                const cache = await caches.open(CACHE_NAME);
                await cache.put(iconUrl, new Response(blob, { headers: { 'Content-Type': 'image/png' } }));
            } catch (e) {
                iconUrl = payload.icon || '/icon-192.png';
            }

            const options = {
                body: payload.body || '你有一条新消息',
                icon: iconUrl,
                badge: iconUrl,
                tag: payload.tag || `chat-${roomCode}-${sender}`,
                data: {
                    url: payload.url || (roomCode ? `/?room=${encodeURIComponent(roomCode)}` : '/'),
                    roomCode: roomCode,
                    sender: sender
                },
                renotify: true,
                requireInteraction: false,
                vibrate: [200, 100, 200],
                silent: false,
                timestamp: Date.now(),
                actions: roomCode ? [
                    { action: 'open', title: '查看' },
                    { action: 'close', title: '关闭' }
                ] : undefined
            };

            await self.registration.showNotification(title, options);
        })().catch((e) => {
            console.error('[sw] 显示通知失败:', e.message);
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    const targetUrl = data.url || '/';

    if (event.action === 'close') return;

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            const existing = clients.find((c) => 'focus' in c);
            if (existing) {
                try {
                    const currentUrl = new URL(existing.url);
                    const target = new URL(targetUrl, self.location.origin);
                    if (currentUrl.pathname !== target.pathname || currentUrl.searchParams.get('room') !== target.searchParams.get('room')) {
                        existing.navigate(targetUrl);
                    }
                } catch (e) {
                    existing.navigate(targetUrl);
                }
                return existing.focus();
            }
            return self.clients.openWindow(targetUrl);
        }).catch((e) => {
            console.error('[sw] 通知点击处理失败:', e.message);
        })
    );
});

self.addEventListener('notificationclose', (event) => {
    const data = event.notification.data || {};
    console.log('[sw] 通知被关闭:', data.roomCode || '无房间信息');
});

self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(
        (async () => {
            try {
                const oldSub = event.oldSubscription;
                const newSub = event.newSubscription;
                console.log('[sw] 推送订阅已变更, 旧订阅:', oldSub ? '存在' : '无', '新订阅:', newSub ? '存在' : '无');
                const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
                clients.forEach((client) => {
                    client.postMessage({
                        type: 'PUSH_SUBSCRIPTION_CHANGE',
                        oldSubscription: oldSub ? oldSub.toJSON() : null,
                        newSubscription: newSub ? newSub.toJSON() : null
                    });
                });
            } catch (e) {
                console.error('[sw] 推送订阅变更处理失败:', e.message);
            }
        })()
    );
});
