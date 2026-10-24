# Supabase 国内反代

让国内用户**不挂 VPN** 也能用 Harry 的聊天室。

## 原理

```
国内用户 → 反代节点（国内可直连）→ Supabase 官方 API（海外，被墙）
```

聊天室前端原来直接连 `xxx.supabase.co`，该域名解析到 Cloudflare 节点，国内直连不通。
改为连反代后，请求经中转即可到达。

代理覆盖：REST API、Auth、Storage、Edge Functions（消息实时推送在反代模式下降级为前端轮询）。

## 两种部署方案

| 方案 | 是否需要信用卡 | 国内可达 | 支持 WebSocket(实时推送) | 推荐度 |
|---|---|---|---|---|
| **Netlify 边缘反代** | ❌ 不需要 | ✅ 实测可达 | ❌（降级为轮询） | ⭐ 首选（你没卡） |
| Render 长连接服务器 | ✅ 需要 | ✅ 实测可达 | ✅ | 有卡时再用 |

> 选 Netlify：免费、免信用卡、国内可达，消息靠前端轮询（已有兜底，登录/聊天完全正常，只是新消息延迟几秒到达）。
> 选 Render：有信用卡时可用，支持真正的实时推送。

---

## 方案一：Netlify 边缘反代（免信用卡，推荐）

### 部署步骤（约 5 分钟）

1. 打开 [app.netlify.com](https://app.netlify.com)，用 **GitHub** 登录
2. 右上 **Add new site** → **Import an existing project** → 选本 GitHub 仓库
3. 在配置页填：
   - **Base directory**：`netlify-proxy`
   - **Build command**：留空
   - **Publish directory**：留空（会自动用 `netlify-proxy/public`）
4. 点 **Deploy**，约 1 分钟得到地址 `https://<随机名>.netlify.app`

> Netlify 免费版（Starter）**不需要绑信用卡**。

### 切换到反代

打开 `web/app.js` 顶部（约第 6 行）：

```js
const SUPABASE_URL = 'https://nryaxymneqyakeykulzq.supabase.co';
```

改成你的 Netlify 地址，**注意末尾带 `/sb`**：

```js
const SUPABASE_URL = 'https://<随机名>.netlify.app/sb';
```

保存后提交到 GitHub main 分支，国内用户硬刷新即可生效。

前端只要检测到 `SUPABASE_URL` 不含 `supabase.co`，就自动：
- 给请求带上 `X-Proxy-Key` 头（对 Netlify 无害，仅 Node 反代需要）；
- 跳过 Realtime 的 WebSocket 连接，直接走轮询（含消息轮询 + 加房审批轮询）。

### 验证

```bash
# 应能看到 Netlify 的占位页（说明站点已上线）
curl -I https://<随机名>.netlify.app/

# 经反代访问 Supabase（返回 401 是正常的，说明缺 Supabase anon key，但链路通了）
curl -I https://<随机名>.netlify.app/sb/rest/v1/
```

---

## 方案二：Render 长连接服务器（需信用卡）

1. 登录 [render.com](https://render.com)（可用 GitHub 登录）
2. 右上 **New +** → **Blueprint**
3. 选本仓库，Root Directory 填 `supabase-proxy`，Apply
4. 部署完得到 `https://harry-chat-proxy.onrender.com`

> Render 免费版 15 分钟无流量会休眠，冷启动约 30-60 秒；有活跃连接期间不休眠。

再把 `web/app.js` 第 6 行改成：

```js
const SUPABASE_URL = 'https://harry-chat-proxy.onrender.com';
```

Render 方案支持 WebSocket，无需前端轮询降级。

---

## 通用注意事项

- **来回切换**：直连官方域名 ↔ 反代地址，前端会自动识别模式，互不影响。
- **Supabase 换项目**：改反代的目标地址（Netlify 改 `netlify.toml` 里的 `to`；Render 改环境变量 `SUPABASE_TARGET`），前端不用动。
- **改密钥**：仅 Render 方案用得到；要换 `PROXY_KEY` 需同时改 Render 环境变量、`server.js` 默认值、`web/app.js` 里的 `PROXY_KEY` 三处。
- 免费额度：Netlify 按请求计费、长期免费；Render 免费版每月 750 小时。
