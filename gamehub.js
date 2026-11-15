/* ============================================================
 * 游戏中心（gamehub.js）
 * ------------------------------------------------------------
 * 导航栏独立入口：不依赖聊天房间，随时开玩。
 *   · 球球大作战：人机三难度 / 输入房间号联机
 *   · 五子棋、井字棋：需要先在聊天房间内邀请对手（沿用原逻辑）
 * 所有样式都注入在 #game-hub 作用域内，不改 style.css。
 * ============================================================ */

(function () {
    'use strict';

    const HUB_ID = 'game-hub';
    const STYLE_ID = 'game-hub-style';

    const DIFFS = [
        { key: 'easy', label: '简单', desc: '反应慢 · 不追人' },
        { key: 'normal', label: '普通', desc: '会追会躲' },
        { key: 'hard', label: '困难', desc: '预判走位 · 主动分裂' }
    ];

    const ROOM_GAMES = [
        { name: '五子棋', icon: '⚫', desc: '15×15 棋盘，先连五子者胜' },
        { name: '井字棋', icon: '⭕', desc: '3×3 快速三连，几秒一局' }
    ];

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        // 游戏中心固定使用深色“游戏面板”配色，不跟站内明暗主题走，
        // 否则浅色主题下卡片半透明、文字对比度会明显不足。
        const css = `
#game-hub{position:fixed;inset:0;z-index:9400;display:none;
    background:rgba(7,9,13,.84);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
    overflow-y:auto;padding:0;color:#eef1f6;animation:ghFade .18s ease-out;}
#game-hub.show{display:block;}
#game-hub .gh-sheet{max-width:760px;margin:0 auto;padding:calc(env(safe-area-inset-top,0px) + 18px) 16px calc(env(safe-area-inset-bottom,0px) + 26px);}
#game-hub .gh-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
#game-hub .gh-title{font-size:20px;font-weight:700;color:#fff;letter-spacing:.02em;}
#game-hub .gh-sub{font-size:12px;color:#9aa4b4;margin-top:4px;}
#game-hub .gh-close{border:none;background:rgba(255,255,255,.1);color:#eef1f6;width:36px;height:36px;
    border-radius:50%;font-size:17px;line-height:1;cursor:pointer;flex:0 0 auto;}
#game-hub .gh-close:hover{background:rgba(255,255,255,.2);}
#game-hub .gh-card{background:#161a21;border:1px solid rgba(255,255,255,.09);
    border-radius:16px;padding:16px;margin-bottom:14px;box-shadow:0 14px 34px rgba(0,0,0,.42);}
#game-hub .gh-card-hero{
    background:
        radial-gradient(130% 130% at 0% 0%,rgba(255,138,61,.24),rgba(255,138,61,0) 58%),
        radial-gradient(130% 130% at 100% 0%,rgba(124,92,255,.22),rgba(124,92,255,0) 58%),
        #161a21;}
#game-hub .gh-card-head{display:flex;align-items:center;gap:10px;margin-bottom:4px;}
#game-hub .gh-card-icon{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;
    font-size:20px;background:rgba(255,255,255,.09);flex:0 0 auto;}
#game-hub .gh-card-name{font-size:15.5px;font-weight:650;color:#fff;}
#game-hub .gh-card-desc{font-size:12px;color:#9aa4b4;margin-top:2px;}
#game-hub .gh-label{font-size:11.5px;color:#7f8998;margin:14px 0 8px;letter-spacing:.06em;}
#game-hub .gh-diffs{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
#game-hub .gh-diff{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);
    border-radius:12px;padding:10px 8px;cursor:pointer;text-align:center;color:#fff;
    transition:transform .12s ease,background .12s ease,border-color .12s ease;}
#game-hub .gh-diff:hover{background:rgba(255,138,61,.16);border-color:rgba(255,138,61,.55);transform:translateY(-1px);}
#game-hub .gh-diff b{display:block;font-size:13.5px;font-weight:650;color:#fff;}
#game-hub .gh-diff span{display:block;font-size:10.5px;color:#98a2b3;margin-top:3px;}
#game-hub .gh-room-row{display:flex;gap:8px;}
#game-hub .gh-input{flex:1 1 auto;min-width:0;padding:11px 12px;border-radius:11px;font-size:14px;
    border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.28);color:#fff;outline:none;}
#game-hub .gh-input::placeholder{color:#6f7887;}
#game-hub .gh-input:focus{border-color:rgba(255,138,61,.65);background:rgba(0,0,0,.4);}
#game-hub .gh-btn{border:none;border-radius:11px;padding:0 16px;height:42px;font-size:13.5px;font-weight:650;cursor:pointer;
    background:linear-gradient(135deg,#ff8a3d,#e86a2b);color:#fff;white-space:nowrap;margin:0;
    box-shadow:0 6px 16px rgba(232,106,43,.3);}
#game-hub .gh-btn:hover{filter:brightness(1.08);}
#game-hub .gh-btn-ghost{background:rgba(255,255,255,.1);color:#fff;box-shadow:none;border:1px solid rgba(255,255,255,.12);}
#game-hub .gh-btn-ghost:hover{background:rgba(255,255,255,.16);}
#game-hub .gh-hint{font-size:11.5px;color:#8b95a5;margin-top:8px;line-height:1.5;}
#game-hub .gh-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;}
#game-hub .gh-mini{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
    border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;}
#game-hub .gh-mini .gh-btn{width:100%;height:40px;font-size:13px;margin:0;}
#game-hub .gh-tip{margin-top:12px;font-size:11.5px;color:#8b95a5;text-align:center;line-height:1.6;}
@keyframes ghFade{from{opacity:0}to{opacity:1}}
@media (max-width:520px){
    #game-hub .gh-sheet{padding-left:12px;padding-right:12px;}
    #game-hub .gh-grid{grid-template-columns:1fr;}
    #game-hub .gh-diffs{gap:6px;}
}
`;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        document.head.appendChild(style);
    }

    function currentRoom() {
        try {
            if (typeof currentRoomCode === 'string' && currentRoomCode) return currentRoomCode;
        } catch (e) { /* ignore */ }
        return '';
    }

    function myName() {
        try {
            if (typeof mySender === 'string' && mySender) return mySender;
        } catch (e) { /* ignore */ }
        return '';
    }

    function buildSkeleton() {
        const hub = document.createElement('div');
        hub.id = HUB_ID;
        hub.onclick = function (e) {
            if (e.target === hub) window.closeGameHub();
        };

        const diffButtons = DIFFS.map(function (d) {
            return '<button class="gh-diff" data-diff="' + d.key + '"><b>' + d.label + '</b><span>' + d.desc + '</span></button>';
        }).join('');

        const roomCards = ROOM_GAMES.map(function (g, i) {
            return (
                '<div class="gh-mini">' +
                    '<div class="gh-card-head">' +
                        '<div class="gh-card-icon">' + g.icon + '</div>' +
                        '<div><div class="gh-card-name">' + g.name + '</div>' +
                        '<div class="gh-card-desc">' + g.desc + '</div></div>' +
                    '</div>' +
                    '<button class="gh-btn gh-btn-ghost" data-room-game="' + i + '">邀请对手开局</button>' +
                '</div>'
            );
        }).join('');

        hub.innerHTML =
            '<div class="gh-sheet">' +
                '<div class="gh-head">' +
                    '<div><div class="gh-title">游戏中心</div>' +
                    '<div class="gh-sub">不用进房间也能玩，随时开局</div></div>' +
                    '<button class="gh-close" aria-label="关闭">✕</button>' +
                '</div>' +

                '<div class="gh-card gh-card-hero">' +
                    '<div class="gh-card-head">' +
                        '<div class="gh-card-icon">🟠</div>' +
                        '<div><div class="gh-card-name">球球大作战</div>' +
                        '<div class="gh-card-desc">吃食物变大，大球吃小球，空格分裂</div></div>' +
                    '</div>' +
                    '<div class="gh-label">人机对战</div>' +
                    '<div class="gh-diffs">' + diffButtons + '</div>' +
                    '<div class="gh-label">和朋友联机</div>' +
                    '<div class="gh-room-row">' +
                        '<input id="gh-room-input" class="gh-input" type="text" maxlength="16" placeholder="房间号，例如 666" autocomplete="off">' +
                        '<button class="gh-btn" id="gh-room-join">进入</button>' +
                    '</div>' +
                    '<div class="gh-hint">把同一个房间号发给朋友，就能在同一个球场上互相吞球。</div>' +
                '</div>' +

                '<div class="gh-card">' +
                    '<div class="gh-card-head">' +
                        '<div class="gh-card-icon">🎲</div>' +
                        '<div><div class="gh-card-name">房间对战</div>' +
                        '<div class="gh-card-desc">在你的聊天房间里邀请好友下一局</div></div>' +
                    '</div>' +
                    '<div class="gh-grid" style="margin-top:12px;">' + roomCards + '</div>' +
                '</div>' +

                '<div class="gh-tip">手机上按住屏幕拖动移动，右下角按钮分裂 / 吐孢子</div>' +
            '</div>';

        document.body.appendChild(hub);

        hub.querySelector('.gh-close').onclick = function () { window.closeGameHub(); };

        hub.querySelectorAll('.gh-diff').forEach(function (btn) {
            btn.onclick = function () {
                window.closeGameHub();
                window.openAgarGame({ mode: 'bot', difficulty: btn.dataset.diff });
            };
        });

        hub.querySelector('#gh-room-join').onclick = function () { joinRoomGame(); };
        hub.querySelector('#gh-room-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') joinRoomGame();
        });

        hub.querySelectorAll('[data-room-game]').forEach(function (btn) {
            btn.onclick = function () { startRoomGame(ROOM_GAMES[Number(btn.dataset.roomGame)]); };
        });

        return hub;
    }

    function joinRoomGame() {
        const input = document.getElementById('gh-room-input');
        const room = (input && input.value || '').trim();
        if (!room) {
            if (input) {
                input.focus();
                input.placeholder = '请先填房间号';
            }
            return;
        }
        window.closeGameHub();
        window.openAgarGame({ mode: 'online', room: room, name: myName() || '玩家' });
    }

    function startRoomGame(game) {
        if (!currentRoom()) {
            const tip = document.querySelector('#game-hub .gh-tip');
            if (tip) {
                tip.textContent = '请先在左侧（手机上在「消息」页）选择一个聊天房间，再回来邀请对手';
                tip.style.color = '#ffb36b';
            }
            return;
        }
        window.closeGameHub();
        if (typeof window.startGame === 'function') {
            window.startGame(game.name, game.icon);
        }
    }

    window.openGameHub = function () {
        injectStyle();
        let hub = document.getElementById(HUB_ID);
        if (!hub) hub = buildSkeleton();
        const input = document.getElementById('gh-room-input');
        if (input && !input.value) input.value = currentRoom();
        hub.classList.add('show');
        document.body.style.overflow = 'hidden';
    };

    window.closeGameHub = function () {
        const hub = document.getElementById(HUB_ID);
        if (hub) hub.classList.remove('show');
        document.body.style.overflow = '';
    };
})();
