# wqzachery.dpdns.org

吴谦（Zachery Wu）的个人网站：主页 + 公共网盘 + AI 助手 + 管理后台。纯手写 HTML / CSS / 原生 JavaScript，零依赖、零构建，跑在一个 Cloudflare Worker 上，月成本 $0。

🌐 https://wqzachery.dpdns.org

## 功能

- **主页**：开场动画、Apple 风格滚动动效、iOS 26 风格液态玻璃（Chromium 上用 SVG 位移贴图做真实折射，Safari 用磨砂兜底）。
- **底部液态玻璃标签栏**：主页 / 网盘 / AI 三个页面。玻璃透镜可以按住拖动，带弹簧、果冻拉伸和放大效果；透镜到位后页面才切换。
- **公共网盘**：不限大小、不限类型；浏览器直传 Hugging Face 存储（16MB 分片、4 路并发），失败自动走 Worker 中转；网格 / 列表视图、分类筛选、文件夹；图片、视频、音频、PDF、文本在线预览；下载与预览都经自有域名代理（支持 Range）；同一 IP 上传的文件显示相同颜色标记。
- **AI 助手**：默认 GPT-6 Astra（Workers AI），可切换 Nemotron 3 Ultra / Super、Laguna S 2.1、Gemma 4、Cohere North Mini（OpenRouter 免费模型）和 Llama 4 Scout；SSE 流式输出；繁忙时自动降级。
- **管理后台** `/admin`：今日访问与上传、30 天访问量 / 上传图表、访客地区与来源、每日上传明细、最近访问记录、文件管理（新建 / 重命名 / 移动 / 删除）、AI 对话记录。数据存在 Durable Object SQLite。

## 目录

| 路径 | 说明 |
|---|---|
| `site/app.html` | 外壳：三个页面 + 底部液态玻璃标签栏 |
| `site/index.html` | 主页 |
| `site/drive.html` | 网盘 |
| `site/ai.html` | AI 聊天 |
| `site/admin.html` | 管理后台 |
| `site/404.html` | 404 页面 |
| `worker/worker.js` | Worker：路由、AI、网盘 API、统计、Durable Object |
| `deploy/deploy_worker.sh` | 通过 Cloudflare API 部署 |
| `tools/lproxy.py` | 本地预览：页面读本地文件，`/api` 转发到线上 |

## 部署

需要的 Worker secrets：`HF_TOKEN`（Hugging Face 写权限）、`ADMIN_KEY`（后台密钥）、`OPENROUTER_KEY`（可选）。绑定：Workers AI、Durable Object `Store`、两个 rate limit。

```bash
HF_REPO=<hf用户>/<数据集> deploy/deploy_worker.sh <worker名>
```

首次部署加 `MIGRATE=1` 创建 Durable Object。

## License

MIT
