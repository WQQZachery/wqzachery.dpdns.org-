# wqzachery.dpdns.org

吴谦（Zachery Wu）的个人网站：主页 + 公共网盘 + AI 助手 + 实时聊天室 + 管理后台。纯手写 HTML / CSS / 原生 JavaScript，零依赖、零构建，跑在一个 Cloudflare Worker 上，在 Cloudflare / Hugging Face 免费套餐内运行。

🌐 https://wqzachery.dpdns.org · 隐私说明 https://wqzachery.dpdns.org/privacy

## 功能

- **主页**：开场动画、滚动动效、iOS 26 风格液态玻璃（Chromium 上用 SVG 位移贴图做真实折射与色散，Safari / Firefox 用磨砂兜底）；首屏四个入口卡片；首页数字来自 `/api/stats`（上线天数、功能数、网盘文件数）。
- **底部液态玻璃标签栏**（`site/app.html`）：主页 / 网盘 / AI / 聊天四个页面（同源 iframe）。透镜可拖动，弹簧 + 果冻形变；透镜到位后页面才切换。玻璃层 `#glass` 与透镜 `#lens` 是兄弟元素，这样透镜的 backdrop 能取到页面内容（嵌套在带 backdrop-filter 的元素里会变成 "backdrop root"，看不到页面）。
- **公共网盘**：浏览器算 SHA-256 → `/api/up/init` → 直传 Hugging Face S3（16 MB 分片 ×4 并发，失败走 Worker 中转）→ `/api/up/finish`。单文件 ≤ 2 GB；每个 IP 每天（北京时间）≤ 5 GB / 50 个；按扩展名 + 文件头（MZ、ELF、Mach-O、#!、deb/rpm、APK/JAR/IPA）拒绝可执行文件、安装包和脚本，服务端在 init、中转和 finish（读取已上传对象的前 64 KB）三处检查。举报、在线预览（图片/视频/音频/PDF/文本，HTML/SVG 一律按纯文本显示）、文件夹、分页（每页 60 个）、懒加载缩略图。多文件最多 3 个同时上传，单个失败可单独重试；上传按钮可用键盘操作；新建文件夹用站内对话框。
- **AI 助手**：默认 GPT-6 Astra（Workers AI），可切换 OpenRouter 免费模型和 Workers AI 上的其他模型；SSE 流式输出；可联网搜索（Bing + 中文维基）；思考强度四档。服务端白名单校验模型和思考强度；每个 IP 同时只能生成一条；每 IP 每天默认 200 次。对话历史只保存在本机浏览器（最多 50 段，可在「历史」里删除，不跨设备）；回答可复制、失败可重试、最后一条可重新生成。
- **聊天室**：WebSocket + Durable Object（Hibernation API）。大厅保留最近 100 条，每段私信最近 50 条；私信只推送给双方。
- **管理后台** `/admin`（noindex）：访问 / 上传统计、文件管理、AI 对话、聊天室、待处理举报（删除文件 / 忽略）。后台密钥常数时间比较；同一 IP 15 分钟内输错 5 个不同密钥即锁定 15 分钟。

## 目录

| 路径 | 说明 |
|---|---|
| `site/app.html` | 外壳：四个页面 + 底部液态玻璃标签栏 |
| `site/index.html` / `drive.html` / `ai.html` / `chat.html` | 主页 / 网盘 / AI / 聊天室 |
| `site/admin.html` | 管理后台 |
| `site/privacy.html` | 隐私说明（也以弹窗形式嵌入各页） |
| `site/shared.css` / `shared.js` | 公共设计变量、液态玻璃、隐私弹窗、JS 拼装邮箱；Worker 以 `?v=<内容哈希>` 长缓存 |
| `site/404.html`、`site/og.png` | 404 页、分享图 |
| `worker/worker.js` | Worker：路由、AI、网盘 API、统计、Durable Object `Store` |
| `wrangler.jsonc` / `package.json` / `tools/build_worker.sh` | Workers Builds 自动部署配置与构建脚本 |
| `deploy/deploy_worker.sh` | 通过 Cloudflare API 手动部署（multipart 上传脚本 + 文本模块） |
| `tools/` | 本地预览与测试脚本（见下） |

## 路由

页面：`/` `/drive` `/ai` `/chat`（外壳）、`/p/home` `/p/drive` `/p/ai` `/p/chat`（单页）、`/privacy`、`/admin`、`/robots.txt`、`/sitemap.xml`、`/llms.txt`、`/og.png`、`/shared.css`、`/shared.js`。

公开 API：`GET /api/models`、`GET /api/stats`、`GET /api/limits`、`POST /api/chat`、`GET /api/files`、`POST /api/folders`、`POST /api/up/init`、`PUT /api/up/part`、`POST /api/up/finish`、`GET /api/files/raw/<path>[?dl=1]`、`GET /api/files/url/<path>`、`POST /api/report`、`GET /api/chat/ws`（WebSocket）。

管理 API（请求头 `x-admin-key`）：`/api/admin/check|stats|sessions|session|analyze|chat|reports`、`DELETE /api/files/dl/<path>`、`DELETE /api/folders`、`POST /api/move`、`POST /api/rename`、`DELETE /api/chat/msg`、`GET /api/search`。

## 数据存储

- **Hugging Face 私有数据集**：网盘文件（`files/<文件夹>/<日期>-<随机>-<文件名>`，LFS）。
- **Durable Object `Store`（SQLite）**表：`msgs`（AI 对话）、`ana`（对话分析）、`hits`（访问）、`ups`（上传者）、`chat` / `chat_leave`（聊天室）、`auth_fail`（后台密钥错误，15 分钟）、`ai_use`（AI 次数/并发，约 7 天清理）、`upq`（上传额度与上传会话，约 3 天清理）、`reports`（举报）。新表都用 `CREATE TABLE IF NOT EXISTS` 创建，不需要新的 DO 迁移。

## 环境变量与绑定（只列名称）

- Secrets：`HF_TOKEN`、`ADMIN_KEY`、`OPENROUTER_KEY`（可选）、`GEMINI_KEY`（可选，目前未启用）。
- Plain text：`HF_REPO`、`AI_MODELS`、`GEMINI_MODELS`、`CAP_LABEL`、`AI_DAILY_CAP`（默认 200，0 = 不限）、`UP_MAX_FILE`（字节，默认 2 GiB）、`UP_DAY_BYTES`（默认 5 GiB）、`UP_DAY_FILES`（默认 50）。
- 绑定：Workers AI `AI`、Durable Object `STORE`（类 `Store`）、rate limit `CHAT_RL`、`UP_RL`。

## 部署

**自动部署**：推送到 `main` 分支后，Cloudflare Workers Builds 自动构建并部署 Worker `wqzachery`（构建命令 `npm run build` → `tools/build_worker.sh` 把 `worker/worker.js` 和页面文件平铺复制到 `dist/`；部署命令 `npx wrangler deploy`，配置见 `wrangler.jsonc`）。Secrets 只在 Cloudflare 后台设置，部署时保留；自定义域名不在配置里声明，wrangler 不会改动。只构建 `main`，其他分支不生成预览。

**手动部署（备用）**：

```bash
HF_REPO=<hf用户>/<数据集> [AI_DAILY_CAP=200] [UP_DAY_FILES=50] deploy/deploy_worker.sh <worker名>
```

首次部署（还没有 Durable Object 时）加 `MIGRATE=1`；已经部署过的 Worker **不要**再加。

## 测试

| 命令 | 内容 |
|---|---|
| `python3 tools/lproxy.py` | 本地预览 :8766，页面读本地文件，`/api` 转发到线上（`UP=` 指定目标） |
| `node tools/unit_test.mjs` | 文件名清洗、禁止类型、文件头识别、常数时间比较 |
| `python3 tools/sec_test.py <base> neg\|quota N\|full\|lockout` | 上传限制、403、AI 白名单与并发、举报、锁定（lockout 会锁定当前 IP 15 分钟） |
| `BASE=<base> python3 tools/chat_test.py` | 聊天室协议（含私信隔离） |
| `python3 tools/scroll_perf.py <local> 1 base /p/home,/` | 滚动帧率（Chromium、4× CPU 降速） |
| `python3 tools/bar_refr.py <label>` | 标签栏折射/色散证据截图 |
| `python3 tools/mobile_check.py` | 360–1280 宽度横向溢出、触控目标、可访问名称 |
| `python3 tools/ui_check.py` | 网盘错误/重试、上传拒绝、举报、隐私弹窗、首页入口与统计 |
| `python3 tools/link_check.py <base>` | 全站链接检查 |
| `python3 tools/syntax_check.py` | 所有内联脚本与 worker.js 语法检查（node --check） |
| `MPORT=8768 python3 tools/mock_api.py` + `PORT=8767 UP=http://127.0.0.1:8768 python3 tools/lproxy.py` | 本地模拟 API（不调用真实 AI / 存储），供下面的浏览器测试使用 |
| `python3 tools/ai_persist_test.py` | AI 本地历史（关闭重开、多会话、删除）、复制、重试、重新生成、中断、保存失败提示、读屏 |
| `python3 tools/drive_test.py [up\|mk]` | 网盘纯键盘上传、≤3 并发、单个失败与重试、拖放、新建文件夹对话框 |
| `python3 tools/tab_test.py` | 标签切换：慢加载提示、失败与重新加载、快速切换无重复请求 |
| `python3 tools/boot_timing.py <base>` | 开场动画：首次 / 7 天内回访 / 减少动态效果 / 点击跳过 的耗时 |
| `python3 tools/favicon_check.py` | 各页面图标声明与 /favicon.* 响应 |
| `python3 tools/contrast_check.py` | 实际渲染文字与背景的 WCAG 对比度 |

## 常见问题

- **标签栏没有折射**：只在 Chromium 内核（Chrome / Edge / 三星等）启用；需要 `CSS.supports('backdrop-filter','url(#x)')`。Safari / Firefox 是磨砂兜底，属正常。
- **上传提示"今日额度已用完"**：同一 IP 当天已到 5 GB 或 50 个，北京时间 0 点重置；可用 `UP_DAY_*` 调整。
- **后台提示"错误次数过多"**：等 15 分钟（或换网络）。
- **网盘列表加载失败**：多半是 `HF_TOKEN` 失效或 Hugging Face 暂时不可用。

## License

MIT
