/* ============================================================
 * 球球大作战 · 独立版
 * ------------------------------------------------------------
 * 两种玩法：
 *   1) 人机对战：8 个本地 bot（简单 / 普通 / 困难），不联网
 *   2) 联机房间：同房间的玩家一起玩
 * 联机同步走 Cloudflare Worker 的 /sb 反代 -> Supabase PostgREST，
 * 每 1 秒轮询一次 agario_state 表，客户端各自权威。
 * 页面入口只依赖 window.AgarArena.open({...})。
 * ============================================================ */
(function () {
    'use strict';

    /* ---------------- 常量与工具 ---------------- */

    const WORLD = 4400;              // 世界边长
    const FOOD_COUNT = 2000;         // 食物总数（比原版密，成长/分裂节奏更快）
    const VIRUS_COUNT = 24;          // 刺球总数
    const MAX_CELLS = 16;            // 单人最多分身
    const START_MASS = 20;           // 出生质量（开局即可分裂一次）
    const DEFAULT_MASS = 10;         // 原版 defaultPlayerMass：减速曲线/最小分裂的基准
    const MIN_EJECT_MASS = 25;       // 可吐孢子的最小质量（门槛降低，W 更早可用）
    const EJECT_COST = 12;           // 吐孢子消耗
    const EJECT_MASS = 10;           // 孢子质量（吃回来略亏，避免刷质量）
    const MERGE_DELAY_MIN = 5000;    // 合体冷却基础值（原版固定 15s，等太久，改成随质量小幅增加）
    const MERGE_DELAY_PER_MASS = 20; // 每点质量增加 20ms 冷却
    const FOOD_RESPAWN = 8000;       // 食物重生
    const VIRUS_RESPAWN = 25000;     // 刺球重生
    const VIRUS_MASS = 110;          // 刺球质量（原版 100~150）
    const FOOD_MASS = 2;             // 每颗豆的质量（原版 1，这里加量让分裂节奏更快）
    const EJECT_TTL = 25000;         // 孢子存活时长
    const MAX_EJECTS = 180;
    const STALE_MS = 6000;           // 远端玩家过期

    /* 以下数值全部取自 owenashurst/agar.io-clone（MIT License）的原版物理：
     * https://github.com/owenashurst/agar.io-clone
     * 原版按 60fps 每帧位移计算，这里统一换算成「每秒」：
     *   6.25px/帧 → 375px/s；20px/帧 → 1200px/s；0.5px/帧² → 1800px/s²
     */
    const MIN_SPEED = 375;           // 基础速度
    // 分裂冲刺：原版固定初速 20px/帧，小球被甩出 190px 像瞬移、大球却几乎没拉开。
    // 这里按「分身间距 ≈ 4.5 个自身半径」反推初速，大小球的分裂观感一致。
    const SPLIT_SEP_PER_R = 4.5;
    const SPLIT_SEP_MIN = 90;
    const SPLIT_SEP_MAX = 380;
    const SPEED_DECEL = 1800;        // 冲刺减速
    const EJECT_SPEED = 560;         // 吐孢子初速（约飞 100px，原版 1500 会甩出 600 多px）
    const EJECT_DECEL = 1600;        // 孢子减速
    const MIN_DISTANCE = 50;         // 靠近目标点时的刹车距离
    const PUSH_AWAY_SPEED = 600;     // 不能合体时的分离速度上限（按重叠深度推开，分身会明显分开）
    const MERGE_PULL_SPEED = 420;    // 冷却结束后分身互相靠拢的速度（不然同速同向会永远保持距离）
    const SLOW_BASE = 4.5;           // 原版 slowBase

    const COLORS = [
        '#ff6b6b', '#f76707', '#fcc419', '#94d82d', '#40c057', '#20c997',
        '#22b8cf', '#4dabf7', '#5c7cfa', '#9775fa', '#da77f2', '#f06595'
    ];

    /* 人机模式：难度只影响「反应速度 / 瞄准误差 / 行为策略」，
     * 物理与玩家完全一致，避免 bot 靠数值作弊。 */
    const BOT_COUNT = 8;
    const BOT_NAMES = ['小橘', '蓝莓', '阿绿', '咕噜', '泡泡', '喵喵', '球王', '大力'];
    const BOT_RESPAWN = 3000;        // bot 死亡后重生延迟

    const DIFFICULTY = {
        easy: {
            label: '简单',
            react: 700,              // 思考间隔（ms）
            aimErr: 35,              // 瞄准误差（±度）
            chaseRatio: 0,           // 不追人（0 表示不追）
            fleeRatio: 0,            // 不逃跑
            splitChance: 0,          // 不分裂
            predict: 0,              // 不预判
            avoidVirus: false
        },
        normal: {
            label: '普通',
            react: 350,
            aimErr: 15,
            chaseRatio: 1.3,         // 质量 > 对方 1.3 倍才追
            chaseRange: 620,         // 追击半径
            fleeRatio: 1.2,          // 对方质量 > 自己 1.2 倍就躲
            splitChance: 0.25,
            predict: 0,
            avoidVirus: true
        },
        hard: {
            label: '困难',
            react: 150,
            aimErr: 5,
            chaseRatio: 1.2,
            chaseRange: 820,
            fleeRatio: 1.1,
            splitChance: 0.8,
            predict: 300,            // 预判目标 300ms 后的位置
            avoidVirus: true
        }
    };

    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

    function hashStr(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    // 确定性随机：保证所有客户端生成同一套食物/刺球
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // 原版 util.massToRadius
    const radiusOf = (m) => 4 + Math.sqrt(m) * 6;
    // 原版 Player.move：质量越大越慢，按 log(质量, 4.5) 衰减
    function slowDownOf(m) {
        const v = Math.log(m) / Math.log(SLOW_BASE) - Math.log(DEFAULT_MASS) / Math.log(SLOW_BASE) + 1;
        return v < 1 ? 1 : v;
    }
    // 合体冷却：质量越大等得稍久（5~13 秒），但不会像原版固定 15 秒那样干等
    function mergeDelayFor(m) {
        return MERGE_DELAY_MIN + Math.min(8000, m * MERGE_DELAY_PER_MASS);
    }
    /* 分裂冲刺初速：本体和分身都朝同一个目标点飞，只有分身带冲刺速度，
     * 所以两者的相对位移 = (v - MIN_SPEED)² / (2 × SPEED_DECEL)，
     * 用这个式子按目标间距反推 v。 */
    function splitSpeedFor(m) {
        const sep = clamp(radiusOf(m) * SPLIT_SEP_PER_R, SPLIT_SEP_MIN, SPLIT_SEP_MAX);
        return clamp(MIN_SPEED + Math.sqrt(2 * SPEED_DECEL * sep), 900, 1500);
    }
    const colorFor = (pid) => COLORS[hashStr(pid) % COLORS.length];

    // 球体渐变的明暗色（amt > 0 提亮，< 0 压暗）
    const shadeCache = new Map();
    function shade(hex, amt) {
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
        const key = hex + amt;
        const hit = shadeCache.get(key);
        if (hit) return hit;
        const n = parseInt(hex.slice(1), 16);
        const t = amt < 0 ? 0 : 255;
        const p = Math.abs(amt);
        const r = Math.round((t - ((n >> 16) & 255)) * p + ((n >> 16) & 255));
        const g = Math.round((t - ((n >> 8) & 255)) * p + ((n >> 8) & 255));
        const b = Math.round((t - (n & 255)) * p + (n & 255));
        const v = 'rgb(' + r + ',' + g + ',' + b + ')';
        shadeCache.set(key, v);
        return v;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmtMass(m) {
        const n = Math.round(m);
        return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    }

    /* ---------------- 运行时状态 ---------------- */

    const G = {
        open: false,
        phase: 'lobby',            // lobby | playing | dead
        mode: 'bot',               // bot | online
        room: 'lobby',             // 联机房间号（人机模式不用）
        difficulty: 'normal',      // easy | normal | hard
        pid: 'p' + Math.random().toString(36).slice(2, 10),
        name: '玩家',
        color: COLORS[0],

        connected: false,
        syncBusy: false,
        pollTimer: 0,
        pollTick: 0,
        lastHeartbeat: 0,
        lobbyPlayers: [],

        food: [],
        foodGrid: null,            // 食物空间网格（吃豆时只查附近分桶，避免每帧全量遍历）
        viruses: [],
        eatenFood: new Map(),      // id -> 重生时间(ms)
        virusRespawn: new Map(),   // id -> 重生时间(ms)
        ejects: [],

        recentFood: new Map(),     // 最近吃掉的（在包里重复携带 2 秒）
        recentVirus: new Map(),
        recentEats: [],
        recentEjectEaten: [],
        deadEjects: new Map(),

        me: { cells: [] },
        remotes: new Map(),        // pid -> { pid, name, color, cells:[], lastTs }
        bots: [],                  // 人机模式的本地 bot
        deadCells: new Map(),      // "pid:cellId" -> 过期时间（防重复吞噬）

        aim: { x: WORLD / 2, y: WORLD / 2 },
        mouse: { x: 0, y: 0, on: false },  // 光标屏幕坐标（每帧换算成目标点）
        touch: { dx: 0, dy: 0, on: false }, // 手机拖拽方向（同样每帧换算，按住就持续前进）
        cam: { x: WORLD / 2, y: WORLD / 2 },
        scale: 1,

        dpr: 1,
        vw: 800,
        vh: 600,
        raf: 0,
        lastFrame: 0,
        lastHud: 0,
        cellSeq: 0,
        ejectSeq: 0,

        canvas: null,
        ctx: null,
        mini: null,
        miniCtx: null,
        listeners: []
    };

    /* ---------------- 玩法 / 世界 ---------------- */

    function buildWorld(seedStr) {
        const rnd = mulberry32(hashStr(seedStr || 'room') || 1);
        G.food = [];
        for (let i = 0; i < FOOD_COUNT; i++) {
            G.food.push({
                id: i,
                x: 40 + rnd() * (WORLD - 80),
                y: 40 + rnd() * (WORLD - 80),
                r: 4.2 + rnd() * 2.4,
                c: COLORS[(rnd() * COLORS.length) | 0]
            });
        }
        G.viruses = [];
        for (let i = 0; i < VIRUS_COUNT; i++) {
            let vx = 0, vy = 0;
            // 拒绝采样：刺球之间保持间距，避免扎堆
            for (let attempt = 0; attempt < 24; attempt++) {
                vx = 200 + rnd() * (WORLD - 400);
                vy = 200 + rnd() * (WORLD - 400);
                let okDist = true;
                for (const other of G.viruses) {
                    if (Math.hypot(other.x - vx, other.y - vy) < 300) { okDist = false; break; }
                }
                if (okDist) break;
            }
            G.viruses.push({ id: i, x: vx, y: vy });
        }
        G.eatenFood.clear();
        G.virusRespawn.clear();
        G.deadCells.clear();
        G.ejects = [];
        buildFoodGrid();
    }

    /* 食物空间网格：2000 颗豆按 160px 分桶。
     * 玩家 + 8 个 bot 每帧都要判定吃豆，全量遍历是 3 万多次距离计算，
     * 手机上会明显掉帧；分桶后每个球只检查覆盖到的几个桶。 */
    const FOOD_GRID = 160;

    function buildFoodGrid() {
        const cols = Math.ceil(WORLD / FOOD_GRID);
        const buckets = new Array(cols * cols);
        for (const f of G.food) {
            const gx = clamp(Math.floor(f.x / FOOD_GRID), 0, cols - 1);
            const gy = clamp(Math.floor(f.y / FOOD_GRID), 0, cols - 1);
            const k = gy * cols + gx;
            if (!buckets[k]) buckets[k] = [];
            buckets[k].push(f);
        }
        G.foodGrid = { cols: cols, buckets: buckets };
    }

    // 遍历圆形（x, y, r）覆盖到的所有食物
    function eachFoodNear(x, y, r, cb) {
        const grid = G.foodGrid;
        if (!grid) return;
        const cols = grid.cols;
        const x0 = clamp(Math.floor((x - r) / FOOD_GRID), 0, cols - 1);
        const x1 = clamp(Math.floor((x + r) / FOOD_GRID), 0, cols - 1);
        const y0 = clamp(Math.floor((y - r) / FOOD_GRID), 0, cols - 1);
        const y1 = clamp(Math.floor((y + r) / FOOD_GRID), 0, cols - 1);
        for (let gy = y0; gy <= y1; gy++) {
            for (let gx = x0; gx <= x1; gx++) {
                const bucket = grid.buckets[gy * cols + gx];
                if (!bucket) continue;
                for (const f of bucket) cb(f);
            }
        }
    }

    function spawn(mass) {
        const m = mass || START_MASS;
        let bx = WORLD / 2, by = WORLD / 2, best = -1;
        // 挑一个离 bot / 刺球最远的位置，避免一出生就被吞
        for (let i = 0; i < 20; i++) {
            const x = 300 + Math.random() * (WORLD - 600);
            const y = 300 + Math.random() * (WORLD - 600);
            let gap = Infinity;
            for (const b of G.bots) {
                if (!b.alive) continue;
                for (const c of b.cells) gap = Math.min(gap, Math.hypot(c.x - x, c.y - y) - radiusOf(c.m));
            }
            for (const v of G.viruses) {
                if (G.virusRespawn.has(v.id)) continue;
                gap = Math.min(gap, Math.hypot(v.x - x, v.y - y) - radiusOf(VIRUS_MASS));
            }
            // 联机模式还要避开场上其他玩家，避免一出生就贴脸
            for (const r of G.remotes.values()) {
                for (const c of r.cells) {
                    gap = Math.min(gap, Math.hypot(c.x - x, c.y - y) - radiusOf(c.m));
                }
            }
            if (gap > best) { best = gap; bx = x; by = y; }
            if (gap > 700) break;
        }
        G.cellSeq += 1;
        G.me.cells = [{
            id: G.cellSeq,
            x: bx,
            y: by,
            m: m,
            speed: MIN_SPEED,
            mergeAt: 0
        }];
        G.aim.x = bx;
        G.aim.y = by;
        G.cam.x = bx;
        G.cam.y = by;
    }

    function aimDir(c, aim) {
        const target = aim || G.aim;
        let dx = target.x - c.x, dy = target.y - c.y;
        const d = Math.hypot(dx, dy);
        if (d < 0.001) return { x: 1, y: 0 };
        return { x: dx / d, y: dy / d };
    }

    /* 原版 Cell.move：
     *   - 每个球体朝鼠标目标点移动，位移速度 = speed / slowDown
     *   - speed 只在分裂冲刺后大于基础值，并以 1800px/s² 回落到基础速度（有惯性）
     *   - 距离目标点小于 MIN_DISTANCE + 半径时按比例刹车
     *   - 速度按 log(质量) 衰减：越大约慢
     * cells 既可以是玩家的分身，也可以是 bot 的球体，物理完全一致。
     */
    function moveCells(cells, aim, dt) {
        for (const c of cells) {
            const dx = aim.x - c.x, dy = aim.y - c.y;
            const d = Math.hypot(dx, dy);
            const speed = c.speed == null ? MIN_SPEED : c.speed;
            const eff = speed > MIN_SPEED ? speed : speed / slowDownOf(c.m);
            let vx = 0, vy = 0;
            if (d > 0.001) {
                vx = (dx / d) * eff;
                vy = (dy / d) * eff;
            }
            if (speed > MIN_SPEED) {
                c.speed = Math.max(MIN_SPEED, speed - SPEED_DECEL * dt);
            }
            const brake = MIN_DISTANCE + radiusOf(c.m);
            if (d < brake) {
                vx *= d / brake;
                vy *= d / brake;
            }
            c.x += vx * dt;
            c.y += vy * dt;
            const r = radiusOf(c.m);
            c.x = clamp(c.x, r, WORLD - r);
            c.y = clamp(c.y, r, WORLD - r);
        }
    }

    /* 自家分身之间的关系（原版 Player.handleCollisions）：
     *   - 冷却结束且两个球体重叠 → 合体
     *   - 冷却未结束但重叠 → 只用 66px/s 缓慢互推，所以分身会长期「糊在一起」
     *   - 不重叠就不干预，所有球体本来就朝同一个目标点聚拢
     */
    function resolveCells(cells, dt, now) {
        for (let i = 0; i < cells.length; i++) {
            for (let j = i + 1; j < cells.length; j++) {
                const a = cells[i], b = cells[j];
                if (!a || !b) continue;
                const ra = radiusOf(a.m), rb = radiusOf(b.m);
                const sum = ra + rb;
                const dx = b.x - a.x, dy = b.y - a.y;
                const d = Math.hypot(dx, dy);
                const nx = d > 0.001 ? dx / d : 1, ny = d > 0.001 ? dy / d : 0;
                const ready = a.mergeAt <= now && b.mergeAt <= now;
                if (ready) {
                    // 冷却结束后不再互推，允许两球叠在一起完成合体（移动中也能合上）
                    if (d <= sum + 8) {
                        const big = a.m >= b.m ? a : b;
                        const small = big === a ? b : a;
                        big.m += small.m;
                        const k = cells.indexOf(small);
                        if (k >= 0) cells.splice(k, 1);
                        i = -1;
                        break;
                    }
                    // 冷却结束后互相靠拢：两个同质量分身朝同一目标点移动时速度完全相同，
                    // 不靠拢就会永远保持距离，看起来像「等半天都不合并」。
                    const pull = Math.min((d - sum) * 0.6, MERGE_PULL_SPEED * dt);
                    a.x += nx * pull; a.y += ny * pull;
                    b.x -= nx * pull; b.y -= ny * pull;
                    continue;
                }
                if (d >= sum) continue;
                // 按重叠深度分离，而不是固定速度互推：分身才不会永远糊成一个球
                const depth = sum - d;
                const push = Math.min(depth * 0.5, PUSH_AWAY_SPEED * dt);
                a.x -= nx * push; a.y -= ny * push;
                b.x += nx * push; b.y += ny * push;
            }
        }
        for (const c of cells) {
            const r = radiusOf(c.m);
            c.x = clamp(c.x, r, WORLD - r);
            c.y = clamp(c.y, r, WORLD - r);
        }
    }

    /* 原版 gameloop 每秒一次：总质量 > 50 时，每个球体每秒掉 0.1% 质量 */
    function decayMass(cells, dt) {
        let total = 0;
        for (const c of cells) total += c.m;
        if (total <= 50) return;
        for (const c of cells) {
            if (c.m * 0.999 > DEFAULT_MASS) c.m -= c.m * 0.001 * dt;
        }
    }

    /* 吃食物 / 孢子 / 刺球，玩家和 bot 共用。
     * 刺球会把球体炸成多个分身，所以传进来的 cells 数组会被就地修改。 */
    function eatWorldFor(cells, tnow, ownerPid) {
        const list = cells.slice();
        for (const c of list) {
            if (cells.indexOf(c) < 0) continue;   // 刚刚被刺球炸掉/合体掉了
            const cr = radiusOf(c.m);
            const cr2 = cr * cr;
            eachFoodNear(c.x, c.y, cr, function (f) {
                if (G.eatenFood.has(f.id)) return;
                const fdx = f.x - c.x, fdy = f.y - c.y;
                if (fdx * fdx + fdy * fdy >= cr2) return;
                c.m += FOOD_MASS;
                G.eatenFood.set(f.id, tnow + FOOD_RESPAWN);
                if (ownerPid === G.pid) { G.recentFood.set(f.id, tnow + FOOD_RESPAWN); G.myFood = (G.myFood || 0) + 1; }
            });
            for (let i = G.ejects.length - 1; i >= 0; i--) {
                const e = G.ejects[i];
                // 自己刚吐出的孢子在 2.5 秒内不能吃回来（否则 W 等于没吐，也喂不到别人）
                if (e.owner === ownerPid && e.born && tnow - e.born < 2500) continue;
                if (c.m <= e.m * 1.1) continue;
                if (Math.hypot(e.x - c.x, e.y - c.y) >= cr) continue;
                c.m += e.m;
                G.ejects.splice(i, 1);
                G.deadEjects.set(e.id, tnow + 3000);
                if (ownerPid === G.pid) G.recentEjectEaten.push({ id: e.id, at: tnow });
            }
            for (const v of G.viruses) {
                if (G.virusRespawn.has(v.id)) continue;
                if (c.m <= VIRUS_MASS) continue;
                // 刺球按「两圆相碰」判定：之前要求球心进入自身半径，
                // 但靠近光标时会提前刹车，正对着刺球走永远撞不到，只有路过才会爆。
                if (Math.hypot(v.x - c.x, v.y - c.y) < radiusOf(c.m) + radiusOf(VIRUS_MASS) - 8) {
                    G.virusRespawn.set(v.id, tnow + VIRUS_RESPAWN);
                    if (ownerPid === G.pid) G.recentVirus.set(v.id, tnow + VIRUS_RESPAWN);
                    // 正式版吃刺球会把刺球的质量加给自己，再炸成多个分身；
                    // 这里之前只炸不给分，等于撞刺球纯亏，补上。
                    c.m += VIRUS_MASS;
                    splatCells(cells, c, ownerPid === G.pid ? MAX_CELLS : 8);
                    break;
                }
            }
        }
    }

    /* 原版 virusSplit：被刺球炸开时，每个球体一分为二，最多到 maxCells */
    function splatCells(cells, c, maxCells) {
        const room = maxCells - cells.length;
        if (room <= 0) {
            c.m = Math.max(DEFAULT_MASS, c.m * 0.75);
            return;
        }
        const pieces = Math.min(room + 1, 8);
        const share = c.m / pieces;
        const now = performance.now();
        const burst = splitSpeedFor(share);
        c.m = share;
        c.speed = burst;
        c.mergeAt = now + mergeDelayFor(share);
        for (let i = 1; i < pieces; i++) {
            const ang = (Math.PI * 2 * i) / pieces;
            G.cellSeq += 1;
            cells.push({
                id: G.cellSeq,
                x: c.x, y: c.y,
                m: share,
                speed: burst,
                mergeAt: now + mergeDelayFor(share)
            });
        }
    }

    /* 通用的「我吃你」判定：球心进入对方球体且质量大 15% 就能吞掉。
     * report=true 时记录吞人事件，联机模式下会随包发给对方。 */
    function eatBetween(cells, ownerPid, victimPid, victimCells, report) {
        for (const c of cells) {
            const cr = radiusOf(c.m);
            for (let i = victimCells.length - 1; i >= 0; i--) {
                const rc = victimCells[i];
                if (!rc) continue;
                if (c.m <= rc.m * 1.15) continue;
                if (Math.hypot(rc.x - c.x, rc.y - c.y) >= cr) continue;
                c.m += rc.m;
                markDead(victimPid, rc.id);
                victimCells.splice(i, 1);
                if (report) G.recentEats.push({ victim: victimPid, cellId: rc.id, at: Date.now() });
            }
        }
    }

    // 玩家吃别人（联机玩家 + 本地 bot 都在 G.remotes 里）
    function eatRemote() {
        for (const r of G.remotes.values()) {
            if (!r.cells.length) continue;
            eatBetween(G.me.cells, G.pid, r.pid, r.cells, G.mode === 'online');
        }
    }

    // bot 吃玩家 / 吃其他 bot（人机模式专用）
    function eatBots() {
        for (const b of G.bots) {
            if (!b.alive || !b.cells.length) continue;
            eatBetween(b.cells, b.pid, G.pid, G.me.cells, false);
            for (const o of G.bots) {
                if (o === b || !o.alive || !o.cells.length) continue;
                eatBetween(b.cells, b.pid, o.pid, o.cells, false);
            }
        }
    }

    function moveEjects(dt) {
        for (let i = G.ejects.length - 1; i >= 0; i--) {
            const e = G.ejects[i];
            if (Date.now() > e.until) { G.ejects.splice(i, 1); continue; }
            const sp = Math.hypot(e.vx || 0, e.vy || 0);
            if (sp > 0) {
                // 原版：孢子初速 1500px/s，之后以 1800px/s² 线性刹车
                const ns = Math.max(0, sp - EJECT_DECEL * dt);
                const k = ns / sp;
                e.vx *= k; e.vy *= k;
                e.x += e.vx * dt;
                e.y += e.vy * dt;
            }
            const r = radiusOf(e.m);
            e.x = clamp(e.x, r, WORLD - r);
            e.y = clamp(e.y, r, WORLD - r);
        }
    }

    function smoothRemotes(dt) {
        const k = 1 - Math.exp(-14 * dt);
        for (const r of G.remotes.values()) {
            for (const c of r.cells) {
                c.x += (c.tx - c.x) * k;
                c.y += (c.ty - c.y) * k;
                c.m += (c.tm - c.m) * 0.35;
            }
        }
    }

    function cullRemotes(now) {
        for (const [pid, r] of G.remotes) {
            if (now - r.lastTs > STALE_MS) G.remotes.delete(pid);
        }
        for (const [key, until] of G.deadCells) {
            if (until < now) G.deadCells.delete(key);
        }
        const tnow = Date.now();
        for (const [key, until] of G.deadEjects) {
            if (until < tnow) G.deadEjects.delete(key);
        }
    }

    function markDead(pid, cellId) {
        G.deadCells.set(pid + ':' + cellId, performance.now() + 2500);
    }

    /* ---------------- 人机模式 ----------------
     * bot 与玩家使用同一套物理与吞噬规则，差异只在「思考间隔、瞄准误差、
     * 会不会追人 / 逃跑 / 分裂」。bot 的球体同时镜像到 G.remotes，
     * 这样排行榜、小地图、渲染、玩家吞噬都能复用联机那套代码。
     */

    function massOf(cells) {
        let t = 0;
        for (const c of cells) t += c.m;
        return t;
    }

    function biggestCell(cells) {
        let best = null;
        for (const c of cells) if (!best || c.m > best.m) best = c;
        return best;
    }

    function centerOf(cells) {
        let x = 0, y = 0, m = 0;
        for (const c of cells) { x += c.x * c.m; y += c.y * c.m; m += c.m; }
        if (!m) return { x: WORLD / 2, y: WORLD / 2 };
        return { x: x / m, y: y / m };
    }

    function resetBots(diffKey) {
        G.bots = [];
        const diff = DIFFICULTY[diffKey] || DIFFICULTY.normal;
        for (let i = 0; i < BOT_COUNT; i++) {
            const bot = {
                pid: 'bot_' + i,
                name: BOT_NAMES[i % BOT_NAMES.length],
                color: COLORS[(i * 5 + 3) % COLORS.length],
                cells: [],
                aim: { x: WORLD / 2, y: WORLD / 2 },
                thinkAt: 0,
                alive: false,
                deadUntil: 0,
                vx: 0,
                vy: 0,
                px: 0,
                py: 0,
                diff: diff
            };
            G.bots.push(bot);
            spawnBot(bot, 15 + Math.random() * 25);
        }
    }

    // 出生点尽量远离玩家和其他球，避免一开局就被贴脸
    function spawnBot(bot, mass) {
        let bx = WORLD / 2, by = WORLD / 2, bestGap = -1;
        for (let i = 0; i < 16; i++) {
            const x = 200 + Math.random() * (WORLD - 400);
            const y = 200 + Math.random() * (WORLD - 400);
            let gap = Infinity;
            const pc = centerOf(G.me.cells);
            if (G.me.cells.length) gap = Math.hypot(pc.x - x, pc.y - y);
            for (const o of G.bots) {
                if (!o.alive || o === bot) continue;
                const oc = centerOf(o.cells);
                gap = Math.min(gap, Math.hypot(oc.x - x, oc.y - y));
            }
            if (gap > bestGap) { bestGap = gap; bx = x; by = y; }
            if (gap > 900) break;
        }
        G.cellSeq += 1;
        bot.cells = [{
            id: G.cellSeq,
            x: bx,
            y: by,
            m: mass,
            speed: MIN_SPEED,
            mergeAt: 0
        }];
        bot.aim.x = bx;
        bot.aim.y = by;
        bot.alive = true;
        bot.deadUntil = 0;
        bot.px = bx;
        bot.py = by;
        syncBotView(bot);
    }

    // 把 bot 的球体共享给 G.remotes（引用同一数组，玩家吃掉时直接生效）
    function syncBotView(bot) {
        if (!bot.alive || !bot.cells.length) {
            G.remotes.delete(bot.pid);
            return;
        }
        let r = G.remotes.get(bot.pid);
        if (!r) {
            r = { pid: bot.pid, name: bot.name, color: bot.color, cells: bot.cells, lastTs: 0 };
            G.remotes.set(bot.pid, r);
        }
        r.cells = bot.cells;
        r.lastTs = performance.now();
        // 禁用远端插值：bot 的位置就是权威位置
        for (const c of bot.cells) {
            c.tx = c.x;
            c.ty = c.y;
            c.tm = c.m;
        }
    }

    // 所有「可被 bot 吃掉 / 可吃掉 bot」的球体（玩家 + 其他 bot）
    function botEnemies(bot) {
        const out = [];
        for (const c of G.me.cells) {
            out.push({ x: c.x, y: c.y, m: c.m, vx: G.pvx || 0, vy: G.pvy || 0 });
        }
        for (const o of G.bots) {
            if (o === bot || !o.alive) continue;
            for (const c of o.cells) {
                out.push({ x: c.x, y: c.y, m: c.m, vx: o.vx, vy: o.vy });
            }
        }
        return out;
    }

    function nearestFood(c) {
        let best = null, bestD = Infinity;
        for (const f of G.food) {
            if (G.eatenFood.has(f.id)) continue;
            const d = (f.x - c.x) * (f.x - c.x) + (f.y - c.y) * (f.y - c.y);
            if (d < bestD) { bestD = d; best = f; }
        }
        return best;
    }

    function botThink(bot, now) {
        const diff = bot.diff;
        const big = biggestCell(bot.cells);
        if (!big) return;
        const enemies = botEnemies(bot);
        const self = centerOf(bot.cells);

        let target = null;
        let chasing = false;

        // 1) 逃跑：附近有能一口吃掉自己的敌人，朝反方向跑
        if (diff.fleeRatio > 0) {
            let threat = null, td = Infinity;
            for (const e of enemies) {
                if (e.m <= big.m * diff.fleeRatio) continue;
                const d = Math.hypot(e.x - self.x, e.y - self.y);
                if (d < 620 && d < td) { td = d; threat = e; }
            }
            if (threat) {
                target = {
                    x: self.x + (self.x - threat.x) * 2,
                    y: self.y + (self.y - threat.y) * 2
                };
            }
        }

        // 2) 追击：找比自己小一圈的最近球体
        if (!target && diff.chaseRatio > 0) {
            let prey = null, pd = Infinity;
            for (const e of enemies) {
                if (e.m * diff.chaseRatio > big.m) continue;
                const d = Math.hypot(e.x - self.x, e.y - self.y);
                if (d < diff.chaseRange && d < pd) { pd = d; prey = e; }
            }
            if (prey) {
                const lead = diff.predict / 1000;
                target = { x: prey.x + prey.vx * lead, y: prey.y + prey.vy * lead };
                chasing = true;
            }
        }

        // 3) 找不到人就吃食物
        if (!target) {
            const f = nearestFood(big);
            target = f ? { x: f.x, y: f.y } : { x: WORLD / 2, y: WORLD / 2 };
        }

        // 4) 自己够大时绕开刺球
        if (diff.avoidVirus && big.m > VIRUS_MASS * 1.2) {
            for (const v of G.viruses) {
                if (G.virusRespawn.has(v.id)) continue;
                const d = Math.hypot(v.x - big.x, v.y - big.y);
                if (d > 0 && d < 260) {
                    // 把目标点往刺球的反方向推一点，形成绕行
                    target = {
                        x: target.x + (big.x - v.x) / d * 320,
                        y: target.y + (big.y - v.y) / d * 320
                    };
                    break;
                }
            }
        }

        // 5) 追击时分裂抢食（困难难度更容易出手）
        if (chasing && diff.splitChance > 0) {
            const dx = target.x - big.x, dy = target.y - big.y;
            const d = Math.hypot(dx, dy);
            if (d < 320 && bot.cells.length < 8 && big.m > 44 && Math.random() < diff.splitChance) {
                bot.aim.x = target.x;
                bot.aim.y = target.y;
                splitBot(bot);
            }
        }

        // 6) 把目标点转成瞄准点，并叠加难度误差
        const dx = target.x - big.x, dy = target.y - big.y;
        const dist = Math.hypot(dx, dy) || 1;
        const err = (Math.random() * 2 - 1) * (diff.aimErr * Math.PI / 180);
        const ang = Math.atan2(dy, dx) + err;
        const reach = clamp(dist, 200, 900);
        bot.aim.x = big.x + Math.cos(ang) * reach;
        bot.aim.y = big.y + Math.sin(ang) * reach;
    }

    function splitBot(bot) {
        const now = performance.now();
        const list = bot.cells.slice().sort(function (a, b) { return b.m - a.m; });
        for (const c of list) {
            if (bot.cells.length >= 8) break;
            if (Math.floor(c.m / DEFAULT_MASS) < 2) continue;
            const half = c.m / 2;
            c.m = half;
            c.mergeAt = now + mergeDelayFor(half);
            G.cellSeq += 1;
            bot.cells.push({
                id: G.cellSeq,
                x: c.x,
                y: c.y,
                m: half,
                speed: splitSpeedFor(half),
                mergeAt: now + mergeDelayFor(half)
            });
        }
    }

    function updateBots(dt, now, tnow) {
        for (const bot of G.bots) {
            if (!bot.alive) {
                if (now >= bot.deadUntil) spawnBot(bot, 15 + Math.random() * 25);
                continue;
            }
            if (!bot.cells.length) {
                bot.alive = false;
                bot.deadUntil = now + BOT_RESPAWN;
                G.remotes.delete(bot.pid);
                continue;
            }
            if (now >= bot.thinkAt) {
                bot.thinkAt = now + bot.diff.react * (0.8 + Math.random() * 0.4);
                botThink(bot, now);
            }
            moveCells(bot.cells, bot.aim, dt);
            resolveCells(bot.cells, dt, now);
            eatWorldFor(bot.cells, tnow, bot.pid);
            decayMass(bot.cells, dt);

            // 记录速度，供困难难度预判
            const c0 = centerOf(bot.cells);
            if (dt > 0) {
                bot.vx = (c0.x - bot.px) / dt;
                bot.vy = (c0.y - bot.py) / dt;
            }
            bot.px = c0.x;
            bot.py = c0.y;
            syncBotView(bot);
        }
    }

    function tick(dt) {
        const now = performance.now();
        const tnow = Date.now();

        if (G.phase === 'playing') {
            // 鼠标模式：目标点 = 球群中心 + 光标相对屏幕中心的偏移（原版行为）。
            // 光标停在屏幕边缘时球会持续前进，而不是跑到某个固定坐标就停住。
            if (G.mouse.on && G.me.cells.length) {
                const own0 = centerOf(G.me.cells);
                G.aim.x = own0.x + (G.mouse.x - G.vw / 2) / G.scale;
                G.aim.y = own0.y + (G.mouse.y - G.vh / 2) / G.scale;
            } else if (G.touch.on && G.me.cells.length) {
                // 手机：按住拖拽方向每帧重算目标点，松手才停
                const own1 = centerOf(G.me.cells);
                const len1 = Math.hypot(G.touch.dx, G.touch.dy) || 1;
                const reach1 = 620 / Math.max(0.35, G.scale);
                G.aim.x = own1.x + (G.touch.dx / len1) * reach1;
                G.aim.y = own1.y + (G.touch.dy / len1) * reach1;
            }
            const prev = centerOf(G.me.cells);
            moveCells(G.me.cells, G.aim, dt);
            resolveCells(G.me.cells, dt, now);
            eatWorldFor(G.me.cells, tnow, G.pid);
            eatRemote();
            decayMass(G.me.cells, dt);
            const cur = centerOf(G.me.cells);
            if (dt > 0) {
                G.pvx = (cur.x - prev.x) / dt;
                G.pvy = (cur.y - prev.y) / dt;
            }
        }
        if (G.mode === 'bot') {
            updateBots(dt, now, tnow);
            eatBots();
            if (G.phase === 'playing' && !G.me.cells.length) die();
        }
        moveEjects(dt);
        smoothRemotes(dt);
        cullRemotes(now);
    }

    function die() {
        if (G.phase !== 'playing') return;
        G.phase = 'dead';
        showDead();
    }

    /* ---------------- 同步 ----------------
     * 线上由 Cloudflare Worker 把 /sb/* 反代到 Supabase，并注入 apikey，
     * 所以浏览器里没有密钥。每人每秒上报一次自己的整包状态，
     * 同时拉取同房间其他人的整包状态并合并。
     * 「吞食物 / 吃玩家 / 刺球爆裂 / 孢子」都用最近 2 秒重复携带的方式同步，
     * 单次丢包也不会造成不同步。
     */

    const TABLE = 'agario_state';
    // 后端入口允许宿主页面覆盖：
    //   独立站走 Cloudflare Worker 的 /sb 反代（不需要 key，Worker 注入）
    //   聊天室站点走 Netlify 反代，需要页面自己带上 anon key
    const AGAR_CFG = (typeof window !== 'undefined' && window.AGAR_CFG) || {};
    const SB_BASE = String(AGAR_CFG.sbBase || '/sb').replace(/\/+$/, '') + '/rest/v1';
    const SB_KEY = AGAR_CFG.anonKey || '';
    const EVENT_KEEP = 2200;
    const POLL_MS = 1000;
    const POLL_LOBBY_EVERY = 2;      // 大厅里每 2 个 tick（2 秒）拉一次
    const ROW_ALIVE_MS = 12000;      // 超过该时长没更新的行视为离线

    // 极简 PostgREST 客户端：只实现游戏需要的 upsert / select / delete
    function dbFrom(table) {
        const state = {
            action: 'select',
            cols: null,
            filters: [],
            body: null,
            onConflict: '',
            prefer: 'return=representation'
        };

        function run() {
            const params = state.filters.slice();
            if (state.action === 'select') params.push('select=' + encodeURIComponent(state.cols || '*'));
            if (state.onConflict) params.push('on_conflict=' + encodeURIComponent(state.onConflict));
            const url = SB_BASE + '/' + table + (params.length ? '?' + params.join('&') : '');
            const headers = { Prefer: state.prefer };
            if (SB_KEY) {
                headers['apikey'] = SB_KEY;
                headers['Authorization'] = 'Bearer ' + SB_KEY;
            }
            const opts = { method: 'GET', headers: headers };
            if (state.action === 'upsert') {
                opts.method = 'POST';
                opts.headers['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(state.body);
            } else if (state.action === 'delete') {
                opts.method = 'DELETE';
            }
            return fetch(url, opts).then(function (res) {
                return res.text().then(function (text) {
                    let data = null;
                    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
                    if (!res.ok) {
                        const msg = data && data.message ? data.message : ('HTTP ' + res.status);
                        return { data: null, error: { message: msg } };
                    }
                    return { data: data, error: null };
                });
            }, function (e) {
                return { data: null, error: { message: (e && e.message) || '网络错误' } };
            });
        }

        const b = {
            select: function (cols) { state.action = 'select'; state.cols = cols; return b; },
            upsert: function (row, opt) {
                state.action = 'upsert';
                state.body = row;
                state.prefer = 'resolution=merge-duplicates,return=minimal';
                if (opt && opt.onConflict) state.onConflict = opt.onConflict;
                return b;
            },
            delete: function () { state.action = 'delete'; state.prefer = 'return=minimal'; return b; },
            eq: function (col, val) {
                state.filters.push(col + '=eq.' + encodeURIComponent(val));
                return b;
            },
            lt: function (col, val) {
                state.filters.push(col + '=lt.' + encodeURIComponent(val));
                return b;
            },
            then: function (resolve, reject) { return run().then(resolve, reject); }
        };
        return b;
    }

    const db = { from: dbFrom };

    function buildPacket() {
        const now = Date.now();
        const food = [];
        G.recentFood.forEach(function (until, id) {
            if (until > now) food.push([id, until]);
            else G.recentFood.delete(id);
        });
        const virus = [];
        G.recentVirus.forEach(function (until, id) {
            if (until > now) virus.push([id, until]);
            else G.recentVirus.delete(id);
        });
        G.recentEats = G.recentEats.filter(function (e) { return now - e.at < EVENT_KEEP; });
        G.recentEjectEaten = G.recentEjectEaten.filter(function (e) { return now - e.at < EVENT_KEEP; });
        return {
            pid: G.pid,
            name: G.name,
            color: G.color,
            ts: now,
            cells: G.me.cells.map(function (c) {
                return { id: c.id, x: Math.round(c.x), y: Math.round(c.y), m: Math.round(c.m * 10) / 10 };
            }),
            food: food,
            virus: virus,
            eats: G.recentEats.map(function (e) { return [e.victim, e.cellId]; }),
            ejectEaten: G.recentEjectEaten.map(function (e) { return e.id; }),
            ejects: G.ejects
                .filter(function (e) { return e.owner === G.pid; })
                .map(function (e) {
                    return {
                        id: e.id,
                        x: Math.round(e.x), y: Math.round(e.y),
                        vx: Math.round(e.vx), vy: Math.round(e.vy),
                        m: e.m, c: e.c, until: e.until
                    };
                })
        };
    }

    function applyRemoteState(p) {
        if (!p || p.pid === G.pid) return;
        let r = G.remotes.get(p.pid);
        if (!r) {
            r = { pid: p.pid, name: p.name || '玩家', color: p.color || colorFor(p.pid), cells: [], lastTs: 0 };
            G.remotes.set(p.pid, r);
        }
        r.name = p.name || r.name;
        r.color = p.color || r.color;
        r.lastTs = performance.now();

        const incoming = p.cells || [];
        const old = new Map();
        for (const c of r.cells) old.set(c.id, c);
        const next = [];
        for (const c of incoming) {
            if (G.deadCells.has(p.pid + ':' + c.id)) continue;
            const prev = old.get(c.id);
            if (prev) {
                prev.tx = c.x; prev.ty = c.y; prev.tm = c.m;
                next.push(prev);
            } else {
                next.push({ id: c.id, x: c.x, y: c.y, tx: c.x, ty: c.y, m: c.m, tm: c.m });
            }
        }
        r.cells = next;
    }

    function applyPacket(p) {
        if (!p || !p.pid || p.pid === G.pid) return;
        const now = Date.now();
        const clampUntil = function (v, span) {
            const t = Number(v) || 0;
            return Math.min(t, now + span);
        };

        (p.food || []).forEach(function (pair) {
            if (!Array.isArray(pair) || pair[0] == null) return;
            const until = clampUntil(pair[1], FOOD_RESPAWN + 2000);
            if (until <= now) return;
            const cur = G.eatenFood.get(pair[0]);
            if (!cur || until > cur) G.eatenFood.set(pair[0], until);
        });
        (p.virus || []).forEach(function (pair) {
            if (!Array.isArray(pair) || pair[0] == null) return;
            const until = clampUntil(pair[1], VIRUS_RESPAWN + 2000);
            if (until <= now) return;
            const cur = G.virusRespawn.get(pair[0]);
            if (!cur || until > cur) G.virusRespawn.set(pair[0], until);
        });
        (p.eats || []).forEach(function (pair) {
            if (!Array.isArray(pair) || pair[0] == null) return;
            const victim = pair[0], cellId = pair[1];
            if (victim === G.pid) {
                removeMyCell(cellId);
            } else {
                markDead(victim, cellId);
                removeRemoteCell(victim, cellId);
            }
        });
        (p.ejectEaten || []).forEach(function (id) {
            G.ejects = G.ejects.filter(function (e) { return e.id !== id; });
        });
        (p.ejects || []).forEach(function (e) {
            if (!e || !e.id || G.deadEjects.has(e.id)) return;
            const until = clampUntil(e.until, EJECT_TTL + 2000);
            const cur = G.ejects.find(function (x) { return x.id === e.id; });
            if (cur) {
                cur.x = e.x; cur.y = e.y;
                cur.vx = e.vx || 0; cur.vy = e.vy || 0;
                cur.m = e.m || EJECT_MASS;
                cur.until = until;
                cur.owner = p.pid;
            } else {
                G.ejects.push({
                    id: e.id, x: e.x, y: e.y,
                    vx: e.vx || 0, vy: e.vy || 0,
                    m: e.m || EJECT_MASS, c: e.c || '#ffd43b',
                    until: until, owner: p.pid
                });
            }
        });
        if (G.ejects.length > MAX_EJECTS) G.ejects.splice(0, G.ejects.length - MAX_EJECTS);

        applyRemoteState(p);
    }

    function removeRemoteCell(pid, cellId) {
        const r = G.remotes.get(pid);
        if (!r) return;
        for (let i = r.cells.length - 1; i >= 0; i--) {
            if (r.cells[i].id === cellId) r.cells.splice(i, 1);
        }
    }

    function removeMyCell(cellId) {
        for (let i = G.me.cells.length - 1; i >= 0; i--) {
            if (G.me.cells[i].id === cellId) G.me.cells.splice(i, 1);
        }
        if (G.phase === 'playing' && G.me.cells.length === 0) {
            G.phase = 'dead';
            showDead();
        }
    }

    function startSync() {
        if (G.pollTimer || G.mode !== 'online') return;
        G.connected = true;
        G.pollTick = 0;
        G.lobbyPlayers = [];
        G.lastHeartbeat = 0;
        // 顺手清掉一小时前的残留行（异常退出不会留下幽灵玩家）
        try {
            db.from(TABLE).delete()
                .eq('room_code', G.room)
                .lt('updated_at', new Date(Date.now() - 3600000).toISOString());
        } catch (e) { /* ignore */ }
        syncNow();
        G.pollTimer = setInterval(syncNow, POLL_MS);
        renderLobby();
    }

    function stopSync() {
        if (G.pollTimer) {
            clearInterval(G.pollTimer);
            G.pollTimer = 0;
        }
        G.connected = false;
    }

    function syncNow() {
        if (!G.open || G.syncBusy || G.mode !== 'online') return;
        G.syncBusy = true;
        G.pollTick += 1;

        const playing = G.phase === 'playing' || G.phase === 'dead';
        const needPull = playing || G.pollTick % POLL_LOBBY_EVERY === 0;
        // lastHeartbeat = 0 表示还没上报过：进场时必须立刻写一行，别人马上能看到
        const needPush = playing || !G.lastHeartbeat || performance.now() - G.lastHeartbeat > 3000;

        if (!needPull && !needPush) {
            G.syncBusy = false;
            return;
        }

        const tasks = [];
        if (needPush) {
            G.lastHeartbeat = performance.now();
            tasks.push(db.from(TABLE).upsert({
                room_code: G.room,
                player_id: G.pid,
                name: G.name,
                color: G.color,
                payload: buildPacket(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'room_code,player_id' }));
        }
        if (needPull) {
            tasks.push(db.from(TABLE)
                .select('player_id,name,color,payload,updated_at')
                .eq('room_code', G.room));
        }

        Promise.all(tasks).then(function (results) {
            if (!needPull) return;
            const res = results[results.length - 1];
            if (!res || res.error) {
                if (res && res.error) console.warn('球球大作战读取失败:', res.error.message);
                return;
            }
            const rows = res.data || [];
            const now = Date.now();
            const players = [];
            rows.forEach(function (row) {
                const payload = row.payload || {};
                const seen = payload.ts || (row.updated_at ? Date.parse(row.updated_at) : 0);
                if (!seen || now - seen > ROW_ALIVE_MS) return;
                players.push({
                    pid: row.player_id,
                    name: row.name || payload.name || '玩家',
                    color: row.color || payload.color || colorFor(row.player_id),
                    at: seen
                });
                if (row.player_id === G.pid) return;
                payload.pid = row.player_id;
                payload.name = row.name || payload.name;
                payload.color = row.color || payload.color;
                applyPacket(payload);
            });
            G.lobbyPlayers = players.sort(function (a, b) { return a.at - b.at; });
            renderLobby();
        }).catch(function (e) {
            console.warn('球球大作战同步失败:', e && e.message ? e.message : e);
        }).finally(function () {
            G.syncBusy = false;
        });
    }

    /* ---------------- 操作 ---------------- */

    function doSplit() {
        if (G.phase !== 'playing') return;
        const now = performance.now();
        const list = G.me.cells.slice().sort(function (a, b) { return b.m - a.m; });
        for (const c of list) {
            if (G.me.cells.length >= MAX_CELLS) break;
            // 原版：至少要能均分成两块（质量 >= 2 × defaultPlayerMass）
            if (Math.floor(c.m / DEFAULT_MASS) < 2) continue;
            const half = c.m / 2;
            c.m = half;
            c.mergeAt = now + mergeDelayFor(half);
            G.cellSeq += 1;
            // 原版：新球生成在同一个位置，靠冲刺初速朝鼠标方向甩出去
            G.me.cells.push({
                id: G.cellSeq,
                x: c.x,
                y: c.y,
                m: half,
                speed: splitSpeedFor(half),
                mergeAt: now + mergeDelayFor(half)
            });
        }
        syncNow();
    }

    function doEject() {
        if (G.phase !== 'playing') return;
        const now = Date.now();
        for (const c of G.me.cells) {
            if (c.m < MIN_EJECT_MASS) continue;
            const dir = aimDir(c);
            c.m -= EJECT_COST;
            const r = radiusOf(c.m);
            G.ejectSeq += 1;
            // 原版：孢子从球心以 1500px/s 射出，0.83 秒后停住（约 625px）
            G.ejects.push({
                id: G.pid + '_' + G.ejectSeq,
                x: c.x + dir.x * (r * 0.6),
                y: c.y + dir.y * (r * 0.6),
                vx: dir.x * EJECT_SPEED,
                vy: dir.y * EJECT_SPEED,
                m: EJECT_MASS,
                c: G.color,
                owner: G.pid,
                until: now + EJECT_TTL,
                born: now
            });
        }
        if (G.ejects.length > MAX_EJECTS) G.ejects.splice(0, G.ejects.length - MAX_EJECTS);
        syncNow();
    }

    /* ---------------- 渲染 ---------------- */

    function updateCamera(dt) {
        const cells = G.me.cells;
        if (!cells.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, total = 0;
        for (const c of cells) {
            const r = radiusOf(c.m);
            if (c.x - r < minX) minX = c.x - r;
            if (c.y - r < minY) minY = c.y - r;
            if (c.x + r > maxX) maxX = c.x + r;
            if (c.y + r > maxY) maxY = c.y + r;
            total += c.m;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        // 只按总质量缩放视野；分身散开时靠镜头居中兜住，不完全拉远
        const base = 700 + 18 * Math.sqrt(total);
        const targetScale = Math.min(G.vw, G.vh) / base;
        G.scale += (targetScale - G.scale) * Math.min(1, dt * 5);

        const halfW = G.vw / 2 / G.scale;
        const halfH = G.vh / 2 / G.scale;
        const tx = WORLD > halfW * 2 ? clamp(cx, halfW, WORLD - halfW) : WORLD / 2;
        const ty = WORLD > halfH * 2 ? clamp(cy, halfH, WORLD - halfH) : WORLD / 2;
        G.cam.x += (tx - G.cam.x) * Math.min(1, dt * 8);
        G.cam.y += (ty - G.cam.y) * Math.min(1, dt * 8);
    }

    function drawGrid(ctx) {
        const step = 220;
        const scale = G.scale;
        const halfW = G.vw / 2 / scale + 100;
        const halfH = G.vh / 2 / scale + 100;
        const x0 = Math.max(0, Math.floor((G.cam.x - halfW) / step) * step);
        const x1 = Math.min(WORLD, G.cam.x + halfW);
        const y0 = Math.max(0, Math.floor((G.cam.y - halfH) / step) * step);
        const y1 = Math.min(WORLD, G.cam.y + halfH);
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,255,255,0.045)';
        ctx.lineWidth = 1 / scale;
        for (let x = x0; x <= x1; x += step) {
            ctx.moveTo(x, y0); ctx.lineTo(x, y1);
        }
        for (let y = y0; y <= y1; y += step) {
            ctx.moveTo(x0, y); ctx.lineTo(x1, y);
        }
        ctx.stroke();
    }

    function drawWorldBorder(ctx) {
        ctx.strokeStyle = 'rgba(120,180,255,0.45)';
        ctx.lineWidth = 6;
        ctx.strokeRect(0, 0, WORLD, WORLD);
    }

    function visible(x, y, pad) {
        const halfW = G.vw / 2 / G.scale + pad;
        const halfH = G.vh / 2 / G.scale + pad;
        return Math.abs(x - G.cam.x) < halfW && Math.abs(y - G.cam.y) < halfH;
    }

    function drawFood(ctx) {
        const now = Date.now();
        for (const f of G.food) {
            const until = G.eatenFood.get(f.id);
            if (until && until > now) continue;
            if (until && until <= now) G.eatenFood.delete(f.id);
            if (!visible(f.x, f.y, 40)) continue;
            ctx.fillStyle = f.c;
            ctx.beginPath();
            ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function drawEjects(ctx) {
        for (const e of G.ejects) {
            if (!visible(e.x, e.y, 40)) continue;
            const r = radiusOf(e.m);
            ctx.beginPath();
            ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
            ctx.fillStyle = e.c;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.4)';
            ctx.lineWidth = Math.max(1.5, r * 0.14);
            ctx.stroke();
        }
    }

    function drawViruses(ctx) {
        const now = Date.now();
        for (const v of G.viruses) {
            const until = G.virusRespawn.get(v.id);
            if (until && until > now) continue;
            if (until && until <= now) G.virusRespawn.delete(v.id);
            if (!visible(v.x, v.y, 160)) continue;
            const r = radiusOf(VIRUS_MASS);
            const spikes = 22;
            ctx.beginPath();
            for (let i = 0; i <= spikes * 2; i++) {
                const ang = (Math.PI * i) / spikes;
                const rr = i % 2 === 0 ? r : r * 0.86;
                const px = v.x + Math.cos(ang) * rr;
                const py = v.y + Math.sin(ang) * rr;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fillStyle = 'rgba(46,204,113,0.28)';
            ctx.fill();
            ctx.strokeStyle = '#2ecc71';
            ctx.lineWidth = 4;
            ctx.stroke();
        }
    }

    function drawCell(ctx, x, y, m, color, name, isMe) {
        const r = radiusOf(m);
        const grad = ctx.createRadialGradient(x - r * 0.32, y - r * 0.36, r * 0.12, x, y, r * 1.02);
        grad.addColorStop(0, shade(color, 0.5));
        grad.addColorStop(0.6, color);
        grad.addColorStop(1, shade(color, -0.26));
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, r * 0.05);
        ctx.strokeStyle = isMe ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.22)';
        ctx.stroke();
        if (r > 18) {
            ctx.beginPath();
            ctx.ellipse(x - r * 0.3, y - r * 0.42, r * 0.4, r * 0.24, -0.6, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.16)';
            ctx.fill();
        }
        if (name && r > 16) {
            const fs = Math.max(12, r * 0.34);
            const ny = r > 34 ? y - fs * 0.34 : y;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '700 ' + fs + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
            ctx.lineWidth = Math.max(2, fs * 0.16);
            ctx.strokeStyle = 'rgba(0,0,0,0.35)';
            ctx.strokeText(name, x, ny);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(name, x, ny);
            if (r > 34) {
                const ms = Math.max(10, r * 0.24);
                ctx.font = '600 ' + ms + 'px -apple-system, sans-serif';
                ctx.strokeText(fmtMass(m), x, y + fs * 0.55);
                ctx.fillStyle = 'rgba(255,255,255,0.9)';
                ctx.fillText(fmtMass(m), x, y + fs * 0.55);
            }
        }
    }

    function drawRemotes(ctx) {
        for (const r of G.remotes.values()) {
            let big = null;
            for (const c of r.cells) if (!big || c.m > big.m) big = c;
            for (const c of r.cells) {
                if (!visible(c.x, c.y, radiusOf(c.m) + 60)) continue;
                // 只在最大的球体上写名字，分身多的时候不容易糊成一片
                drawCell(ctx, c.x, c.y, c.m, r.color, c === big ? r.name : '', false);
            }
        }
    }

    function drawMe(ctx) {
        let big = null;
        for (const c of G.me.cells) if (!big || c.m > big.m) big = c;
        for (const c of G.me.cells) {
            drawCell(ctx, c.x, c.y, c.m, G.color, c === big ? G.name : '', true);
        }
    }

    function render(dt) {
        if (!G.ctx) return;
        updateCamera(dt);
        const ctx = G.ctx;
        const w = G.vw, h = G.vh;
        ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
        ctx.fillStyle = '#080d18';
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.scale(G.scale, G.scale);
        ctx.translate(-G.cam.x, -G.cam.y);

        ctx.fillStyle = '#0f1729';
        ctx.fillRect(0, 0, WORLD, WORLD);
        drawGrid(ctx);
        drawFood(ctx);
        drawEjects(ctx);
        drawViruses(ctx);
        drawRemotes(ctx);
        drawMe(ctx);
        drawWorldBorder(ctx);

        ctx.restore();

        drawMinimap();
        maybeUpdateHud();
    }

    function drawMinimap() {
        const ctx = G.miniCtx;
        if (!ctx) return;
        const s = 130;
        const k = s / WORLD;
        ctx.clearRect(0, 0, s, s);
        ctx.fillStyle = 'rgba(10,18,32,0.78)';
        ctx.fillRect(0, 0, s, s);

        // 刺球
        ctx.fillStyle = 'rgba(46,204,113,0.75)';
        for (const v of G.viruses) {
            if (G.virusRespawn.has(v.id)) continue;
            ctx.fillRect(v.x * k - 1, v.y * k - 1, 2.5, 2.5);
        }

        for (const r of G.remotes.values()) {
            for (const c of r.cells) {
                ctx.fillStyle = r.color;
                const sz = Math.max(3, radiusOf(c.m) * k * 1.6);
                ctx.fillRect(c.x * k - sz / 2, c.y * k - sz / 2, sz, sz);
            }
        }
        ctx.fillStyle = G.color;
        for (const c of G.me.cells) {
            const sz = Math.max(3.5, radiusOf(c.m) * k * 1.8);
            ctx.fillRect(c.x * k - sz / 2, c.y * k - sz / 2, sz, sz);
        }
        const vw = G.vw / G.scale * k;
        const vh = G.vh / G.scale * k;
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(G.cam.x * k - vw / 2, G.cam.y * k - vh / 2, vw, vh);
        ctx.strokeStyle = 'rgba(120,180,255,0.35)';
        ctx.strokeRect(0.5, 0.5, s - 1, s - 1);
    }

    /* ---------------- 界面 ---------------- */

    function injectStyle() {
        if (document.getElementById('agar-style')) return;
        const st = document.createElement('style');
        st.id = 'agar-style';
        st.textContent = `
        .agar-root{position:fixed;inset:0;z-index:9600;background:#080d18;overflow:hidden;
            touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
            font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#fff;}
        .agar-root canvas{display:block;position:absolute;inset:0;width:100%;height:100%;}
        .agar-topbar{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;
            padding:calc(8px + env(safe-area-inset-top,0px)) 12px 8px;pointer-events:none;z-index:5;}
        .agar-title{font-size:14px;font-weight:700;letter-spacing:.5px;text-shadow:0 2px 8px rgba(0,0,0,.8);}
        .agar-online{font-size:11px;font-weight:500;opacity:.7;margin-left:6px;}
        .agar-exit{pointer-events:auto;border:none;border-radius:50%;width:40px;height:40px;font-size:18px;
            background:rgba(255,255,255,.12);color:#fff;cursor:pointer;line-height:1;}
        .agar-board{position:absolute;top:calc(52px + env(safe-area-inset-top,0px));right:12px;width:150px;
            background:rgba(12,20,34,.62);border:1px solid rgba(255,255,255,.1);border-radius:10px;
            padding:8px 9px;font-size:12px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:4;
            max-height:260px;overflow:hidden;}
        .agar-board-title{font-size:11px;opacity:.65;margin-bottom:5px;letter-spacing:1px;}
        .agar-lb-row{display:flex;align-items:center;gap:5px;line-height:1.7;white-space:nowrap;overflow:hidden;}
        .agar-lb-row.me{color:#ffd43b;font-weight:700;}
        .agar-lb-rank{width:14px;opacity:.6;flex-shrink:0;}
        .agar-lb-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
        .agar-lb-name{flex:1;overflow:hidden;text-overflow:ellipsis;}
        .agar-lb-mass{opacity:.75;flex-shrink:0;}
        .agar-hud{position:absolute;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));
            display:flex;gap:14px;font-size:13px;background:rgba(12,20,34,.6);border-radius:10px;
            padding:8px 14px;border:1px solid rgba(255,255,255,.08);z-index:4;}
        .agar-hud b{font-size:17px;margin-left:4px;}
        .agar-hud-label{opacity:.6;font-size:11px;}
        .agar-tips{position:absolute;left:50%;transform:translateX(-50%);
            bottom:calc(14px + env(safe-area-inset-bottom,0px));font-size:11px;opacity:.45;
            white-space:nowrap;z-index:3;}
        .agar-actions{position:absolute;right:14px;bottom:calc(16px + env(safe-area-inset-bottom,0px));
            display:flex;flex-direction:column;gap:12px;z-index:6;}
        .agar-act{width:68px;height:68px;border-radius:50%;border:2px solid rgba(255,255,255,.22);
            background:rgba(255,255,255,.12);color:#fff;font-size:14px;font-weight:700;cursor:pointer;
            display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
            backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);touch-action:manipulation;}
        .agar-act small{font-size:9px;font-weight:400;opacity:.6;}
        .agar-act:active{background:rgba(255,255,255,.28);transform:scale(.95);}
        .agar-board,.agar-hud,.agar-tips,.agar-mini{pointer-events:none;}
        .agar-mini{position:absolute;left:12px;top:calc(52px + env(safe-area-inset-top,0px));z-index:4;opacity:.9;}
        .agar-mini canvas{position:static;width:130px;height:130px;border-radius:10px;}
        .agar-lobby,.agar-dead{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
            background:rgba(5,9,18,.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:10;
            padding:16px;}
        .agar-lobby-card,.agar-dead-card{width:100%;max-width:340px;background:rgba(18,28,45,.96);
            border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:22px 20px;text-align:center;
            box-shadow:0 20px 60px rgba(0,0,0,.5);}
        .agar-lobby-title,.agar-dead-title{font-size:20px;font-weight:800;margin-bottom:4px;}
        .agar-lobby-sub,.agar-dead-sub{font-size:12px;opacity:.6;margin-bottom:16px;}
        .agar-lobby-list{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:16px;
            max-height:110px;overflow-y:auto;}
        .agar-chip{font-size:11px;padding:3px 9px;border-radius:20px;background:rgba(255,255,255,.1);}
        .agar-chip.me{background:rgba(255,212,59,.2);color:#ffd43b;}
        .agar-primary{width:100%;padding:12px;border:none;border-radius:10px;font-size:15px;font-weight:700;
            background:linear-gradient(135deg,#ffb020,#ff7a18);color:#231200;cursor:pointer;margin-bottom:10px;}
        .agar-primary:active{filter:brightness(.92);}
        .agar-ghost{width:100%;padding:10px;border-radius:10px;font-size:13px;cursor:pointer;
            background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.14);margin-bottom:8px;}
        .agar-ghost:active{background:rgba(255,255,255,.16);}
        .agar-link{font-size:12px;opacity:.55;cursor:pointer;padding:6px;}
        .agar-link:active{opacity:.9;}
        @media (max-width: 480px){
            .agar-board{width:120px;font-size:11px;top:calc(50px + env(safe-area-inset-top,0px));}
            .agar-mini{transform:scale(.82);transform-origin:top left;}
            .agar-hud{font-size:12px;padding:6px 10px;gap:10px;}
            .agar-tips{display:none;}
            .agar-act{width:62px;height:62px;font-size:13px;}
        }
        `;
        document.head.appendChild(st);
    }

    function buildDom() {
        const root = document.createElement('div');
        root.id = 'agar-root';
        root.className = 'agar-root';
        root.innerHTML = `
            <canvas id="agar-canvas"></canvas>
            <div class="agar-topbar">
                <div class="agar-title">🟠 球球大作战<span class="agar-online" id="agar-online">连接中…</span></div>
                <button class="agar-exit" id="agar-exit" aria-label="退出">✕</button>
            </div>
            <div class="agar-mini"><canvas id="agar-mini-canvas" width="130" height="130"></canvas></div>
            <div class="agar-board" id="agar-board">
                <div class="agar-board-title">排行榜</div>
                <div id="agar-board-list"></div>
            </div>
            <div class="agar-hud">
                <div><span class="agar-hud-label">质量</span><b id="agar-mass">${START_MASS}</b></div>
                <div><span class="agar-hud-label">分身</span><b id="agar-cellcount">1</b></div>
            </div>
            <div class="agar-tips">鼠标控制方向 · 空格分裂 · W 吐孢子</div>
            <div class="agar-actions">
                <button class="agar-act" id="agar-split">分裂<small>空格</small></button>
                <button class="agar-act" id="agar-eject">吐孢子<small>W</small></button>
            </div>
            <div class="agar-lobby" id="agar-lobby">
                <div class="agar-lobby-card">
                    <div class="agar-lobby-title">🟠 球球大作战</div>
                    <div class="agar-lobby-sub" id="agar-lobby-sub">房间内所有人可一起玩</div>
                    <div class="agar-lobby-list" id="agar-lobby-list"></div>
                    <button class="agar-primary" id="agar-start">开始游戏</button>
                    <button class="agar-ghost" id="agar-copy">复制邀请链接</button>
                    <div class="agar-link" id="agar-quit">离开</div>
                </div>
            </div>
            <div class="agar-dead" id="agar-dead" style="display:none">
                <div class="agar-dead-card">
                    <div class="agar-dead-title">你被吃掉了</div>
                    <div class="agar-dead-sub" id="agar-dead-sub">重新开始，去吃掉别人</div>
                    <button class="agar-primary" id="agar-respawn">再来一局</button>
                    <div class="agar-link" id="agar-dead-quit">退出游戏</div>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        G.canvas = root.querySelector('#agar-canvas');
        G.ctx = G.canvas.getContext('2d');
        G.mini = root.querySelector('#agar-mini-canvas');
        G.miniCtx = G.mini.getContext('2d');
    }

    function updateOnlineLabel() {
        const el = document.getElementById('agar-online');
        if (!el) return;
        if (G.mode === 'bot') {
            el.textContent = DIFFICULTY[G.difficulty].label + ' · ' + BOT_COUNT + ' 个对手';
        } else {
            el.textContent = G.connected ? (G.lobbyPlayers.length + ' 人在线') : '连接中…';
        }
    }

    function renderLobby() {
        const list = document.getElementById('agar-lobby-list');
        if (!list) return;
        const players = G.lobbyPlayers || [];
        updateOnlineLabel();
        if (G.phase !== 'lobby') return;
        if (!players.length) {
            list.innerHTML = '<span class="agar-chip">等待玩家加入…</span>';
            return;
        }
        list.innerHTML = players.map(function (p) {
            const me = p.pid === G.pid;
            return '<span class="agar-chip' + (me ? ' me' : '') + '">' +
                esc(p.name || '玩家') + (me ? '（你）' : '') + '</span>';
        }).join('');
    }

    // 联机模式：把带房间号的链接复制给朋友
    function copyInvite() {
        const link = location.origin + location.pathname + '#room=' + encodeURIComponent(G.room);
        const btn = document.getElementById('agar-copy');
        const done = function () {
            if (btn) {
                btn.textContent = '已复制 ✓';
                setTimeout(function () { if (btn) btn.textContent = '复制邀请链接'; }, 1500);
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(done, function () { prompt('复制链接发给朋友', link); });
        } else {
            prompt('复制链接发给朋友', link);
        }
    }

    function maybeUpdateHud() {
        const now = performance.now();
        if (now - G.lastHud < 160) return;
        G.lastHud = now;

        let total = 0;
        for (const c of G.me.cells) total += c.m;
        const massEl = document.getElementById('agar-mass');
        const cellEl = document.getElementById('agar-cellcount');
        if (massEl) massEl.textContent = fmtMass(total);
        if (cellEl) cellEl.textContent = String(G.me.cells.length);

        const box = document.getElementById('agar-board-list');
        if (!box) return;
        const rows = [];
        rows.push({ name: G.name, color: G.color, mass: total, me: true });
        for (const r of G.remotes.values()) {
            let t = 0;
            for (const c of r.cells) t += c.m;
            rows.push({ name: r.name, color: r.color, mass: t, me: false });
        }
        rows.sort(function (a, b) { return b.mass - a.mass; });
        box.innerHTML = rows.slice(0, 10).map(function (r, i) {
            return '<div class="agar-lb-row' + (r.me ? ' me' : '') + '">' +
                '<span class="agar-lb-rank">' + (i + 1) + '</span>' +
                '<span class="agar-lb-dot" style="background:' + r.color + '"></span>' +
                '<span class="agar-lb-name">' + esc(r.name) + '</span>' +
                '<span class="agar-lb-mass">' + fmtMass(r.mass) + '</span>' +
                '</div>';
        }).join('');
    }

    function showDead() {
        const el = document.getElementById('agar-dead');
        if (!el) return;
        const sub = document.getElementById('agar-dead-sub');
        let total = 0;
        for (const r of G.remotes.values()) {
            for (const c of r.cells) total += c.m;
        }
        if (sub) {
            sub.textContent = (G.mode === 'bot' ? '对手总质量 ' : '场上剩余玩家质量 ') + fmtMass(total);
        }
        el.style.display = 'flex';
    }

    function hideDead() {
        const el = document.getElementById('agar-dead');
        if (el) el.style.display = 'none';
    }

    function startPlaying() {
        if (G.phase === 'lobby') {
            spawn(START_MASS);
        }
        G.phase = 'playing';
        const lobby = document.getElementById('agar-lobby');
        if (lobby) lobby.style.display = 'none';
        hideDead();
        syncNow();
    }

    function respawn() {
        spawn(START_MASS);
        G.phase = 'playing';
        hideDead();
        syncNow();
    }

    /* ---------------- 输入 ---------------- */

    function setAimFromScreen(clientX, clientY) {
        // 记录光标屏幕坐标，真正的目标点每帧按镜头重新计算（见 tick）。
        // 原版行为：光标停在屏幕边缘时球会一直往前走，而不是跑到某个固定世界坐标就刹住。
        G.mouse.x = clientX;
        G.mouse.y = clientY;
        G.mouse.on = true;
        G.touch.on = false;
        G.aim.x = G.cam.x + (clientX - G.vw / 2) / G.scale;
        G.aim.y = G.cam.y + (clientY - G.vh / 2) / G.scale;
    }

    function centerAim(dirX, dirY) {
        G.mouse.on = false;
        G.touch.dx = dirX;
        G.touch.dy = dirY;
        G.touch.on = true;
        let total = 0, cx = 0, cy = 0;
        for (const c of G.me.cells) { cx += c.x * c.m; cy += c.y * c.m; total += c.m; }
        if (!total) return;
        cx /= total; cy /= total;
        const len = Math.hypot(dirX, dirY) || 1;
        const reach = 620 / Math.max(0.35, G.scale);
        G.aim.x = cx + (dirX / len) * reach;
        G.aim.y = cy + (dirY / len) * reach;
    }

    function bindInput() {
        const canvas = G.canvas;
        const onPointerMove = function (e) {
            if (e.pointerType === 'mouse') {
                if (G.phase !== 'playing') return;
                setAimFromScreen(e.clientX, e.clientY);
            }
        };
        const onPointerDown = function (e) {
            if (G.phase !== 'playing') return;
            if (e.pointerType === 'mouse') {
                setAimFromScreen(e.clientX, e.clientY);
            } else {
                const rect = canvas.getBoundingClientRect();
                centerAim(e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
            }
        };
        const onPointerTouchMove = function (e) {
            if (e.pointerType === 'mouse' || G.phase !== 'playing') return;
            const rect = canvas.getBoundingClientRect();
            centerAim(e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
        };
        const onTouchEnd = function (e) {
            if (e.pointerType === 'mouse') return;
            G.touch.on = false;
            // 松手就停在原地：否则目标点还留在 620px 外，球会自己继续滑一段
            if (G.me.cells.length) {
                const own = centerOf(G.me.cells);
                G.aim.x = own.x;
                G.aim.y = own.y;
            }
        };
        const onKey = function (e) {
            if (!G.open) return;
            // 别用 e.key 判断：中文输入法激活时 key 会变成 Process/Unidentified（keyCode 229），
            // 所以统一用 e.code / keyCode，保证中英文输入法下都能分裂、吐球。
            const isSpace = e.code === 'Space' || e.keyCode === 32;
            const isW = e.code === 'KeyW' || e.keyCode === 87 || e.key === 'w' || e.key === 'W';
            if (isSpace) {
                e.preventDefault();
                if (!e.repeat) doSplit();
            } else if (isW) {
                e.preventDefault();
                if (!e.repeat) doEject();
            } else if (e.key === 'Escape') {
                closeGame();
            }
        };
        const onResize = function () { resize(); };

        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerTouchMove);
        canvas.addEventListener('pointerup', onTouchEnd);
        canvas.addEventListener('pointercancel', onTouchEnd);
        window.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

        G.listeners.push(function () {
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointermove', onPointerTouchMove);
            canvas.removeEventListener('pointerup', onTouchEnd);
            canvas.removeEventListener('pointercancel', onTouchEnd);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onResize);
            if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize);
        });
    }

    function bindButtons() {
        const on = function (id, fn) {
            const el = document.getElementById(id);
            if (!el) return;
            const h = function (e) { e.preventDefault(); fn(); };
            el.addEventListener('click', h);
            G.listeners.push(function () { el.removeEventListener('click', h); });
        };
        on('agar-exit', closeGame);
        on('agar-quit', closeGame);
        on('agar-dead-quit', closeGame);
        on('agar-start', startPlaying);
        on('agar-copy', copyInvite);
        on('agar-respawn', respawn);
        on('agar-split', doSplit);
        on('agar-eject', doEject);
    }

    /* ---------------- 生命周期 ---------------- */

    function resize() {
        if (!G.canvas) return;
        const rect = G.canvas.getBoundingClientRect();
        G.dpr = Math.min(2, window.devicePixelRatio || 1);
        G.vw = rect.width;
        G.vh = rect.height;
        G.canvas.width = Math.max(1, Math.round(rect.width * G.dpr));
        G.canvas.height = Math.max(1, Math.round(rect.height * G.dpr));
    }

    function loop(ts) {
        if (!G.open) return;
        const last = G.lastFrame || ts;
        const dt = Math.min(0.05, Math.max(0.001, (ts - last) / 1000));
        G.lastFrame = ts;
        tick(dt);
        render(dt);
        G.raf = requestAnimationFrame(loop);
    }

    function teardown() {
        G.open = false;
        G.phase = 'lobby';
        // 联机模式退出时清掉自己那一行，别人不用等 12 秒才判定离线
        if (G.mode === 'online' && G.connected) {
            try {
                db.from(TABLE).delete()
                    .eq('room_code', G.room)
                    .eq('player_id', G.pid);
            } catch (e) { /* ignore */ }
        }
        stopSync();
        if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
        (G.listeners || []).forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
        G.listeners = [];
        const root = document.getElementById('agar-root');
        if (root) root.remove();
        document.body.style.overflow = '';
        G.canvas = null;
        G.ctx = null;
        G.mini = null;
        G.miniCtx = null;
        G.me.cells = [];
        G.remotes.clear();
        G.bots = [];
        G.deadCells.clear();
        G.deadEjects.clear();
        G.recentFood.clear();
        G.recentVirus.clear();
        G.recentEats = [];
        G.recentEjectEaten = [];
        G.ejects = [];
        G.lobbyPlayers = [];
        G.lastFrame = 0;
        G.lastHud = 0;
        G.syncBusy = false;
        G.scale = 1;
    }

    function closeGame() {
        if (!G.open) return;
        teardown();
        // 通知宿主页面（index.html）回到首页
        try {
            window.dispatchEvent(new CustomEvent('agar:closed'));
        } catch (e) { /* ignore */ }
    }

    /* 入口：
     *   AgarArena.open({ mode:'bot', difficulty:'hard', name:'小明' })
     *   AgarArena.open({ mode:'online', room:'abcd1234', name:'小明' })
     */
    function openGame(opts) {
        if (G.open) return;
        const o = opts || {};

        G.mode = o.mode === 'online' ? 'online' : 'bot';
        G.room = String(o.room || 'lobby').trim() || 'lobby';
        G.difficulty = DIFFICULTY[o.difficulty] ? o.difficulty : 'normal';
        G.name = String(o.name || '玩家').slice(0, 12) || '玩家';
        G.color = colorFor(G.pid);
        G.phase = 'lobby';
        G.open = true;

        injectStyle();
        buildDom();
        bindInput();
        bindButtons();
        // 游戏是全屏遮罩，但底下的聊天输入框/房间号输入框可能还留着焦点，
        // 会让键盘事件全被输入框吃掉（W、空格都无反应），这里主动收回焦点。
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }
        // 人机模式每次开局都换一张地图，联机模式用房间号保证同房间同一张图
        buildWorld(G.mode === 'online' ? 'room:' + G.room : 'bot:' + Date.now());
        resize();
        document.body.style.overflow = 'hidden';
        updateOnlineLabel();

        if (G.mode === 'bot') {
            resetBots(G.difficulty);
            startPlaying();          // 人机模式没有大厅，直接开打
        } else {
            const sub = document.getElementById('agar-lobby-sub');
            if (sub) sub.textContent = '房间 ' + G.room + ' · 同房间的人可一起玩';
            renderLobby();
            startSync();
        }

        G.lastFrame = 0;
        G.raf = requestAnimationFrame(loop);
    }

    window.AgarArena = {
        open: openGame,
        close: closeGame,
        // 调试用：只读快照，方便本地测试脚本核对位移/速度
        _debug: function () {
            return {
                phase: G.phase,
                mouse: { x: Math.round(G.mouse.x), y: Math.round(G.mouse.y), on: G.mouse.on },
                aim: { x: Math.round(G.aim.x), y: Math.round(G.aim.y) },
                cam: { x: Math.round(G.cam.x), y: Math.round(G.cam.y) },
                scale: Math.round(G.scale * 100) / 100,
                eaten: G.eatenFood.size,
                myFood: G.myFood || 0,
                viruses: G.viruses.map(function (v) {
                    return { id: v.id, x: Math.round(v.x), y: Math.round(v.y), alive: !G.virusRespawn.has(v.id) };
                }),
                world: WORLD,
                ejects: G.ejects.map(function (e) { return { x: Math.round(e.x), y: Math.round(e.y), v: Math.round(Math.hypot(e.vx || 0, e.vy || 0)) }; }),
                cells: G.me.cells.map(function (c) {
                    return { x: Math.round(c.x), y: Math.round(c.y), m: Math.round(c.m * 10) / 10, speed: Math.round(c.speed) };
                })
            };
        },
        difficultyLabels: function () {
            return { easy: DIFFICULTY.easy.label, normal: DIFFICULTY.normal.label, hard: DIFFICULTY.hard.label };
        }
    };

    /* 兼容聊天室原有入口 window.openAgarGame()：
     * 不带参数时用当前聊天室房间开联机模式；
     * 传 { mode:'bot', difficulty:'hard' } 则开人机练习。
     */
    window.openAgarGame = function (opts) {
        if (G.open) return;
        const o = opts || {};
        let room = o.room || '';
        let name = o.name || '';
        try { if (!room && typeof currentRoomCode === 'string') room = currentRoomCode; } catch (e) { /* ignore */ }
        try { if (!name && typeof mySender === 'string') name = mySender; } catch (e) { /* ignore */ }
        openGame({
            mode: o.mode || (room ? 'online' : 'bot'),
            room: room || 'lobby',
            name: name || '玩家',
            difficulty: o.difficulty || 'normal'
        });
    };
})();
