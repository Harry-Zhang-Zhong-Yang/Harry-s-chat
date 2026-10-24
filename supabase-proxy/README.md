# Supabase 国内反代

让国内用户**不挂 VPN** 也能用 Harry 的聊天室。

## 原理

```
国内用户 → Render（新加坡节点，国内可达）→ Supabase 官方 API（海外）
```

聊天室前端原来直接连 `xxx.supabase.co`，该域名解析到 Cloudflare 节点，国内直连不通。
改为连本反代后，请求经 Render 中转即可到达。

代理覆盖：REST API、Auth、Storage、Edge Functions，以及 **Realtime 的 WebSocket**（消息实时推送靠它）。

## 部署（Render，免费，约 5 分钟）

1. 注册 / 登录 [render.com](https://render.com)（可用 GitHub 账号直接登录）
2. 右上 **New +** → **Blueprint**
3. 选择包含本目录的 GitHub 仓库，Root Directory 填 `supabase-proxy`
4. Apply，等待部署完成（约 1-2 分钟）
5. 部署完会得到一个地址，形如 `https://harry-chat-proxy.onrender.com`

> Render 免费版 15 分钟无流量会休眠，下次首个请求需约 30-60 秒冷启动；
> 有活跃 WebSocket 连接期间不会休眠，聊天过程中无感。

## 部署后要做的（关键）

把反代地址填进前端。打开 `web/app.js`，找到顶部这几行：

```js
const SUPABASE_URL = 'https://nryaxymneqyakeykulzq.supabase.co';
```

改成你的 Render 地址：

```js
const SUPABASE_URL = 'https://harry-chat-proxy.onrender.com';
```

保存后提交到 GitHub main 分支，用户硬刷新即可生效。

前端只在检测到 `SUPABASE_URL` 不是官方域名时，才会自动带上 `X-Proxy-Key` 请求头；
保持直连官方地址时不会带，所以两种模式可以随时来回切换，互不影响。

## 验证

```bash
# 不带密钥应返回 401
curl -i https://你的地址.onrender.com/rest/v1/

# 带密钥应能透传到 Supabase（返回 401 是正常的，说明缺少 Supabase anon key）
curl -i -H "X-Proxy-Key: harry-chat-2026" https://你的地址.onrender.com/rest/v1/
```

## 注意事项

- **改密钥**：若需更换 `PROXY_KEY`，要同时改三处——Render 环境变量、`server.js` 默认值、`web/app.js` 里的 `PROXY_KEY`。
- **Supabase 换项目**：改 Render 环境变量 `SUPABASE_TARGET` 即可，前端不用动。
- 免费额度：Render 免费版每月 750 小时，单服务够用；密钥机制就是防止被扫描刷爆。
