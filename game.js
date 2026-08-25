let activeGame = null;

function isMobile() {
    return /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || 
           ('ontouchstart' in window && window.innerWidth < 768) ||
           window.matchMedia('(pointer: coarse)').matches;
}

function isIOS() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent || '');
}

function isAndroid() {
    return /Android/.test(navigator.userAgent || '');
}

function showGameLoading(gameName, icon) {
    const existing = document.getElementById('game-board-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'game-board-modal';
    modal.className = 'game-fs';
    modal.innerHTML = `
        <div class="game-fs-header">
            <span class="game-fs-title">${icon} ${gameName}</span>
            <button class="game-fs-close" onclick="window.closeGameBoard()" aria-label="关闭">✕</button>
        </div>
        <div class="game-fs-board-area" style="display:flex;align-items:center;justify-content:center;">
            <div style="text-align:center;">
                <div class="game-loading-spinner"></div>
                <div class="game-loading-text">正在创建游戏...</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
}

window.startGame = async function(gameName, icon) {
    if (activeGame && activeGame.name === gameName && activeGame.status === 'waiting') {
        showToast(`你已发起了一个${gameName}邀请，请等待对方接受或取消后再试`, 'warning');
        return;
    }
    window.closeGamePanel();
    showGameLoading(gameName, icon);
    
    const gameId = 'game_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const inviteText = `[GAME_INVITE:${gameId}:${gameName}:${icon}]`;
    const now = beijingISOString();
    const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    
    appendMessageToUI(tempId, mySender, inviteText, true, now);

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
                content: inviteText, 
                sender: mySender,
                created_at: now
            }])
            .select('id')
            .single();

        if (error) {
            console.error("发送游戏邀请失败:", error);
            updateMessageStatus(tempId, 'failed', '发送失败，点击重试');
            showToast("游戏邀请发送失败，请检查网络后重试。", 'error');
            window.closeGameBoard();
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
            }
            activeGame = { id: gameId, name: gameName, icon: icon, host: mySender, status: 'waiting' };
            openWaitingBoard(gameId, gameName, icon);
        }
    } catch (e) {
        console.error("发送游戏邀请异常:", e);
        updateMessageStatus(tempId, 'failed', '发送失败，点击重试');
        window.closeGameBoard();
    }

    showToast(`已发送${gameName}邀请`, 'success');
};

window.acceptGame = async function(gameId, gameName, icon, host) {
    if (activeGame && activeGame.status === 'playing') {
        showToast('你正在游戏中，请完成当前游戏后再接受新邀请', 'warning');
        return;
    }
    showGameLoading(gameName, icon);
    
    const acceptText = `[GAME_ACCEPT:${gameId}:${mySender}]`;
    const now = beijingISOString();
    const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    
    appendMessageToUI(tempId, mySender, acceptText, true, now);
    const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
    if (tempEl) {
        tempEl.dataset.sending = 'true';
        const statusEl = document.createElement('span');
        statusEl.className = 'msg-send-status sending';
        statusEl.innerText = '发送中...';
        tempEl.appendChild(statusEl);
    }
    requestAnimationFrame(scrollToBottomInstant);

    try {
        const { data, error } = await supabaseClient
            .from('messages')
            .insert([{ room_code: currentRoomCode, content: acceptText, sender: mySender, created_at: now }])
            .select('id').single();

        if (error) {
            updateMessageStatus(tempId, 'failed', '发送失败');
            showToast("接受游戏失败", 'error');
            window.closeGameBoard();
            return;
        }
        if (data && data.id) {
            const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
            if (tempEl) {
                tempEl.dataset.msgId = String(data.id);
                tempEl.dataset.sending = 'false';
                const statusEl = tempEl.querySelector('.msg-send-status');
                if (statusEl) { statusEl.className = 'msg-send-status sent'; statusEl.innerText = '已发送'; }
            }
        }
        openGameBoard(gameId, gameName, icon, host, mySender);
    } catch (e) {
        updateMessageStatus(tempId, 'failed', '发送失败');
        window.closeGameBoard();
    }
};

const MIN_CELL = 16;
const MAX_CELL_GOMOKU = 32;
const MAX_CELL_TICTACTOE = 80;

function calcCellSize(size) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const headerH = 150;
    const availW = vw - 20;
    const availH = vh - headerH;
    const borderOverhead = 10;
    const cellByW = Math.floor((availW - borderOverhead) / size);
    const cellByH = Math.floor((availH - borderOverhead) / size);
    const raw = Math.min(cellByW, cellByH);
    if (size === 3) return Math.min(raw, MAX_CELL_TICTACTOE);
    return Math.min(Math.max(raw, MIN_CELL), MAX_CELL_GOMOKU);
}

function isBoardTooSmall(size) {
    const cellSize = calcCellSize(size);
    return cellSize < MIN_CELL;
}

function buildBoardHTML(size, gameName, cellSize) {
    let html = '';
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            const isStar = gameName === '五子棋' && (
                (r === 3 && c === 3) || (r === 3 && c === 7) || (r === 3 && c === 11) ||
                (r === 7 && c === 3) || (r === 7 && c === 7) || (r === 7 && c === 11) ||
                (r === 11 && c === 3) || (r === 11 && c === 7) || (r === 11 && c === 11)
            );
            html += `<div class="game-cell${isStar ? ' star-point' : ''}" data-row="${r}" data-col="${c}" style="width:${cellSize}px;height:${cellSize}px;">${isStar ? '<span class="star-dot"></span>' : ''}</div>`;
        }
    }
    return html;
}

window.openWaitingBoard = function(gameId, gameName, icon) {
    const existing = document.getElementById('game-board-modal');
    if (existing) existing.remove();

    const size = gameName === '井字棋' ? 3 : 15;
    const board = Array.from({ length: size }, () => Array(size).fill(null));
    activeGame.board = board;
    activeGame.size = size;
    activeGame.myPiece = 'black';
    activeGame.currentTurn = activeGame.host;

    const cellSize = calcCellSize(size);
    const tooSmall = isBoardTooSmall(size);
    const boardHTML = buildBoardHTML(size, gameName, cellSize);

    const modal = document.createElement('div');
    modal.id = 'game-board-modal';
    modal.className = 'game-fs';

    modal.innerHTML = `
        <div class="game-fs-header">
            <span class="game-fs-title">${icon} ${gameName}</span>
            <button class="game-fs-close" onclick="window.closeGameBoard()" aria-label="关闭">✕</button>
        </div>
        <div class="game-fs-players">
            <span class="player-tag-game black">⚫ ${escapeHtml(mySender)}（你）</span>
            <span class="vs-text-game">VS</span>
            <span class="player-tag-game waiting">⏳ 等待对手...</span>
        </div>
        <div id="game-turn-indicator" class="game-fs-turn waiting">⏳ 等待对手加入...</div>
        <div class="game-fs-board-area">
            ${tooSmall ? `
                <div class="game-fs-too-small">
                    <div class="game-fs-too-small-icon">⚠️</div>
                    <div class="game-fs-too-small-text">窗口太小，请放大浏览器窗口或旋转设备</div>
                </div>
            ` : `
                <div class="game-board" style="grid-template-columns:repeat(${size},${cellSize}px);grid-template-rows:repeat(${size},${cellSize}px);width:${size * cellSize}px;height:${size * cellSize}px;">
                    ${boardHTML}
                </div>
            `}
        </div>
        <div class="game-fs-bottom">
            <button class="game-fs-btn cancel" onclick="window.cancelGameInvite()">取消邀请</button>
        </div>
    `;
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
};

window.openGameBoard = function(gameId, gameName, icon, host, opponent) {
    const existing = document.getElementById('game-board-modal');
    if (existing) existing.remove();

    const size = gameName === '井字棋' ? 3 : 15;
    const existingBoard = activeGame && activeGame.id === gameId && activeGame.board ? activeGame.board : null;
    const board = existingBoard || Array.from({ length: size }, () => Array(size).fill(null));
    const myPiece = mySender === host ? 'black' : 'white';
    const existingTurn = activeGame && activeGame.id === gameId ? activeGame.currentTurn : host;
    const existingStatus = activeGame && activeGame.id === gameId ? activeGame.status : 'playing';
    const isMyTurn = existingTurn === mySender;

    activeGame = { id: gameId, name: gameName, icon, host, opponent, board, size, myPiece, currentTurn: existingTurn, status: existingStatus };

    const cellSize = calcCellSize(size);
    const tooSmall = isBoardTooSmall(size);
    const boardHTML = buildBoardHTML(size, gameName, cellSize);

    const turnText = isMyTurn ? '轮到你了' : '等待对方落子...';
    const pieceIcon = myPiece === 'black' ? '⚫' : '⚪';

    const modal = document.createElement('div');
    modal.id = 'game-board-modal';
    modal.className = 'game-fs';

    modal.innerHTML = `
        <div class="game-fs-header">
            <span class="game-fs-title">${icon} ${gameName}</span>
            <button class="game-fs-close" onclick="window.closeGameBoard()" aria-label="关闭">✕</button>
        </div>
        <div class="game-fs-players">
            <span class="player-tag-game black">⚫ ${escapeHtml(host)}</span>
            <span class="vs-text-game">VS</span>
            <span class="player-tag-game white">⚪ ${escapeHtml(opponent)}</span>
        </div>
        <div id="game-turn-indicator" class="game-fs-turn${isMyTurn ? ' my-turn' : ''}">${pieceIcon} ${turnText}</div>
        <div class="game-fs-board-area">
            ${tooSmall ? `
                <div class="game-fs-too-small">
                    <div class="game-fs-too-small-icon">⚠️</div>
                    <div class="game-fs-too-small-text">窗口太小，请放大浏览器窗口或旋转设备</div>
                </div>
            ` : `
                <div class="game-board" style="grid-template-columns:repeat(${size},${cellSize}px);grid-template-rows:repeat(${size},${cellSize}px);width:${size * cellSize}px;height:${size * cellSize}px;">
                    ${boardHTML}
                </div>
            `}
        </div>
        <div class="game-fs-bottom">
            <button id="game-giveup-btn" class="game-fs-btn" onclick="window.giveUpGame()">🏳 认输</button>
        </div>
    `;
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    if (existingBoard && !tooSmall) {
        setTimeout(() => renderGamePieces(), 50);
    }

    if (!tooSmall) {
        const cells = modal.querySelectorAll('.game-cell');
        cells.forEach(cell => {
            const r = parseInt(cell.dataset.row);
            const col = parseInt(cell.dataset.col);
            let fired = false;
            cell.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                if (fired) return;
                fired = true;
                window.gameCellClick(r, col);
                setTimeout(() => { fired = false; }, 300);
            });
        });
    }

    if (!isMyTurn && !tooSmall) {
        setTimeout(() => {
            const cells = modal.querySelectorAll('.game-cell');
            cells.forEach(c => c.style.pointerEvents = 'none');
        }, 100);
    }
};

window.closeGameBoard = function() {
    const modal = document.getElementById('game-board-modal');
    if (modal) modal.remove();
    document.body.style.overflow = '';
};

window.gameCellClick = async function(row, col) {
    if (!activeGame || activeGame.status !== 'playing') return;
    if (activeGame.currentTurn !== mySender) return;
    if (activeGame.board[row][col] !== null) return;

    activeGame.board[row][col] = activeGame.myPiece;
    renderGamePieces();
    if (activeGame.name === '井字棋') {
        checkTicTacToeWin();
    } else {
        checkWinAndHandle(row, col);
    }

    if (activeGame.status !== 'over') {
        const gameId = activeGame.id;
        const moveText = `[GAME_MOVE:${gameId}:${row}:${col}:${mySender}]`;
        const now = beijingISOString();

        try {
            await supabaseClient.from('messages').insert([{
                room_code: currentRoomCode, content: moveText, sender: mySender, created_at: now
            }]);
        } catch (e) {
            console.error("发送游戏落子失败:", e);
        }

        activeGame.currentTurn = activeGame.opponent;
        updateTurnIndicator();
        const cells = document.querySelectorAll('#game-board-modal .game-cell');
        cells.forEach(c => c.style.pointerEvents = 'none');
    }
};

function renderGamePieces() {
    if (!activeGame) return;
    const cells = document.querySelectorAll('#game-board-modal .game-cell');
    const cellSize = calcCellSize(activeGame.size);
    const pieceSize = activeGame.size === 3 ? Math.floor(cellSize * 0.78) : Math.floor(cellSize * 0.82);
    cells.forEach(cell => {
        const r = parseInt(cell.dataset.row);
        const c = parseInt(cell.dataset.col);
        const piece = activeGame.board[r][c];
        if (piece === 'black') {
            cell.innerHTML = `<div class="game-piece black" style="width:${pieceSize}px;height:${pieceSize}px;"></div>`;
        } else if (piece === 'white') {
            cell.innerHTML = `<div class="game-piece white" style="width:${pieceSize}px;height:${pieceSize}px;"></div>`;
        } else {
            const isStar = cell.classList.contains('star-point');
            cell.innerHTML = isStar ? '<span class="star-dot"></span>' : '';
        }
    });
}

function updateTurnIndicator() {
    if (!activeGame) return;
    const indicator = document.getElementById('game-turn-indicator');
    if (!indicator) return;
    if (activeGame.status === 'over') return;
    const isMyTurn = activeGame.currentTurn === mySender;
    const icon = activeGame.currentTurn === activeGame.host ? '⚫' : '⚪';
    indicator.innerHTML = `${icon} ${isMyTurn ? '轮到你了' : '等待对方落子...'}`;
    indicator.className = 'game-fs-turn' + (isMyTurn ? ' my-turn' : '');
    const cells = document.querySelectorAll('#game-board-modal .game-cell');
    cells.forEach(c => {
        c.style.pointerEvents = isMyTurn ? 'auto' : 'none';
        c.style.cursor = isMyTurn ? 'pointer' : 'default';
    });
}

function checkWinAndHandle(row, col) {
    if (!activeGame || activeGame.name !== '五子棋') return;
    const piece = activeGame.board[row][col];
    if (!piece) return;
    const size = activeGame.size;
    const directions = [[0,1],[1,0],[1,1],[1,-1]];
    for (const [dr, dc] of directions) {
        let count = 1;
        for (let i = 1; i < 5; i++) {
            const r = row + dr * i, c = col + dc * i;
            if (r >= 0 && r < size && c >= 0 && c < size && activeGame.board[r][c] === piece) count++; else break;
        }
        for (let i = 1; i < 5; i++) {
            const r = row - dr * i, c = col - dc * i;
            if (r >= 0 && r < size && c >= 0 && c < size && activeGame.board[r][c] === piece) count++; else break;
        }
        if (count >= 5) {
            activeGame.status = 'over';
            const winner = piece === activeGame.myPiece ? mySender : activeGame.opponent;
            const resultText = `[GAME_RESULT:${activeGame.id}:${winner}]`;
            supabaseClient.from('messages').insert([{
                room_code: currentRoomCode, content: resultText, sender: mySender, created_at: beijingISOString()
            }]);
            showGameOver(winner === mySender);
            return;
        }
    }
}

function checkTicTacToeWin() {
    if (!activeGame || activeGame.name !== '井字棋') return;
    const b = activeGame.board;
    const lines = [
        [[0,0],[0,1],[0,2]], [[1,0],[1,1],[1,2]], [[2,0],[2,1],[2,2]],
        [[0,0],[1,0],[2,0]], [[0,1],[1,1],[2,1]], [[0,2],[1,2],[2,2]],
        [[0,0],[1,1],[2,2]], [[0,2],[1,1],[2,0]]
    ];
    for (const line of lines) {
        const [a, b2, c] = line;
        if (b[a[0]][a[1]] && b[a[0]][a[1]] === b[b2[0]][b2[1]] && b[a[0]][a[1]] === b[c[0]][c[1]]) {
            activeGame.status = 'over';
            const winner = b[a[0]][a[1]] === activeGame.myPiece ? mySender : activeGame.opponent;
            const resultText = `[GAME_RESULT:${activeGame.id}:${winner}]`;
            supabaseClient.from('messages').insert([{
                room_code: currentRoomCode, content: resultText, sender: mySender, created_at: beijingISOString()
            }]);
            showGameOver(winner === mySender);
            return;
        }
    }
    const isDraw = b.every(row => row.every(cell => cell !== null));
    if (isDraw) {
        activeGame.status = 'over';
        const resultText = `[GAME_RESULT:${activeGame.id}:draw]`;
        supabaseClient.from('messages').insert([{
            room_code: currentRoomCode, content: resultText, sender: mySender, created_at: beijingISOString()
        }]);
        showGameOver(null);
    }
}

function showGameOver(iWon) {
    const indicator = document.getElementById('game-turn-indicator');
    if (indicator) {
        if (iWon === null) {
            indicator.innerHTML = '🤝 平局！';
            indicator.className = 'game-fs-turn draw';
        } else if (iWon) {
            indicator.innerHTML = '🎉 你赢了！';
            indicator.className = 'game-fs-turn win';
        } else {
            indicator.innerHTML = '😞 你输了';
            indicator.className = 'game-fs-turn lose';
        }
    }
    const cells = document.querySelectorAll('#game-board-modal .game-cell');
    cells.forEach(c => { c.style.pointerEvents = 'none'; c.style.cursor = 'default'; });
    const giveupBtn = document.getElementById('game-giveup-btn');
    if (giveupBtn) giveupBtn.style.display = 'none';
    setTimeout(() => { activeGame = null; }, 5000);
}

window.giveUpGame = async function() {
    if (!activeGame || activeGame.status !== 'playing') return;
    activeGame.status = 'over';
    const resultText = `[GAME_RESULT:${activeGame.id}:${activeGame.opponent}]`;
    await supabaseClient.from('messages').insert([{
        room_code: currentRoomCode, content: resultText, sender: mySender, created_at: beijingISOString()
    }]);
    showGameOver(false);
};

window.cancelGameInvite = async function() {
    if (!activeGame || activeGame.status !== 'waiting') return;
    const gameId = activeGame.id;
    const cancelText = `[GAME_CANCEL:${gameId}]`;
    const now = beijingISOString();

    try {
        await supabaseClient.from('messages').insert([{
            room_code: currentRoomCode, content: cancelText, sender: mySender, created_at: now
        }]);
    } catch (e) {
        console.error("取消邀请失败:", e);
        showToast("取消邀请失败", 'error');
        return;
    }

    const modal = document.getElementById('game-board-modal');
    if (modal) modal.remove();
    document.body.style.overflow = '';
    activeGame = null;
    showToast("已取消游戏邀请", 'success');

    const card = document.querySelector(`.game-invite-card[data-game-id="${gameId}"]`);
    if (card) {
        const status = card.querySelector('.game-invite-waiting');
        if (status) {
            status.textContent = '邀请已取消';
            status.style.color = '#ef4444';
        }
        const btn = card.querySelector('.game-accept-btn');
        if (btn) btn.remove();
        const cancelBtn = card.querySelector('.game-cancel-btn');
        if (cancelBtn) cancelBtn.remove();
    }
};

window.reopenGameBoard = function() {
    if (!activeGame) return;
    if (activeGame.status === 'waiting') {
        openWaitingBoard(activeGame.id, activeGame.name, activeGame.icon);
    } else if (activeGame.status === 'playing') {
        openGameBoard(activeGame.id, activeGame.name, activeGame.icon, activeGame.host, activeGame.opponent);
    }
};

function handleGameContent(content) {
    if (!content) return null;
    const inviteMatch = content.match(/^\[GAME_INVITE:([^:]+):([^:]+):([^\]]+)\]$/);
    if (inviteMatch) {
        const [, gameId, gameName, icon] = inviteMatch;
        return { type: 'invite', gameId, gameName, icon };
    }
    const acceptMatch = content.match(/^\[GAME_ACCEPT:([^:]+):([^\]]+)\]$/);
    if (acceptMatch) {
        const [, gameId, accepter] = acceptMatch;
        return { type: 'accept', gameId, accepter };
    }
    const moveMatch = content.match(/^\[GAME_MOVE:([^:]+):(\d+):(\d+):([^\]]+)\]$/);
    if (moveMatch) {
        const [, gameId, row, col, player] = moveMatch;
        return { type: 'move', gameId, row: parseInt(row), col: parseInt(col), player };
    }
    const resultMatch = content.match(/^\[GAME_RESULT:([^:]+):([^\]]+)\]$/);
    if (resultMatch) {
        const [, gameId, winner] = resultMatch;
        return { type: 'result', gameId, winner };
    }
    const cancelMatch = content.match(/^\[GAME_CANCEL:([^\]]+)\]$/);
    if (cancelMatch) {
        const [, gameId] = cancelMatch;
        return { type: 'cancel', gameId };
    }
    return null;
}

function renderGameInviteCard(wrapper, gameId, gameName, icon, sender) {
    const isHost = sender === mySender;
    const existingGame = activeGame && activeGame.id === gameId;
    const gameStatus = existingGame ? activeGame.status : 'waiting';
    const isAccepted = gameStatus === 'playing' || gameStatus === 'over';
    const isCancelled = gameStatus === 'cancelled';

    return `
        <div class="game-invite-card" data-game-id="${gameId}">
            <div class="game-invite-header">
                <div class="game-invite-icon">${icon}</div>
                <div class="game-invite-info">
                    <div class="game-invite-name">${gameName}</div>
                    <div class="game-invite-sender">${escapeHtml(sender)} 发起的挑战</div>
                </div>
            </div>
            ${isCancelled ? `
                <div class="game-invite-waiting" style="color:#ef4444;">邀请已取消</div>
            ` : isHost ? `
                <div class="game-invite-waiting">等待对方接受邀请...</div>
                <button class="game-accept-btn" onclick="event.stopPropagation();window.reopenGameBoard()" style="background:#ffd700;color:#333;">查看棋盘</button>
                <button class="game-cancel-btn" onclick="event.stopPropagation();window.cancelGameInvite()">取消邀请</button>
            ` : (isAccepted ? `
                <div class="game-invite-waiting">${gameStatus === 'playing' ? '游戏进行中' : '游戏已结束'}</div>
                ${gameStatus === 'playing' ? `<button class="game-accept-btn" onclick="event.stopPropagation();window.reopenGameBoard()" style="background:#ffd700;color:#333;">进入游戏</button>` : ''}
            ` : `
                <button class="game-accept-btn" onclick="event.stopPropagation();window.acceptGame('${gameId}','${gameName}','${icon}','${escapeHtml(sender)}')">接受挑战</button>
            `)}
        </div>
    `;
}

function renderGameResultCard(wrapper, gameId, winner, sender) {
    const isDraw = winner === 'draw';
    const iWon = winner === mySender;
    const cls = isDraw ? 'draw' : (iWon ? 'win' : 'lose');
    const text = isDraw ? '🤝 平局！' : (iWon ? '🎉 你赢了！' : '😞 你输了');
    const emoji = isDraw ? '🤝' : (iWon ? '🎉' : '😞');
    const gameName = activeGame && activeGame.id === gameId ? activeGame.name : '游戏';
    
    return `
        <div class="game-result-card ${cls}">
            <div class="game-result-emoji">${emoji}</div>
            <div class="game-result-text">${text}</div>
            <div class="game-result-game">${gameName} 对局结束</div>
        </div>
    `;
}

function handleGameMessageInUI(wrapper, sender, content) {
    const gameData = handleGameContent(content);
    if (!gameData) return false;

    const msgContent = wrapper.querySelector('.msg-content');
    if (!msgContent) return false;

    if (gameData.type === 'invite') {
        msgContent.innerHTML = renderGameInviteCard(wrapper, gameData.gameId, gameData.gameName, gameData.icon, sender);
        wrapper.classList.add('game-message');
        return true;
    }
    
    if (gameData.type === 'result') {
        msgContent.innerHTML = renderGameResultCard(wrapper, gameData.gameId, gameData.winner, sender);
        wrapper.classList.add('game-message');
        if (activeGame && activeGame.id === gameData.gameId) {
            const iWon = gameData.winner === mySender;
            showGameOver(gameData.winner === 'draw' ? null : iWon);
        }
        return true;
    }

    if (gameData.type === 'move') {
        wrapper.style.display = 'none';
        if (activeGame && activeGame.id === gameData.gameId && activeGame.status === 'playing') {
            if (gameData.player !== mySender) {
                activeGame.board[gameData.row][gameData.col] = (gameData.player === activeGame.host ? 'black' : 'white');
                renderGamePieces();
                activeGame.currentTurn = mySender;
                updateTurnIndicator();
                if (activeGame.name === '井字棋') checkTicTacToeWin();
                else checkWinAndHandle(gameData.row, gameData.col);
            }
        }
        return true;
    }

    if (gameData.type === 'accept') {
        wrapper.style.display = 'none';
        if (activeGame && activeGame.id === gameData.gameId && activeGame.status === 'waiting') {
            const existingModal = document.getElementById('game-board-modal');
            openGameBoard(gameData.gameId, activeGame.name, activeGame.icon, activeGame.host, gameData.accepter);
            const card = document.querySelector(`.game-invite-card[data-game-id="${gameData.gameId}"]`);
            if (card) {
                const btn = card.querySelector('.game-accept-btn');
                if (btn) btn.remove();
                const cancelBtn = card.querySelector('.game-cancel-btn');
                if (cancelBtn) cancelBtn.remove();
                const status = card.querySelector('.game-invite-waiting');
                if (status) status.textContent = '游戏进行中';
            }
        }
        return true;
    }

    if (gameData.type === 'cancel') {
        if (activeGame && activeGame.id === gameData.gameId && activeGame.status === 'waiting') {
            const modal = document.getElementById('game-board-modal');
            if (modal) modal.remove();
            document.body.style.overflow = '';
            activeGame = null;
            showToast("对方取消了邀请", 'info');
        }
        const card = document.querySelector(`.game-invite-card[data-game-id="${gameData.gameId}"]`);
        if (card) {
            const status = card.querySelector('.game-invite-waiting');
            if (status) {
                status.textContent = '邀请已取消';
                status.style.color = '#ef4444';
            }
            const btn = card.querySelector('.game-accept-btn');
            if (btn) btn.remove();
            const cancelBtn = card.querySelector('.game-cancel-btn');
            if (cancelBtn) cancelBtn.remove();
        }
        return true;
    }

    return false;
}

window.handleGameMessageInUI = handleGameMessageInUI;
