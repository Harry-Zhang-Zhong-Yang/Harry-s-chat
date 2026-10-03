    const CHAT_APP_VERSION = "3.5.2";
    const SUPABASE_URL = 'https://nryaxymneqyakeykulzq.supabase.co'; 
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5yeWF4eW1uZXF5YWtleWt1bHpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NjE3MTMsImV4cCI6MjEwMTAzNzcxM30.8DxcRaDXRBNopYo7F0bbwvHyyC7cE4zQuxn9C2ayj4M';
    
    let supabaseClient;
    try {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (e) { console.error("Supabase 初始化失败:", e); }

    function beijingISOString(date) {
        const d = date || new Date();
        const beijingMs = d.getTime() + 8 * 60 * 60 * 1000;
        const bj = new Date(beijingMs);
        const year = bj.getUTCFullYear();
        const month = String(bj.getUTCMonth() + 1).padStart(2, '0');
        const day = String(bj.getUTCDate()).padStart(2, '0');
        const hours = String(bj.getUTCHours()).padStart(2, '0');
        const minutes = String(bj.getUTCMinutes()).padStart(2, '0');
        const seconds = String(bj.getUTCSeconds()).padStart(2, '0');
        const ms = String(bj.getUTCMilliseconds()).padStart(3, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}+08:00`;
    }

    function parseBeijingTime(isoStr) {
        if (!isoStr) return new Date();
        return new Date(isoStr);
    }

    function showToast(message, type = 'info', duration = 2500) {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        }
        if (container.children.length >= 3) return null;
        const toast = document.createElement('div');
        const tone = type === 'success' ? 'toast-success' : type === 'error' ? 'toast-error' : type === 'warning' ? 'toast-warning' : 'toast-info';
        toast.className = `toast ${tone}`;
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');

        const text = document.createElement('span');
        text.textContent = message;

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', '关闭提示');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
            toast.classList.add('out');
            setTimeout(() => toast.remove(), 180);
        });

        toast.appendChild(text);
        toast.appendChild(closeBtn);
        container.appendChild(toast);

        if (duration === 0) {
            return toast;
        }
        const hideTimer = setTimeout(() => {
            if (!toast.isConnected) return;
            toast.classList.add('out');
            setTimeout(() => toast.remove(), 180);
        }, duration);
        toast.__toastTimer = hideTimer;
        return toast;
    }

    window.appEnhanceUi = function() {
        const root = document.documentElement;
        root.classList.remove('app-boot');
        const firstInput = () => {
            const focusable = [
                document.getElementById('auth-username'),
                document.getElementById('auth-password'),
                document.getElementById('reg-username'),
                document.getElementById('reg-password'),
                document.getElementById('mrv-room-input'),
                document.getElementById('join-room-modal-input'),
                document.getElementById('message-input')
            ].filter(Boolean)[0];
            if (focusable && document.activeElement !== focusable) {
                try { focusable.focus({ preventScroll: true }); } catch (e) {}
            }
        };
        requestAnimationFrame(firstInput);

        document.addEventListener('click', (event) => {
            const toast = event.target.closest('.toast-close');
            if (!toast) return;
            const parent = toast.closest('.toast');
            if (parent) {
                parent.classList.add('out');
                setTimeout(() => parent.remove(), 180);
            }
        }, true);
    };

    let currentRoomCode = "";
    let continuationToken = null;
    let continuationPolling = null;
    let continuationWarningTimer = null;
    let continuationCursor = 0;
    let continuationOldestCursor = 0;
    let continuationPhrase = null; // 当前暗房的暗号（仅内存，用于派生加密密钥）
    let continuationCryptoKey = null; // 由暗号派生的 AES-256-GCM 密钥
    let pendingUrlRoom = ""; // 通过链接 ?room=xxx 带入的目标房间（登录后自动继续）
    let mySender = "用户_" + Math.floor(Math.random() * 1000);

    let replyData = null;
    let roomSubscription = null;
    let realtimeReady = Promise.resolve();
    let realtimeReadyResolve = null;
    let pendingMedia = null;
    let isSpeedMode = false;
    let isPollingEnabled = false;
    let mediaRecorder = null;
    let recordingChunks = [];
    let recordingStartedAt = 0;
    let recordingPointerId = null;
    let recordingCancelled = false;
    let recordingStartCancelled = false;
    let mobileVoiceMode = false;
    let speechRecognition = null;
    let speechTranscript = '';
    let presenceActive = false;
    async function logJoinRoom(joinType = 'manual') {
        if (!currentRoomCode || !mySender) return;
        try {
            await supabaseClient.from('join_logs').insert([{
                room_code: currentRoomCode,
                user_name: mySender,
                join_type: joinType,
                user_agent: navigator.userAgent || ''
            }]);
        } catch (e) {
            console.warn('join_logs insert failed:', e);
        }
    }

    window.addEventListener('unhandledrejection', function(e) {
        if (e.reason && e.reason.message && e.reason.message.includes('message channel closed')) {
            e.preventDefault();
        }
    });

    let presenceIdleTimer = null;
    const PRESENCE_IDLE_MS = 2 * 60 * 1000;
    let realtimePolling = null;
    let lastKnownMessageId = null;

    // 分页相关变量
    let isFetchingHistory = false;
    const PAGE_SIZE = 30;
    // 用于分页：记录已加载的最早消息时间戳
    let oldestLoadedAt = null;
    // 是否已经没有更多历史可加载
    let noMoreHistory = false;

    // 本地消息缓存（用于导出）
    let messagesCache = [];
    let isLeavingRoom = false;

    function isRealMobileDevice() {
        const ua = navigator.userAgent || '';
        const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
        const narrowViewport = window.matchMedia('(max-width: 768px)').matches;
        const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
        return !!(mobileUA && (coarsePointer || narrowViewport));
    }

    function isDesktopLayout() {
        return !isRealMobileDevice() && window.matchMedia('(min-width: 1024px)').matches;
    }

    // ===== Service Worker（页面缓存 network-first + 推送通知基础） =====
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        navigator.serviceWorker.register('/sw.js').then((reg) => {
            // 每 60 秒检查一次 SW 更新，有新版立即激活（sw.js 内 skipWaiting + clients.claim）
            setInterval(() => reg.update().catch(() => {}), 60000);
        }).catch((e) => console.warn('[sw] 注册失败:', e.message));
    }

    // ===== 安卓 APK（Capacitor 原生壳）：后台收到新消息弹系统通知，点击直达房间 =====
    const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    let localNotifySeq = 0;
    function getLocalNotifyPlugin() {
        return (isNativeApp && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
    }
    function notifyIncomingMessage(sender, content, mediaType) {
        const Ln = getLocalNotifyPlugin();
        if (!Ln || !document.hidden) return; // 正在看聊天时不弹（App 被杀后收不到属本地通知边界）
        let body = String(content || '');
        if (!body && mediaType) body = mediaType === 'image' ? '[图片]' : (mediaType === 'audio' ? '[语音]' : '[文件]');
        if (body.length > 80) body = body.slice(0, 80) + '…';
        let roomName = currentRoomCode;
        try {
            if (Array.isArray(sidebarRoomsData) && sidebarRoomsData.length) {
                const hit = sidebarRoomsData.find(r => r.code === currentRoomCode);
                if (hit && hit.name) roomName = hit.name;
            }
        } catch (e) { /* 忽略 */ }
        Ln.schedule({
            notifications: [{
                id: (Date.now() + (localNotifySeq++)) % 2147483647,
                title: roomName ? `${sender} · ${roomName}` : String(sender || '新消息'),
                body: body || '发来一条新消息',
                extra: { roomCode: currentRoomCode }
            }]
        }).catch(e => console.warn('本地通知失败:', e));
    }
    async function setupNativeNotifications() {
        const Ln = getLocalNotifyPlugin();
        if (!Ln) return;
        try {
            const cur = await Ln.checkPermissions();
            if (cur && cur.display !== 'granted') await Ln.requestPermissions();
        } catch (e) { console.warn('通知权限请求失败:', e); }
        try {
            Ln.addListener('localNotificationActionPerformed', (action) => {
                const roomCode = action && action.notification && action.notification.data && action.notification.data.roomCode;
                if (!roomCode || !getLoggedInUser()) return;
                if (currentRoomCode === roomCode) return;
                document.getElementById('auth-overlay').classList.remove('show');
                if (currentRoomCode) {
                    window.switchToRoom(roomCode);
                } else {
                    showRoomLoading();
                    window.joinRoom(roomCode);
                }
            });
        } catch (e) { console.warn('通知点击监听失败:', e); }
    }
    setupNativeNotifications();

    // 下载安卓 APK：jsDelivr CDN（国内有节点，比 GitHub Pages 直连稳定）+ 原生 <a download>（浏览器下载管理器接管，断点续传）
    (function initApkDownloadLink() {
        const a = document.getElementById('mrv-apk-download');
        if (!a) return;
        if (isNativeApp) { a.style.display = 'none'; return; }
        // jsDelivr CDN 托管在 GitHub 仓库的 APK，跨域请求不经过 SW，无缓存截断问题
        const base = 'https://cdn.jsdelivr.net/gh/Harry-Zhang-Zhong-Yang/Harry-s-chat@main/Harry%E7%9A%84%E8%81%8A%E5%A4%A9%E5%AE%A4-v' + CHAT_APP_VERSION + '.apk';
        a.href = base;
        a.addEventListener('click', () => {
            showToast('正在下载安卓 App，请等待1-2分钟，在通知栏可查看进度', 'info', 4000);
        });
    })();

    function showRoomLoading() {
        document.getElementById('login-area').style.display = 'none';
        document.getElementById('chat-container').style.display = 'flex';
        // 电脑端（宽屏）：微信 PC 版布局 —— 左侧房间栏 + 右侧聊天区
        if (isDesktopLayout()) {
            document.body.classList.add('in-chat-desktop');
            renderRoomSidebar();
        } else {
            document.body.classList.remove('in-chat-desktop');
        }
        document.getElementById('room-loading').classList.remove('hidden');
    }

    // ===== 电脑端左侧房间栏 =====
    let sidebarRoomsData = []; // [{code, name, memberCount}]
    async function renderRoomSidebar() {
        const user = getLoggedInUser();
        if (!user || !supabaseClient) return;
        const nameEl = document.getElementById('sidebar-username');
        const avaEl = document.getElementById('sidebar-avatar');
        if (nameEl) nameEl.textContent = user;
        if (avaEl) {
            avaEl.textContent = String(user).slice(0, 1).toUpperCase();
            avaEl.style.background = hashGradient(user);
        }
        // 侧栏头像用自定义头像（有缓存则替换为图片）
        renderOwnAvatar();
        fetchAndApplyUserAvatars([user]);
        const listEl = document.getElementById('sidebar-room-list');
        if (!listEl) return;
        // 首次加载显示骨架屏（不出现"加载中"文字）；已有数据时保留旧列表
        if (!sidebarRoomsData.length) {
            listEl.innerHTML = '<div class="skeleton-item"></div><div class="skeleton-item"></div><div class="skeleton-item"></div>';
        }
        try {
            const { data, error } = await supabaseClient
                .from('room_members')
                .select('room_code')
                .eq('user_name', user)
                .order('created_at', { ascending: false });
            if (error) throw error;
            const codes = [...new Set((data || []).map(r => r.room_code))];
            if (!codes.length) {
                sidebarRoomsData = [];
                listEl.innerHTML = '<div class="sidebar-empty">还没有加入任何房间<br>点击顶部 ＋ 加入或创建</div>';
                return;
            }
            const joinedAt = {};
            (data || []).forEach(r => { if (!(r.room_code in joinedAt)) joinedAt[r.room_code] = r.created_at; });
            // 并行拉取：房间名 + 每个房间的成员数
            const nameMap = {};
            const countMap = {};
            try {
                const [roomsRes, membersRes] = await Promise.all([
                    supabaseClient.from('rooms').select('room_code,room_name').in('room_code', codes),
                    supabaseClient.from('room_members').select('room_code').in('room_code', codes)
                ]);
                (roomsRes.data || []).forEach(r => { if (r.room_name) nameMap[r.room_code] = r.room_name; });
                (membersRes.data || []).forEach(m => { countMap[m.room_code] = (countMap[m.room_code] || 0) + 1; });
            } catch (e) { /* 表不可用时忽略 */ }
            // 每个房间取最新一条消息（用于排序 + 预览，和手机端逻辑一致）
            const latestMap = {};
            await Promise.all(codes.map(c =>
                supabaseClient.from('messages').select('sender,content,media_type,created_at')
                    .eq('room_code', c).order('created_at', { ascending: false }).limit(1)
                    .then(res => { if (res.data && res.data[0]) latestMap[c] = res.data[0]; })
                    .catch(() => {})
            ));
            sidebarRoomsData = codes.map(c => ({ code: c, name: nameMap[c] || c, memberCount: countMap[c] || 1, latest: latestMap[c] || null, joinedAt: joinedAt[c] }));
            renderSidebarList();
        } catch (e) {
            console.warn('侧栏房间加载失败:', e);
            listEl.innerHTML = '<div class="sidebar-empty">加载失败，请重试</div>';
        }
    }

    function renderSidebarList() {
        const listEl = document.getElementById('sidebar-room-list');
        if (!listEl) return;
        const kw = (document.getElementById('sidebar-search')?.value || '').trim().toLowerCase();
        let rows = kw
            ? sidebarRoomsData.filter(r => r.code.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw))
            : [...sidebarRoomsData];
        if (!rows.length) {
            listEl.innerHTML = `<div class="sidebar-empty">${kw ? '没有匹配的房间' : '还没有加入任何房间<br>点击顶部 ＋ 加入或创建'}</div>`;
            return;
        }
        // 排序：有最新消息的按时间倒序；没消息的按加入时间倒序排在后面（和手机端一致）
        rows.sort((a, b) => {
            const ta = a.latest ? new Date(a.latest.created_at).getTime() : 0;
            const tb = b.latest ? new Date(b.latest.created_at).getTime() : 0;
            if (ta !== tb) return tb - ta;
            return new Date(b.joinedAt || 0) - new Date(a.joinedAt || 0);
        });
        listEl.innerHTML = rows.map(r => {
            const m = r.latest;
            const preview = m ? `${m.sender}: ${mrvPreviewText(m)}` : `${r.memberCount ? r.memberCount + ' 名成员 · ' : ''}${escapeHtml(r.code)}`;
            const time = m ? mrvFmtTime(m.created_at) : '';
            return `
            <div class="sidebar-room-item ${r.code === currentRoomCode ? 'active' : ''}" onclick="window.switchToRoom('${escapeHtml(r.code).replace(/'/g, '&#39;')}')">
                <span class="sri-text"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(preview)}</small></span>
                ${time ? `<span class="sri-time">${time}</span>` : '<span class="sri-arrow">›</span>'}
            </div>`;
        }).join('');
    }

    window.filterSidebarRooms = function() { renderSidebarList(); };

    window.switchToRoom = function(code) {
        code = String(code || '').trim();
        if (!code) return;
        if (code === currentRoomCode) return;
        document.getElementById('join-room-modal').style.display = 'none';
        window.joinRoom(code);
    };

    window.openJoinRoomModal = function() {
        const modal = document.getElementById('join-room-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        setTimeout(() => document.getElementById('join-room-modal-input').focus(), 60);
    };

    window.closeJoinRoomModal = function() {
        const modal = document.getElementById('join-room-modal');
        if (modal) modal.style.display = 'none';
        const input = document.getElementById('join-room-modal-input');
        if (input) input.value = '';
    };

    window.confirmJoinRoomModal = function() {
        const input = document.getElementById('join-room-modal-input');
        const code = input ? input.value.trim() : '';
        if (!code) return showToast('请输入房间代码', 'error');
        window.switchToRoom(code);
    };

    function hideRoomLoading() {
        document.getElementById('room-loading').classList.add('hidden');
    }

    /** 回到主页（已登录→房间列表页；未登录→登录/注册层） */
    function backToLoginArea() {
        document.body.classList.remove('in-chat-desktop');
        document.getElementById('room-loading').classList.add('hidden');
        document.getElementById('chat-container').style.display = 'none';
        if (getLoggedInUser()) {
            showRoomListView();
        } else {
            showAuthOverlay();
        }
    }

    // ===== 手机端：主页（微信式底部导航：消息 / 我的） =====
    function showRoomListView() {
        const area = document.getElementById('login-area');
        area.style.display = 'flex';
        area.classList.add('show-room-view');
        document.getElementById('chat-container').style.display = 'none';
        const user = getLoggedInUser();
        const nameEl = document.getElementById('mrv-username');
        const avaEl = document.getElementById('mrv-avatar');
        if (nameEl) nameEl.textContent = user || '';
        if (avaEl) {
            avaEl.textContent = String(user || '?').slice(0, 1).toUpperCase();
            avaEl.style.background = hashGradient(user || '');
        }
        if (user) fetchAndApplyUserAvatars([user]); // 有自定义头像则替换首字母
        window.switchMrvTab('msgs'); // 每次回到主页默认停在"消息"tab
        renderMobileRoomList();
    }

    window.switchMrvTab = function(tab) {
        const isMsgs = tab !== 'me';
        document.getElementById('mrv-page-msgs').style.display = isMsgs ? 'flex' : 'none';
        document.getElementById('mrv-page-me').style.display = isMsgs ? 'none' : 'flex';
        document.getElementById('mrv-tab-msgs').classList.toggle('active', isMsgs);
        document.getElementById('mrv-tab-me').classList.toggle('active', !isMsgs);
    };

    window.toggleMrvAdd = function() {
        const row = document.getElementById('mrv-add-row');
        if (!row) return;
        row.style.display = row.style.display === 'none' ? 'flex' : 'none';
        if (row.style.display === 'flex') document.getElementById('mrv-room-input').focus();
    };

    /** 微信式消息预览文案：媒体消息显示类型标记 */
    function mrvPreviewText(m) {
        let body = String(m.content || '');
        if (!body && m.media_type) body = m.media_type === 'image' ? '[图片]' : (m.media_type === 'audio' ? '[语音]' : '[文件]');
        return body || '';
    }

    /** 微信式时间戳：今天显示 HH:MM，昨天显示"昨天"，今年显示 M/D，更早显示 Y/M/D */
    function mrvFmtTime(ts) {
        const d = new Date(ts);
        if (isNaN(d)) return '';
        const now = new Date();
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        if (d.toDateString() === now.toDateString()) return hm;
        if (d.toDateString() === yesterday.toDateString()) return '昨天';
        if (now.getFullYear() === d.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
        return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    }

    /** 手机端房间列表：微信式 —— 最新一条消息预览 + 时间，按最新消息时间倒序 */
    async function renderMobileRoomList() {
        const listEl = document.getElementById('mrv-list');
        if (!listEl) return;
        const user = getLoggedInUser();
        if (!user || !supabaseClient) return;
        if (!listEl.dataset.ready) listEl.innerHTML = '<div class="mrv-empty">加载中…</div>';
        try {
            const { data, error } = await supabaseClient
                .from('room_members')
                .select('room_code,created_at')
                .eq('user_name', user)
                .order('created_at', { ascending: false });
            if (error) throw error;
            const joined = data || [];
            const codes = [...new Set(joined.map(r => r.room_code))];
            if (!codes.length) {
                listEl.innerHTML = '<div class="mrv-empty">还没有房间<br>在下方输入房间代码加入或创建</div>';
                listEl.dataset.ready = '1';
                return;
            }
            const nameMap = {};
            try {
                const roomsRes = await supabaseClient.from('rooms').select('room_code,room_name').in('room_code', codes);
                (roomsRes.data || []).forEach(r => { if (r.room_name) nameMap[r.room_code] = r.room_name; });
            } catch (e) { /* rooms 表不可用时忽略 */ }
            // 每个房间取最新一条消息
            const latest = {};
            await Promise.all(codes.map(c =>
                supabaseClient.from('messages').select('sender,content,media_type,created_at')
                    .eq('room_code', c).order('created_at', { ascending: false }).limit(1)
                    .then(res => { if (res.data && res.data[0]) latest[c] = res.data[0]; })
                    .catch(() => {})
            ));
            // 排序：有消息的按最新消息时间倒序；没消息的按加入时间倒序排在后面
            const joinedAt = {};
            joined.forEach(r => { if (!(r.room_code in joinedAt)) joinedAt[r.room_code] = r.created_at; });
            const sorted = codes.slice().sort((a, b) => {
                const ta = latest[a] ? new Date(latest[a].created_at).getTime() : 0;
                const tb = latest[b] ? new Date(latest[b].created_at).getTime() : 0;
                if (ta !== tb) return tb - ta;
                return new Date(joinedAt[b] || 0) - new Date(joinedAt[a] || 0);
            });
            const html = sorted.map(c => {
                const m = latest[c];
                const preview = m ? `${m.sender}: ${mrvPreviewText(m)}` : `房间 ${c}`;
                const time = m ? mrvFmtTime(m.created_at) : '';
                return `
                <div class="mrv-item" onclick="window.mrvEnter('${escapeHtml(c).replace(/'/g, '&#39;')}')">
                    <span class="mrv-badge" style="background:${hashGradient(c)}">${escapeHtml((nameMap[c] || c).slice(0, 1).toUpperCase())}</span>
                    <span class="mrv-item-text"><b>${escapeHtml(nameMap[c] || c)}</b><small>${escapeHtml(preview)}</small></span>
                    ${time ? `<span class="mrv-item-time">${time}</span>` : ''}
                </div>`;
            }).join('');
            // 数据没变化就不重绘（避免刷新时闪烁）
            if (listEl.dataset.ready && listEl.dataset.sig === html) return;
            listEl.dataset.sig = html;
            listEl.innerHTML = html;
            listEl.dataset.ready = '1';
        } catch (e) {
            console.warn('手机房间列表加载失败:', e);
            if (!listEl.dataset.ready) listEl.innerHTML = '<div class="mrv-empty">加载失败，请下拉刷新重试</div>';
        }
    }

    // 主页可见时每 15 秒静默刷新列表（微信式：停在消息页也能看到新消息预览）
    setInterval(() => {
        if (document.hidden) return;
        const area = document.getElementById('login-area');
        if (area && area.style.display !== 'none' && area.classList.contains('show-room-view') && getLoggedInUser()) {
            renderMobileRoomList();
        }
    }, 15000);

    window.mrvEnter = function(code) {
        code = String(code || '').trim();
        if (!code) return;
        window.joinRoom(code); // 直接进入，不再先露出旧登录页
    };

    window.mrvJoin = function() {
        const v = document.getElementById('mrv-room-input').value.trim();
        if (!v) return showToast('请输入房间代码', 'error');
        document.getElementById('mrv-room-input').value = '';
        window.mrvEnter(v);
    };

    window.onload = async () => {
        document.addEventListener('touchstart', function(){}, {passive: true});
        document.addEventListener('gesturestart', function(e) { e.preventDefault(); });
        document.addEventListener('gesturechange', function(e) { e.preventDefault(); });
        document.addEventListener('gestureend', function(e) { e.preventDefault(); });
        window.appEnhanceUi && window.appEnhanceUi();
        
        const setVH = () => {
            const vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
        };
        setVH();
        window.addEventListener('resize', setVH);
        window.addEventListener('orientationchange', () => setTimeout(setVH, 100));

        // 窗口跨过电脑/手机布局阈值（1024px）时，同步侧栏显示与数据
        let lastDesktopLayout = isDesktopLayout();
        window.addEventListener('resize', () => {
            const nowDesktop = isDesktopLayout();
            if (nowDesktop === lastDesktopLayout) return;
            lastDesktopLayout = nowDesktop;
            const chatVisible = document.getElementById('chat-container').style.display !== 'none';
            if (chatVisible && currentRoomCode) {
                document.body.classList.toggle('in-chat-desktop', nowDesktop);
                if (nowDesktop) renderRoomSidebar();
            }
        });
        
        const urlParams = new URLSearchParams(window.location.search);
        const roomFromUrl = urlParams.get('room');
        if (roomFromUrl) {
            pendingUrlRoom = String(roomFromUrl).trim();
            if (window.history && window.history.replaceState) {
                window.history.replaceState({}, '', window.location.pathname);
            }
        }

        if (window.visualViewport) {
            const fixIOSKeyboard = () => {
                const chatBox = document.getElementById('chat-box');
                const chatContainer = document.getElementById('chat-container');
                if (chatContainer) {
                    const offset = window.innerHeight - window.visualViewport.height;
                    chatContainer.style.transform = offset > 0 ? `translateY(${-offset}px)` : '';
                }
                if (chatBox && chatBox.scrollTop + chatBox.clientHeight >= chatBox.scrollHeight - 100) {
                    requestAnimationFrame(() => {
                        chatBox.scrollTop = chatBox.scrollHeight;
                    });
                }
            };
            window.visualViewport.addEventListener('resize', fixIOSKeyboard);
            window.visualViewport.addEventListener('scroll', fixIOSKeyboard);
        }

        const voiceButton = document.getElementById('voice-btn');
        const messageInput = document.getElementById('message-input');
        const isMobileDevice = () => isRealMobileDevice() || (window.matchMedia('(max-width: 600px)').matches && /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent || ''));
        voiceButton.addEventListener('click', (event) => {
            event.preventDefault();
            if (isMobileDevice()) {
                mobileVoiceMode = !mobileVoiceMode;
                voiceButton.classList.toggle('voice-mode', mobileVoiceMode);
                messageInput.placeholder = mobileVoiceMode ? '长按此处录音，松开发送' : '输入消息并按回车...';
                return;
            }
            if (mediaRecorder) stopVoiceRecording();
            else startVoiceRecording({ pointerId: null, inputSource: 'desktop' });
        });
        messageInput.addEventListener('pointerdown', (event) => {
            if (!mobileVoiceMode || !isMobileDevice()) return;
            event.preventDefault();
            startVoiceRecording({ pointerId: event.pointerId, inputSource: 'mobile-input' });
        });
        messageInput.addEventListener('pointerup', stopVoiceRecording);
        messageInput.addEventListener('pointercancel', stopVoiceRecording);
        messageInput.addEventListener('pointermove', (event) => {
            if (mediaRecorder && recordingPointerId === event.pointerId) {
                recordingCancelled = event.clientY < messageInput.getBoundingClientRect().top - 70;
            }
        });

        // ===== 账号系统：已登录则恢复账号，未登录显示登录/注册层 =====
        const loggedUser = getLoggedInUser();
        if (loggedUser) {
            mySender = loggedUser;
            insertLoginLog('auto');
        } else {
            showAuthOverlay();
        }

        const savedToken = localStorage.getItem('chat_auth_token');
        const savedRoom = localStorage.getItem('chat_last_room');
        const expiry = localStorage.getItem('chat_auth_expiry');

        if (loggedUser && savedRoom && expiry) {
            const now = new Date().getTime();
            if (now < parseInt(expiry)) {
                currentRoomCode = savedRoom;
            mySender = loggedUser;
            showRoomLoading();
                setRoomTitle(currentRoomCode);
                await loadHistory(true);
                hideRoomLoading();
                logJoinRoom('auto');
                setTimeout(() => { document.getElementById('message-input').focus(); }, 100);
                ensureRoomExists().catch(e => console.warn('ensureRoomExists failed:', e));
                initRealtime();
                realtimeReady.catch(() => startPolling());
                if (isPollingEnabled) startPolling();
            } else {
                localStorage.removeItem('chat_last_room');
                localStorage.removeItem('chat_auth_expiry');
            }
        }

        if (loggedUser) {
            await loadMyRooms();
            // 链接带入的房间优先；其次电脑端自动进最近房间；否则显示房间列表主页
            if (!currentRoomCode && pendingUrlRoom) {
                const target = pendingUrlRoom;
                pendingUrlRoom = '';
                showRoomLoading();
                await window.joinRoom(target);
            } else if (isDesktopLayout() && !currentRoomCode && myRoomsCache.length) {
                showRoomLoading();
                window.switchToRoom(myRoomsCache[0]);
            } else if (!currentRoomCode) {
                showRoomListView();
            }
        }

        // 登录/注册回车键
        document.getElementById('auth-username').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); document.getElementById('auth-password').focus(); }
        });
        document.getElementById('auth-password').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); window.doLogin(); }
        });
        document.getElementById('reg-username').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); document.getElementById('reg-password').focus(); }
        });
        document.getElementById('reg-password').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); document.getElementById('reg-password2').focus(); }
        });
        document.getElementById('reg-password2').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); window.doRegister(); }
        });

        // ===== 图片查看器：缩放 / 平移 =====
        const lightboxState = { scale: 1, x: 0, y: 0, pointers: new Map(), lastDist: 0, dragging: false, lastTap: 0, currentUrl: '' };
        const lightboxEl = () => document.getElementById('image-lightbox');
        const lightboxImgEl = () => document.getElementById('image-lightbox-img');

        function applyLightboxTransform() {
            const img = lightboxImgEl();
            if (!img) return;
            img.style.transform = `translate(${lightboxState.x}px, ${lightboxState.y}px) scale(${lightboxState.scale})`;
            img.classList.toggle('zoomed', lightboxState.scale > 1.02);
        }
        function resetLightboxTransform() {
            lightboxState.scale = 1; lightboxState.x = 0; lightboxState.y = 0;
            lightboxState.pointers.clear(); lightboxState.lastDist = 0; lightboxState.dragging = false;
            applyLightboxTransform();
        }
        function zoomLightboxAt(factor, cx, cy) {
            const img = lightboxImgEl();
            if (!img) return;
            const rect = img.getBoundingClientRect();
            const oldScale = lightboxState.scale;
            const newScale = Math.min(6, Math.max(0.5, oldScale * factor));
            const k = newScale / oldScale;
            // 保持锚点 (cx, cy) 视觉位置不动
            lightboxState.x += (cx - (rect.left + rect.width / 2)) * (1 - k);
            lightboxState.y += (cy - (rect.top + rect.height / 2)) * (1 - k);
            lightboxState.scale = newScale;
            applyLightboxTransform();
        }
        function toggleLightboxZoom(cx, cy) {
            if (lightboxState.scale > 1.02) resetLightboxTransform();
            else zoomLightboxAt(2.5, cx, cy);
        }

        // 从 URL 提取文件名（兜底用时间戳）
        function urlToFileName(url, fallbackName) {
            try {
                const u = new URL(url, window.location.href);
                const base = u.pathname.split('/').pop();
                if (base && /\.[a-zA-Z0-9]{2,5}$/.test(base)) return decodeURIComponent(base);
            } catch (e) { /* ignore */ }
            if (fallbackName) return fallbackName;
            return `image_${Date.now()}.jpg`;
        }

        // 下载单张图片：fetch blob -> a[download]
        async function downloadImage(url, suggestedName) {
            if (!url) return false;
            try {
                const resp = await fetch(url, { mode: 'cors', cache: 'no-cache' });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const blob = await resp.blob();
                const fileName = urlToFileName(url, suggestedName);
                const objectUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = objectUrl;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
                return true;
            } catch (e) {
                console.error('downloadImage 失败:', e);
                // CORS 失败兜底：直接打开链接（浏览器自行决定是否下载）
                try {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = urlToFileName(url, suggestedName);
                    a.target = '_blank';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    return true;
                } catch (e2) {
                    console.error('downloadImage fallback 失败:', e2);
                    return false;
                }
            }
        }

        // 批量下载当前房间所有图片（从 messagesCache 提取）
        async function downloadAllRoomImages() {
            if (!Array.isArray(messagesCache) || messagesCache.length === 0) {
                showToast('当前房间暂无图片可下载', 'info');
                return;
            }
            // 倒序收集图片消息（最新在前），过滤掉已撤回/删除
            const images = messagesCache
                .filter(m => m && m.media_type === 'image' && m.media_url && !m.is_recalled && !m.is_deleted)
                .map(m => ({ url: m.media_url, sender: m.sender || 'user', created_at: m.created_at }))
                .reverse();
            if (images.length === 0) {
                showToast('当前房间暂无图片可下载', 'info');
                return;
            }
            const total = images.length;
            const progressToast = showToast(`批量下载中... 0/${total}（请允许浏览器多次下载）`, 'info', 0);
            const updateProgress = (cur) => {
                if (progressToast) progressToast.innerText = `批量下载中... ${cur}/${total}（请允许浏览器多次下载）`;
            };
            let success = 0;
            let failed = 0;
            for (let i = 0; i < total; i++) {
                updateProgress(i);
                const item = images[i];
                // 给文件名带上序号 + 发送者 + 时间，避免重名
                const ts = item.created_at ? new Date(item.created_at).toISOString().replace(/[:.]/g, '-').slice(0, 19) : Date.now();
                const safeSender = (item.sender || 'user').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 16);
                const idx = String(i + 1).padStart(3, '0');
                const ok2 = await downloadImage(item.url, `${idx}_${safeSender}_${ts}.jpg`);
                if (ok2) success++; else failed++;
                // 间隔避免浏览器拦截
                if (i < total - 1) await new Promise(r => setTimeout(r, 350));
            }
            if (progressToast) progressToast.remove();
            if (failed === 0) {
                showToast(`已下载 ${success} 张图片`, 'success');
            } else {
                showToast(`下载完成：成功 ${success} 张，失败 ${failed} 张`, 'info', 4000);
            }
        }

        function openImageLightbox(url) {
            const lightbox = lightboxEl();
            const image = lightboxImgEl();
            if (!lightbox || !image || !url) return;
            resetLightboxTransform();
            lightboxState.currentUrl = url;
            image.src = url;
            image.onerror = () => { showToast('图片加载失败', 'error'); closeImageLightbox(); };
            lightbox.classList.add('visible');
            const hint = lightbox.querySelector('.lightbox-hint');
            if (hint) {
                hint.style.opacity = '1';
                clearTimeout(hint._timer);
                hint._timer = setTimeout(() => { hint.style.opacity = '0'; }, 2200);
            }
        }

        function closeImageLightbox(event) {
            if (event && event.target.id === 'image-lightbox-img') return;
            const lightbox = lightboxEl();
            const image = lightboxImgEl();
            if (lightbox) lightbox.classList.remove('visible');
            if (image) { image.removeAttribute('src'); image.onerror = null; }
            resetLightboxTransform();
        }

        // 滚轮缩放（桌面）
        document.addEventListener('wheel', (e) => {
            const lightbox = lightboxEl();
            if (!lightbox || !lightbox.classList.contains('visible')) return;
            e.preventDefault();
            zoomLightboxAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
        }, { passive: false });

        // 触摸 / 鼠标拖拽 + 双指捏合 + 双击
        (function initLightboxGestures() {
            const getImg = () => lightboxImgEl();
            document.addEventListener('pointerdown', (e) => {
                const lightbox = lightboxEl();
                if (!lightbox || !lightbox.classList.contains('visible') || e.target.id !== 'image-lightbox-img') return;
                lightboxState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (lightboxState.pointers.size === 1) {
                    lightboxState.dragging = lightboxState.scale > 1.02;
                    if (lightboxState.dragging) { getImg()?.classList.add('dragging'); lightbox.setPointerCapture(e.pointerId); }
                } else if (lightboxState.pointers.size === 2) {
                    const pts = [...lightboxState.pointers.values()];
                    lightboxState.lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                }
            });
            document.addEventListener('pointermove', (e) => {
                const lightbox = lightboxEl();
                if (!lightbox || !lightbox.classList.contains('visible') || !lightboxState.pointers.has(e.pointerId)) return;
                const prev = lightboxState.pointers.get(e.pointerId);
                lightboxState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (lightboxState.pointers.size === 2) {
                    const pts = [...lightboxState.pointers.values()];
                    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                    if (lightboxState.lastDist > 0 && dist > 0) {
                        zoomLightboxAt(dist / lightboxState.lastDist, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
                    }
                    lightboxState.lastDist = dist;
                } else if (lightboxState.dragging) {
                    lightboxState.x += e.clientX - prev.x;
                    lightboxState.y += e.clientY - prev.y;
                    applyLightboxTransform();
                }
            });
            const endPointer = (e) => {
                const lightbox = lightboxEl();
                const wasSingle = lightboxState.pointers.size === 1;
                lightboxState.pointers.delete(e.pointerId);
                lightboxState.lastDist = 0;
                lightboxState.dragging = false;
                getImg()?.classList.remove('dragging');
                // 单指快速点按 → 双击检测
                if (wasSingle && lightbox && lightbox.classList.contains('visible')) {
                    const now = Date.now();
                    if (now - lightboxState.lastTap < 300) {
                        toggleLightboxZoom(e.clientX, e.clientY);
                        lightboxState.lastTap = 0;
                    } else {
                        lightboxState.lastTap = now;
                    }
                }
            };
            document.addEventListener('pointerup', endPointer);
            document.addEventListener('pointercancel', endPointer);
        })();

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const roomNameModal = document.getElementById('room-name-modal');
                if (roomNameModal && roomNameModal.style.display === 'flex') {
                    roomNameModal.style.display = 'none';
                    return;
                }
                const lightbox = document.getElementById('image-lightbox');
                if (lightbox && lightbox.classList.contains('visible')) {
                    closeImageLightbox();
                    return;
                }
                const searchModal = document.getElementById('search-modal');
                if (searchModal && searchModal.style.display === 'flex') {
                    closeSearchModal();
                    return;
                }
                const settingsModal = document.getElementById('settings-modal');
                if (settingsModal && settingsModal.style.display === 'flex') {
                    settingsModal.style.display = 'none';
                    return;
                }
                const emojiPanel = document.getElementById('emoji-panel');
                if (emojiPanel && emojiPanel.classList.contains('visible')) {
                    emojiPanel.classList.remove('visible');
                    return;
                }
                if (replyData) {
                    cancelReply();
                    return;
                }
                hideContextMenu();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                searchMessages();
            }
        });
        window.openImageLightbox = openImageLightbox;
        window.closeImageLightbox = closeImageLightbox;
        window.downloadCurrentLightboxImage = async function(event) {
            if (event) { event.stopPropagation(); }
            const url = lightboxState.currentUrl;
            if (!url) { showToast('没有可下载的图片', 'info'); return; }
            const btn = document.getElementById('lightbox-download-btn');
            if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }
            const ok = await downloadImage(url);
            if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
            showToast(ok ? '图片已开始下载' : '下载失败，可能是跨域限制', ok ? 'success' : 'error');
        };
        window.downloadAllRoomImages = async function(event) {
            if (event) { event.stopPropagation(); }
            await downloadAllRoomImages();
        };
        // 绑定 lightbox 内按钮事件（关闭按钮用类选择器，避开 download 按钮）
        (function bindLightboxButtons() {
            const dl = document.getElementById('lightbox-download-btn');
            const dlAll = document.getElementById('lightbox-download-all-btn');
            const close = document.querySelector('#image-lightbox .lightbox-close-btn');
            if (dl) dl.addEventListener('click', (e) => { e.stopPropagation(); window.downloadCurrentLightboxImage(); });
            if (dlAll) dlAll.addEventListener('click', (e) => { e.stopPropagation(); window.downloadAllRoomImages(); });
            if (close) close.addEventListener('click', (e) => { e.stopPropagation(); closeImageLightbox(); });
        })();

        // 清理旧版本残留的自定义背景数据
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith('chat_bg_url')) localStorage.removeItem(k);
            }
        } catch (e) { /* ignore */ }

        // ===== 主题初始化：A(石墨极简,默认) / B(奶油纸感) =====
        const savedStyle = localStorage.getItem('chat_theme_style');
        document.documentElement.dataset.theme = (savedStyle === 'b') ? 'b' : 'a';
        // 深色模式已移除：强制浅色并清理旧开关残留
        localStorage.removeItem('chat_theme_mode');
        document.documentElement.dataset.mode = 'light';

        const savedColor = localStorage.getItem('chat_theme_color');
        if (savedColor) {
            document.documentElement.style.setProperty('--bubble-color', savedColor);
            document.documentElement.style.setProperty('--bubble-bg', savedColor);
            const sel = document.getElementById('color-selector');
            if (sel) sel.value = savedColor;
        }

        isSpeedMode = localStorage.getItem('chat_speed_mode') === '1';
        const speedToggle = document.getElementById('speed-mode-toggle');
        if (speedToggle) speedToggle.checked = isSpeedMode;

        isPollingEnabled = localStorage.getItem('chat_polling_enabled') === '1';
        const pollingToggle = document.getElementById('polling-toggle');
        if (pollingToggle) pollingToggle.checked = isPollingEnabled;

        window.addEventListener('online', () => {
            if (roomSubscription && !presenceActive) setPresenceActive(true);
        });
        window.addEventListener('offline', () => {
            if (roomSubscription && presenceActive) setPresenceActive(false);
        });
    };

    function endContinuation() {
        if (continuationPolling) {
            clearInterval(continuationPolling);
            continuationPolling = null;
        }
        if (continuationWarningTimer) {
            clearTimeout(continuationWarningTimer);
            continuationWarningTimer = null;
        }
        const token = continuationToken;
        continuationToken = null;
        continuationCursor = 0;
        continuationOldestCursor = 0;
        continuationPhrase = null;
        continuationCryptoKey = null;
        if (token) {
            insertLoginLog('hidden_room_exit', currentRoomCode);
            callServerAction(null, 'session-close', { continuation: token })
                .catch(error => console.warn('Continuation cleanup failed:', error));
        }
        ['voice-btn', 'add-btn', 'settings-btn', 'online-count'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
        const restoreInput = document.getElementById('message-input');
        if (restoreInput) restoreInput.placeholder = '输入消息并按回车...';
        document.body.classList.remove('in-hidden-room');
    }

    function startContinuation(token) {
        // 保存刚派生的加密密钥（endContinuation 会清空它）
        const savedKey = continuationCryptoKey;
        const savedPhrase = continuationPhrase;
        if (roomSubscription) {
            roomSubscription.unsubscribe();
            roomSubscription = null;
        }
        stopPolling(true);
        if (selectionMode) clearSelectionMode();
        presenceActive = false;
        endContinuation();
        continuationCryptoKey = savedKey;
        continuationPhrase = savedPhrase;
        continuationToken = token;
        isFetchingHistory = false;
        continuationCursor = 0;
        continuationOldestCursor = 0;
        messagesCache = [];
        oldestLoadedAt = null;
        noMoreHistory = false;
        lastKnownMessageId = null;
        document.getElementById('chat-box').innerHTML = '';
        document.body.classList.add('in-hidden-room');
        insertLoginLog('hidden_room_enter', currentRoomCode);
        // 端到端加密需要 crypto.subtle（仅安全上下文 HTTPS/localhost 可用）
        if (!continuationCryptoKey) {
            showToast('⚠️ 当前环境不支持加密（需 HTTPS），消息将以明文发送', 'error', 8000);
        }
        // 会话说明卡片（仅本地渲染，不入库）
        const hintCard = document.createElement('div');
        hintCard.className = 'msg-wrapper system-msg-wrapper';
        hintCard.innerHTML = `<div class="system-msg-card">
            <b>🔒 独立会话（端到端加密）</b><br>
            · 消息端到端加密，数据库仅存密文<br>
            · 这里与房间消息完全隔离，仅进入者可见<br>
            · 消息保留 2 天，到期自动删除<br>
            · 会话 10 分钟后过期，重新发送暗号可再次进入<br>
            · <b>修改暗号</b>：发送 <b>改暗号 新暗号</b>（改暗号会清空历史消息）
        </div>`;
        document.getElementById('chat-box').appendChild(hintCard);
        const mi = document.getElementById('message-input');
        if (mi) mi.placeholder = '输入消息…发送「改暗号 新暗号」可修改暗号';
        ['voice-btn', 'add-btn', 'settings-btn', 'online-count'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        const tokenAtStart = continuationToken;
        // 会话剩 2 分钟时弹出预警
        if (continuationWarningTimer) clearTimeout(continuationWarningTimer);
        continuationWarningTimer = setTimeout(() => {
            if (continuationToken === tokenAtStart) {
                showToast('⏰ 会话还有 2 分钟过期，发送暗号可续期', 'info', 8000);
            }
        }, 8 * 60 * 1000);
        loadHistory(true).finally(() => {
            if (continuationToken === tokenAtStart && !continuationPolling) {
                continuationPolling = setInterval(loadContinuationUpdates, 4000);
            }
        });
    }

    async function loadContinuationUpdates() {
        if (!continuationToken) return;
        const token = continuationToken;
        try {
            const result = await callServerAction(null, 'session-updates', {
                continuation: token,
                cursor: continuationCursor
            });
            if (continuationToken !== token) return;
            for (const message of result.messages || []) {
                let displayText = message.content || '';
                if (message.sender !== 'system' && displayText.startsWith('enc:') && continuationCryptoKey) {
                    try {
                        displayText = await decryptText(continuationCryptoKey, displayText);
                    } catch (e) {
                        displayText = '[无法解密的消息]';
                    }
                }
                appendMessageToUI(`c_${message.id}`, message.sender, escapeHtml(displayText), true, message.created_at);
                continuationCursor = Math.max(continuationCursor, Number(message.id) || 0);
            }
            if (result.messages && result.messages.length) {
                document.getElementById('chat-box').scrollTop = document.getElementById('chat-box').scrollHeight;
            }
        } catch (error) {
            if (continuationToken !== token) return;
            console.error('Continuation update failed:', error);
            const room = currentRoomCode;
            endContinuation();
            showToast('当前会话已失效，请重新发送消息', 'error');
            if (room) window.joinRoom(room);
        }
    }

    async function loadContinuationHistory(isInitial) {
        if (!continuationToken || isFetchingHistory) return;
        const token = continuationToken;
        isFetchingHistory = true;
        const chatBox = document.getElementById('chat-box');
        if (isInitial) {
            // 独立会话首次加载：保留提示卡片，不清空
            if (!continuationToken) chatBox.innerHTML = '';
            messagesCache = [];
            continuationCursor = 0;
            continuationOldestCursor = 0;
            noMoreHistory = false;
        }
        try {
            const result = await callServerAction(null, 'session-history', {
                continuation: token,
                cursor: isInitial ? null : continuationOldestCursor
            });
            if (continuationToken !== token) return;
            const messages = result.messages || [];
            if (!messages.length) {
                noMoreHistory = true;
                return;
            }
            const renderMessages = isInitial ? messages : [...messages].reverse();
            for (const message of renderMessages) {
                let displayText = message.content || '';
                // 系统消息不加密；普通消息尝试解密（兼容旧明文）
                if (message.sender !== 'system' && displayText.startsWith('enc:') && continuationCryptoKey) {
                    try {
                        displayText = await decryptText(continuationCryptoKey, displayText);
                    } catch (e) {
                        displayText = '[无法解密的消息]';
                    }
                }
                appendMessageToUI(`c_${message.id}`, message.sender, escapeHtml(displayText), false, message.created_at, null, null, !isInitial);
            }
            continuationOldestCursor = Number(messages[0].id) || continuationOldestCursor;
            continuationCursor = Math.max(continuationCursor, Number(messages[messages.length - 1].id) || 0);
            if (messages.length < PAGE_SIZE) noMoreHistory = true;
            if (isInitial) chatBox.scrollTop = chatBox.scrollHeight;
        } catch (error) {
            if (continuationToken === token) {
                console.error('Continuation history failed:', error);
                const room = currentRoomCode;
                endContinuation();
                showToast('当前会话已失效，请重新发送消息', 'error');
                if (room) window.joinRoom(room);
            }
        } finally {
            isFetchingHistory = false;
        }
    }

    window.joinRoom = async function(codeOverride) {
        endContinuation();
        // 账号系统：昵称强制使用已登录账号，未登录先弹登录层（记住目标房间，登录后自动继续）
        const nameInput = getLoggedInUser();
        const wantedCode = String(codeOverride || pendingUrlRoom || '').trim();
        if (!nameInput) { pendingUrlRoom = wantedCode; showAuthOverlay(); return; }
        const prevRoomCode = currentRoomCode; // 聊天中切换房间失败时用于回退
        currentRoomCode = wantedCode || currentRoomCode;
        pendingUrlRoom = '';

        if (!/^[a-zA-Z0-9\s\W]+$/.test(currentRoomCode)) {
            currentRoomCode = prevRoomCode;
            return showToast("房间代码格式不正确，请只使用字母、数字或符号。", 'error');
        }

        if (!nameInput || !currentRoomCode) {
            currentRoomCode = prevRoomCode;
            return showToast("请输入名字和房间代码", 'error');
        }

        // 聊天中切换房间失败时留在原房间（不踢回登录页）
        const switchingInChat = !!prevRoomCode && document.getElementById('chat-container').style.display === 'flex';
        // 回退时恢复“自动进入房间”目标为原房间
        const revertToPrev = () => {
            currentRoomCode = prevRoomCode;
            localStorage.setItem('chat_last_room', prevRoomCode);
            if (isDesktopLayout()) renderRoomSidebar();
        };

        localStorage.setItem('chat_auth_token', nameInput);
        mySender = nameInput;

        const expiryTime = new Date().getTime() + (10 * 24 * 60 * 60 * 1000);
        localStorage.setItem('chat_last_room', currentRoomCode);
        localStorage.setItem('chat_auth_expiry', expiryTime.toString());

        try {
            // ====== 成员白名单 + 审批检查 ======
            const join = await evaluateJoinStatus(currentRoomCode, mySender);

            if (join.status === 'member' || join.status === 'new_room') {
                // 成员 / 全新房间：直接进入
                if (join.status === 'new_room') {
                    // 全新房间，自动加入为第一个成员
                    await supabaseClient.from('room_members')
                        .upsert([{ room_code: currentRoomCode, user_name: mySender }],
                            { onConflict: 'room_code,user_name' });
                }
                stopJoinWaitWatcher();
                hideApplyScreen();
                document.getElementById('login-area').style.display = 'none';
                showRoomLoading();
                setRoomTitle(currentRoomCode);
                await actuallyEnterRoom(prevRoomCode);
            } else if (join.status === 'pending') {
                if (switchingInChat) {
                    revertToPrev();
                    showToast('该房间的加入申请审核中，请等待成员审批', 'info', 3000);
                    return;
                }
                // 已有进行中的申请：进入等待页
                document.getElementById('login-area').style.display = 'none';
                showApplyScreen();
                renderWaitingScreen(currentRoomCode, mySender, join.requestId,
                    join.approveCount || 0, join.totalMembers);
            } else if (join.status === 'approved') {
                // 之前已被批准但可能未自动写入成员 → 补一下
                await supabaseClient.from('room_members')
                    .upsert([{ room_code: currentRoomCode, user_name: mySender }],
                        { onConflict: 'room_code,user_name' });
                document.getElementById('login-area').style.display = 'none';
                showRoomLoading();
                setRoomTitle(currentRoomCode);
                await actuallyEnterRoom(prevRoomCode);
            } else if (join.status === 'rejected') {
                if (switchingInChat) {
                    revertToPrev();
                    showToast('你之前的加入申请被拒绝了，无法加入该房间', 'error', 3000);
                    return;
                }
                // 之前被拒：用申请屏提示可重新发起
                document.getElementById('login-area').style.display = 'none';
                showApplyScreen(`
                    <div class="apply-icon">🚫</div>
                    <h3>你之前的加入申请被拒绝了</h3>
                    <p>房间「${escapeHtml(currentRoomCode)}」暂时无法进入，可以重新发起申请。</p>
                    <button onclick="window.reapplyJoin()">申请重新加入</button>
                `);
            } else {
                // 'none'：房间存在但用户不是成员，需要申请加入
                if (switchingInChat) {
                    revertToPrev();
                    showToast('你不是该房间的成员，加入需要成员审批', 'error', 3000);
                    return;
                }
                document.getElementById('login-area').style.display = 'none';
                const totalMembers = join.totalMembers || 0;
                const need = votesNeeded(totalMembers);
                showApplyScreen(`
                    <div class="apply-icon">🙋</div>
                    <h3>加入房间「${escapeHtml(currentRoomCode)}」需要审批</h3>
                    <p>你不是该房间的成员（当前共 <b>${totalMembers}</b> 名成员）。<br>加入需要超过 1/2（即 <b>${need}</b> 票）现有成员同意。</p>
                    <button onclick="window.requestJoinRoom()">🙋 申请加入房间</button>
                `);
            }
        } catch (e) {
            console.error('加入房间检查失败:', e);
            showToast('加入房间检查失败：' + (e.message || ''), 'error');
        }
    };

    /**
     * 「申请加入」：发起申请 → 进入等待页
     */
    window.requestJoinRoom = async function() {
        const name = getLoggedInUser();
        const room = currentRoomCode;
        if (!name || !room) return showToast('请先登录并输入房间代码', 'error');
        try {
            const res = await submitJoinRequest(room, name);
            if (!res.ok) {
                showToast('提交申请失败：' + (res.message || res.reason || '未知错误'), 'error');
                return;
            }
            // 进入等待页
            document.getElementById('login-area').style.display = 'none';
            showApplyScreen();
            const totalMembers = await getRoomMemberCount(room);
            renderWaitingScreen(room, name, res.requestId, 0, totalMembers);
        } catch (e) {
            console.error('申请失败:', e);
            showToast('申请失败：' + (e.message || ''), 'error');
        }
    };

    /** 被拒后重新申请 */
    window.reapplyJoin = async function() {
        const name = getLoggedInUser();
        const room = currentRoomCode;
        if (!name || !room) return showToast('请先登录并输入房间代码', 'error');
        try {
            const res = await submitJoinRequest(room, name);
            if (!res.ok) {
                showToast('重新申请失败：' + (res.message || res.reason || ''), 'error');
                return;
            }
            document.getElementById('login-area').style.display = 'none';
            showApplyScreen();
            const totalMembers = await getRoomMemberCount(room);
            renderWaitingScreen(room, name, res.requestId, 0, totalMembers);
        } catch (e) {
            console.error('重新申请失败:', e);
            showToast('重新申请失败：' + (e.message || ''), 'error');
        }
    };

    async function ensureRoomExists() {
        const { data: room, error } = await supabaseClient
            .from('rooms')
            .select('room_code,room_name')
            .eq('room_code', currentRoomCode)
            .single();

        if (error || !room) {
            const { error: insertError } = await supabaseClient
                .from('rooms')
                .insert([{ room_code: currentRoomCode, room_name: currentRoomCode }]);
            if (insertError && insertError.code !== '23505') throw insertError;
        } else {
            setRoomTitle(room.room_name || currentRoomCode);
        }

    }

    // ============================================
    // 房间成员白名单 + 加入审批
    // ============================================

    /** 查询当前房间的成员总数（用于计算投票阈值） */
    async function getRoomMemberCount(roomCode) {
        const { count, error } = await supabaseClient
            .from('room_members')
            .select('user_name', { count: 'exact', head: true })
            .eq('room_code', roomCode);
        if (error) { console.warn('[members] count error:', error); return 0; }
        return count || 0;
    }

    /** 查询用户在某房间的成员身份 */
    async function checkRoomMembership(roomCode, userName) {
        const { data, error } = await supabaseClient
            .from('room_members')
            .select('user_name')
            .eq('room_code', roomCode)
            .eq('user_name', userName)
            .maybeSingle();
        if (error) { console.warn('[members] check error:', error); return false; }
        return !!data;
    }

    /** 查询某房间某用户的最新加入申请状态（pending 优先，其次按时间倒序） */
    async function getLatestJoinRequest(roomCode, userName) {
        const { data, error } = await supabaseClient
            .from('join_requests')
            .select('id,room_code,user_name,status,created_at,resolved_at')
            .eq('room_code', roomCode)
            .eq('user_name', userName)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) { console.warn('[join] query error:', error); return null; }
        return data;
    }

    /** 查询某条申请的所有投票 */
    async function getJoinVotes(requestId) {
        const { data, error } = await supabaseClient
            .from('join_votes')
            .select('voter,vote,voted_at')
            .eq('request_id', requestId);
        if (error) { console.warn('[votes] query error:', error); return []; }
        return data || [];
    }

    /** 计算审批阈值：需要 approvals > totalMembers / 2 */
    function votesNeeded(totalMembers) {
        return Math.floor(totalMembers / 2) + 1; // > N/2 等价于 ≥ floor(N/2)+1
    }

    /**
     * 完整加入流程：
     * 1) 成员白名单命中 → 'member'
     * 2) 房间在白名单里无任何成员（全新房间）→ 'new_room'（自动添加为第一个成员）
     * 3) 已有 pending 申请 → 'pending'（请求展示 id）
     * 4) 已有 approved 申请（但还没写入 room_members，可能是并发或之前未自动同步）→ 'approved'
     * 5) 否则 → 'none'（需申请）
     */
    async function evaluateJoinStatus(roomCode, userName) {
        const isMember = await checkRoomMembership(roomCode, userName);
        if (isMember) return { status: 'member' };
        const totalMembers = await getRoomMemberCount(roomCode);
        if (totalMembers === 0) return { status: 'new_room', totalMembers: 0 };
        const req = await getLatestJoinRequest(roomCode, userName);
        if (!req) return { status: 'none', totalMembers };
        const votes = req.status === 'pending' ? await getJoinVotes(req.id) : [];
        const approveCount = votes.filter(v => v.vote === 'approve').length;
        const rejectCount = votes.filter(v => v.vote === 'reject').length;
        return {
            status: req.status,            // pending | approved | rejected
            requestId: req.id,
            totalMembers,
            approveCount,
            rejectCount,
            createdAt: req.created_at
        };
    }

    /** 申请人提交申请 → 写入 join_requests 并发系统消息 */
    async function submitJoinRequest(roomCode, userName) {
        // 防止重复：先查 latest
        const existing = await getLatestJoinRequest(roomCode, userName);
        if (existing && existing.status === 'pending') {
            return { ok: false, reason: 'already_pending', requestId: existing.id };
        }
        // 如果之前被拒过或已批准，则覆盖为新的一条 pending
        const { data, error } = await supabaseClient
            .from('join_requests')
            .insert([{ room_code: roomCode, user_name: userName, status: 'pending' }])
            .select()
            .single();
        if (error) {
            console.warn('[join] insert error:', error);
            // 如果触发器报「已有进行中」也算已有
            if (error.code === 'P0001' || (error.message || '').includes('进行中')) {
                const cur = await getLatestJoinRequest(roomCode, userName);
                if (cur && cur.status === 'pending') return { ok: true, requestId: cur.id };
            }
            return { ok: false, reason: 'db_error', message: error.message };
        }
        // 系统消息：广播给现有成员（写入 messages 表，所有订阅者都会收到）
        const sysMsg = `🙋 [新用户申请] ${userName} 请求加入本房间，老用户可投票（需超过 1/2 同意）`;
        try {
            await supabaseClient.from('messages').insert([{
                room_code: roomCode,
                sender: 'system',
                content: sysMsg,
                media_url: null,
                media_type: 'system_join_request:' + data.id   // 用 media_type 编码 request id，便于渲染投票 UI
            }]);
        } catch (e) { console.warn('[join] broadcast message failed:', e); }
        // ====== 触发站外通知（新用户申请加入）======
        try {
            window.triggerExternalNotify('join_request', {
                room_code: roomCode,
                sender: userName,
                request_id: data.id,
            });
        } catch (eJ) { console.warn('[extn] join_request trigger error:', eJ); }
        return { ok: true, requestId: data.id };
    }

    /** 老用户投票：写入 join_votes（已投过则覆盖原票） */
    async function castJoinVote(requestId, voter, vote) {
        if (vote !== 'approve' && vote !== 'reject') return { ok: false };
        const { error } = await supabaseClient
            .from('join_votes')
            .upsert([{ request_id: requestId, voter: voter, vote: vote, voted_at: new Date().toISOString() }],
                { onConflict: 'request_id,voter' });
        if (error) { console.warn('[vote] insert error:', error); return { ok: false, message: error.message }; }
        // 投票后立即评估是否够阈值
        await evaluateAndResolveRequest(requestId);
        return { ok: true };
    }

    /**
     * 评估某条申请：阈值达成则批准、自动入群、广播系统消息
     */
    async function evaluateAndResolveRequest(requestId) {
        try {
            const { data: req, error: reqErr } = await supabaseClient
                .from('join_requests')
                .select('id,room_code,user_name,status')
                .eq('id', requestId)
                .single();
            if (reqErr || !req) return;
            if (req.status !== 'pending') return;
            const totalMembers = await getRoomMemberCount(req.room_code);
            if (totalMembers === 0) {
                // 极端情况：房间白名单空了（不应该发生），先按 1 算
            }
            const votes = await getJoinVotes(requestId);
            const approveCount = votes.filter(v => v.vote === 'approve').length;
            const needed = votesNeeded(totalMembers);
            if (approveCount >= needed) {
                // 标记 approved
                await supabaseClient.from('join_requests')
                    .update({ status: 'approved', resolved_at: new Date().toISOString() })
                    .eq('id', requestId);
                // 写入 room_members（如果尚未存在）
                await supabaseClient.from('room_members')
                    .upsert([{ room_code: req.room_code, user_name: req.user_name }],
                        { onConflict: 'room_code,user_name' });
                // 广播系统消息
                try {
                    await supabaseClient.from('messages').insert([{
                        room_code: req.room_code,
                        sender: 'system',
                        content: `✅ ${req.user_name} 已通过审批加入房间`,
                        media_url: null,
                        media_type: 'system_join_approved:' + requestId
                    }]);
                } catch (e) { console.warn('[join] approval broadcast failed:', e); }
            }
        } catch (e) {
            console.warn('[join] evaluate error:', e);
        }
    }

    /** 显示申请/等待屏幕 */
    function showApplyScreen(contentHtml) {
        const screen = document.getElementById('apply-screen');
        const login = document.getElementById('login-area');
        document.getElementById('apply-card-content').innerHTML = contentHtml;
        screen.style.display = 'flex';
        if (login) login.style.display = 'none';
        document.getElementById('chat-container').style.display = 'none';
    }

    function hideApplyScreen() {
        const screen = document.getElementById('apply-screen');
        screen.style.display = 'none';
    }

    /**
     * 渲染申请等待页（含实时进度）
     * @param roomCode 房间代码
     * @param userName 申请者
     * @param requestId 当前申请 ID
     * @param initialApproveCount 初始已同意票数
     * @param totalMembers 房间总成员数
     */
    function renderWaitingScreen(roomCode, userName, requestId, initialApproveCount, totalMembers) {
        function paint(approveCount, memberCount) {
            const need = votesNeeded(memberCount);
            const have = Math.min(approveCount, need);
            const pct = Math.min(100, Math.round(have / need * 100));
            const remaining = Math.max(0, need - approveCount);
            const html = `
                <div class="apply-icon">⏳</div>
                <h3>正在等待房间「${escapeHtml(roomCode)}」的成员审批</h3>
                <p>共 <b>${memberCount}</b> 名现有成员，需要超过 1/2（即 <b>${need}</b> 票）同意才能通过。</p>
                <div class="apply-progress">
                    <div class="apply-progress-row">
                        <span>当前进度</span>
                        <span>${approveCount} / ${need}</span>
                    </div>
                    <div class="apply-bar"><div class="apply-bar-fill" style="width:${pct}%;"></div></div>
                    <div class="apply-detail">
                        ${remaining > 0
                            ? '还差 <b>' + remaining + '</b> 票同意'
                            : '🎉 票数已满足，正在进入房间…'}
                    </div>
                </div>
                <p style="font-size:12px;color:var(--muted);margin-top:6px;">
                    不用刷新页面，审批通过后会自动进入。
                </p>
                <button class="apply-back" onclick="window.cancelJoinWait()">取消申请</button>
            `;
            document.getElementById('apply-card-content').innerHTML = html;
        }
        paint(initialApproveCount, totalMembers);
        // 订阅 join_requests 和 join_votes
        if (window.__joinWaitChannel) {
            try { supabaseClient.removeChannel(window.__joinWaitChannel); } catch (e) {}
        }
        const channel = supabaseClient.channel('join_wait_' + requestId)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'join_requests', filter: 'id=eq.' + requestId }, async (payload) => {
                if (payload.new && payload.new.status === 'approved') {
                    // 被批准：写入成员 + 跳转
                    await supabaseClient.from('room_members')
                        .upsert([{ room_code: roomCode, user_name: userName }], { onConflict: 'room_code,user_name' });
                    stopJoinWaitWatcher();
                    hideApplyScreen();
                    showToast('🎉 你已通过审批，欢迎加入房间！', 'success', 3000);
                    actuallyEnterRoom();
                }
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'join_votes', filter: 'request_id=eq.' + requestId }, async () => {
                const votes = await getJoinVotes(requestId);
                const approveCount = votes.filter(v => v.vote === 'approve').length;
                const mc = await getRoomMemberCount(roomCode);
                paint(approveCount, mc);
            })
            .subscribe();
        window.__joinWaitChannel = channel;
    }

    function stopJoinWaitWatcher() {
        if (window.__joinWaitChannel) {
            try { supabaseClient.removeChannel(window.__joinWaitChannel); } catch (e) {}
            window.__joinWaitChannel = null;
        }
    }

    window.cancelJoinWait = async function() {
        stopJoinWaitWatcher();
        hideApplyScreen();
        backToLoginArea();
        showToast('已取消申请', 'info', 1800);
    };

    /**
     * 渲染一条加入申请卡片（用于聊天内的 system 消息）
     * @param requestId 申请 ID
     * @param requesterName 申请者名字
     * @param currentUserIsMember 当前用户是否是房间成员
     * @param currentVoterVote 当前用户的票（'approve' | 'reject' | null）
     */
    function renderJoinRequestCard(requestId, requesterName, currentUserIsMember, currentVoterVote) {
        const card = document.createElement('div');
        card.className = 'join-request-card';
        card.dataset.joinRequestId = String(requestId);
        card.innerHTML = `
            <div class="jr-head">
                <span class="jr-icon">🙋</span>
                <span>新用户 <b>${escapeHtml(requesterName)}</b> 请求加入本房间</span>
            </div>
            <div class="jr-meta" data-role="meta">老用户可投票，需要超过 1/2 同意</div>
            <div class="jr-progress" data-role="progress-wrap"><div class="jr-progress-bar" data-role="progress-bar" style="width:0%;"></div></div>
            <div class="jr-vote-btns-locked" data-role="locked" style="display:none;">你不是本房间成员，无法投票</div>
            <div class="jr-actions" data-role="actions" style="display:none;">
                <button class="jr-vote-btn jr-approve" data-vote="approve">👍 同意</button>
                <button class="jr-vote-btn jr-reject" data-vote="reject">👎 拒绝</button>
            </div>
        `;
        if (!currentUserIsMember) {
            card.querySelector('[data-role="locked"]').style.display = '';
        } else {
            const actions = card.querySelector('[data-role="actions"]');
            actions.style.display = '';
            const approveBtn = card.querySelector('.jr-approve');
            const rejectBtn = card.querySelector('.jr-reject');
            if (currentVoterVote === 'approve') approveBtn.classList.add('voted');
            if (currentVoterVote === 'reject') rejectBtn.classList.add('voted');
            approveBtn.addEventListener('click', async function() {
                if (approveBtn.disabled) return;
                approveBtn.disabled = true; rejectBtn.disabled = true;
                const res = await castJoinVote(requestId, mySender, 'approve');
                if (res.ok) {
                    approveBtn.classList.add('voted');
                    rejectBtn.classList.remove('voted');
                }
                approveBtn.disabled = false; rejectBtn.disabled = false;
            });
            rejectBtn.addEventListener('click', async function() {
                if (rejectBtn.disabled) return;
                approveBtn.disabled = true; rejectBtn.disabled = true;
                const res = await castJoinVote(requestId, mySender, 'reject');
                if (res.ok) {
                    rejectBtn.classList.add('voted');
                    approveBtn.classList.remove('voted');
                }
                approveBtn.disabled = false; rejectBtn.disabled = false;
            });
        }
        // 立即拉一次最新进度
        refreshJoinRequestCardProgress(card, requestId);
        return card;
    }

    async function refreshJoinRequestCardProgress(card, requestId) {
        try {
            const votes = await getJoinVotes(requestId);
            const approveCount = votes.filter(v => v.vote === 'approve').length;
            const memberCount = await getRoomMemberCount(currentRoomCode);
            const need = votesNeeded(memberCount);
            const pct = Math.min(100, Math.round(approveCount / need * 100));
            const bar = card.querySelector('[data-role="progress-bar"]');
            const meta = card.querySelector('[data-role="meta"]');
            if (bar) bar.style.width = pct + '%';
            if (meta) meta.innerText = `当前进度：${approveCount} / ${need} 票${memberCount > 0 ? `（房间共 ${memberCount} 人）` : ''}`;
        } catch (e) { console.warn('[join] refresh progress failed:', e); }
    }

    /**
     * 真正进入房间（成员审批通过 / 全新房间自动加入时调用）
     */
    async function actuallyEnterRoom(previousRoomCode = '') {
        // 此函数复用 joinRoom 后半段（消息加载 + realtime）
        try {
            await loadHistory(true);
            hideRoomLoading();
            if (isDesktopLayout()) renderRoomSidebar(); // 进入房间后刷新左侧栏（高亮当前房间）
            logJoinRoom('manual');
            setTimeout(() => { document.getElementById('message-input').focus(); }, 100);
            ensureRoomExists().catch(e => console.warn('ensureRoomExists failed:', e));
            initRealtime();
            realtimeReady.catch(() => startPolling());
            if (isPollingEnabled) startPolling();
        } catch (error) {
            console.error('进入房间失败:', error);
            if (previousRoomCode) {
                currentRoomCode = previousRoomCode;
                localStorage.setItem('chat_last_room', previousRoomCode);
                setRoomTitle(previousRoomCode);
            }
            const keepDesktopShell = isDesktopLayout() && document.getElementById('chat-container').style.display === 'flex';
            hideRoomLoading();
            if (keepDesktopShell) {
                document.body.classList.add('in-chat-desktop');
                renderRoomSidebar();
                showToast('房间消息加载失败，请点击左侧房间重试。', 'error');
            } else {
                backToLoginArea();
            }
            if (!keepDesktopShell) showToast('进入房间失败，请检查网络后重试。', 'error');
        }
    }

    /**
     * 加载历史消息后，把已存在的 pending 申请也渲染为可投票卡片
     */
    async function decorateHistoryJoinRequests() {
        try {
            // 找出本房间所有 pending 申请
            const { data: pendingReqs } = await supabaseClient
                .from('join_requests')
                .select('id,room_code,user_name,status')
                .eq('room_code', currentRoomCode)
                .eq('status', 'pending');
            if (!pendingReqs || pendingReqs.length === 0) {
                window.__joinReqIdsCache = [];
                return;
            }
            window.__joinReqIdsCache = pendingReqs.map(r => r.id);
            // 找出当前用户已投的票
            const reqIds = pendingReqs.map(r => r.id);
            const { data: myVotes } = await supabaseClient
                .from('join_votes')
                .select('request_id,vote')
                .in('request_id', reqIds)
                .eq('voter', mySender);
            const myVoteMap = {};
            (myVotes || []).forEach(v => { myVoteMap[v.request_id] = v.vote; });
            // 在聊天框里查找对应的 system 消息位置；如果找不到就在顶部插入
            const chatBox = document.getElementById('chat-box');
            for (const r of pendingReqs) {
                const card = renderJoinRequestCard(r.id, r.user_name, true, myVoteMap[r.id] || null);
                // 尝试插入到对应的 system message 后面
                const sysMsgs = chatBox.querySelectorAll('.system-message');
                let inserted = false;
                for (const sm of sysMsgs) {
                    if (sm.textContent && sm.textContent.indexOf('[' + r.user_name + ']') !== -1 &&
                        sm.textContent.indexOf('请求加入') !== -1) {
                        sm.insertAdjacentElement('afterend', card);
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) chatBox.appendChild(card);
            }
        } catch (e) { console.warn('[join] decorate history error:', e); }
    }

    /**
     * 加载历史记录逻辑
     * @param {boolean} isInitial - 是否为初始加载（如果是，则只显示最新的30条）
     */
    async function loadHistory(isInitial = true) {
        if (continuationToken) {
            await loadContinuationHistory(isInitial);
            return;
        }
        const roomAtStart = currentRoomCode;
        if (isInitial) {
            // 切换房间：打断上一次未完成的加载，立即清空消息区（旧结果会因下方房间校验被丢弃，避免串台）
            isFetchingHistory = false;
            document.getElementById('chat-box').innerHTML = '';
        }
        if (isFetchingHistory) return;
        isFetchingHistory = true;
        const chatBox = document.getElementById('chat-box');

        try {
            if (isInitial) {
                oldestLoadedAt = null;
                noMoreHistory = false;
                messagesCache = [];
                lastKnownMessageId = null; // 跨房间重置，避免新房间消息被误跳过

                let { data: recentData, error } = await supabaseClient
                    .from('messages')
                    .select('id,room_code,sender,content,media_url,media_type,created_at')
                    .eq('room_code', currentRoomCode)
                    .order('created_at', { ascending: false })
                    .limit(PAGE_SIZE);

                // 等待期间用户已切到其他房间：丢弃本次结果，避免旧房间消息渲染进新房
                if (continuationToken || currentRoomCode !== roomAtStart) {
                    isFetchingHistory = false;
                    return;
                }

                if (error) {
                    console.error('[chat] 查询消息失败:', error.message, error.code, error.details);
                    throw error;
                }

                if (!recentData || recentData.length === 0) {
                    console.warn('[chat] 未查询到任何消息，房间:', currentRoomCode);
                    if (!chatBox.children.length) {
                        chatBox.innerHTML = `
                            <div class="welcome-card">
                                <div class="welcome-badge" style="background:${hashGradient(currentRoomCode || 'chat')}">${escapeHtml(String(currentRoomCode || '?').slice(0, 1).toUpperCase())}</div>
                                <h3>欢迎来到房间 ${escapeHtml(currentRoomCode || '')}</h3>
                                <p>这里还一片安静。<br>发送第一条消息，开启你们的话题吧。</p>
                                <div class="welcome-tips">
                                    <span class="welcome-tip">💬 文字</span>
                                    <span class="welcome-tip">🖼️ 图片</span>
                                    <span class="welcome-tip">🎙️ 语音</span>
                                    <span class="welcome-tip">🎮 小游戏</span>
                                </div>
                            </div>`;
                    }
                    noMoreHistory = true;
                    isFetchingHistory = false;
                    return;
                }

                const msgs = recentData.reverse();
                chatBox.innerHTML = "";
                const addedIds = new Set();
                msgs.forEach(msg => {
                    if (!addedIds.has(String(msg.id))) {
                        addedIds.add(String(msg.id));
                        appendMessageToUI(msg.id, msg.sender, msg.content, false, msg.created_at, msg.media_url, msg.media_type);
                    }
                });
                chatBox.scrollTop = chatBox.scrollHeight;
                oldestLoadedAt = msgs[0].created_at;
                noMoreHistory = msgs.length < PAGE_SIZE;
                if (!isSpeedMode) {
                    fetchAndApplyUserAvatars(msgs.map(m => m.sender));
                }
                // ====== 装饰：把已存在的 pending 申请渲染为可投票卡片 ======
                await decorateHistoryJoinRequests();
            } else {
                // 上拉加载：如果已经没有更多则直接返回
                if (noMoreHistory) {
                    isFetchingHistory = false;
                    return;
                }
                if (!oldestLoadedAt) {
                    isFetchingHistory = false;
                    return;
                }

                const prevScrollHeight = chatBox.scrollHeight;
                const prevScrollTop = chatBox.scrollTop;

                let { data: olderData, error } = await supabaseClient
                    .from('messages')
                    .select('id,room_code,sender,content,media_url,media_type,created_at')
                    .eq('room_code', currentRoomCode)
                    .lt('created_at', oldestLoadedAt)
                    .order('created_at', { ascending: false })
                    .limit(PAGE_SIZE);

                if (continuationToken || currentRoomCode !== roomAtStart) return;
                if (error) throw error;
                if (olderData) {
                    if (olderData.length === 0) {
                        noMoreHistory = true;
                        isFetchingHistory = false;
                        return;
                    }

                    const msgs = olderData.reverse();
                    const existingIds = new Set();
                    chatBox.querySelectorAll('.msg-wrapper[data-msg-id]').forEach(el => existingIds.add(el.dataset.msgId));
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        const msg = msgs[i];
                        if (!existingIds.has(String(msg.id))) {
                            appendMessageToUI(msg.id, msg.sender, msg.content, false, msg.created_at, msg.media_url, msg.media_type, true, true);
                        }
                    }
                    refreshMessageAvatars();

                    // 更新最早时间戳
                    oldestLoadedAt = msgs[0].created_at;

                    // 保持滚动位置，使用户看到与之前相同位置的消息
                    const newScrollHeight = chatBox.scrollHeight;
                    chatBox.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;

                    if (olderData.length < PAGE_SIZE) noMoreHistory = true;
                    if (!isSpeedMode) {
                        const senders = msgs.map(m => m.sender);
                        fetchAndApplyUserAvatars(senders);
                    }
                }
            }
        } catch (e) {
            console.error("LoadHistory Error:", e);
            const errorBox = document.getElementById('chat-box');
            if (errorBox && !errorBox.children.length) {
                errorBox.innerHTML = '<div style="padding:18px; text-align:center; color:var(--muted); font-size:13px;">历史消息加载失败，请检查网络后重试</div>';
            }
        } finally {
            isFetchingHistory = false;
        }
    }

    // 上拉监听逻辑（防抖）
    const chatBox = document.getElementById('chat-box');
    let scrollDebounceTimer = null;
    chatBox.addEventListener('scroll', () => {
        if (scrollDebounceTimer) return;
        if (chatBox.scrollTop <= 10 && !isFetchingHistory && !noMoreHistory) {
            scrollDebounceTimer = setTimeout(() => {
                scrollDebounceTimer = null;
                loadHistory(false);
            }, 300);
        }
    });

    function initRealtime() {
        if (continuationToken) return;
        stopPolling();
        if (roomSubscription) roomSubscription.unsubscribe();
        presenceActive = false;
        realtimeReady = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                console.warn('Realtime 连接超时（10秒），将继续使用轮询');
                if (realtimePolling) return;
                startPolling();
                reject(new Error('实时连接超时'));
            }, 10000);
            realtimeReadyResolve = () => {
                clearTimeout(timeout);
                resolve();
            };
        });
        roomSubscription = supabaseClient.channel(`room_${currentRoomCode}`, {
            config: { presence: { key: `${currentRoomCode}:${mySender}` } }
        })
            .on('presence', { event: 'sync' }, updateOnlineCount)
            .on('broadcast', { event: 'room_name_update' }, (payload) => {
                const data = payload.payload || {};
                if (data.room === currentRoomCode && data.roomName) {
                    setRoomTitle(data.roomName);
                }
            })
            .on('broadcast', { event: 'avatar_update' }, (payload) => {
                if (isSpeedMode) return;
                const av = payload.payload || {};
                if (av.room === currentRoomCode && av.user && av.avatarUrl) {
                    localStorage.setItem(avatarStorageKey(av.user), av.avatarUrl);
                    const safeUser = av.user.replace(/"/g, '\\"');
                    document.querySelectorAll(`.message-avatar[data-sender="${safeUser}"]`).forEach(avatar => {
                        if (avatar.tagName === 'SPAN') {
                            const __img = document.createElement('img');
                            __img.className = 'message-avatar';
                            __img.src = av.avatarUrl;
                            __img.alt = av.user + '的头像';
                            __img.dataset.sender = av.user;
                            avatar.outerHTML = __img.outerHTML;
                        } else {
                            avatar.src = av.avatarUrl;
                        }
                    });
                }
            })
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'messages',
                filter: `room_code=eq.${currentRoomCode}`
            }, (payload) => {
                if (continuationToken) return;
                const existing = document.querySelector(`.msg-wrapper[data-msg-id="${payload.new.id}"]`);
                if (existing) return;
                if (payload.new.sender === mySender) {
                    const existingTemp = findTempMessage(payload.new.content, payload.new.created_at);
                    if (existingTemp && existingTemp.dataset.sending === 'true') {
                        existingTemp.dataset.msgId = String(payload.new.id);
                        existingTemp.dataset.sending = 'false';
                        const idx = messagesCache.findIndex(m => m.id && m.id.startsWith && m.id.startsWith('temp_') && m.sender === mySender);
                        if (idx >= 0) messagesCache[idx].id = payload.new.id;
                        existingTemp.style.opacity = '1';
                        existingTemp.title = '';
                        const statusEl = existingTemp.querySelector('.msg-send-status');
                        if (statusEl) {
                            statusEl.className = 'msg-send-status sent';
                            statusEl.innerText = '已发送';
                            statusEl.onclick = null;
                            setTimeout(() => { if (statusEl.parentNode) statusEl.style.display = 'none'; }, 3000);
                        }
                        return;
                    }
                    if (existingTemp && existingTemp.dataset.sending === 'false') return;
                }
                appendMessageToUI(payload.new.id, payload.new.sender, payload.new.content, true, payload.new.created_at, payload.new.media_url, payload.new.media_type);
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'rooms',
                filter: `room_code=eq.${currentRoomCode}`
            }, (payload) => {
                const room = payload.new;
                setRoomTitle(room.room_name || currentRoomCode);
            })
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'user_profiles',
                filter: `room_code=eq.${currentRoomCode}`
            }, (payload) => {
                if (payload.eventType === 'DELETE') return;
                if (isSpeedMode) return;
                const profile = payload.new;
                if (profile && profile.user_name && profile.avatar_url && profile.user_name !== mySender) {
                    localStorage.setItem(avatarStorageKey(profile.user_name), profile.avatar_url);
                    const safeUser = profile.user_name.replace(/"/g, '\\"');
                    document.querySelectorAll(`.message-avatar[data-sender="${safeUser}"]`).forEach(avatar => {
                        if (avatar.tagName === 'SPAN') {
                            const __img = document.createElement('img');
                            __img.className = 'message-avatar';
                            __img.src = profile.avatar_url;
                            __img.alt = profile.user_name + '的头像';
                            __img.dataset.sender = profile.user_name;
                            avatar.outerHTML = __img.outerHTML;
                        } else {
                            avatar.src = profile.avatar_url;
                        }
                    });
                }
            })
            // ====== 加入申请 / 投票 实时事件 ======
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'join_requests',
                filter: `room_code=eq.${currentRoomCode}`
            }, async (payload) => {
                const r = payload.new;
                if (!r || r.status !== 'pending') return;
                if (r.user_name === mySender) return; // 自己不看自己的请求（已在等待页）
                const card = renderJoinRequestCard(r.id, r.user_name, true, null);
                const chatBox = document.getElementById('chat-box');
                // 紧跟在对应 system message 后
                const sysMsgs = chatBox.querySelectorAll('.system-message');
                let inserted = false;
                for (const sm of sysMsgs) {
                    if (sm.textContent && sm.textContent.indexOf('[' + r.user_name + ']') !== -1 &&
                        sm.textContent.indexOf('请求加入') !== -1) {
                        sm.insertAdjacentElement('afterend', card);
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) {
                    chatBox.appendChild(card);
                }
                chatBox.scrollTop = chatBox.scrollHeight;
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'join_requests',
                filter: `room_code=eq.${currentRoomCode}`
            }, async (payload) => {
                const r = payload.new;
                if (!r) return;
                // 申请被批准后，刷新卡片样式
                const card = document.querySelector(`.join-request-card[data-join-request-id="${r.id}"]`);
                if (r.status === 'approved') {
                    if (card) {
                        card.classList.add('resolved');
                        card.querySelector('[data-role="actions"]').style.display = 'none';
                        card.querySelector('[data-role="locked"]').style.display = '';
                        card.querySelector('[data-role="locked"]').innerText = '✅ 已批准';
                    }
                } else if (r.status === 'rejected') {
                    if (card) {
                        card.classList.add('resolved');
                        card.querySelector('[data-role="actions"]').style.display = 'none';
                        card.querySelector('[data-role="locked"]').style.display = '';
                        card.querySelector('[data-role="locked"]').innerText = '❌ 已拒绝';
                    }
                }
            })
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'join_votes',
                filter: `request_id=in.(${window.__joinReqIdsCache ? window.__joinReqIdsCache.join(',') : '0'})`
            }, async (payload) => {
                // 重新刷新所有相关卡片进度
                const cards = document.querySelectorAll('.join-request-card');
                cards.forEach(card => {
                    const rid = parseInt(card.dataset.joinRequestId, 10);
                    if (rid) refreshJoinRequestCardProgress(card, rid);
                });
            })
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    stopPolling();
                    await setPresenceActive(true);
                    resetPresenceIdleTimer();
                    if (realtimeReadyResolve) realtimeReadyResolve();
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    console.warn('Realtime 断开，开启轮询兜底');
                    if (!realtimePolling) startPolling();
                    if (realtimeReadyResolve) {
                        try { realtimeReadyResolve(); } catch (e) {}
                    }
                }
            });

    }

    function startPolling() {
        if (continuationToken) return;
        if (realtimePolling) return;
        realtimePolling = setInterval(async () => {
            try {
                if (continuationToken) return;
                const roomAtStart = currentRoomCode;
                const { data, error } = await supabaseClient
                    .from('messages')
                    .select('*')
                    .eq('room_code', currentRoomCode)
                    .order('created_at', { ascending: false })
                    .limit(5);
                if (error) return;
                // 等待期间已切换房间：丢弃本次结果，避免旧房间消息串台
                if (continuationToken || currentRoomCode !== roomAtStart) return;
                if (data && data.length > 0) {
                    for (const msg of data.reverse()) {
                        const existing = document.querySelector(`.msg-wrapper[data-msg-id="${msg.id}"]`);
                        if (existing && (msg.is_recalled || msg.content === '[已撤回]')) {
                            const contentEl = existing.querySelector('.msg-content');
                            if (contentEl) {
                                contentEl.innerHTML = '<span style="opacity:0.5;font-style:italic;">此消息已被撤回</span>';
                            }
                            existing.querySelector('.msg-send-status')?.remove();
                            existing.querySelector('.msg-actions')?.remove();
                            continue;
                        }
                        if (existing) continue;
                        if (lastKnownMessageId && String(msg.id) === String(lastKnownMessageId)) continue;
                        if (msg.sender === mySender) {
                            const existingTemp = findTempMessage(msg.content, msg.created_at);
                            if (existingTemp) {
                                if (existingTemp.dataset.sending === 'true') {
                                    existingTemp.dataset.msgId = String(msg.id);
                                    existingTemp.dataset.sending = 'false';
                                    const statusEl = existingTemp.querySelector('.msg-send-status');
                                    if (statusEl) {
                                        statusEl.className = 'msg-send-status sent';
                                        statusEl.innerText = '已发送';
                                        statusEl.onclick = null;
                                        setTimeout(() => { if (statusEl.parentNode) statusEl.style.display = 'none'; }, 3000);
                                    }
                                }
                                continue;
                            }
                        }
                        appendMessageToUI(msg.id, msg.sender, msg.content, true, msg.created_at, msg.media_url, msg.media_type);
                    }
                    lastKnownMessageId = data[data.length - 1].id;
                }
            } catch (e) { /* ignore polling errors */ }
        }, 5000);
    }

    function stopPolling(force = false) {
        if (isPollingEnabled && !force) return;
        if (realtimePolling) {
            clearInterval(realtimePolling);
            realtimePolling = null;
        }
    }

    function updateOnlineCount() {
        const el = document.getElementById('online-count');
        if (!el) return;
        let count = 0;
        try {
            if (roomSubscription) {
                const state = roomSubscription.presenceState();
                if (state && typeof state === 'object') {
                    count = Object.keys(state).length;
                }
            }
        } catch (e) { /* presence state unavailable */ }
        el.innerText = `在线 ${presenceActive ? Math.max(1, count) : Math.max(0, count)} 人`;
    }

    async function setPresenceActive(active) {
        if (!roomSubscription || presenceActive === active) {
            updateOnlineCount();
            return;
        }
        presenceActive = active;
        if (active) {
            await roomSubscription.track({ user: mySender, room: currentRoomCode });
        } else {
            await roomSubscription.untrack();
        }
        updateOnlineCount();
    }

    function appendSystemMessage(text) {
        const chatBox = document.getElementById('chat-box');
        if (!chatBox || !text) return;
        const el = document.createElement('div');
        el.className = 'system-message';
        el.innerText = text;
        chatBox.appendChild(el);
        chatBox.scrollTop = chatBox.scrollHeight;
        return el;
    }

    function resetPresenceIdleTimer() {
        clearTimeout(presenceIdleTimer);
        if (!roomSubscription) return;
        if (!presenceActive) setPresenceActive(true);
        presenceIdleTimer = setTimeout(() => setPresenceActive(false), PRESENCE_IDLE_MS);
    }

    document.addEventListener('visibilitychange', () => {
        if (!roomSubscription) return;
        if (document.visibilityState === 'visible') {
            setPresenceActive(true);
            resetPresenceIdleTimer();
        } else {
            setPresenceActive(false);
        }
    });

    window.addEventListener('pagehide', () => {
        if (roomSubscription && presenceActive) setPresenceActive(false);
    });

    ['pointerdown', 'keydown', 'touchstart', 'input', 'scroll'].forEach((eventName) => {
        document.addEventListener(eventName, resetPresenceIdleTimer, { passive: true });
    });

    window.toggleAttachPanel = function() {
        const panel = document.getElementById('attach-panel');
        const emojiPanel = document.getElementById('emoji-panel');
        if (emojiPanel) emojiPanel.classList.remove('visible');
        panel.classList.toggle('visible');
    };

    window.closeAttachPanel = function() {
        const panel = document.getElementById('attach-panel');
        if (panel) panel.classList.remove('visible');
    };

    window.triggerImageUpload = function() {
        document.getElementById('file-input').click();
    };

    window.triggerFileUpload = function() {
        document.getElementById('file-input-generic').click();
    };

    window.openGamePanel = function() {
        const modal = document.getElementById('game-modal');
        if (modal) modal.style.display = 'flex';
    };

    window.closeGamePanel = function() {
        const modal = document.getElementById('game-modal');
        if (modal) modal.style.display = 'none';
    };

    const CHAT_EMOJIS = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🫡','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','👍','👎','👏','🙌','🙏','💪','❤️','💔','💯','✨','🎉','🔥','✅','❌','⭐','☀️','🌈'];
    function getRecentEmojis() {
        try {
            return JSON.parse(localStorage.getItem('chat_recent_emojis') || '[]');
        } catch (e) { return []; }
    }
    function saveRecentEmoji(emoji) {
        let recent = getRecentEmojis();
        recent = recent.filter(e => e !== emoji);
        recent.unshift(emoji);
        if (recent.length > 16) recent.pop();
        localStorage.setItem('chat_recent_emojis', JSON.stringify(recent));
    }
    function renderEmojiPanel() {
        const panel = document.getElementById('emoji-panel');
        if (!panel) return;
        panel.innerHTML = '';
        const recent = getRecentEmojis();
        const makeEmojiBtn = (emoji, isRecent) => {
            const button = document.createElement('button');
            button.className = 'emoji-item';
            if (isRecent) button.style.background = '#eef2ff';
            button.type = 'button';
            button.innerText = emoji;
            button.onclick = () => {
                const input = document.getElementById('message-input');
                const start = input.selectionStart;
                const end = input.selectionEnd;
                input.value = `${input.value.slice(0, start)}${emoji}${input.value.slice(end)}`;
                input.focus();
                input.selectionStart = input.selectionEnd = start + emoji.length;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                saveRecentEmoji(emoji);
            };
            return button;
        };
        if (recent.length > 0) {
            const recentLabel = document.createElement('div');
            recentLabel.style.cssText = 'grid-column:1/-1;font-size:11px;color:var(--muted);padding:4px 0 0;';
            recentLabel.innerText = '最近使用';
            panel.appendChild(recentLabel);
            recent.forEach(e => panel.appendChild(makeEmojiBtn(e, true)));
            const divider = document.createElement('div');
            divider.style.cssText = 'grid-column:1/-1;height:1px;background:var(--line);margin:4px 0;';
            panel.appendChild(divider);
        }
        CHAT_EMOJIS.forEach(e => panel.appendChild(makeEmojiBtn(e, false)));
    }
    window.toggleEmojiPanel = function(event) {
        event?.stopPropagation();
        const panel = document.getElementById('emoji-panel');
        const attachPanel = document.getElementById('attach-panel');
        if (attachPanel) attachPanel.classList.remove('visible');
        renderEmojiPanel();
        panel.classList.toggle('visible');
    };
    document.addEventListener('click', (event) => {
        const panel = document.getElementById('emoji-panel');
        if (panel && !panel.contains(event.target) && event.target.id !== 'emoji-btn') panel.classList.remove('visible');
        const attachPanel = document.getElementById('attach-panel');
        if (attachPanel && !attachPanel.contains(event.target) && event.target.id !== 'add-btn') attachPanel.classList.remove('visible');
    });

    // 上传单个媒体文件到 Supabase 存储桶，返回公开 URL
    async function uploadMediaToStorage(file) {
        const fileExt = (file.name.split('.').pop() || 'bin').toLowerCase();
        const fileName = `media_${Math.random().toString(36).substring(2, 10)}.${fileExt}`;
        const filePath = `chat_media/${fileName}`;
        const { error } = await supabaseClient
            .storage
            .from('chat_media')
            .upload(filePath, file);
        if (error) throw error;
        const { data: publicData } = await supabaseClient
            .storage
            .from('chat_media')
            .getPublicUrl(filePath);
        return publicData.publicUrl;
    }

    // 直接把单条媒体消息写入数据库（不依赖输入框/回复/全局 pendingMedia）
    async function insertMediaMessage(url, type, fileMeta) {
        const now = beijingISOString();
        const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        let finalContent = '';
        if (type === 'file' && fileMeta) {
            const meta = encodeURIComponent(JSON.stringify(fileMeta));
            finalContent = `\n\n[文件元数据:${meta}]`;
        }
        appendMessageToUI(tempId, mySender, finalContent, true, now, url, type, false, false, fileMeta ? fileMeta.fileName : null, fileMeta ? fileMeta.fileSize : null);
        const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
        if (tempEl) {
            tempEl.dataset.sending = 'true';
            const statusEl = document.createElement('span');
            statusEl.className = 'msg-send-status sending';
            statusEl.innerText = '发送中...';
            tempEl.appendChild(statusEl);
        }
        requestAnimationFrame(scrollToBottomInstant);
        [50, 150, 300].forEach((d) => setTimeout(scrollToBottomInstant, d));
        try {
            const { data, error } = await supabaseClient
                .from('messages')
                .insert([{
                    room_code: currentRoomCode,
                    content: finalContent,
                    sender: mySender,
                    media_url: url,
                    media_type: type,
                    created_at: now
                }])
                .select('id')
                .single();
            if (error) throw error;
            if (tempEl && data && data.id) {
                tempEl.dataset.msgId = String(data.id);
                tempEl.dataset.sending = 'false';
                const idx = messagesCache.findIndex(m => String(m.id) === tempId);
                if (idx >= 0) messagesCache[idx].id = data.id;
                const statusEl = tempEl.querySelector('.msg-send-status');
                if (statusEl) {
                    statusEl.className = 'msg-send-status sent';
                    statusEl.innerText = '已发送';
                    setTimeout(() => { if (statusEl && statusEl.parentNode) statusEl.style.display = 'none'; }, 3000);
                }
            }
        } catch (e) {
            console.error('insertMediaMessage:', e);
            updateMessageStatus(tempId, 'failed', '发送失败，点击重试');
            throw e;
        }
    }

    function showStorageError(e) {
        if (e.message && (e.message.includes('Bucket') || e.message.includes('not found'))) {
            showToast("存储桶不存在，请在Supabase控制台中创建名为 chat_media 的公开存储桶。", 'error');
        } else if (e.message && e.message.includes('row-level security')) {
            showToast("存储桶权限不足，请在Supabase控制台 → Storage → chat_media → 添加公开读取策略。", 'error');
        } else if (e.message && (e.message.includes('quota') || e.message.includes('exceeded'))) {
            showToast("存储空间已满，请在Supabase控制台中清理 chat_media 存储桶中的文件。", 'error');
        } else {
            showToast("上传失败，请检查网络。", 'error');
        }
    }

    window.handleFileSelect = async function(event) {
        const fileList = event.target.files;
        if (!fileList || fileList.length === 0) return;
        const files = Array.from(fileList);

        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/aac'];
        const isOk = (f) => allowedTypes.some(t => (f.type && f.type.startsWith(t.split('/')[0])) || f.type === t);

        // 不支持的文件直接剔除
        const validFiles = files.filter(isOk);
        const invalidCount = files.length - validFiles.length;
        if (invalidCount > 0) {
            showToast(`已忽略 ${invalidCount} 个不支持的文件（仅支持图片/音频）。`, 'error');
        }
        if (validFiles.length === 0) {
            event.target.value = '';
            return;
        }

        const hasAudio = validFiles.some(f => f.type.startsWith('audio/') || /\.(mp3|wav|webm|m4a|ogg|aac|flac)$/i.test(f.name));
        const imageFiles = validFiles.filter(f => f.type && f.type.startsWith('image/'));

        // 单文件：保持原有 sendMessage 流程（支持回复/输入框文本一起发）
        if (validFiles.length === 1) {
            let file = validFiles[0];
            if (file.type.startsWith('image/')) {
                try {
                    const compressed = await compressImageFile(file, 1100, 0.68);
                    if (compressed && compressed.size > 100 && compressed.size < file.size) file = compressed;
                } catch (e) { console.warn('image compression failed', e); }
            }
            if (file.size > 15 * 1024 * 1024) {
                showToast("文件太大啦！请选择小于15MB的文件。", 'error');
                event.target.value = '';
                return;
            }
            try {
                const mediaUrl = await uploadMediaToStorage(file);
                fetch(mediaUrl, { method: 'HEAD', cache: 'no-cache' })
                    .then(r => { if (!r.ok) throw new Error('not ok'); })
                    .catch(() => {
                        showToast("图片上传成功但无法公开访问！请在Supabase → SQL Editor执行: CREATE POLICY \"public_read\" ON storage.objects FOR SELECT USING (bucket_id='chat_media');", 'error', 6000);
                    });
                const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|webm|m4a|ogg|aac|flac)$/i.test(file.name);
                pendingMedia = { url: mediaUrl, type: isAudio ? 'audio' : 'image' };
                window.sendMessage();
            } catch (e) {
                console.error('文件上传失败:', e);
                showStorageError(e);
            } finally {
                event.target.value = '';
            }
            return;
        }

        // 多文件：批量发送（仅支持图片，音频不允许多选）
        if (hasAudio) {
            showToast('音频不支持批量发送，请逐张选择。', 'error');
            event.target.value = '';
            return;
        }
        if (imageFiles.length !== validFiles.length) {
            showToast('批量发送仅支持图片，已忽略非图片文件。', 'error');
        }
        if (imageFiles.length === 0) {
            event.target.value = '';
            return;
        }

        const total = imageFiles.length;
        let success = 0;
        let failed = 0;
        const progressToast = showToast(`批量发送中... 0/${total}`, 'info', 0);
        const updateProgress = (cur) => {
            if (progressToast && progressToast.innerText !== undefined) {
                progressToast.innerText = `批量发送中... ${cur}/${total}`;
            }
        };

        for (let i = 0; i < total; i++) {
            const file = imageFiles[i];
            updateProgress(i);
            try {
                let uploadFile = file;
                try {
                    const compressed = await window.compressImageFile(file, 1100, 0.68);
                    if (compressed && compressed.size > 100 && compressed.size < file.size) uploadFile = compressed;
                } catch (e) { /* 压缩失败用原图 */ }
                if (uploadFile.size > 15 * 1024 * 1024) {
                    showToast(`第 ${i + 1} 张超过 15MB，已跳过。`, 'error');
                    failed++;
                    continue;
                }
                const mediaUrl = await uploadMediaToStorage(uploadFile);
                await insertMediaMessage(mediaUrl, 'image', null);
                success++;
            } catch (e) {
                console.error('批量上传第', i + 1, '张失败:', e);
                failed++;
            }
            // 间隔一下避免发送过快
            if (i < total - 1) await new Promise(r => setTimeout(r, 120));
        }

        if (progressToast) progressToast.remove();
        if (failed === 0) {
            showToast(`已批量发送 ${success} 张图片`, 'success');
        } else {
            showToast(`发送完成：成功 ${success} 张，失败 ${failed} 张`, 'info', 4000);
        }
        event.target.value = '';
    };

    window.handleGenericFileSelect = async function(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (file.size > 50 * 1024 * 1024) {
            return showToast("文件太大啦！请选择小于50MB的文件。", 'error');
        }

        const tempId = 'uploading_' + Date.now();
        const progressEl = appendUploadingPlaceholder(tempId, file.name, file.size);

        try {
            const fileExt = file.name.split('.').pop();
            const safeName = file.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_');
            const fileName = `file_${Date.now()}_${Math.random().toString(36).substring(2, 6)}_${safeName}`;
            const filePath = `chat_media/${fileName}`;

            const { data, error } = await supabaseClient
                .storage
                .from('chat_media')
                .upload(filePath, file);

            if (error) throw error;

            const { data: publicData } = await supabaseClient
                .storage
                .from('chat_media')
                .getPublicUrl(filePath);

            const mediaUrl = publicData.publicUrl;

            removeUploadingPlaceholder(tempId);

            pendingMedia = {
                url: mediaUrl,
                type: 'file',
                fileName: file.name,
                fileSize: file.size
            };

            window.sendMessage();
        } catch (e) {
            removeUploadingPlaceholder(tempId);
            console.error('文件上传失败:', e);
            if (e.message && (e.message.includes('Bucket') || e.message.includes('not found'))) {
                showToast("存储桶不存在，请在Supabase控制台中创建名为 chat_media 的公开存储桶。", 'error');
            } else if (e.message && e.message.includes('row-level security')) {
                showToast("存储桶权限不足，请在Supabase控制台 → Storage → chat_media → 添加公开读取策略。", 'error');
            } else if (e.message && (e.message.includes('quota') || e.message.includes('exceeded'))) {
                showToast("存储空间已满，请在Supabase控制台中清理 chat_media 存储桶中的文件。", 'error');
            } else {
                showToast("上传失败，请检查网络。", 'error');
            }
        } finally {
            event.target.value = '';
        }
    };

    function appendUploadingPlaceholder(tempId, fileName, fileSize) {
        const chatBox = document.getElementById('chat-box');
        if (!chatBox) return null;

        const icon = getFileIcon(fileName);
        const extLabel = getFileExtLabel(fileName);
        const sizeStr = fileSize ? formatFileSize(fileSize) : '';

        const div = document.createElement('div');
        div.className = 'msg-wrapper right msg-uploading';
        div.id = tempId;
        div.innerHTML = `
            <div class="msg-content" style="opacity:0.9;padding:0;border:0;background:transparent;box-shadow:none;gap:4px;">
                <div class="file-card file-card-uploading" style="cursor:default;pointer-events:none;border:1px solid var(--line);">
                    <div class="file-card-icon-wrap">
                        <span class="file-card-icon-emoji">${icon}</span>
                        <span class="file-card-ext-label">${escapeHtml(extLabel)}</span>
                    </div>
                    <div class="file-card-body">
                        <div class="file-card-name">${escapeHtml(fileName)}</div>
                        <div class="file-card-meta">
                            <span class="file-card-type-badge">${escapeHtml(extLabel)} 文件</span>
                            ${sizeStr ? `<span>${sizeStr}</span>` : ''}
                        </div>
                    </div>
                    <div class="file-card-upload-spinner">
                        <div class="upload-spinner-ring"></div>
                    </div>
                </div>
                <div class="file-upload-status" style="margin-top:0;">
                    <span class="upload-dot-pulse"></span>
                    <span>正在上传文件...</span>
                </div>
            </div>
        `;
        chatBox.appendChild(div);
        requestAnimationFrame(scrollToBottomInstant);
        [50, 150].forEach((d) => setTimeout(scrollToBottomInstant, d));
        return div;
    }

    function removeUploadingPlaceholder(tempId) {
        const el = document.getElementById(tempId);
        if (el) {
            el.style.transition = 'opacity 0.3s';
            el.style.opacity = '0';
            setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
        }
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function getFileIcon(fileName) {
        const ext = (fileName || '').split('.').pop().toLowerCase();
        const iconMap = {
            zip: '🗜', rar: '🗜', '7z': '🗜', tar: '🗜', gz: '🗜', bz2: '🗜', xz: '🗜',
            pdf: '📕', doc: '📄', docx: '📄', xls: '📊', xlsx: '📊', ppt: '📽', pptx: '📽',
            txt: '📝', md: '📝', csv: '📊', json: '📋', xml: '📋', html: '🌐', css: '🎨', js: '📜', py: '📜', java: '📜', cpp: '📜', c: '📜', ts: '📜', go: '📜', rs: '📜',
            mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵',
            mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬', webm: '🎬',
            jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼', svg: '🖼', bmp: '🖼',
            exe: '⚙', dmg: '⚙', apk: '📱', ipa: '📱',
            iso: '💿',
        };
        return iconMap[ext] || '📎';
    }

    function getFileExtLabel(fileName) {
        const ext = (fileName || '').split('.').pop().toLowerCase();
        const labelMap = {
            zip: 'ZIP', rar: 'RAR', '7z': '7Z', tar: 'TAR', gz: 'GZ', bz2: 'BZ2', xz: 'XZ',
            pdf: 'PDF', doc: 'DOC', docx: 'DOCX', xls: 'XLS', xlsx: 'XLSX', ppt: 'PPT', pptx: 'PPTX',
            txt: 'TXT', md: 'MD', csv: 'CSV', json: 'JSON', xml: 'XML', html: 'HTML', css: 'CSS',
            js: 'JS', py: 'PY', java: 'JAVA', cpp: 'CPP', ts: 'TS', go: 'GO', rs: 'RS',
            mp3: 'MP3', wav: 'WAV', flac: 'FLAC', aac: 'AAC', ogg: 'OGG',
            mp4: 'MP4', avi: 'AVI', mkv: 'MKV', mov: 'MOV', webm: 'WEBM',
            jpg: 'JPG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WEBP', svg: 'SVG', bmp: 'BMP',
            exe: 'EXE', dmg: 'DMG', apk: 'APK', ipa: 'IPA', iso: 'ISO',
        };
        return labelMap[ext] || ext.toUpperCase().slice(0, 4) || 'FILE';
    }

    function fileMessageHtml(url, fileName, fileSize) {
        const icon = getFileIcon(fileName);
        const extLabel = getFileExtLabel(fileName);
        const sizeStr = fileSize ? formatFileSize(fileSize) : '';
        const displayName = fileName || '未知文件';
        const safeUrl = escapeHtml(url);
        const safeName = escapeHtml(displayName);
        return `<div class="file-card" onclick="window.downloadFile('${safeUrl}', '${safeName}')" title="点击下载 ${safeName}">
            <div class="file-card-icon-wrap">
                <span class="file-card-icon-emoji">${icon}</span>
                <span class="file-card-ext-label">${escapeHtml(extLabel)}</span>
            </div>
            <div class="file-card-body">
                <div class="file-card-name">${safeName}</div>
                <div class="file-card-meta">
                    <span class="file-card-type-badge">${escapeHtml(extLabel)} 文件</span>
                    ${sizeStr ? `<span>${sizeStr}</span>` : ''}
                </div>
            </div>
            <div class="file-card-download-btn">⬇</div>
        </div>`;
    }

    window.isDesktopDevice = function() {
        if (isRealMobileDevice()) return false;
        if (window.matchMedia('(pointer: coarse)').matches && !/Tablet/i.test(navigator.userAgent || '')) return false;
        if (window.matchMedia('(max-width: 768px)').matches && !/Tablet/i.test(navigator.userAgent || '')) return false;
        return true;
    };

    window.downloadFile = async function(url, fileName) {
        if (!window.isDesktopDevice()) {
            showToast('📱 手机端暂不支持下载文件，请使用电脑访问此页面下载', 'error', 4000);
            return;
        }

        const saveName = fileName || 'download';
        showToast('正在准备下载...', 'info');

        try {
            const response = await fetch(url, { mode: 'cors' });
            if (!response.ok) throw new Error('下载失败: ' + response.status);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = saveName;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
            }, 1000);
            const sizeStr = blob.size ? formatFileSize(blob.size) : '';
            showToast(`✅ 下载已开始${sizeStr ? ' (' + sizeStr + ')' : ''}`, 'success', 3500);
        } catch (e) {
            console.error('文件下载失败:', e);
            window.open(url, '_blank');
            showToast('⚠ 直接下载失败，已在新标签页打开文件', 'error', 3500);
        }
    };

    function getAudioMimeType() {
        const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg;codecs=opus'];
        return candidates.find(type => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
    }

    function startSpeechRecognition() {
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        speechTranscript = '';
        if (!Recognition) return;
        speechRecognition = new Recognition();
        speechRecognition.lang = 'zh-CN';
        speechRecognition.continuous = true;
        speechRecognition.interimResults = true;
        speechRecognition.maxAlternatives = 1;
        speechRecognition.onresult = (event) => {
            let text = '';
            for (let i = 0; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                    text += event.results[i][0].transcript;
                } else {
                    text += event.results[i][0].transcript;
                }
            }
            speechTranscript = text.trim();
        };
        speechRecognition.onerror = (event) => {
            if (event.error !== 'no-speech' && event.error !== 'aborted') {
                console.warn('语音识别失败:', event.error);
            }
        };
        speechRecognition.onend = () => {
            speechRecognition = null;
        };
        try {
            speechRecognition.start();
        } catch (error) {
            console.warn('语音识别启动失败:', error);
            speechRecognition = null;
        }
    }

    function stopSpeechRecognition() {
        if (!speechRecognition) return;
        try { speechRecognition.stop(); } catch (error) { console.warn('speech recognition stop failed:', error); }
    }

    async function startVoiceRecording(event) {
        if (mediaRecorder) return;
        recordingStartCancelled = false;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
            showToast('当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari。', 'error');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (recordingStartCancelled) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            const mimeType = getAudioMimeType();
            mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            recordingChunks = [];
            recordingStartedAt = Date.now();
            recordingPointerId = event && event.pointerId;
            recordingCancelled = false;
            mediaRecorder.addEventListener('dataavailable', (e) => {
                if (e.data && e.data.size) recordingChunks.push(e.data);
            });
            mediaRecorder.addEventListener('stop', async () => {
                stream.getTracks().forEach(track => track.stop());
                const recorder = mediaRecorder;
                mediaRecorder = null;
                const duration = Date.now() - recordingStartedAt;
                document.getElementById('voice-btn').classList.remove('recording');
                document.getElementById('voice-btn').innerText = '🎙';
                document.getElementById('voice-recording-overlay').classList.remove('visible');
                stopSpeechRecognition();
                if (recordingCancelled || duration < 500 || !recordingChunks.length) return;
                await uploadRecordedAudio(recordingChunks, recorder.mimeType || mimeType || 'audio/webm', speechTranscript);
            }, { once: true });
            mediaRecorder.start();
            startSpeechRecognition();
            const button = document.getElementById('voice-btn');
            button.classList.add('recording');
            document.getElementById('voice-recording-overlay').classList.add('visible');
            const label = document.querySelector('.voice-recording-label');
            if (label) label.innerHTML = event.inputSource === 'desktop' ? '再次点击停止' : '松开发送<br><small>上滑取消</small>';
            if (event.pointerId !== null && event.pointerId !== undefined) button.setPointerCapture?.(event.pointerId);
        } catch (error) {
            console.error('voice recording permission failed:', error);
            showToast('无法使用麦克风，请允许浏览器访问麦克风后重试。', 'error');
        }
    }

    function stopVoiceRecording(event) {
        if (!mediaRecorder) {
            recordingStartCancelled = true;
            return;
        }
        if (recordingPointerId !== null && event && event.pointerId !== recordingPointerId) return;
        mediaRecorder.stop();
        recordingPointerId = null;
    }

    async function uploadRecordedAudio(chunks, mimeType, transcript = '') {
        const extMap = { 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/ogg': 'ogg' };
        const extension = extMap[mimeType] || (mimeType.includes('webm') ? 'webm' : 'm4a');
        const file = new File([new Blob(chunks, { type: mimeType || 'audio/webm' })], `voice_${Date.now()}.${extension}`, { type: mimeType || 'audio/webm' });
        if (file.size > 15 * 1024 * 1024) {
            showToast('语音文件过大，请缩短录音后重试。', 'error');
            return;
        }
        try {
            const filePath = `chat_media/voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
            const { error } = await supabaseClient.storage.from('chat_media').upload(filePath, file);
            if (error) throw error;
            const { data } = supabaseClient.storage.from('chat_media').getPublicUrl(filePath);
            pendingMedia = { url: data.publicUrl, type: 'audio' };
            if (transcript) document.getElementById('message-input').value = transcript;
            await window.sendMessage();
        } catch (error) {
            console.error('voice upload failed:', error);
            showToast('语音发送失败，请检查 Storage 权限或网络连接。', 'error');
        }
    }

    async function discardPendingUpload(media) {
        if (!media || !media.url) return;
        const marker = '/storage/v1/object/public/chat_media/';
        const markerIndex = media.url.indexOf(marker);
        if (markerIndex < 0) return;
        const objectPath = decodeURIComponent(media.url.slice(markerIndex + marker.length).split('?')[0]);
        if (!objectPath) return;
        const { error } = await supabaseClient.storage.from('chat_media').remove([objectPath]);
        if (error) throw error;
    }

    // 图片压缩工具：返回压缩后的 File/Blob
    function compressImageFile(file, maxWidth = 1200, quality = 0.72) {
        return new Promise((resolve) => {
            try {
                if (!file || !file.type || !file.type.startsWith('image/')) return resolve(file);
                const reader = new FileReader();
                reader.onerror = () => resolve(file);
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        const needsScale = img.width > maxWidth || img.height > 1600;
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        let targetW = img.width;
                        let targetH = img.height;
                        if (needsScale) {
                            const ratio = img.width / img.height;
                            const scale = Math.min(1, maxWidth / img.width, 1600 / img.height);
                            targetW = Math.max(1, Math.round(img.width * scale));
                            targetH = Math.max(1, Math.round(img.height * scale));
                            if (targetW / targetH > ratio) {
                                targetW = Math.round(targetH * ratio);
                            }
                        }
                        canvas.width = targetW;
                        canvas.height = targetH;
                        ctx.clearRect(0, 0, targetW, targetH);
                        ctx.drawImage(img, 0, 0, targetW, targetH);
                        canvas.toBlob((blob) => {
                            if (!blob) return resolve(file);
                            if (blob.size >= file.size * 0.98 && file.size < 1.5 * 1024 * 1024) {
                                return resolve(file);
                            }
                            const nameWithoutExt = file.name.replace(/\.[^.]+$/, '');
                            const newFile = new File([blob], nameWithoutExt + '.jpg', { type: 'image/jpeg' });
                            resolve(newFile);
                        }, 'image/jpeg', quality);
                    };
                    img.onerror = () => resolve(file);
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            } catch (e) { resolve(file); }
        });
    }

    window.sendMessage = async function() {
        const inputEl = document.getElementById('message-input');
        if (!inputEl) return;
        let content = inputEl.value.trim();
        
        if (!content && !pendingMedia) return;

        if (continuationToken) {
            if (pendingMedia) return showToast('当前会话暂不支持发送附件', 'info');
            if (replyData) return showToast('当前会话暂不支持引用消息', 'info');
            try {
                // 端到端加密：暗号指令不加密（后端需要识别），普通消息加密后发送
                let payload = content;
                const isPhraseCmd = /^改暗号(?:[\s\u3000]+|$)/.test(content);
                let pendingNewPhrase = null;
                if (isPhraseCmd) {
                    const m = content.match(/^改暗号(?:[\s\u3000]+(.+))?$/);
                    pendingNewPhrase = (m && m[1]) ? m[1].trim() : null;
                }
                if (!isPhraseCmd && continuationCryptoKey) {
                    payload = await encryptText(continuationCryptoKey, content);
                }
                const result = await callServerAction(null, 'session-send', {
                    continuation: continuationToken,
                    content: payload
                });
                const message = result.message;
                // 改暗号成功后，更新本地暗号和密钥
                if (isPhraseCmd && pendingNewPhrase) {
                    continuationPhrase = pendingNewPhrase;
                    try {
                        continuationCryptoKey = await deriveCryptoKey(pendingNewPhrase);
                    } catch (e) {
                        console.error('Unable to derive new crypto key:', e);
                    }
                }
                // 自己发的消息：直接显示原文（不展示密文）
                const displayContent = isPhraseCmd
                    ? escapeHtml(message.content || '')
                    : escapeHtml(content);
                appendMessageToUI(`c_${message.id}`, message.sender, displayContent, true, message.created_at);
                continuationCursor = Math.max(continuationCursor, Number(message.id) || 0);
                inputEl.value = '';
                inputEl.style.height = 'auto';
                requestAnimationFrame(scrollToBottomInstant);
            } catch (error) {
                console.error('Continuation message send failed:', error);
                showToast(error.message || '消息发送失败，请重试', 'error');
            }
            return;
        }

        if (content && content.length <= 4000) {
            try {
                const result = await callServerAction(null, 'message-intent', {
                    username: mySender,
                    text: content,
                    room_code: currentRoomCode
                });
                if (result.continuation) {
                    const mediaToDiscard = pendingMedia;
                    inputEl.value = '';
                    inputEl.style.height = 'auto';
                    pendingMedia = null;
                    cancelReply();
                    if (mediaToDiscard) {
                        try {
                            await discardPendingUpload(mediaToDiscard);
                        } catch (error) {
                            console.error('Unable to discard pending upload:', error);
                            showToast('附件未发送且无法自动清理，请检查存储空间', 'error', 4000);
                        }
                    }
                    // 保存暗号（仅内存）并派生加密密钥
                    continuationPhrase = content;
                    try {
                        continuationCryptoKey = await deriveCryptoKey(content);
                    } catch (e) {
                        console.error('[暗房加密] 密钥派生失败:', e?.message || e);
                        continuationCryptoKey = null;
                    }
                    startContinuation(result.continuation);
                    return;
                }
            } catch (error) {
                console.error('Message preflight failed:', error);
                showToast('消息发送前检查失败，请稍后重试', 'error');
                return;
            }
        }

        let finalContent = content;
        if (replyData) {
            const replyMeta = encodeURIComponent(JSON.stringify(replyData));
            finalContent = `${content}\n\n[回复元数据:${replyMeta}]`;
        }
        if (pendingMedia && pendingMedia.type === 'file') {
            const fileMeta = encodeURIComponent(JSON.stringify({ fileName: pendingMedia.fileName, fileSize: pendingMedia.fileSize }));
            finalContent = `${finalContent}\n\n[文件元数据:${fileMeta}]`;
        }

        const now = beijingISOString();
        const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const pendingMediaCopy = pendingMedia ? { ...pendingMedia } : null;

        inputEl.value = "";
        inputEl.style.height = 'auto';
        pendingMedia = null;
        cancelReply();

        appendMessageToUI(tempId, mySender, finalContent, true, now, pendingMediaCopy ? pendingMediaCopy.url : null, pendingMediaCopy ? pendingMediaCopy.type : null, false, false, pendingMediaCopy ? pendingMediaCopy.fileName : null, pendingMediaCopy ? pendingMediaCopy.fileSize : null);

        const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
        if (tempEl) {
            tempEl.dataset.sending = 'true';
            const statusEl = document.createElement('span');
            statusEl.className = 'msg-send-status sending';
            statusEl.innerText = '发送中...';
            tempEl.appendChild(statusEl);
        }

        requestAnimationFrame(scrollToBottomInstant);
        [50, 150, 300].forEach((delay) => setTimeout(scrollToBottomInstant, delay));

        try {
            const { data, error } = await supabaseClient
                .from('messages')
                .insert([{ 
                    room_code: currentRoomCode, 
                    content: finalContent, 
                    sender: mySender,
                    media_url: pendingMediaCopy ? pendingMediaCopy.url : null,
                    media_type: pendingMediaCopy ? pendingMediaCopy.type : null,
                    created_at: now
                }])
                .select('id')
                .single();

            if (error) {
                console.error("发送失败:", error);
                updateMessageStatus(tempId, 'failed', '发送失败，点击重试');
                showToast("消息发送失败，请检查网络后重试。", 'error');
            } else if (data && data.id) {
                const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
                if (tempEl) {
                    tempEl.dataset.msgId = String(data.id);
                    tempEl.dataset.sending = 'false';
                    const idx = messagesCache.findIndex(m => String(m.id) === tempId);
                    if (idx >= 0) messagesCache[idx].id = data.id;
                    const statusEl = tempEl.querySelector('.msg-send-status');
                    if (statusEl) {
                        statusEl.className = 'msg-send-status sent';
                        statusEl.innerText = '已发送';
                        statusEl.onclick = null;
                        setTimeout(() => { if (statusEl && statusEl.parentNode) statusEl.style.display = 'none'; }, 3000);
                    }
                } else {
                    // realtime 已抢先更新了ID，用真实ID再找一次
                    const realEl = document.querySelector(`[data-msg-id="${data.id}"]`);
                    if (realEl) {
                        const statusEl = realEl.querySelector('.msg-send-status');
                        if (statusEl) {
                            statusEl.className = 'msg-send-status sent';
                            statusEl.innerText = '已发送';
                            statusEl.onclick = null;
                            setTimeout(() => { if (statusEl && statusEl.parentNode) statusEl.style.display = 'none'; }, 3000);
                        }
                    }
                }
                // ====== 触发站外通知（新消息 + @提及）======
                try {
                    const sentContent = (finalContent || '')
                        .replace(/\n\n\[回复元数据:[^\]]+\]/g, '')
                        .replace(/\n\n\[文件元数据:[^\]]+\]/g, '')
                        .trim();
                    // 系统消息（sender === 'system'）不推
                    if (mySender && mySender !== 'system') {
                        window.triggerExternalNotify('new_message', {
                            room_code: currentRoomCode,
                            sender: mySender,
                            content: sentContent,
                        });
                        // 解析 @xxx 触发 mention 事件
                        const mentions = sentContent.match(/@([^\s@,，。!?;:\]\[]+)/g) || [];
                        const seen = new Set();
                        for (const token of mentions) {
                            const username = token.slice(1);
                            if (!username || username === mySender || seen.has(username)) continue;
                            seen.add(username);
                            window.triggerExternalNotify('mention', {
                                room_code: currentRoomCode,
                                sender: mySender,
                                content: sentContent,
                                mention_user: username,
                            });
                        }
                    }
                } catch (eN) { console.warn('[extn] trigger error:', eN); }
            }
        } catch (e) {
            console.error(e);
            updateMessageStatus(tempId, 'failed', '发送失败，点击重试');
            showToast("消息发送失败，请检查网络后重试。", 'error');
        } finally {
            setTimeout(() => {
                const inputEl = document.getElementById('message-input');
                if (inputEl && document.activeElement !== inputEl) inputEl.focus();
            }, 100);
        }
    };

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    // ===== 暗房端到端加密（AES-256-GCM，密钥由暗号 PBKDF2 派生）=====
    function bufToB64(buf) {
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }
    function b64ToBuf(b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    async function deriveCryptoKey(phrase) {
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(phrase), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: enc.encode('harry-hidden-room'), iterations: 120000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }
    async function encryptText(key, plaintext) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
        return 'enc:' + bufToB64(iv) + ':' + bufToB64(ciphertext);
    }
    async function decryptText(key, payload) {
        // payload format: "enc:<iv_b64>:<ciphertext_b64>"
        const parts = payload.split(':');
        if (parts.length !== 3 || parts[0] !== 'enc') return payload;
        const iv = b64ToBuf(parts[1]);
        const ciphertext = b64ToBuf(parts[2]);
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return new TextDecoder().decode(plaintext);
    }

    function updateMessageStatus(msgId, status, label) {
        const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (!wrapper) return;
        let statusEl = wrapper.querySelector('.msg-send-status');
        if (!statusEl && status) {
            statusEl = document.createElement('span');
            statusEl.className = 'msg-send-status';
            wrapper.appendChild(statusEl);
        }
        if (!statusEl) return;
        statusEl.className = 'msg-send-status ' + status;
        if (status === 'sent') {
            statusEl.innerText = '已发送';
            setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 3000);
        } else if (status === 'failed') {
            statusEl.innerText = label || '发送失败';
            statusEl.title = '点击重试';
            statusEl.onclick = () => retryMessage(msgId);
            wrapper.style.opacity = '0.8';
            wrapper.dataset.sending = 'false';
            wrapper.title = label || '发送失败，点击重试';
        } else if (status === 'sending') {
            statusEl.innerText = '发送中...';
        }
    }

    async function retryMessage(msgId) {
        const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (!wrapper) return;
        const content = wrapper.dataset.originalContent || '';
        const mediaUrl = wrapper.dataset.mediaUrl || '';
        const mediaType = wrapper.dataset.mediaType || '';
        const createdAt = wrapper.dataset.createdAt || beijingISOString();
        wrapper.style.opacity = '1';
        wrapper.title = '';
        updateMessageStatus(msgId, 'sending', '重试中...');
        try {
            const { data, error } = await supabaseClient
                .from('messages')
                .insert([{
                    room_code: currentRoomCode,
                    content: content,
                    sender: mySender,
                    media_url: mediaUrl || null,
                    media_type: mediaType || null,
                    created_at: createdAt
                }])
                .select('id')
                .single();
            if (error) throw error;
            if (data && data.id) {
                wrapper.dataset.msgId = String(data.id);
                wrapper.dataset.sending = 'false';
                const statusEl = wrapper.querySelector('.msg-send-status');
                if (statusEl) {
                    statusEl.className = 'msg-send-status sent';
                    statusEl.innerText = '已发送';
                    statusEl.onclick = null;
                    setTimeout(() => { if (statusEl && statusEl.parentNode) statusEl.style.display = 'none'; }, 3000);
                }
                showToast('消息已重新发送', 'success');
            }
        } catch (e) {
            console.error('重试发送失败:', e);
            updateMessageStatus(msgId, 'failed', '重试失败，点击重试');
            showToast('重试发送失败，请检查网络', 'error');
        }
    }

    function findTempMessage(content, createdAt) {
        const chatBox = document.getElementById('chat-box');
        if (!chatBox) return null;
        const wrappers = chatBox.querySelectorAll('.msg-wrapper[data-msg-id^="temp_"]');
        const newTime = createdAt ? new Date(createdAt).getTime() : 0;
        const normalizedContent = (content || '').replace(/\s+/g, '');
        for (const wrapper of wrappers) {
            if (wrapper.dataset.sender !== mySender) continue;
            const wrapperContent = (wrapper.dataset.originalContent || '').replace(/\s+/g, '');
            const wrapperTime = new Date(wrapper.dataset.createdAt).getTime();
            if (wrapperContent === normalizedContent && newTime && Math.abs(wrapperTime - newTime) < 5000) return wrapper;
            if (wrapperContent === normalizedContent && !newTime) return wrapper;
        }
        return null;
    }

    function avatarStorageKey(sender) {
        return `chat_avatar:${sender}`;
    }

    // 头像统一单色（石墨极简风）：不再按名字随机配色，用主题变量自动适配深浅色
    function hashGradient(text) {
        return 'linear-gradient(135deg, var(--ava-g1), var(--ava-g2))';
    }

    function setRoomTitle(text) {
        document.getElementById('room-title').innerText = text;
    }

    function avatarHtml(sender) {
        const grad = hashGradient(sender || '?');
        if (isSpeedMode) return `<span class="message-avatar" style="background:${grad};color:#fff;" aria-label="${escapeHtml(sender)}的头像" data-sender="${escapeHtml(sender)}">${escapeHtml(String(sender || '?').slice(0, 1))}</span>`;
        const avatar = localStorage.getItem(avatarStorageKey(sender));
        return avatar
            ? (() => { const __img = document.createElement('img'); __img.className = 'message-avatar'; __img.src = avatar; __img.alt = sender + '的头像'; __img.dataset.sender = sender; return __img.outerHTML; })()
            : `<span class="message-avatar" style="background:${grad};color:#fff;" aria-label="${escapeHtml(sender)}的头像" data-sender="${escapeHtml(sender)}">${escapeHtml(String(sender || '?').slice(0, 1))}</span>`;
    }

    async function fetchAndApplyUserAvatars(senders) {
        if (!senders || !senders.length) return;
        if (isSpeedMode) return;
        const uniqueSenders = [...new Set(senders)].filter(s => !localStorage.getItem(avatarStorageKey(s)));
        if (!uniqueSenders.length) return;
        try {
            const { data: profiles } = await supabaseClient.from('user_profiles').select('user_name,avatar_url').in('user_name', uniqueSenders);
            if (profiles && profiles.length) {
                profiles.forEach(p => {
                    if (p.avatar_url) localStorage.setItem(avatarStorageKey(p.user_name), p.avatar_url);
                });
                renderOwnAvatar(); // 同步刷新自己相关位置（我的页卡片 / 侧栏 / 个人信息页）
                document.querySelectorAll('.message-avatar[data-sender]').forEach(avatar => {
                    const sender = avatar.dataset.sender;
                    const saved = localStorage.getItem(avatarStorageKey(sender));
                    if (saved && avatar.tagName === 'SPAN') {
                        const __img = document.createElement('img');
                        __img.className = 'message-avatar';
                        __img.src = saved;
                        __img.alt = sender + '的头像';
                        __img.dataset.sender = sender;
                        avatar.outerHTML = __img.outerHTML;
                    } else if (saved && avatar.tagName === 'IMG') {
                        avatar.src = saved;
                    }
                });
            }
        } catch (e) { /* ignore */ }
    }

    // 渲染"我自己"的头像到所有相关位置（设置页预览 / 个人信息页 / 我的页卡片 / 桌面侧栏）
    function renderOwnAvatar() {
        const avatar = localStorage.getItem(avatarStorageKey(mySender));
        const setPreview = (el) => {
            if (!el) return;
            if (avatar) {
                el.innerHTML = '';
                const __img = document.createElement('img');
                __img.src = avatar;
                __img.alt = '我的头像';
                __img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;';
                el.appendChild(__img);
            } else {
                el.innerHTML = escapeHtml(String(mySender || '?').slice(0, 1));
            }
        };
        setPreview(document.getElementById('profile-avatar-preview'));
        setPreview(document.getElementById('profile-page-avatar'));
        setPreview(document.getElementById('mrv-avatar'));
        setPreview(document.getElementById('sidebar-avatar'));
    }

    function refreshMessageAvatars() {
        document.querySelectorAll('.msg-wrapper').forEach((wrapper) => {
            let previous = wrapper.previousElementSibling;
            let separatedByTime = false;
            while (previous && !previous.classList.contains('msg-wrapper')) {
                if (previous.classList.contains('message-time-divider')) separatedByTime = true;
                previous = previous.previousElementSibling;
            }
            const avatar = wrapper.querySelector('.message-avatar');
            if (!avatar) return;
            const sameGroup = !separatedByTime && !!previous && previous.dataset.sender === wrapper.dataset.sender;
            avatar.classList.toggle('is-hidden', sameGroup);
            const content = wrapper.querySelector('.msg-content');
            const senderLabel = wrapper.querySelector('.sender-name');
            if (sameGroup && senderLabel) senderLabel.remove();
            const stack = wrapper.querySelector('.message-stack');
            if (!sameGroup && wrapper.dataset.sender !== mySender && !senderLabel && stack) {
                const label = document.createElement('span');
                label.className = 'sender-name';
                label.innerText = wrapper.dataset.sender || '';
                stack.insertBefore(label, content);
            }
        });
    }

    function replyPreviewHtml(meta) {
        const preview = meta.mediaType === 'image' ? '图片' : meta.mediaType === 'audio' ? '语音' : (meta.content || '消息');
        const mediaPreview = meta.mediaType === 'image' && meta.mediaUrl
            ? (() => { const __img = document.createElement('img'); __img.src = meta.mediaUrl; __img.className = 'reply-media-preview'; __img.alt = '引用图片'; return __img.outerHTML; })()
            : meta.mediaType === 'audio' && meta.mediaUrl
                ? `<button class="reply-audio-preview" data-audio-url="${escapeHtml(meta.mediaUrl)}" aria-label="播放引用语音">
                    <span class="voice-play">▶</span>
                    <span class="voice-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
                    <span class="voice-duration">--″</span>
                </button>`
                : '';
        return `<div class="reply-quote${meta.legacy ? ' legacy' : ''}" ${meta.id ? `data-reply-id="${escapeHtml(meta.id)}"` : ''} title="${meta.id ? '点击定位原消息' : ''}">
            ${meta.legacy ? '' : `<strong>${escapeHtml(meta.sender || '未知用户')}</strong>`}
            ${mediaPreview}<span class="reply-text">${escapeHtml(meta.mediaType ? preview : (meta.content || preview)).slice(0, 120)}</span>
        </div>`;
    }

    function stripReplyMetadata(content) {
        return String(content || '').replace(/\n\n\[回复元数据:[^\]]+\]$/, '');
    }

    function toggleReplyAudio(button) {
        if (!button._audio) {
            const url = button.dataset.audioUrl;
            if (!url) {
                showToast('引用语音地址不存在，无法播放。', 'error');
                return;
            }
            button._audio = new Audio(url);
            button._audio.preload = 'metadata';
            button._audio.addEventListener('loadedmetadata', () => {
                button.querySelector('.voice-duration').innerText = `${Math.max(1, Math.round(button._audio.duration))}″`;
            });
            button._audio.addEventListener('error', () => {
                button.querySelector('.voice-play').innerText = '!';
            });
            button._audio.addEventListener('ended', () => { button.querySelector('.voice-play').innerText = '▶'; });
        }
        if (button._audio.paused) {
            button._audio.play().then(() => { button.querySelector('.voice-play').innerText = '❚❚'; })
                .catch(() => showToast('引用语音播放失败，请检查网络或 Storage 权限。', 'error'));
        } else {
            button._audio.pause();
            button.querySelector('.voice-play').innerText = '▶';
        }
    }

    function voiceMessageHtml(mediaUrl, transcript = '') {
        const safeUrl = String(mediaUrl).replace(/"/g, '&quot;');
        const safeTranscript = escapeHtml(transcript);
        return `<span class="voice-message-wrap">
            <button class="voice-message" data-audio-url="${safeUrl}" onclick="toggleVoiceMessage(this)" aria-label="播放语音">
                <span class="voice-play">▶</span>
                <span class="voice-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
                <span class="voice-duration">--″</span>
            </button>
            ${safeTranscript ? `<span class="voice-transcript">${safeTranscript}</span>` : ''}
        </span>`;
    }

    window.toggleVoiceTranscript = function(event, button) {
        event.stopPropagation();
        const transcript = button.nextElementSibling;
        if (!transcript) return;
        const visible = transcript.classList.toggle('visible');
        button.innerText = visible ? '收起文字' : '转文字';
    };

    function toggleVoiceTranscriptForMessage(wrapper) {
        const transcript = wrapper.querySelector('.voice-transcript');
        if (!transcript) {
            showToast('这条语音没有可显示的识别文字。', 'info');
            return;
        }
        transcript.classList.toggle('visible');
    }

    window.toggleVoiceMessage = function(button) {
        let audio = button._audio;
        if (!audio) {
            audio = new Audio(button.dataset.audioUrl);
            audio.preload = 'metadata';
            button._audio = audio;
            audio.addEventListener('loadedmetadata', () => {
                button.querySelector('.voice-duration').innerText = `${Math.max(1, Math.round(audio.duration))}″`;
            });
            audio.addEventListener('ended', () => {
                button.querySelector('.voice-play').innerText = '▶';
            });
        }
        if (audio.paused) {
            audio.play().then(() => { button.querySelector('.voice-play').innerText = '❚❚'; })
                .catch(() => showToast('语音播放失败，请检查浏览器声音权限或网络连接。', 'error'));
        } else {
            audio.pause();
            button.querySelector('.voice-play').innerText = '▶';
        }
    };

    function appendMessageToUI(id, sender, content, isNew, timestamp_str, mediaUrl = null, mediaType = null, insertAtTop = false, skipAvatarRefresh = false, fileName = null, fileSize = null) {
        // 安卓 APK：后台收到别人的新消息 → 弹系统通知
        if (isNew && !insertAtTop && sender && sender !== mySender && isNativeApp) {
            notifyIncomingMessage(sender, content, mediaType);
        }
        const chatBox = document.getElementById('chat-box');
        if (isNew && id && Array.from(chatBox.querySelectorAll('.msg-wrapper[data-msg-id]')).some((item) => item.dataset.msgId === String(id))) return;
        const wrapper = document.createElement('div');
        // 系统提示（仅独立会话内出现）：居中卡片样式
        if (sender === 'system') {
            wrapper.className = 'msg-wrapper system-msg-wrapper';
            if (id) wrapper.dataset.msgId = id;
            wrapper.innerHTML = `<div class="system-msg-card">${content}</div>`;
            chatBox.appendChild(wrapper);
            if (isNew) requestAnimationFrame(scrollToBottomInstant);
            return;
        }
        wrapper.className = `msg-wrapper ${sender === mySender ? 'right' : 'left'}`;
        if (id) wrapper.dataset.msgId = id;
        wrapper.dataset.sender = sender;
        wrapper.dataset.createdAt = timestamp_str || beijingISOString();
        wrapper.dataset.originalContent = content || '';
        wrapper.dataset.mediaUrl = mediaUrl || '';
        wrapper.dataset.mediaType = mediaType || '';

        const messageDate = parseBeijingTime(timestamp_str || beijingISOString());
        const currentMessages = messagesCache;
        const adjacentMessage = insertAtTop ? currentMessages[0] : currentMessages[currentMessages.length - 1];
        const adjacentTime = adjacentMessage ? new Date(adjacentMessage.created_at).getTime() : 0;
        const shouldShowTime = !adjacentTime || Math.abs(messageDate.getTime() - adjacentTime) >= 5 * 60 * 1000;
        const isGroupStart = insertAtTop ? true : (!adjacentMessage || adjacentMessage.sender !== sender || shouldShowTime);

        let displayContent = content;
        let replyTagHtml = "";

        const replyMatch = content && content.match(/\n\n\[回复元数据:([^\]]+)\]$/);
        if (replyMatch) {
            try {
                const meta = JSON.parse(decodeURIComponent(replyMatch[1]));
                displayContent = content.slice(0, replyMatch.index);
                wrapper.dataset.replyId = meta.id || '';
                replyTagHtml = replyPreviewHtml(meta);
            } catch (error) {
                console.warn('引用数据解析失败:', error);
            }
        } else {
            const legacyReplyMatch = content && content.match(/\n\n\[回复:\s*([\s\S]*)\]$/);
            if (legacyReplyMatch) {
                displayContent = content.slice(0, legacyReplyMatch.index);
                replyTagHtml = replyPreviewHtml({
                    content: legacyReplyMatch[1],
                    legacy: true
                });
            }
        }

        const fileMetaMatch = displayContent && displayContent.match(/\n\n\[文件元数据:([^\]]+)\]$/);
        if (fileMetaMatch) {
            try {
                const meta = JSON.parse(decodeURIComponent(fileMetaMatch[1]));
                if (meta.fileName && !fileName) fileName = meta.fileName;
                if (meta.fileSize && !fileSize) fileSize = meta.fileSize;
                displayContent = displayContent.slice(0, fileMetaMatch.index);
            } catch (e) { console.warn('文件元数据解析失败:', e); }
        }

        let mediaHtml = "";
        const isRecalled = content === '[已撤回]';
        if (isRecalled) {
            displayContent = '<span style="opacity:0.5;font-style:italic;">[已撤回]</span>';
            mediaUrl = null;
            mediaType = null;
        } else if (mediaUrl) {
            if (mediaType === 'image') {
                mediaHtml = (() => {
                                const __wrapper = document.createElement('div');
                                __wrapper.className = 'msg-image-shell';
                                __wrapper.style.display = 'grid';
                                __wrapper.style.maxWidth = '320px';
                                const __placeholder = document.createElement('div');
                                __placeholder.className = 'msg-img-placeholder';
                                __placeholder.style.cssText = 'grid-area:1/1;width:100%;';
                                const __img = document.createElement('img');
                                __img.src = mediaUrl;
                                __img.className = 'msg-img';
                                __img.style.cssText = 'grid-area:1/1;';
                                __img.alt = '图片消息';
                                __img.onload = function() { this.previousElementSibling.remove(); };
                                __img.onerror = function() { this.previousElementSibling.innerHTML = '图片加载失败<br><span style=font-size:11px>请检查网络或图片链接</span>'; this.previousElementSibling.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);font-size:13px;text-align:center;padding:10px;grid-area:1/1;width:100%;height:180px;border-radius:8px;background:var(--chip-bg);margin-top:5px;'; };
                                __wrapper.appendChild(__placeholder);
                                __wrapper.appendChild(__img);
                                return __wrapper.outerHTML;
                            })();
                wrapper.classList.add('media-only');
            } else if (mediaType === 'audio') {
                mediaHtml = voiceMessageHtml(mediaUrl, displayContent);
                displayContent = '';
            } else if (mediaType === 'file') {
                mediaHtml = fileMessageHtml(mediaUrl, fileName, fileSize);
                wrapper.classList.add('has-file-card');
            }
        }

        wrapper.innerHTML = `
            <div class="message-row">
                ${avatarHtml(sender).replace('message-avatar"', `message-avatar${isGroupStart ? '"' : ' is-hidden"'}`)}
                <div class="message-stack">
                    ${sender !== mySender && isGroupStart ? `<span class="sender-name">${escapeHtml(sender)}</span>` : ''}
                    <div class="msg-content">
                    <div style="white-space: pre-wrap; word-break: break-word;">${mediaHtml}${displayContent}</div>
                    ${replyTagHtml}
                    </div>
                </div>
            </div>
        `;
        const messageImage = wrapper.querySelector('.msg-img');
        if (messageImage) {
            messageImage.onclick = () => openImageLightbox(messageImage.src);
            bindImageDownloadButton(messageImage);
        }
        if (typeof handleGameMessageInUI === 'function') {
            handleGameMessageInUI(wrapper, sender, content);
        }
        const replyTarget = wrapper.querySelector('.reply-quote');
        if (replyTarget) {
            if (replyTarget.dataset.replyId) replyTarget.onclick = () => goToMessage(replyTarget.dataset.replyId);
            const replyImage = replyTarget.querySelector('.reply-media-preview');
            if (replyImage) {
                replyImage.onclick = (event) => {
                    event.stopPropagation();
                    openImageLightbox(replyImage.src);
                };
            }
            const replyAudio = replyTarget.querySelector('.reply-audio-preview');
            if (replyAudio) {
                replyAudio.onclick = (event) => {
                    event.stopPropagation();
                    toggleReplyAudio(replyAudio);
                };
            }
        }

        if (insertAtTop && chatBox.firstChild) {
            chatBox.insertBefore(wrapper, chatBox.firstChild);
        } else if (insertAtTop) {
            chatBox.appendChild(wrapper);
        } else {
            chatBox.appendChild(wrapper);
        }

        if (shouldShowTime) {
            const divider = document.createElement('div');
            divider.className = 'message-time-divider';
            divider.innerText = insertAtTop ? formatMessageTime(new Date(adjacentTime)) : formatMessageTime(messageDate);
            if (insertAtTop) {
                chatBox.insertBefore(divider, wrapper.nextSibling);
            } else {
                chatBox.insertBefore(divider, wrapper);
            }
        }
        if (!skipAvatarRefresh) refreshMessageAvatars();
        // 存入本地缓存（用于导出）
        try {
            const msgObj = { id: id || null, sender, content, created_at: timestamp_str || beijingISOString(), media_url: mediaUrl || null, media_type: mediaType || null };
            if (insertAtTop) {
                messagesCache.unshift(msgObj);
            } else {
                messagesCache.push(msgObj);
            }

        } catch (e) { console.error('cache error', e); }
    }

    function formatMessageTime(date) {
        // 消息时间戳带有时区信息，解析后直接用本地时间即可（之前的 +8h 手动偏移
        // 在东八区设备上会把当天上午的消息错判成"昨天"，故移除）
        const d = new Date(date);
        if (isNaN(d)) return '';
        const now = new Date();
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        if (d.toDateString() === now.toDateString()) return time;
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
        return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
    }

    const chatBoxEl = document.getElementById('chat-box');
    let pressTimer;
    let selectedMessageIds = new Set();
    let selectionMode = false;
    let selectionToolbar = null;

    function ensureSelectionToolbar() {
        if (selectionToolbar) return selectionToolbar;
        selectionToolbar = document.createElement('div');
        selectionToolbar.className = 'message-selection-bar hidden';
        selectionToolbar.innerHTML = `
            <span class="message-selection-count" data-role="count">0 项已选</span>
            <button type="button" class="message-select-pill primary" data-action="download">批量下载</button>
            <button type="button" class="message-select-pill danger" data-action="delete">批量删除</button>
            <button type="button" class="message-select-pill" data-action="cancel">取消</button>
        `;
        selectionToolbar.addEventListener('click', (event) => {
            const actionBtn = event.target.closest('[data-action]');
            if (!actionBtn) return;
            const action = actionBtn.dataset.action;
            if (action === 'download') {
                downloadSelectedMessages();
            } else if (action === 'delete') {
                deleteSelectedMessages();
            } else if (action === 'cancel') {
                clearSelectionMode();
            }
        });
        document.body.appendChild(selectionToolbar);
        return selectionToolbar;
    }

    function updateSelectionToolbar() {
        const toolbar = ensureSelectionToolbar();
        const count = selectedMessageIds.size;
        const countEl = toolbar.querySelector('[data-role="count"]');
        if (countEl) countEl.textContent = `${count} 项已选`;
        toolbar.classList.toggle('hidden', count === 0);
        if (count === 0) {
            toolbar.style.display = 'none';
        } else {
            toolbar.style.display = 'flex';
        }
    }

    function clearSelectionMode() {
        selectionMode = false;
        selectedMessageIds.forEach((id) => {
            const wrapper = document.querySelector(`[data-msg-id="${id}"]`);
            if (wrapper) wrapper.classList.remove('selected');
        });
        selectedMessageIds.clear();
        const toolbar = ensureSelectionToolbar();
        toolbar.classList.add('hidden');
        toolbar.style.display = 'none';
    }

    function enterSelectionMode(messageId) {
        selectionMode = true;
        const toolbar = ensureSelectionToolbar();
        toolbar.style.display = 'flex';
        toolbar.classList.remove('hidden');
        if (messageId) {
            const currentId = String(messageId);
            const wrapper = document.querySelector(`[data-msg-id="${currentId}"]`);
            if (wrapper && !wrapper.classList.contains('system-msg')) {
                selectedMessageIds.add(currentId);
                wrapper.classList.add('selected');
            }
        }
        updateSelectionToolbar();
    }

    function toggleMessageSelection(messageId, forceState) {
        const currentId = String(messageId);
        const wrapper = document.querySelector(`[data-msg-id="${currentId}"]`);
        if (!wrapper || wrapper.classList.contains('system-msg')) return;
        const shouldSelect = typeof forceState === 'boolean' ? forceState : !selectedMessageIds.has(currentId);
        if (shouldSelect) {
            selectedMessageIds.add(currentId);
            wrapper.classList.add('selected');
        } else {
            selectedMessageIds.delete(currentId);
            wrapper.classList.remove('selected');
        }
        if (selectedMessageIds.size === 0) {
            clearSelectionMode();
            return;
        }
        selectionMode = true;
        updateSelectionToolbar();
    }

    async function downloadSelectedMessages() {
        if (!selectedMessageIds.size) {
            showToast('请先选择要下载的消息', 'info');
            return;
        }
        const ids = [...selectedMessageIds];
        let total = 0;
        let success = 0;
        for (const id of ids) {
            const wrapper = document.querySelector(`[data-msg-id="${id}"]`);
            if (!wrapper) continue;
            const url = wrapper.dataset.mediaUrl || wrapper.querySelector('.msg-img')?.src || wrapper.querySelector('.file-card a')?.href;
            if (!url) continue;
            total += 1;
            const got = await downloadImage(url, wrapper.dataset.fileName || urlToFileName(url, 'message_download'));
            if (got) success += 1;
            await new Promise(r => setTimeout(r, 250));
        }
        clearSelectionMode();
        showToast(total ? `已下载 ${success}/${total} 个文件` : '没有可下载的消息', total && success > 0 ? 'success' : 'info');
    }

    async function deleteSelectedMessages() {
        if (!selectedMessageIds.size) {
            showToast('请先选择要删除的消息', 'info');
            return;
        }
        const ids = [...selectedMessageIds];
        const removable = [];
        for (const id of ids) {
            const wrapper = document.querySelector(`[data-msg-id="${id}"]`);
            if (!wrapper) continue;
            if (wrapper.dataset.sender === mySender || String(wrapper.dataset.sender || '').trim() === String(mySender || '').trim()) {
                removable.push(id);
            }
        }
        if (!removable.length) {
            clearSelectionMode();
            showToast('只能删除自己的消息', 'info');
            return;
        }
        for (const id of removable) {
            await recallMessage(id);
        }
        clearSelectionMode();
    }

    function bindImageDownloadButton(img) {
        if (!img || img.dataset.longPressBound === '1') return;
        img.dataset.longPressBound = '1';
        const shell = img.closest('.msg-image-shell');
        if (!shell) return;
        const ensureBtn = () => {
            let btn = shell.querySelector('.msg-image-download-btn');
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'msg-image-download-btn';
                btn.title = '下载图片';
                btn.setAttribute('aria-label', '下载图片');
                btn.innerHTML = '↓';
                btn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const src = img.src || img.dataset.src || '';
                    if (!src) return;
                    const ok = await downloadImage(src, urlToFileName(src, 'chat_image'));
                    btn.classList.remove('visible');
                    showToast(ok ? '图片已开始下载' : '下载失败', ok ? 'success' : 'error');
                });
                shell.appendChild(btn);
            }
            return btn;
        };
        let holdTimer = null;
        const hideBtn = () => {
            const btn = shell.querySelector('.msg-image-download-btn');
            if (btn) btn.classList.remove('visible');
        };
        img.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            clearTimeout(holdTimer);
            holdTimer = setTimeout(() => {
                const btn = ensureBtn();
                btn.classList.add('visible');
            }, 380);
        });
        img.addEventListener('pointerup', () => clearTimeout(holdTimer));
        img.addEventListener('pointerleave', () => {
            clearTimeout(holdTimer);
            hideBtn();
        });
        img.addEventListener('pointercancel', () => {
            clearTimeout(holdTimer);
            hideBtn();
        });
        img.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const btn = ensureBtn();
            btn.classList.add('visible');
        });
        img.addEventListener('click', (event) => {
            if (event.target === img) hideBtn();
        });
    }

    function scrollToBottomInstant() {
        const chatBox = document.getElementById('chat-box');
        if (!chatBox) return;
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    function handleLongPress(element) {
        // Deprecated: long press now shows context menu. Keep for compatibility.
        const rect = element.getBoundingClientRect();
        showContextMenu(rect.left + 20, rect.top + 20, element.dataset.msgId, element);
    }

    function clearSelectionOnOutsideClick(event) {
        const toolbar = ensureSelectionToolbar();
        if (!selectionMode) return;
        const clickedInsideMessage = event.target.closest('.msg-wrapper');
        const clickedInsideToolbar = event.target.closest('.message-selection-bar');
        if (!clickedInsideMessage && !clickedInsideToolbar) {
            clearSelectionMode();
        }
    }

    window.cancelReply = function() {
        replyData = null;
        document.getElementById('reply-preview').style.display = 'none';
        document.querySelectorAll('.msg-wrapper.reply-highlight').forEach(el => el.classList.remove('reply-highlight'));
    };

    // 显示上下文菜单（长按或右键）
    function showContextMenu(x, y, messageId, wrapper) {
        hideContextMenu();
        let menu = document.getElementById('msg-context-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'msg-context-menu';
            menu.className = 'context-menu';
            menu.setAttribute('onclick', 'event.stopPropagation()');
            document.body.appendChild(menu);
        }
        menu.innerHTML = '';

        const contentEl = wrapper ? wrapper.querySelector('.msg-content > div') : null;
        const contentText = contentEl ? contentEl.innerText : '';
        const sender = wrapper ? (wrapper.dataset.sender || (wrapper.classList.contains('right') ? mySender : '')) : '';

        const addItem = (label, fn) => {
            const btn = document.createElement('button');
            btn.innerText = label;
            btn.onclick = (e) => { e.stopPropagation(); fn(); hideContextMenu(); };
            menu.appendChild(btn);
            return btn;
        };

        addItem('多选', () => {
            enterSelectionMode(messageId);
        });

        addItem('回复', () => {
            replyData = {
                id: messageId,
                sender,
                content: stripReplyMetadata(wrapper?.dataset.originalContent || contentText),
                mediaUrl: wrapper?.dataset.mediaUrl || '',
                mediaType: wrapper?.dataset.mediaType || ''
            };
            const preview = document.getElementById('reply-preview');
            preview.style.display = 'flex';
            preview.innerHTML = `正在回复：${escapeHtml(replyData.mediaType === 'image' ? '图片' : replyData.mediaType === 'audio' ? '语音' : replyData.content)} <span style="cursor:pointer; color:var(--muted);" onclick="window.cancelReply()">✕</span>`;
        });

        addItem('复制', async () => {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(contentText);
                } else {
                    const textarea = document.createElement('textarea');
                    textarea.value = contentText;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                }
                showToast('已复制', 'success', 1500);
            } catch (e) { showToast('复制失败', 'error'); }
        });

        if (wrapper && wrapper.dataset.replyId) {
            addItem('定位原文', () => goToMessage(wrapper.dataset.replyId));
        }

        if (wrapper && wrapper.querySelector('.voice-message')) {
            addItem('转文字', () => toggleVoiceTranscriptForMessage(wrapper));
        }

        if (sender === mySender) {
            addItem('编辑', () => editMessage(messageId));
            addItem('撤回', () => recallMessage(messageId));
        }

        // position and style
        menu.style.display = 'flex';
        menu.style.flexDirection = 'column';
        menu.style.minWidth = '160px';
        if (!menu.parentElement) document.body.appendChild(menu);
        const mw = menu.offsetWidth || 160;
        const mh = menu.offsetHeight || (menu.children.length * 40 + 10);
        let left = x, top = y;
        if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
        if (top + mh > window.innerHeight) top = window.innerHeight - mh - 8;
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
    }

    function hideContextMenu() {
        const menu = document.getElementById('msg-context-menu');
        if (menu) menu.style.display = 'none';
    }

    // 记录触摸位置以便长按显示菜单，并支持取消（移动时取消）
    let lastTouchPos = { x: 0, y: 0 };
    chatBoxEl.addEventListener('touchstart', (e) => {
        if (continuationToken) return;
        const target = e.target.closest('.msg-wrapper');
        if (e.touches && e.touches[0]) {
            lastTouchPos.x = e.touches[0].clientX;
            lastTouchPos.y = e.touches[0].clientY;
        }
        if (target && !target.classList.contains('system-msg')) {
            pressTimer = setTimeout(() => {
                if (e.target && e.target.closest('.msg-image-download-btn')) return;
                if (selectionMode) {
                    toggleMessageSelection(target.dataset.msgId, true);
                } else {
                    enterSelectionMode(target.dataset.msgId);
                }
            }, 550);
        }
    }, {passive: true});

    // 触摸移动取消长按
    chatBoxEl.addEventListener('touchmove', (e) => {
        if (pressTimer) clearTimeout(pressTimer);
    }, {passive: true});

    chatBoxEl.addEventListener('touchend', () => clearTimeout(pressTimer));
    chatBoxEl.addEventListener('touchcancel', () => clearTimeout(pressTimer));

    chatBoxEl.addEventListener('click', (event) => {
        if (continuationToken) return;
        const wrapper = event.target.closest('.msg-wrapper');
        if (!wrapper || selectionMode === false) return;
        const actionLike = event.target.closest('button, .msg-img, .voice-message, .file-card, .reply-quote');
        if (actionLike) return;
        toggleMessageSelection(wrapper.dataset.msgId, !selectedMessageIds.has(String(wrapper.dataset.msgId)));
    });

    // 右键（桌面）或 contextmenu 事件：优先在 chatBox 内处理，否则全局捕获
    chatBoxEl.addEventListener('contextmenu', (e) => {
        if (continuationToken) return;
        const target = e.target.closest('.msg-wrapper');
        if (target && !target.classList.contains('system-msg')) {
            try { e.preventDefault(); } catch (er) {}
            showContextMenu(e.clientX, e.clientY, target.dataset.msgId, target);
        }
    });

    // mousedown fallback for environments that don't reliably fire contextmenu
    document.addEventListener('mousedown', (e) => {
        if (continuationToken) return;
        if (e.button !== 2) return;
        const target = e.target.closest('.msg-wrapper');
        if (target && !target.classList.contains('system-msg')) {
            try { e.preventDefault(); } catch (er) {}
            showContextMenu(e.clientX, e.clientY, target.dataset.msgId, target);
        }
    });

    // 全局 fallback：一些浏览器/设备可能 not trigger the above handler
    document.addEventListener('contextmenu', (e) => {
        if (continuationToken) return;
        const target = e.target.closest('.msg-wrapper');
        if (target && !target.classList.contains('system-msg')) {
            try { e.preventDefault(); } catch (er) {}
            showContextMenu(e.clientX, e.clientY, target.dataset.msgId, target);
        }
    });

    // 全局点击隐藏上下文菜单
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('msg-context-menu');
        if (menu && !menu.contains(e.target)) menu.style.display = 'none';
        clearSelectionOnOutsideClick(e);
    });

    // 更新消息（用于处理撤回/编辑）并同步本地缓存
    function updateMessageInUI(newMsg) {
        try {
            const chatBox = document.getElementById('chat-box');
            const wrapper = chatBox.querySelector(`[data-msg-id="${newMsg.id}"]`);
            if (!wrapper) return;
            const contentDiv = wrapper.querySelector('.msg-content > div');
            if (contentDiv) {
                const isRecalled = newMsg.content === '[已撤回]';
                if (isRecalled) {
                    contentDiv.innerHTML = '<span style="opacity:0.5;font-style:italic;">[已撤回]</span>';
                    wrapper.dataset.originalContent = '[已撤回]';
                    wrapper.dataset.mediaUrl = '';
                    wrapper.dataset.mediaType = '';
                    const img = wrapper.querySelector('.msg-img');
                    if (img) img.remove();
                    const placeholder = wrapper.querySelector('.msg-img-placeholder');
                    if (placeholder) placeholder.remove();
                    const voiceMsg = wrapper.querySelector('.voice-message-wrap');
                    if (voiceMsg) voiceMsg.remove();
                    const fileCard = wrapper.querySelector('.file-card');
                    if (fileCard) fileCard.remove();
                    wrapper.classList.remove('has-file-card');
                    wrapper.classList.remove('media-only');
                } else {
                    let mediaHtml = '';
                    if (newMsg.media_url) {
                        if (newMsg.media_type === 'audio') {
                            mediaHtml = voiceMessageHtml(newMsg.media_url, newMsg.content);
                        } else if (newMsg.media_type === 'file') {
                            const fn = newMsg.fileName || '';
                            const fs = newMsg.fileSize || null;
                            mediaHtml = fileMessageHtml(newMsg.media_url, fn, fs);
                            wrapper.classList.add('has-file-card');
                        } else {
                            const __img = document.createElement('img');
                            __img.src = newMsg.media_url;
                            __img.className = 'msg-img';
                            __img.alt = '图片消息';
                            mediaHtml = __img.outerHTML;
                        }
                    }
                    const editedBadge = newMsg.edited_at ? ' <span style="font-size:10px;opacity:0.6;">(已编辑)</span>' : '';
                    contentDiv.innerHTML = `${mediaHtml}${newMsg.media_type === 'audio' ? '' : escapeHtml(newMsg.content || '')}${editedBadge}`;
                    const updatedImage = contentDiv.querySelector('.msg-img');
                    if (updatedImage) updatedImage.onclick = () => openImageLightbox(updatedImage.src);
                }
            }
            wrapper.dataset.originalContent = newMsg.content || '';

            // 同步本地缓存，以便搜索/撤回规则保持一致
            try {
                const idx = messagesCache.findIndex(m => String(m.id) === String(newMsg.id));
                if (idx >= 0) {
                    messagesCache[idx].content = newMsg.content;
                    if (newMsg.media_url !== undefined) messagesCache[idx].media_url = newMsg.media_url;
                    if (newMsg.media_type !== undefined) messagesCache[idx].media_type = newMsg.media_type;
                    if (newMsg.edited_at) messagesCache[idx].edited_at = newMsg.edited_at;
                    if (newMsg.is_deleted !== undefined) messagesCache[idx].is_deleted = newMsg.is_deleted;
                    if (newMsg.is_recalled !== undefined) messagesCache[idx].is_recalled = newMsg.is_recalled;
                }
            } catch (e2) { /* ignore cache sync errors */ }
        } catch (e) { console.error('updateMessageInUI', e); }
    }

    // 撤回消息（仅在短时间内允许）
    async function recallMessage(messageId) {
        try {
            const msg = messagesCache.find(m => String(m.id) === String(messageId));
            if (!msg) return showToast('无法找到消息或已过期', 'error');
            const created = new Date(msg.created_at).getTime();
            const now = Date.now();
            const windowMs = 2 * 60 * 1000;
            if (now - created > windowMs) return showToast('撤回时间已过（仅支持发送后2分钟内撤回）', 'error');
            await supabaseClient.from('messages').update({ content: '[已撤回]', media_url: null, media_type: null }).eq('id', messageId);
            updateMessageInUI({ id: messageId, sender: mySender, content: '[已撤回]', media_url: null, media_type: null });
        } catch (e) { console.error('recallMessage', e); showToast('撤回失败', 'error'); }
    }

    async function editMessage(messageId) {
        try {
            const msg = messagesCache.find(m => String(m.id) === String(messageId));
            if (!msg) return showToast('无法找到消息或已过期', 'error');
            if (msg.media_type === 'audio' || msg.media_type === 'image' || msg.media_type === 'file') return showToast('暂不支持编辑媒体消息', 'error');
            const created = new Date(msg.created_at).getTime();
            const now = Date.now();
            const windowMs = 2 * 60 * 1000;
            if (now - created > windowMs) return showToast('编辑时间已过（仅支持发送后2分钟内编辑）', 'error');
            const currentContent = msg.content || '';
            const cleanContent = stripReplyMetadata(currentContent);
            const newContent = prompt('编辑消息：', cleanContent);
            if (newContent === null || newContent.trim() === '') return;
            if (newContent.trim() === cleanContent.trim()) return;
            const finalContent = newContent.trim();
            await supabaseClient.from('messages').update({ content: finalContent, edited_at: beijingISOString() }).eq('id', messageId);
            updateMessageInUI({ id: messageId, sender: mySender, content: finalContent, edited_at: beijingISOString() });
            showToast('消息已编辑', 'success');
        } catch (e) { console.error('editMessage', e); showToast('编辑失败', 'error'); }
    }

    // 搜索消息（升级版：用 modal 显示搜索结果并支持点击跳转）
    window.doSearchModal = async function() {
        const input = document.getElementById('search-modal-input');
        const term = input ? input.value.trim() : '';
        if (!term) return;
        const list = document.querySelector('#search-modal .search-list');
        list.innerHTML = '<div style="padding:12px; color:var(--muted); text-align:center;">搜索中...</div>';

        const results = [];
        const localMatches = messagesCache.filter(m => (m.content||'').toLowerCase().includes(term.toLowerCase()));
        localMatches.forEach(m => results.push({ source: 'local', id: m.id, sender: m.sender, content: m.content, created_at: m.created_at }));

        try {
            const { data, error } = await supabaseClient.from('messages').select('*').ilike('content', `%${term}%`).eq('room_code', currentRoomCode).order('created_at', { ascending: false }).limit(100);
            if (!error && data && data.length) {
                data.forEach(m => {
                    if (!results.find(r => String(r.id) === String(m.id))) {
                        results.push({ source: 'server', id: m.id, sender: m.sender, content: m.content, created_at: m.created_at });
                    }
                });
            }
        } catch (e) { console.warn('server search failed', e); }

        renderSearchResults(results, term);
    };

    function renderSearchResults(results, term) {
        const list = document.querySelector('#search-modal .search-list');
        list.innerHTML = '';
        if (!results || results.length === 0) {
            list.innerHTML = `<div style="padding:12px; color:var(--muted);">未找到与 "${term}" 匹配的消息</div>`;
        } else {
            results.forEach(r => {
                const item = document.createElement('div');
                item.className = 'search-item';
                item.style.cssText = 'padding:10px; border-bottom:1px solid var(--line); cursor:pointer;';
                item.innerHTML = `<div style="font-size:13px; color:var(--muted);">${r.sender} · ${formatMessageTime(new Date(r.created_at))}</div><div style="margin-top:6px; color:var(--text-main);">${String(r.content).slice(0,200)}</div>`;
                item.onclick = async () => { await goToMessage(String(r.id)); closeSearchModal(); };
                list.appendChild(item);
            });
        }
    }

    async function searchMessages() {
        const modal = document.getElementById('search-modal');
        const input = document.getElementById('search-modal-input');
        if (!modal) return showToast('搜索功能暂时不可用', 'error');
        modal.style.display = 'flex';
        if (input) { input.value = ''; setTimeout(() => input.focus(), 100); }
        document.querySelector('#search-modal .search-list').innerHTML = '';
    }
    window.searchMessages = searchMessages;

    function closeSearchModal() {
        const modal = document.getElementById('search-modal');
        if (modal) modal.style.display = 'none';
    }

    // 跳转到指定消息，若未加载尝试上拉加载直到找到或达到上限
    async function goToMessage(messageId, maxAttempts = 12) {
        if (!messageId) return showToast('消息 ID 无效', 'error');
        // 如果元素已在 DOM 中，直接滚动
        let el = document.querySelector(`[data-msg-id="${messageId}"]`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.style.boxShadow = '0 0 0 3px rgba(0,132,255,0.14)';
            setTimeout(() => { el.style.boxShadow = ''; }, 2500);
            return true;
        }

        // 否则尝试分页加载历史，直到找到或 noMoreHistory
        for (let i = 0; i < maxAttempts; i++) {
            if (noMoreHistory) break;
            await loadHistory(false);
            el = document.querySelector(`[data-msg-id="${messageId}"]`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.style.boxShadow = '0 0 0 3px rgba(0,132,255,0.14)';
                setTimeout(() => { el.style.boxShadow = ''; }, 2500);
                return true;
            }
            // small delay to allow DOM to update and avoid tight loop
            await new Promise(r => setTimeout(r, 250));
        }
        showToast('未能在历史记录中找到该消息，请继续上滑以加载更多历史', 'info');
        return false;
    }



    // 聊天设置弹窗（右上角）：仅房间成员、聊天相关项
    window.toggleSettings = function(e) {
        const modal = document.getElementById('settings-modal');
        // If called with an event (overlay click), only close when clicking the overlay itself
        if (e) {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
            return;
        }
        modal.style.display = (modal.style.display === 'flex') ? 'none' : 'flex';
        if (modal.style.display === 'flex') {
            renderRoomMembers();
        }
    };

    // 全局设置页（左下角"设置"）：覆盖整个聊天区域
    window.openGlobalSettings = function() {
        const page = document.getElementById('global-settings-page');
        if (!page) return;
        document.getElementById('settings-modal').style.display = 'none';
        const user = getLoggedInUser();
        const nameEl = document.getElementById('gsp-username');
        if (nameEl) nameEl.textContent = user || '未登录';
        renderOwnAvatar();
        syncThemeCards();
        const speedToggle = document.getElementById('speed-mode-toggle');
        if (speedToggle) speedToggle.checked = isSpeedMode;
        const pollingToggle = document.getElementById('polling-toggle');
        if (pollingToggle) pollingToggle.checked = isPollingEnabled;
        page.style.display = 'block';
        page.scrollTop = 0;
    };

    window.closeGlobalSettings = function() {
        const page = document.getElementById('global-settings-page');
        if (page) page.style.display = 'none';
    };

    // 个人信息页（微信式）：头像 / 账号 / 密码
    window.openProfilePage = function() {
        const page = document.getElementById('profile-page');
        if (!page) return;
        renderOwnAvatar();
        const nameEl = document.getElementById('profile-page-username');
        if (nameEl) nameEl.textContent = mySender || getLoggedInUser() || '';
        page.style.display = 'block';
        page.scrollTop = 0;
    };

    window.closeProfilePage = function() {
        const page = document.getElementById('profile-page');
        if (page) page.style.display = 'none';
    };

    // ============================================
    // 站外通知（群机器人 webhook）
    // ============================================
    const EXTN_EDGE_URL = SUPABASE_URL + '/functions/v1/external-notify';
    const EXTN_HEADERS = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    };
    const EXTN_TYPES = {
        feishu:   { icon: '飞', label: '飞书' },
        dingtalk: { icon: '钉', label: '钉钉' },
        wechat:   { icon: '微', label: '微信/企微' },
        qq:       { icon: 'Q',  label: 'QQ 机器人' },
        custom:   { icon: '⚙', label: '自定义' },
    };
    const EXTN_EVENT_LABELS = {
        new_message: '新消息',
        mention:     '@提及',
        join_request:'新申请',
    };
    let extnEditingId = null;  // null=新增 / number=编辑

    window.openExternalNotifyPage = async function() {
        const page = document.getElementById('external-notify-page');
        if (!page) return;
        // 关闭其他可能打开的层
        document.getElementById('settings-modal').style.display = 'none';
        document.getElementById('global-settings-page').style.display = 'none';
        page.style.display = 'block';
        page.scrollTop = 0;
        await window.extnLoadAndRender();
    };

    window.closeExternalNotifyPage = function() {
        const page = document.getElementById('external-notify-page');
        if (page) page.style.display = 'none';
    };

    async function extnFetchChannels() {
        const user = getLoggedInUser();
        if (!user) return [];
        const { data, error } = await supabaseClient
            .from('external_notify_channels')
            .select('id,user_name,channel_type,name,webhook_url,enabled,events,show_sender,show_content,created_at')
            .eq('user_name', user)
            .order('id', { ascending: true });
        if (error) { console.warn('[extn] load error:', error); return []; }
        return data || [];
    }

    window.extnLoadAndRender = async function() {
        const list = await extnFetchChannels();
        const container = document.getElementById('extn-channels-list');
        const empty = document.getElementById('extn-empty-tip');
        if (!container) return;
        if (list.length === 0) {
            container.innerHTML = '';
            if (empty) empty.style.display = 'block';
            return;
        }
        if (empty) empty.style.display = 'none';
        container.innerHTML = list.map(ch => extnRenderCard(ch)).join('');
    };

    function extnRenderCard(ch) {
        const t = EXTN_TYPES[ch.channel_type] || EXTN_TYPES.custom;
        const url = (ch.webhook_url || '').replace(/(.{32}).+(.{8})/, '$1…$2');
        const evts = (ch.events || []).map(e => `<span class="extn-evt-tag">${escapeHtml(EXTN_EVENT_LABELS[e] || e)}</span>`).join('');
        const privacy = [
            ch.show_sender  ? '<span class="extn-evt-tag">显示名称</span>' : '',
            ch.show_content ? '<span class="extn-evt-tag">显示内容</span>' : '',
        ].filter(Boolean).join('') || '<span class="extn-evt-tag">隐私全开</span>';
        return `
        <div class="extn-channel-card${ch.enabled ? '' : ' disabled'}" data-ch-id="${ch.id}">
            <div class="extn-channel-head">
                <div class="extn-channel-icon ${escapeHtml(ch.channel_type)}">${escapeHtml(t.icon)}</div>
                <div class="extn-channel-name">${escapeHtml(ch.name)}</div>
                <label class="extn-channel-toggle">
                    <input type="checkbox" data-ch-id="${ch.id}" ${ch.enabled ? 'checked' : ''} onchange="window.toggleChannelEnabled(${ch.id}, this.checked)">
                </label>
            </div>
            <div class="extn-channel-meta">
                <div>${escapeHtml(t.label)} · ${escapeHtml(url)}</div>
                <div style="margin-top:4px;">订阅：${evts}</div>
                <div style="margin-top:4px;">隐私：${privacy}</div>
            </div>
            <div class="extn-channel-actions">
                <button class="extn-action-btn" onclick="window.editChannel(${ch.id})">编辑</button>
                <button class="extn-action-btn" onclick="window.testChannel(${ch.id})">测试</button>
                <button class="extn-action-btn danger" onclick="window.deleteChannel(${ch.id})">删除</button>
            </div>
        </div>`;
    }

    window.toggleChannelEnabled = async function(id, enabled) {
        const { error } = await supabaseClient
            .from('external_notify_channels')
            .update({ enabled })
            .eq('id', id);
        if (error) { showToast('更新失败：' + error.message, 'error'); return; }
        const card = document.querySelector(`[data-ch-id="${id}"]`);
        if (card) card.classList.toggle('disabled', !enabled);
        showToast(enabled ? '已启用' : '已停用', 'success', 1200);
    };

    window.openAddChannelModal = function() {
        extnEditingId = null;
        document.getElementById('extn-modal-title').textContent = '添加钉钉通知渠道';
        document.getElementById('extn-channel-name').value = '';
        document.getElementById('extn-channel-url').value = '';
        document.getElementById('extn-evt-newmsg').checked = true;
        document.getElementById('extn-evt-mention').checked = true;
        document.getElementById('extn-evt-join').checked = false;
        document.getElementById('extn-show-sender').checked = false;
        document.getElementById('extn-show-content').checked = false;
        document.getElementById('extn-channel-modal').classList.add('show');
        setTimeout(() => document.getElementById('extn-channel-name').focus(), 50);
    };

    window.closeChannelModal = function() {
        document.getElementById('extn-channel-modal').classList.remove('show');
        extnEditingId = null;
    };

    window.editChannel = async function(id) {
        const list = await extnFetchChannels();
        const ch = list.find(x => String(x.id) === String(id));
        if (!ch) return;
        extnEditingId = id;
        document.getElementById('extn-modal-title').textContent = '编辑钉钉通知渠道';
        document.getElementById('extn-channel-name').value = ch.name || '';
        document.getElementById('extn-channel-url').value = ch.webhook_url || '';
        const evs = new Set(ch.events || []);
        document.getElementById('extn-evt-newmsg').checked = evs.has('new_message');
        document.getElementById('extn-evt-mention').checked = evs.has('mention');
        document.getElementById('extn-evt-join').checked = evs.has('join_request');
        document.getElementById('extn-show-sender').checked = !!ch.show_sender;
        document.getElementById('extn-show-content').checked = !!ch.show_content;
        document.getElementById('extn-channel-modal').classList.add('show');
    };

    window.saveChannel = async function() {
        const user = getLoggedInUser();
        if (!user) { showToast('请先登录', 'error'); return; }
        const btn = document.getElementById('extn-save-btn');
        const channel_type = 'dingtalk';   // 仅支持钉钉
        const name = document.getElementById('extn-channel-name').value.trim();
        const webhook_url = document.getElementById('extn-channel-url').value.trim();
        const events = [];
        if (document.getElementById('extn-evt-newmsg').checked) events.push('new_message');
        if (document.getElementById('extn-evt-mention').checked) events.push('mention');
        if (document.getElementById('extn-evt-join').checked) events.push('join_request');
        const show_sender = document.getElementById('extn-show-sender').checked;
        const show_content = document.getElementById('extn-show-content').checked;
        if (!name) { showToast('请填写渠道名称', 'error'); return; }
        if (!webhook_url) { showToast('请填写 Webhook URL', 'error'); return; }
        if (!/^https:\/\//i.test(webhook_url)) { showToast('Webhook URL 必须以 https:// 开头', 'error'); return; }
        if (events.length === 0) { showToast('至少勾选一个订阅事件', 'error'); return; }
        btn.disabled = true; btn.textContent = '保存中...';
        try {
            if (extnEditingId) {
                const { error } = await supabaseClient
                    .from('external_notify_channels')
                    .update({ channel_type, name, webhook_url, events, show_sender, show_content })
                    .eq('id', extnEditingId);
                if (error) throw error;
                showToast('已保存', 'success', 1200);
            } else {
                const { error } = await supabaseClient
                    .from('external_notify_channels')
                    .insert([{ user_name: user, channel_type, name, webhook_url, events, show_sender, show_content, enabled: true }]);
                if (error) throw error;
                showToast('已添加', 'success', 1200);
            }
            window.closeChannelModal();
            await window.extnLoadAndRender();
        } catch (e) {
            showToast('保存失败：' + (e.message || ''), 'error', 3500);
        } finally {
            btn.disabled = false; btn.textContent = '保存';
        }
    };

    window.deleteChannel = async function(id) {
        if (!confirm('确定删除该通知渠道？')) return;
        const { error } = await supabaseClient
            .from('external_notify_channels')
            .delete()
            .eq('id', id);
        if (error) { showToast('删除失败：' + error.message, 'error'); return; }
        showToast('已删除', 'success', 1200);
        await window.extnLoadAndRender();
    };

    /** 测试渠道：直接往该渠道 webhook 推一条测试消息（绕过房间收件人逻辑），并显示平台返回的具体错误 */
    window.testChannel = async function(id) {
        const list = await extnFetchChannels();
        const ch = list.find(x => String(x.id) === String(id));
        if (!ch) return;
        const btn = document.querySelector(`.extn-channel-card[data-ch-id="${id}"] .extn-action-btn[data-test]`) ||
                    [...document.querySelectorAll(`.extn-channel-card[data-ch-id="${id}"] .extn-action-btn`)].find(b => b.textContent.includes('测试'));
        const origText = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = '测试中...'; }
        try {
            const resp = await fetch(EXTN_EDGE_URL, {
                method: 'POST',
                headers: EXTN_HEADERS,
                body: JSON.stringify({
                    event: 'new_message',
                    room_code: currentRoomCode || 'test',
                    sender: mySender || getLoggedInUser() || 'tester',
                    content: '站外通知渠道连通性测试，请忽略',
                    channel_id: id,   // 测试模式：直接推送到本渠道
                }),
            });
            const data = await resp.json().catch(() => ({}));
            if (data.ok === true) {
                showToast(`✓ 测试成功，请到${(EXTN_TYPES[ch.channel_type] || {}).label || '对应 IM'}查看`, 'success', 3000);
            } else {
                const reason = data.error || (data.response && typeof data.response === 'object'
                    ? (data.response.errmsg || data.response.msg || JSON.stringify(data.response))
                    : (data.response ? String(data.response) : `HTTP ${data.status || resp.status}`));
                showToast(`✗ 测试失败：${reason}`, 'error', 5000);
            }
        } catch (e) {
            showToast('请求失败：' + e.message, 'error', 4000);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = origText; }
        }
    };

    /**
     * 实际触发站外通知（由 sendMessage / submitJoinRequest / 投票完成后调用）
     * @param {string} event 'new_message' | 'mention' | 'join_request'
     * @param {object} opts { room_code, sender, content, mention_user?, request_id? }
     */
    async function triggerExternalNotify(event, opts) {
        try {
            // 仅在浏览器前台时触发；静默失败不影响主流程
            if (typeof window === 'undefined' || typeof fetch !== 'function') return;
            const payload = { event, ...opts };
            const resp = await fetch(EXTN_EDGE_URL, {
                method: 'POST',
                headers: EXTN_HEADERS,
                body: JSON.stringify(payload),
                // 不阻塞主流程：失败仅记录
            }).catch(e => ({ ok: false, _err: String(e) }));
            // 不要 await；fire-and-forget；不打印日志避免噪音
            return resp;
        } catch (e) {
            console.warn('[extn] trigger failed:', e);
        }
    }
    window.triggerExternalNotify = triggerExternalNotify;

    // 修改密码：旧密码与新密码校验都在后端 Edge Function 执行，前端不接触密码哈希逻辑。
    window.changePassword = async function() {
        const msgEl = document.getElementById('pwd-msg');
        const oldEl = document.getElementById('pwd-old');
        const newEl = document.getElementById('pwd-new');
        const new2El = document.getElementById('pwd-new2');
        const user = getLoggedInUser();
        if (!user) return;
        const show = (text, ok) => {
            msgEl.textContent = text;
            msgEl.style.color = ok ? '#16a34a' : '#dc2626';
            msgEl.style.display = 'block';
        };
        const oldPwd = oldEl.value.trim(), newPwd = newEl.value.trim(), newPwd2 = new2El.value.trim();
        if (!oldPwd || !newPwd) { show('请填写完整', false); return; }
        if (newPwd.length < 4) { show('新密码至少 4 位', false); return; }
        if (newPwd !== newPwd2) { show('两次输入的新密码不一致', false); return; }
        try {
            await callServerAction(SUPABASE_URL + '/functions/v1/verify-auth', 'change-password', {
                username: user,
                oldPassword: oldPwd,
                newPassword: newPwd
            });
            show('密码修改成功', true);
            oldEl.value = ''; newEl.value = ''; new2El.value = '';
            showToast('密码已更新', 'success', 2000);
        } catch (e) {
            show(e && e.message ? e.message : '修改失败，请重试', false);
        }
    };

    // ===== 房间成员（微信聊天信息风格：头像网格 + 在线绿点 + 点击@TA） =====
    window.insertMentionFromMembers = function(name) {
        const input = document.getElementById('message-input');
        if (!input) return;
        input.value = (input.value || '') + '@' + name + ' ';
        input.focus();
    };

    async function renderRoomMembers() {
        const section = document.getElementById('members-section');
        const grid = document.getElementById('members-grid');
        const countEl = document.getElementById('members-count');
        const tipEl = document.getElementById('members-tip');
        if (!section || !grid) return;
        if (!currentRoomCode || !supabaseClient) { section.style.display = 'none'; return; }
        section.style.display = 'block';
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);font-size:12px;padding:8px 0;">加载中…</div>';
        try {
            const { data, error } = await supabaseClient
                .from('room_members')
                .select('user_name,created_at')
                .eq('room_code', currentRoomCode)
                .order('created_at', { ascending: true });
            if (error) throw error;
            const members = [...new Set((data || []).map(m => m.user_name))];
            // 在线判断：presence key = `房间:用户`
            const onlineKeys = new Set();
            try {
                if (roomSubscription) {
                    const state = roomSubscription.presenceState();
                    Object.keys(state || {}).forEach(k => {
                        const idx = k.indexOf(':');
                        if (idx > -1 && k.slice(0, idx) === currentRoomCode) onlineKeys.add(k.slice(idx + 1));
                    });
                }
            } catch (e) { /* presence 不可用时忽略 */ }
            if (countEl) countEl.textContent = members.length;
            if (!members.length) {
                grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);font-size:12px;padding:8px 0;">暂无固定成员</div>';
                if (tipEl) tipEl.style.display = 'none';
                return;
            }
            if (tipEl) tipEl.style.display = 'block';
            grid.innerHTML = members.map(name =>
                `<div class="member-cell ${onlineKeys.has(name) ? 'online' : ''}" onclick="window.insertMentionFromMembers('${escapeHtml(name).replace(/'/g, '&#39;')}')">
                    <div class="member-ava-wrap">${avatarHtml(name)}<span class="member-online-dot"></span></div>
                    <div class="member-name">${escapeHtml(name)}</div>
                </div>`
            ).join('');
            // 头像未缓存时批量回填（会自动替换 DOM 中的头像）
            fetchAndApplyUserAvatars(members);
        } catch (e) {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);font-size:12px;padding:8px 0;">加载失败</div>';
        }
    }

    window.toggleSpeedMode = function(toggle) {
        isSpeedMode = toggle.checked;
        localStorage.setItem('chat_speed_mode', isSpeedMode ? '1' : '0');
        if (isSpeedMode) {
            document.querySelectorAll('.message-avatar[data-sender]').forEach(avatar => {
                const sender = avatar.dataset.sender;
                if (avatar.tagName === 'IMG') {
                    avatar.outerHTML = avatarHtml(sender);
                }
            });
            refreshMessageAvatars();
            showToast('极速模式已开启，优先保证消息收发', 'success', 2000);
        } else {
            showToast('已切换为正常模式', 'info', 2000);
            if (currentRoomCode) {
                fetchAndApplyUserAvatars(messagesCache.map(m => m.sender));
            }
        }
    };

    window.togglePolling = function(toggle) {
        isPollingEnabled = toggle.checked;
        localStorage.setItem('chat_polling_enabled', isPollingEnabled ? '1' : '0');
        if (isPollingEnabled) {
            startPolling();
            showToast('消息轮询已开启，每5秒主动拉取新消息', 'success', 2000);
        } else {
            stopPolling();
            showToast('消息轮询已关闭，仅依赖实时推送', 'info', 2000);
        }
    };

    // ============================================
    // 后台管理面板
    // ============================================
    const ADMIN_MSG_PAGE_SIZE = 50;
    let adminTab = 'rooms';
    let adminMsgRoom = '';
    let adminMsgSearch = '';
    let adminMsgPage = 0;
    let adminRoomsCache = [];
    let adminUsersCache = [];
    let adminLoading = false;

    function adminEsc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function adminFmtTime(ts) {
        if (!ts) return '-';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return adminEsc(ts);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    function adminMediaTag(m) {
        if (!m) return '';
        const t = String(m);
        if (t.startsWith('system_join_request')) return '📬 系统';
        if (t.startsWith('image')) return '🖼 图片';
        if (t.startsWith('audio')) return '🎤 语音';
        if (t.startsWith('video')) return '🎬 视频';
        return '📎 文件';
    }

    window.openAdminPanel = function() {
        document.getElementById('settings-modal').style.display = 'none';
        // 每次打开都强制重新输密码（不信任任何缓存）
        sessionStorage.removeItem('harry_admin_ok');
        const modal = document.getElementById('admin-modal');
        modal.classList.add('show');
        document.getElementById('admin-login-view').style.display = 'flex';
        document.getElementById('admin-main-view').style.display = 'none';
        const pwd = document.getElementById('admin-pwd-input');
        pwd.value = '';
        setTimeout(() => pwd.focus(), 100);
    };

    window.closeAdminPanel = function() {
        document.getElementById('admin-modal').classList.remove('show');
    };

    window.adminTryLogin = async function() {
        const pwd = document.getElementById('admin-pwd-input').value;
        const err = document.getElementById('admin-pwd-err');
        const btn = document.getElementById('admin-login-btn');
        btn.disabled = true;
        try {
            await callServerAction(null, 'admin-login', { password: pwd });
            sessionStorage.setItem('harry_admin_ok', '1');
            err.style.display = 'none';
            document.getElementById('admin-login-view').style.display = 'none';
            document.getElementById('admin-main-view').style.display = 'flex';
            adminEnterMain();
        } catch (error) {
            console.error('Admin authentication failed:', error);
            err.style.display = 'block';
        } finally {
            btn.disabled = false;
        }
    };

    window.adminLogout = function() {
        sessionStorage.removeItem('harry_admin_ok');
        window.closeAdminPanel();
        showToast('已退出后台管理', 'info', 1500);
    };

    function adminEnterMain() {
        window.adminSwitchTab(adminTab);
    }

    window.adminReload = function() {
        window.adminSwitchTab(adminTab);
    };

    window.adminSwitchTab = function(tab) {
        adminTab = tab;
        // 同时更新桌面端侧栏和手机端底部 tabbar 的 active 状态
        document.querySelectorAll('.admin-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.querySelectorAll('.admin-tab-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        const body = document.getElementById('admin-tab-body');
        body.innerHTML = '<div class="admin-empty">加载中…</div>';
        if (tab === 'rooms') adminRenderRooms();
        else if (tab === 'messages') adminInitMessagesTab();
        else if (tab === 'users') adminRenderUsers();
        else if (tab === 'login-logs') adminRenderLoginLogs();
    };

    /** 房间列表：房间 + 成员数 + 成员管理入口（踢出） */
    async function adminRenderRooms() {
        const body = document.getElementById('admin-tab-body');
        try {
            const { data: rooms, error } = await supabaseClient.from('rooms').select('room_code,room_name').order('room_code');
            if (error) throw error;
            adminRoomsCache = rooms || [];
            const { data: members } = await supabaseClient.from('room_members').select('room_code,user_name');
            const memberCount = {};
            (members || []).forEach(m => { memberCount[m.room_code] = (memberCount[m.room_code] || 0) + 1; });
            body.innerHTML = '<table class="admin-table"><thead><tr><th>房间号</th><th>房间名称</th><th>成员数</th><th>操作</th></tr></thead><tbody>' +
                adminRoomsCache.map(r =>
                    `<tr><td data-label="房间号"><b>${adminEsc(r.room_code)}</b></td><td data-label="名称">${adminEsc(r.room_name || '-')}</td><td data-label="成员">${memberCount[r.room_code] || 0} 人</td>` +
                    `<td data-label="管理"><button class="admin-op" onclick="window.adminOpenRoomMembers('${adminEsc(r.room_code).replace(/'/g, '&#39;')}')">成员管理</button> <button class="admin-op danger" data-code="${adminEsc(r.room_code).replace(/'/g, '&#39;')}" onclick="window.adminDeleteRoom(this)">删除</button></td></tr>`
                ).join('') +
                '</tbody></table>';
            if (!adminRoomsCache.length) body.innerHTML = '<div class="admin-empty">暂无房间</div>';
        } catch (e) {
            body.innerHTML = '<div class="admin-error">加载失败：' + adminEsc(e.message || e) + '</div>';
        }
    }

    /** 房间成员管理：查看成员 + 踢出 */
    window.adminOpenRoomMembers = async function(code) {
        const body = document.getElementById('admin-tab-body');
        body.innerHTML =
            `<div class="admin-subhead"><button class="admin-back-btn" onclick="window.adminSwitchTab('rooms')">‹ 返回房间列表</button><span><b>${adminEsc(code)}</b> 的成员</span></div>` +
            '<div id="admin-mem-list"><div class="admin-empty">加载中…</div></div>';
        try {
            const { data, error } = await supabaseClient.from('room_members').select('user_name,created_at').eq('room_code', code).order('created_at');
            if (error) throw error;
            const rows = data || [];
            document.getElementById('admin-mem-list').innerHTML = rows.length
                ? '<table class="admin-table"><thead><tr><th>成员</th><th>加入时间</th><th>操作</th></tr></thead><tbody>' +
                  rows.map(m =>
                      `<tr><td data-label="成员"><b>${adminEsc(m.user_name)}</b></td><td data-label="加入于">${adminFmtTime(m.created_at)}</td>` +
                      `<td data-label="管理"><button class="admin-op danger" data-code="${adminEsc(code)}" data-user="${adminEsc(m.user_name)}" onclick="window.adminKickMember(this)">踢出</button></td></tr>`
                  ).join('') +
                  '</tbody></table>'
                : '<div class="admin-empty">该房间暂无成员</div>';
        } catch (e) {
            document.getElementById('admin-mem-list').innerHTML = '<div class="admin-error">加载失败：' + adminEsc(e.message || e) + '</div>';
        }
    };

    /** 踢出成员（两步确认，防误触） */
    window.adminKickMember = function(btn) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = '确认踢出?';
            setTimeout(() => {
                if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = '踢出'; }
            }, 3000);
            return;
        }
        const code = btn.dataset.code, user = btn.dataset.user;
        btn.disabled = true; btn.textContent = '踢出中…';
        supabaseClient.from('room_members').delete().eq('room_code', code).eq('user_name', user)
            .then(({ error }) => {
                if (error) {
                    showToast('踢出失败：' + (error.message || ''), 'error');
                    btn.disabled = false; btn.dataset.armed = ''; btn.textContent = '踢出';
                    return;
                }
                showToast(`已将 ${user} 移出房间 ${code}`, 'success');
                window.adminOpenRoomMembers(code);
            });
    };

    /** 删除房间（两步确认，级联删消息和成员） */
    window.adminDeleteRoom = function(btn) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = '确认删除?';
            setTimeout(() => {
                if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = '删除'; }
            }, 3000);
            return;
        }
        const code = btn.dataset.code;
        btn.disabled = true; btn.textContent = '删除中…';
        // 级联删除：先删消息、再删成员、最后删房间
        Promise.all([
            supabaseClient.from('messages').delete().eq('room_code', code),
            supabaseClient.from('room_members').delete().eq('room_code', code)
        ]).then(() =>
            supabaseClient.from('rooms').delete().eq('room_code', code)
        ).then(({ error }) => {
            if (error) {
                showToast('删除失败：' + (error.message || ''), 'error');
                btn.disabled = false; btn.dataset.armed = ''; btn.textContent = '删除';
                return;
            }
            showToast(`房间 ${code} 已删除`, 'success');
            window.adminRenderRooms();
        }).catch(e => {
            showToast('删除失败：' + (e.message || e), 'error');
            btn.disabled = false; btn.dataset.armed = ''; btn.textContent = '删除';
        });
    };

    /** 删除单条消息（两步确认） */
    window.adminDeleteMessage = function(btn) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = '确认删除?';
            setTimeout(() => {
                if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = '删除'; }
            }, 3000);
            return;
        }
        const id = btn.dataset.id;
        btn.disabled = true; btn.textContent = '删除中…';
        supabaseClient.from('messages').delete().eq('id', id)
            .then(({ error }) => {
                if (error) {
                    showToast('删除失败：' + (error.message || ''), 'error');
                    btn.disabled = false; btn.dataset.armed = ''; btn.textContent = '删除';
                    return;
                }
                showToast('消息已删除', 'success');
                // 从列表移除
                const item = btn.closest('.admin-msg-item');
                if (item) item.remove();
            });
    };

    /** 删除用户（两步确认，级联删登录日志 + 成员记录 + 消息） */
    window.adminDeleteUser = function(btn) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = '确认删除?';
            setTimeout(() => {
                if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = '删除'; }
            }, 3000);
            return;
        }
        const user = btn.dataset.username;
        btn.disabled = true; btn.textContent = '删除中…';
        // 级联删除：登录日志 + 房间成员 + 用户消息 + 用户记录
        Promise.all([
            supabaseClient.from('login_logs').delete().eq('username', user),
            supabaseClient.from('room_members').delete().eq('user_name', user),
            supabaseClient.from('messages').delete().eq('sender', user)
        ]).then(() =>
            supabaseClient.from('users').delete().eq('username', user)
        ).then(({ error }) => {
            if (error) {
                showToast('删除失败：' + (error.message || ''), 'error');
                btn.disabled = false; btn.dataset.armed = ''; btn.textContent = '删除';
                return;
            }
            showToast(`用户 ${user} 已删除`, 'success');
            window.adminRenderUsers();
        }).catch(e => {
            showToast('删除失败：' + (e.message || e), 'error');
            btn.disabled = false; btn.dataset.armed = ''; btn.textContent = '删除';
        });
    };

    /** 消息浏览：选房间 + 搜索 + 分页 + 批量勾选删除 */
    function adminInitMessagesTab() {
        const body = document.getElementById('admin-tab-body');
        adminMsgPage = 0;
        const options = ['<option value="">全部房间</option>'].concat(
            adminRoomsCache.map(r => `<option value="${adminEsc(r.room_code)}" ${r.room_code === adminMsgRoom ? 'selected' : ''}>${adminEsc(r.room_code)}</option>`)
        ).join('');
        body.innerHTML =
            `<div class="admin-toolbar">
                <select id="admin-msg-room" onchange="window.adminMsgFilterChanged()">${options}</select>
                <input type="text" id="admin-msg-search" placeholder="搜索消息内容…" value="${adminEsc(adminMsgSearch)}" onkeydown="if(event.key==='Enter')window.adminMsgFilterChanged()">
                <button onclick="window.adminMsgFilterChanged()">查询</button>
            </div>
            <div class="admin-batch-bar" id="admin-batch-bar" style="display:none;">
                <label><input type="checkbox" id="admin-msg-check-all" onchange="window.adminMsgToggleAll(this)"> 全选本页</label>
                <span id="admin-msg-selected-count">已选 0 条</span>
                <button class="admin-op danger" onclick="window.adminBatchDeleteMessages()">批量删除</button>
                <button class="admin-op" onclick="window.adminClearSelection()">取消</button>
            </div>
            <div id="admin-msg-list"></div>
            <button id="admin-msg-more" class="admin-load-more" style="display:none" onclick="window.adminLoadMoreMessages()">加载更多</button>`;
        adminLoadMessagesPage(false);
    }

    window.adminMsgFilterChanged = function() {
        adminMsgRoom = document.getElementById('admin-msg-room').value;
        adminMsgSearch = document.getElementById('admin-msg-search').value.trim();
        adminMsgPage = 0;
        adminLoadMessagesPage(false);
    };

    window.adminLoadMoreMessages = function() {
        adminLoadMessagesPage(true);
    };

    window.adminMsgToggleAll = function(cb) {
        const list = document.getElementById('admin-msg-list');
        if (!list) return;
        list.querySelectorAll('.admin-msg-check').forEach(c => c.checked = cb.checked);
        window.adminUpdateBatchCount();
    };

    window.adminClearSelection = function() {
        const list = document.getElementById('admin-msg-list');
        if (!list) return;
        list.querySelectorAll('.admin-msg-check').forEach(c => c.checked = false);
        const bar = document.getElementById('admin-batch-bar');
        if (bar) bar.style.display = 'none';
    };

    window.adminUpdateBatchCount = function() {
        const list = document.getElementById('admin-msg-list');
        const bar = document.getElementById('admin-batch-bar');
        if (!list || !bar) return;
        const checked = list.querySelectorAll('.admin-msg-check:checked').length;
        if (checked > 0) {
            bar.style.display = 'flex';
            document.getElementById('admin-msg-selected-count').textContent = `已选 ${checked} 条`;
        } else {
            bar.style.display = 'none';
        }
    };

    window.adminBatchDeleteMessages = function() {
        const list = document.getElementById('admin-msg-list');
        if (!list) return;
        const ids = Array.from(list.querySelectorAll('.admin-msg-check:checked')).map(c => Number(c.value));
        if (!ids.length) { showToast('请先勾选要删除的消息', 'info'); return; }
        if (!confirm(`确定删除选中的 ${ids.length} 条消息？此操作不可撤销`)) return;
        showToast(`正在删除 ${ids.length} 条消息…`, 'info', 3000);
        Promise.all(ids.map(id => supabaseClient.from('messages').delete().eq('id', id)))
            .then(() => {
                showToast('批量删除完成', 'success');
                window.adminClearSelection();
                // 移除已删节点
                ids.forEach(id => {
                    const row = list.querySelector(`.admin-msg-row[data-id="${id}"]`);
                    if (row) row.remove();
                });
                // 如果列表空了，显示空提示
                if (!list.children.length) {
                    list.innerHTML = '<div class="admin-empty">没有匹配的消息</div>';
                    const more = document.getElementById('admin-msg-more');
                    if (more) more.style.display = 'none';
                }
            })
            .catch(e => showToast('删除失败：' + (e.message || e), 'error'));
    };

    async function adminLoadMessagesPage(append) {
        if (adminLoading) return;
        adminLoading = true;
        const list = document.getElementById('admin-msg-list');
        const moreBtn = document.getElementById('admin-msg-more');
        try {
            let q = supabaseClient.from('messages').select('*').order('created_at', { ascending: false })
                .range(adminMsgPage * ADMIN_MSG_PAGE_SIZE, adminMsgPage * ADMIN_MSG_PAGE_SIZE + ADMIN_MSG_PAGE_SIZE - 1);
            if (adminMsgRoom) q = q.eq('room_code', adminMsgRoom);
            if (adminMsgSearch) q = q.ilike('content', `%${adminMsgSearch}%`);
            const { data, error } = await q;
            if (error) throw error;
            const rows = data || [];
            const html = rows.map(m => {
                const tag = adminMediaTag(m.media_type);
                const preview = adminEsc(stripReplyMetadata(m.content || '')) || (m.media_url ? '[媒体]' : '');
                return `<div class="admin-msg-row" data-id="${m.id}">
                    <input type="checkbox" class="admin-msg-check" value="${m.id}" onchange="window.adminUpdateBatchCount()">
                    <span class="admin-msg-sender">${adminEsc(m.sender)}</span>
                    ${adminMsgRoom ? '' : `<span class="admin-msg-room">${adminEsc(m.room_code)}</span>`}
                    ${tag ? `<span class="admin-chip">${tag}</span>` : ''}
                    <span class="admin-msg-preview">${preview}</span>
                    <span class="admin-msg-time">${adminFmtTime(m.created_at)}</span>
                </div>`;
            }).join('');
            if (append) list.insertAdjacentHTML('beforeend', html);
            else list.innerHTML = html || '<div class="admin-empty">没有匹配的消息</div>';
            adminMsgPage++;
            if (moreBtn) moreBtn.style.display = rows.length === ADMIN_MSG_PAGE_SIZE ? 'block' : 'none';
        } catch (e) {
            list.innerHTML = '<div class="admin-error">加载失败：' + adminEsc(e.message || e) + '</div>';
        }
        adminLoading = false;
    }

    /** 用户列表（卡片式：头像 + 用户名 + 注册/登录信息 + 改密码） */
    async function adminRenderUsers() {
        const body = document.getElementById('admin-tab-body');
        try {
            const { data: users, error } = await supabaseClient.from('users').select('username,avatar_url,created_at').order('created_at', { ascending: true });
            if (error) throw error;
            const rows = users || [];
            adminUsersCache = rows;
            if (!rows.length) { body.innerHTML = '<div class="admin-empty">暂无注册用户</div>'; return; }
            // 聚合最近登录时间和登录次数
            const loginMap = {};
            try {
                const { data: logs } = await supabaseClient.from('login_logs').select('username,created_at').order('created_at', { ascending: false }).limit(1000);
                (logs || []).forEach(l => {
                    if (!loginMap[l.username]) loginMap[l.username] = { last: l.created_at, count: 0 };
                    loginMap[l.username].count++;
                });
            } catch (e) { /* login_logs 表可能还没创建，忽略 */ }
            // 头像统一单色（石墨极简）：不再按用户名随机配色
            const colorOf = () => '#52525b';
            body.innerHTML = rows.map((u, i) => {
                const lm = loginMap[u.username];
                const avatar = u.avatar_url
                    ? (() => { const __img = document.createElement('img'); __img.className = 'admin-user-avatar'; __img.src = u.avatar_url; __img.alt = ''; __img.onerror = function() { this.style.display = 'none'; }; return __img.outerHTML; })()
                    : `<div class="admin-user-avatar" style="background:${colorOf(u.username)}">${adminEsc(String(u.username).slice(0, 1).toUpperCase())}</div>`;
                return `<div class="admin-user-card">
                    ${avatar}
                    <div class="admin-user-info">
                        <div class="admin-user-name">${adminEsc(u.username)}</div>
                        <div class="admin-user-meta">注册：${adminFmtTime(u.created_at)} · 最近登录：${lm ? adminFmtTime(lm.last) + ' · ' + lm.count + ' 次' : '暂无记录'}</div>
                        <div class="admin-pw-form" id="admin-pw-${i}" style="display:none;">
                            <input type="text" id="admin-pw-input-${i}" placeholder="输入新密码（至少4位）" autocomplete="off">
                            <button class="admin-op" onclick="window.adminSavePassword(${i})">保存</button>
                        </div>
                    </div>
                    <div class="admin-user-actions">
                        <button class="admin-op" onclick="window.adminTogglePwForm(${i})">改密码</button>
                        <button class="admin-op danger" data-username="${adminEsc(u.username).replace(/'/g, '&#39;')}" onclick="window.adminDeleteUser(this)">删除</button>
                    </div>
                </div>`;
            }).join('');
        } catch (e) {
            body.innerHTML = '<div class="admin-error">加载失败：' + adminEsc(e.message || e) + '</div>';
        }
    }

    /** 改密码：展开/收起表单 */
    window.adminTogglePwForm = function(i) {
        const form = document.getElementById('admin-pw-' + i);
        if (!form) return;
        const show = form.style.display === 'none';
        // 收起其他已展开的表单
        document.querySelectorAll('.admin-pw-form').forEach(f => { f.style.display = 'none'; });
        if (show) {
            form.style.display = 'flex';
            const input = document.getElementById('admin-pw-input-' + i);
            if (input) { input.value = ''; setTimeout(() => input.focus(), 60); }
        }
    };

    /** 保存新密码 */
    window.adminSavePassword = async function(i) {
        const u = adminUsersCache[i];
        if (!u) return;
        const input = document.getElementById('admin-pw-input-' + i);
        const pwd = (input && input.value || '').trim();
        if (pwd.length < 4) return showToast('新密码至少 4 位', 'error');
        const adminPassword = prompt('请输入管理密码以确认此操作：');
        if (!adminPassword) return;
        try {
            await callServerAction(null, 'admin-change-password', {
                adminPassword,
                username: u.username,
                newPassword: pwd
            });
            showToast(`已修改 ${u.username} 的密码，下次登录生效`, 'success');
            const form = document.getElementById('admin-pw-' + i);
            if (form) form.style.display = 'none';
        } catch (e) {
            showToast('修改失败：' + (e.message || e), 'error');
        }
    };

    /** 登录日志（手动 + 自动 + 暗房进入/退出） */
    async function adminRenderLoginLogs() {
        const body = document.getElementById('admin-tab-body');
        try {
            const { data, error } = await supabaseClient.from('login_logs').select('*').order('created_at', { ascending: false }).limit(200);
            if (error) throw error;
            const rows = data || [];
            const shortUA = ua => { ua = String(ua || ''); return ua.length > 46 ? ua.slice(0, 46) + '…' : ua; };
            const typeChip = t => {
                if (t === 'auto') return '<span class="admin-chip">自动登录</span>';
                if (t === 'hidden_room_enter') return '<span class="admin-chip hidden">进入暗房</span>';
                if (t === 'hidden_room_exit') return '<span class="admin-chip">退出暗房</span>';
                return '<span class="admin-chip ok">手动登录</span>';
            };
            body.innerHTML = rows.length
                ? '<table class="admin-table"><thead><tr><th>时间</th><th>用户</th><th>事件</th><th>房间</th><th>设备</th></tr></thead><tbody>' +
                  rows.map(l => `<tr><td data-label="时间">${adminFmtTime(l.created_at)}</td><td data-label="用户"><b>${adminEsc(l.username)}</b></td><td data-label="事件">${typeChip(l.login_type)}</td><td data-label="房间">${l.room_code ? '<code class="admin-room-code">' + adminEsc(l.room_code) + '</code>' : '<span class="admin-muted">—</span>'}</td><td data-label="设备" title="${adminEsc(l.user_agent)}">${adminEsc(shortUA(l.user_agent))}</td></tr>`).join('') +
                  '</tbody></table>'
                : '<div class="admin-empty">暂无登录日志</div>';
        } catch (e) {
            body.innerHTML = '<div class="admin-error">加载失败：' + adminEsc(e.message || e) + '</div><div class="admin-empty">如果提示关系不存在，请先在 Supabase 执行 migrations 里的 20260827_add_login_logs.sql</div>';
        }
    }

    // ============================================
    // 账号系统
    // ============================================
    function getLoggedInUser() { return localStorage.getItem('chat_logged_user') || ''; }

    async function callServerAction(endpoint, action, payload) {
        const url = endpoint || (SUPABASE_URL + '/functions/v1/verify-auth');
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ action, ...payload })
        });
        let json = {};
        try { json = await res.json(); } catch (e) { json = {}; }
        if (!res.ok || json.ok === false) {
            const message = json && json.error ? json.error : '服务器校验失败';
            throw new Error(message);
        }
        return json;
    }

    window.togglePwd = function(inputId, el) {
        const input = document.getElementById(inputId);
        if (!input) return;
        if (input.type === 'password') { input.type = 'text'; el.textContent = '🙈'; }
        else { input.type = 'password'; el.textContent = '👁'; }
    };

    /** 登录日志：手动/自动登录、暗房进入/退出都记录（roomCode 仅暗房事件使用） */
    async function insertLoginLog(type, roomCode) {
        try {
            await supabaseClient.from('login_logs').insert([{
                username: getLoggedInUser(),
                login_type: type,
                user_agent: navigator.userAgent || '',
                room_code: roomCode || null
            }]);
        } catch (e) { console.warn('login_logs insert failed:', e); }
    }

    window.showAuthOverlay = function() {
        const overlay = document.getElementById('auth-overlay');
        if (!overlay) return;
        overlay.classList.add('show');
        window.showLogin();
    };

    window.showLogin = function() {
        document.getElementById('auth-login-card').style.display = '';
        document.getElementById('auth-register-card').style.display = 'none';
        const e1 = document.getElementById('auth-error');
        const e2 = document.getElementById('reg-error');
        if (e1) e1.textContent = '';
        if (e2) e2.textContent = '';
        setTimeout(() => { const i = document.getElementById('auth-username'); if (i && !i.value) i.focus(); }, 100);
    };

    window.showRegister = function() {
        document.getElementById('auth-login-card').style.display = 'none';
        document.getElementById('auth-register-card').style.display = '';
        const e1 = document.getElementById('auth-error');
        const e2 = document.getElementById('reg-error');
        if (e1) e1.textContent = '';
        if (e2) e2.textContent = '';
        setTimeout(() => document.getElementById('reg-username').focus(), 100);
    };

    window.doLogin = async function() {
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value.trim();
        const errEl = document.getElementById('auth-error');
        const btn = document.getElementById('auth-login-btn');
        errEl.textContent = '';

        if (!username || !password) { errEl.textContent = '请输入用户名和密码'; return; }

        btn.disabled = true;
        btn.textContent = '登录中…';
        try {
            const result = await callServerAction(SUPABASE_URL + '/functions/v1/verify-auth', 'login', { username, password });
            localStorage.setItem('chat_logged_user', username);
            localStorage.setItem('chat_auth_token', username);
            mySender = username;
            insertLoginLog('manual');
            document.getElementById('auth-overlay').classList.remove('show');
            showToast('欢迎回来，' + username, 'success', 2000);
            await loadMyRooms();
            if (pendingUrlRoom) {
                const target = pendingUrlRoom;
                pendingUrlRoom = '';
                showRoomLoading();
                await window.joinRoom(target);
            } else if (isDesktopLayout() && myRoomsCache.length) {
                showRoomLoading();
                window.switchToRoom(myRoomsCache[0]);
            } else {
                showRoomListView();
            }
        } catch (e) {
            console.error('登录失败:', e);
            errEl.textContent = e && e.message ? e.message : '用户名或密码错误';
        } finally {
            btn.disabled = false;
            btn.textContent = '登 录';
        }
    };

    window.doRegister = async function() {
        const username = document.getElementById('reg-username').value.trim();
        const password = document.getElementById('reg-password').value.trim();
        const password2 = document.getElementById('reg-password2').value.trim();
        const errEl = document.getElementById('reg-error');
        const btn = document.getElementById('auth-register-btn');
        errEl.textContent = '';

        if (!username || !password) { errEl.textContent = '请输入用户名和密码'; return; }
        if (username.length < 2 || username.length > 20) { errEl.textContent = '用户名长度需要 2-20 个字符'; return; }
        if (!/^[a-zA-Z0-9_\u4e00-\u9fff]+$/.test(username)) { errEl.textContent = '用户名只能包含字母、数字、下划线和中文'; return; }
        if (password.length < 4) { errEl.textContent = '密码至少需要 4 个字符'; return; }
        if (password !== password2) { errEl.textContent = '两次输入的密码不一致'; return; }

        btn.disabled = true;
        btn.textContent = '注册中…';
        try {
            await callServerAction(SUPABASE_URL + '/functions/v1/verify-auth', 'register', { username, password });
            showToast('注册成功！请登录', 'success', 2000);
            document.getElementById('auth-username').value = username;
            document.getElementById('auth-password').value = '';
            window.showLogin();
        } catch (e) {
            console.error('注册失败:', e);
            errEl.textContent = e && e.message ? e.message : '注册失败，请检查网络';
        } finally {
            btn.disabled = false;
            btn.textContent = '注 册';
        }
    };

    window.doLogout = function() {
        localStorage.removeItem('chat_logged_user');
        localStorage.removeItem('chat_auth_token');
        localStorage.removeItem('chat_last_room');
        localStorage.removeItem('chat_auth_expiry');
        location.reload();
    };

    let myRoomsCache = [];
    async function loadMyRooms() {
        const user = getLoggedInUser();
        if (!user || !supabaseClient) { myRoomsCache = []; return; }
        try {
            const { data, error } = await supabaseClient
                .from('room_members')
                .select('room_code')
                .eq('user_name', user)
                .order('created_at', { ascending: false });
            if (error) throw error;
            myRoomsCache = [...new Set((data || []).map(r => r.room_code))];
        } catch (e) {
            console.warn('加载我的房间失败:', e);
        }
    }

    window.updateRoomName = async function() {
        document.getElementById('room-name-modal-input').value = '';
        document.getElementById('room-name-modal').style.display = 'flex';
        setTimeout(() => document.getElementById('room-name-modal-input').focus(), 100);
    };

    window.closeRoomNameModal = function() {
        document.getElementById('room-name-modal').style.display = 'none';
    };

    window.confirmRoomName = async function() {
        var newName = document.getElementById('room-name-modal-input').value.trim();
        if (!newName) return showToast('房间名称不能为空', 'error');
        document.getElementById('room-name-modal').style.display = 'none';
        try {
            var { error } = await supabaseClient
                .from('rooms')
                .update({ room_name: newName })
                .eq('room_code', currentRoomCode);
            if (error) throw error;
            setRoomTitle(newName);
            if (roomSubscription) {
                roomSubscription.send({ type: 'broadcast', event: 'room_name_update', payload: { room: currentRoomCode, roomName: newName } });
            }
            window.toggleSettings();
            showToast('房间名称已更新！', 'success');
        } catch (e) {
            console.error('修改房间名称失败:', e);
            showToast('修改房间名称失败，请重试', 'error');
        }
    };

    // ===== 主题切换 =====
    function syncThemeCards() {
        const theme = document.documentElement.dataset.theme || 'a';
        const cardA = document.getElementById('theme-card-a');
        const cardB = document.getElementById('theme-card-b');
        if (cardA) cardA.classList.toggle('active', theme === 'a');
        if (cardB) cardB.classList.toggle('active', theme === 'b');
    }

    window.applyThemeStyle = function(style) {
        const theme = style === 'b' ? 'b' : 'a';
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('chat_theme_style', theme);
        // 切换主题时清除自定义气泡颜色，让主题渐变生效
        if (localStorage.getItem('chat_theme_color')) resetBubbleColor(true);
        syncThemeCards();
        showToast(theme === 'b' ? '已切换到「奶油纸感」主题' : '已切换到「石墨极简」主题', 'success');
    };

    function resetBubbleColor(silent) {
        document.documentElement.style.removeProperty('--bubble-color');
        document.documentElement.style.removeProperty('--bubble-bg');
        localStorage.removeItem('chat_theme_color');
        const sel = document.getElementById('color-selector');
        if (sel) sel.value = (document.documentElement.dataset.theme === 'b') ? '#c2783c' : '#18181b';
        if (!silent) showToast('已恢复默认气泡颜色', 'success');
    }
    window.resetBubbleColor = resetBubbleColor;

    window.saveSettings = function() {
        const color = document.getElementById('color-selector').value;
        document.documentElement.style.setProperty('--bubble-color', color);
        document.documentElement.style.setProperty('--bubble-bg', color);
        localStorage.setItem('chat_theme_color', color);
    };

    // 清除本地聊天记录（只影响本地显示与缓存）
    window.clearLocalHistory = function() {
        if (!confirm('确定要清除本地聊天记录吗？此操作不会删除服务器上的消息。')) return;
        var chatBox = document.getElementById('chat-box');
        chatBox.innerHTML = '';
        messagesCache = [];
        oldestLoadedAt = null;
        noMoreHistory = false;
        showToast('本地聊天记录和缓存已清除。', 'success');
    };

    window.handleAvatarUpload = function(event) {
        const file = event.target.files[0];
        if (!file || !file.type.startsWith('image/')) {
            showToast('请选择图片文件作为头像。', 'error');
            event.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => showToast('头像图片读取失败。', 'error');
        reader.onload = async () => {
            const avatarUrl = reader.result;
            localStorage.setItem(avatarStorageKey(mySender), avatarUrl);
            renderOwnAvatar();
            document.querySelectorAll('.msg-wrapper').forEach((wrapper) => {
                if (wrapper.dataset.sender !== mySender) return;
                const avatar = wrapper.querySelector('.message-avatar');
                if (avatar) {
                    avatar.outerHTML = avatarHtml(mySender);
                }
            });
            refreshMessageAvatars();
            if (roomSubscription) {
                roomSubscription.send({ type: 'broadcast', event: 'avatar_update', payload: { user: mySender, room: currentRoomCode, avatarUrl } });
            }
            try {
                await supabaseClient.from('user_profiles').upsert({
                    user_name: mySender,
                    avatar_url: avatarUrl,
                    updated_at: beijingISOString()
                }, { onConflict: 'user_name' });
            } catch (e) { console.warn('头像同步到数据库失败:', e); }
            showToast('头像已更新！', 'success');
        };
        reader.readAsDataURL(file);
        event.target.value = '';
    };

    window.leaveRoom = function() {
        // 如果在暗房里，退出暗房回到正常房间，不退出整个房间
        if (continuationToken) {
            endContinuation();
            showRoomLoading();
            window.joinRoom(currentRoomCode);
            return;
        }
        isLeavingRoom = true;
        if (roomSubscription) { roomSubscription.unsubscribe(); roomSubscription = null; }
        stopPolling(true);
        presenceActive = false;
        if (presenceIdleTimer) { clearTimeout(presenceIdleTimer); presenceIdleTimer = null; }
        localStorage.removeItem('chat_last_room');
        localStorage.removeItem('chat_auth_expiry');
        currentRoomCode = "";
        mySender = "";
        messagesCache = [];
        oldestLoadedAt = null;
        noMoreHistory = false;
        lastKnownMessageId = null;
        document.getElementById('chat-box').innerHTML = '';
        setRoomTitle('正在加载...');
        document.getElementById('online-count').innerText = '在线 0 人';
        backToLoginArea();
        loadMyRooms();
    };

    function isIOS() {
        return /iPhone|iPad|iPod/.test(navigator.userAgent || '') ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function isAndroid() {
        return /Android/.test(navigator.userAgent || '');
    }

    function isMobileDevice() {
        return isIOS() || isAndroid();
    }

    // 输入事件：发送 typing 通知 并发送消息
    let typingTimeout = null;
    const msgInput = document.getElementById('message-input');

    // ===== @提及补全 =====
    const mentionPopup = document.getElementById('mention-popup');
    let mentionState = { active: false, items: [], index: 0, start: -1 };

    function getMentionCandidates() {
        const names = new Set();
        // 在线用户（presence）
        try {
            if (roomSubscription) {
                const state = roomSubscription.presenceState();
                Object.keys(state || {}).forEach(key => {
                    const payload = (state[key] || [])[0];
                    const name = (payload && payload.user) || key.slice(key.indexOf(':') + 1);
                    if (name) names.add(name);
                });
            }
        } catch (e) { /* ignore */ }
        // 近期消息发送者
        (messagesCache || []).forEach(m => { if (m && m.sender) names.add(m.sender); });
        names.delete(mySender);
        return [...names];
    }

    function hideMentionPopup() {
        mentionState.active = false;
        mentionState.items = [];
        mentionState.index = 0;
        mentionState.start = -1;
        if (mentionPopup) mentionPopup.classList.remove('visible');
    }

    function renderMentionPopup() {
        if (!mentionPopup) return;
        mentionPopup.innerHTML = `
            <div class="mention-tip">↑↓ 选择 · Enter/Tab 确认 · Esc 关闭</div>
            ${mentionState.items.map((name, i) => `
                <div class="mention-item${i === mentionState.index ? ' active' : ''}" data-name="${escapeHtml(name)}">
                    <span class="mention-ava" style="background:${hashGradient(name)}">${escapeHtml(String(name).slice(0, 1).toUpperCase())}</span>
                    <span>${escapeHtml(name)}</span>
                </div>`).join('')}`;
        mentionPopup.classList.add('visible');
    }

    function updateMentionPopup() {
        if (!msgInput || !mentionPopup) return;
        const pos = msgInput.selectionStart;
        const before = msgInput.value.slice(0, pos);
        const match = before.match(/@([^\s@]{0,20})$/);
        if (!match) { hideMentionPopup(); return; }
        const query = match[1].toLowerCase();
        const candidates = getMentionCandidates()
            .filter(n => n.toLowerCase().includes(query))
            .sort((a, b) => a.length - b.length)
            .slice(0, 6);
        if (!candidates.length) { hideMentionPopup(); return; }
        mentionState.active = true;
        mentionState.items = candidates;
        mentionState.index = 0;
        mentionState.start = pos - match[0].length;
        renderMentionPopup();
    }

    function applyMention() {
        const name = mentionState.items[mentionState.index];
        if (!name || !msgInput) { hideMentionPopup(); return; }
        const pos = msgInput.selectionStart;
        const value = msgInput.value;
        // 匹配段从 mentionState.start 到光标，替换为完整 @name
        msgInput.value = value.slice(0, mentionState.start) + '@' + name + ' ' + value.slice(pos);
        const newPos = mentionState.start + name.length + 2;
        msgInput.focus();
        msgInput.setSelectionRange(newPos, newPos);
        hideMentionPopup();
        msgInput.style.height = 'auto';
        msgInput.style.height = `${Math.min(msgInput.scrollHeight, 150)}px`;
    }

    if (mentionPopup) {
        mentionPopup.addEventListener('pointerdown', (e) => {
            const item = e.target.closest('.mention-item');
            if (!item) return;
            e.preventDefault();
            const idx = mentionState.items.indexOf(item.dataset.name);
            if (idx > -1) mentionState.index = idx;
            applyMention();
        });
    }

    msgInput.addEventListener('input', (e) => {
        sendTypingNotification();
        updateMentionPopup();
        msgInput.style.height = 'auto';
        msgInput.style.height = `${Math.min(msgInput.scrollHeight, 150)}px`;
    });

    msgInput.addEventListener('keydown', (e) => {
        // @提及补全激活时：方向键选择 / Enter·Tab 确认 / Esc 关闭
        if (mentionState.active && mentionState.items.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.index = (mentionState.index + 1) % mentionState.items.length; renderMentionPopup(); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.index = (mentionState.index - 1 + mentionState.items.length) % mentionState.items.length; renderMentionPopup(); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(); return; }
            if (e.key === 'Escape') { e.preventDefault(); hideMentionPopup(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            const emojiPanel = document.getElementById('emoji-panel');
            if (emojiPanel) emojiPanel.classList.remove('visible');
            hideMentionPopup();
            Promise.resolve(window.sendMessage()).then(() => {
                [0, 80, 180, 350].forEach((delay) => {
                    setTimeout(() => {
                        const chatBox = document.getElementById('chat-box');
                        if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
                    }, delay);
                });
            });
            }
        });

    // 发送 typing 通知（短时广播）
    function sendTypingNotification() {
        // 在线人数已取代顶部的正在输入提示，保留函数避免旧事件处理器报错。
        return;
    }

    // 订阅 broadcast typing（尝试）
    try {
        if (roomSubscription) {
            roomSubscription.on('broadcast', { event: 'typing' }, (payload) => {
                if (payload?.payload?.room !== currentRoomCode) return;
                const user = payload.payload.user;
                if (user === mySender) return;
                const el = document.getElementById('online-count');
                if (!el) return;
            });
        }
    } catch (e) { /* best-effort */ }

    // 键盘快捷键：Escape 关闭弹窗/菜单
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const ctxMenu = document.getElementById('context-menu');
        if (ctxMenu && ctxMenu.style.display === 'block') {
            ctxMenu.style.display = 'none';
            return;
        }
        const emoji = document.getElementById('emoji-panel');
        if (emoji && emoji.classList.contains('visible')) {
            emoji.classList.remove('visible');
            return;
        }
        const settings = document.getElementById('settings-modal');
        if (settings && settings.style.display === 'flex') {
            settings.style.display = 'none';
            return;
        }
        const lightbox = document.getElementById('image-lightbox');
        if (lightbox && lightbox.style.display === 'flex') {
            lightbox.style.display = 'none';
            return;
        }
    });

