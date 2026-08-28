const CACHE_NAME = 'harrys-chat-v29';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/game.js'
];

async function generateAndCacheIcon(size) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2563eb';
    const r = size * 0.22;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r);
    ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size);
    ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${size * 0.48}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💬', size / 2, size / 2);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const cache = await caches.open(CACHE_NAME);
    const url = `/icon-${size}.png`;
    await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'image/png' } }));
    return url;
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            await self.skipWaiting();
            try {
                await generateAndCacheIcon(192);
                await generateAndCacheIcon(512);
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
    const url = new URL(event.request.url);
    if (url.hostname.includes('supabase')) return;
    if (url.hostname.includes('api.qrserver.com')) return;
    if (url.hostname.includes('cdn.jsdelivr.net')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                const fetchPromise = fetch(event.request).then((response) => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => cached);
                return cached || fetchPromise;
            })
        );
        return;
    }

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // 其余静态资源：stale-while-revalidate —— 立即返回缓存（快），同时后台拉新版更新缓存（保证下次打开是最新）
    event.respondWith(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.match(event.request).then((cached) => {
                const fetchPromise = fetch(event.request).then((response) => {
                    if (response && response.status === 200) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                }).catch(() => cached);
                return cached || fetchPromise;
            });
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
                iconUrl = await generateAndCacheIcon(192);
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
