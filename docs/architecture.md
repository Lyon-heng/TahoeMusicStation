# 架构与接口说明

> 本文档从发布包 `TahoeCore.exe`（PyInstaller / Python 3.12）中解包后，
> 通过提取 `server.pyc` 的常量与路由表整理而成，用于在原始 `.py`
> 源码丢失后指导后端重写。

## 进程模型

```
┌─────────────────────────────────────────────────┐
│  Tahoe音乐站.exe  (C++ / WebView2 无边框窗口壳)   │
│   └── 启动并托管 TahoeCore.exe                    │
└─────────────────────────────────────────────────┘
                  │
                  ▼  HTTP (无 TLS)
┌─────────────────────────────────────────────────┐
│  TahoeCore.exe  (Python 3.12 / stdlib http.server)│
│                                                  │
│  监听端口：                                       │
│    8613  HTTPS   局域网主入口（访客浏览器）        │
│    8614  HTTP    本机回环（C++ 窗口壳专用）        │
│    8615  HTTP    8614 被占用时顺延                │
│    8616  HTTP    继续顺延                         │
│    80    HTTP    可选：把 http://IP 302 跳到 8613 │
│                                                  │
│  出站：                                          │
│    https://music.163.com                         │
│    https://interface3.music.163.com/eapi         │
└─────────────────────────────────────────────────┘
```

- **本机判定**：请求来自回环地址 `127.0.0.1` 且无反向代头（`X-Forwarded-*`）
  时视为"机主"，免登录直接用本机账号；可设环境变量 `TAHOE_FORCE_PUBLIC=1`
  强制所有访问都登录。
- **会话**：Cookie 隔离每个访客会话；服务端维护一个会话表，LRU 淘汰最久未活动的访客。

## 路由表（前端 ↔ 代理）

所有路径前缀 `/api/` 或 `/weapi/` 由代理转发到网易云；其余路径直接服务 `web/` 静态文件。

| 路径 | 用途 |
|------|------|
| `GET  /` | 首页（`index.html`） |
| `GET  /api/session` | 当前会话 uid / 登录状态 |
| `POST /api/logout` | 退出登录，清会话 |
| `GET  /api/nuser/account/get` | 当前账号信息 |
| `GET  /api/login/qrcode/client/login` | 二维码登录轮询 |
| `GET  /api/qr/key` | 取二维码 unikey |
| `GET  /api/qr/img` | 取二维码图片（data URI） |
| `GET  /api/qr/check` | 检查扫码状态 |
| `GET  /api/search?s=...` | 全库歌曲搜索 |
| `GET  /api/playlists` | 账号全部歌单（第一条固定"我喜欢的音乐"） |
| `GET  /api/playlist?plid=...` | 单个歌单曲目；`plid` 为空即"我喜欢" |
| `GET  /api/liked` | "我喜欢的音乐"列表 |
| `GET  /api/songurl?ids=...` | 取播放地址（vip/无版权时返回提示） |
| `GET  /api/lyric?id=...` | 歌词（lv=1&kv=1&tv=-1） |
| `GET  /api/cover?id=...` | 封面图代理（同源下发，防 canvas 污染） |
| `GET  /api/cookie` / `POST /api/cookie` | 读写会话 cookie |
| `GET  /api/lan` / `GET /api/lan/qr` | 局域网二维码入口 |
| `GET  /api/scan` | 扫码相关 |
| `GET  /stream` | 音频流代理 |

对应的 weapi 通道（`/weapi/search/get`、`/weapi/song/like/get`、
`/weapi/v6/playlist/detail`、`/weapi/login/qrcode/*`）使用网易云
官方的 WeAPI AES-CBC + RSA 加密；PC 客户端风格的 EAPI 头同时进
加密载荷与 Cookie，用于在网页通道判死歌时救回播放地址。

## 安全 / 沙箱

- 出站 URL 白名单正则：
  `^https?://[A-Za-z0-9.-]+\.(music\.126\.net|music\.163\.com)/`
  以及 `interface3.music.163.com/eapi`；其余出站一律拒绝。
- API 路径白名单：`^/(api|weapi)/[\w/?=&%.\[\],:-]*$`。
- Cookie 下发带 `Path=/; HttpOnly; SameSite=Lax`。
- 自签证书仅用于局域网 HTTPS；窗口壳走纯 HTTP 回环，不碰证书。
- 80 端口只做 302 跳转，不服务任何文件，避免第二个攻击面。

## 前端要点

- `web/index.html`：入口，dusk 深色主题；SVG `feTurbulence + feDisplacementMap` 做液态玻璃边缘折射。
- `web/app.js`：播放管线、歌单拉取、登录态、壁纸由封面主色/模糊封面动态生成。
- `web/particles.js`：粒子视界背景。
- `web/assets/bg-*.webp`：6 张兜底壁纸（day / dusk / emerald-bay / tahoe-sand / tahoe-sierra / tahoe-zephyr）。
