/**
 * Supabase 国内反代服务
 *
 * 作用：把国内用户对 Supabase 的请求，通过 Render（国内可达的托管平台）中转过去，
 * 解决 Supabase 官方域名（Cloudflare 节点）在国内直连不可达的问题。
 *
 * 代理范围：
 *   - HTTP/HTTPS：REST API (/rest/v1)、Auth、Storage、Edge Functions (/functions/v1)
 *   - WebSocket：Realtime 实时订阅（wss  upgrade，聊天室消息推送依赖它）
 *
 * 部署：推到 GitHub 后在 Render 用 Blueprint 一键部署（见 render.yaml / README.md）
 */

const http = require('http');
const httpProxy = require('http-proxy');

const TARGET = process.env.SUPABASE_TARGET || 'https://nryaxymneqyakeykulzq.supabase.co';
const PORT = process.env.PORT || 3000;
// 防滥用密钥：前端仅在指向本反代时会带上该头；随机扫描/盗刷会被拒绝。
// 该值同时写在前端 app.js（PROXY_KEY），两处需保持一致；改的话两端一起改。
const PROXY_KEY = process.env.PROXY_KEY || 'harry-chat-2026';

const proxy = httpProxy.createProxyServer({
    target: TARGET,
    changeOrigin: true,
    ws: true,
    secure: true,
    // 不缓冲响应，保证 SSE / 流式 / WebSocket 实时性
    buffer: false,
});

proxy.on('error', (err, req, res) => {
    console.error('[proxy error]', err.code || '', err.message);
    // WebSocket 场景 res 是 socket，不能写 HTTP 响应
    if (res && typeof res.writeHead === 'function' && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy_unavailable', message: '反代服务暂时不可用，请稍后重试' }));
    } else if (res && res.destroy) {
        try { res.destroy(); } catch (e) { /* ignore */ }
    }
});

// 简易鉴权：只放行带正确 X-Proxy-Key 的请求，防止免费额度被刷爆
function authorized(req) {
    return req.headers['x-proxy-key'] === PROXY_KEY;
}

const server = http.createServer((req, res) => {
    if (!authorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', message: '缺少或错误的代理密钥' }));
        return;
    }
    // 透传时去掉代理密钥，避免污染上游
    const headers = Object.assign({}, req.headers);
    delete headers['x-proxy-key'];
    req.headers = headers;
    proxy.web(req, res, { target: TARGET });
});

// Supabase Realtime 走 WebSocket，必须单独处理 upgrade
server.on('upgrade', (req, socket, head) => {
    if (!authorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    proxy.ws(req, socket, head, { target: TARGET });
});

server.listen(PORT, () => {
    console.log(`Supabase proxy running on port ${PORT}`);
    console.log(`Upstream target: ${TARGET}`);
});
