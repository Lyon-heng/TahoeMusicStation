# Tahoe · 液态玻璃音乐台

一款 Windows 桌面端的网易云音乐第三方客户端：无边框液态玻璃风格窗口，本机起一个轻量代理服务完成 weapi/eapi 加密请求，扫码登录后即可搜索、播放、看歌词、管理歌单；同一服务开着时，手机/局域网内其他设备也能通过浏览器访问并各自登录自己的账号。

> 本项目为**非官方第三方客户端**，与网易公司 / 网易云音乐官方无关。使用时请遵守网易云音乐用户协议与相关法律法规，请勿用于商业用途或大规模爬取数据。

---

## 功能特性

- **液态玻璃窗口**：无边框、可拖动、可缩放、可最大化；SVG `feTurbulence + feDisplacementMap` 模拟玻璃边缘折射。
- **本机回环入口**：窗口通过 `127.0.0.1` 访问服务，不依赖证书信任，拷到任何电脑都不会弹"连接不是专用连接"。
- **扫码登录**：服务端代理网易云二维码登录流程，登录态按会话隔离。
- **多端共用**：软件开着时，局域网设备访问 `https://<电脑IP>:8613/` 即可使用，访客各自登录自己的账号。
- **搜索 / 歌单 / 歌词 / 封面**：全量 weapi/eapi 加密代理；封面图由服务端取回同源下发，避免 canvas 跨域污染。
- **壁纸联动**：登录后由歌单封面主色 / 模糊封面动态生成壁纸，6 张预置背景做兜底。

## 快速开始（普通用户）

前往 [Releases](../../releases) 下载最新发布的 `Tahoe音乐站.zip`（或单文件 exe）：

1. 解压到任意目录；
2. 双击 `Tahoe音乐站.exe`；
3. 首次启动 Windows 防火墙弹窗请点"允许"；
4. 窗口内点"登录"扫码即可。

> 需要系统已安装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Windows 11 已自带）。

## 从源码运行（开发者）

### 前端（可独立阅读/修改）

```bash
# 前端是纯静态文件，无需构建
cd web
# 任意静态服务器，例如：
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 注意：纯打开 `web/index.html` 只能看到界面，搜索/登录/播放需要后端代理（见下）。

### 后端代理

后端原始 `.py` 源码在本次仓库整理时已丢失，仅从发布用的 PyInstaller onefile 包中提取出了字节码存档（见 [`bytecode/`](bytecode/)）。后端的职责与路由表记录在 [docs/architecture.md](docs/architecture.md)，可供后续重写参考。

如需自行重建后端，至少需要实现：

- 一个 HTTP/HTTPS 服务器，监听 `8613`（局域网）+ 回环 `8614/8615/8616`（窗口专用）；
- 代理 `https://music.163.com` 与 `https://interface3.music.163.com/eapi` 的 weapi/eapi 加密请求；
- 会话/Cookie 管理、二维码登录、封面图代理、CORS 处理。

参考构建命令见 [`scripts/`](scripts/)。

## 项目结构

```
TahoeMusicStation/
├── web/                    # 前端源码（从发布包完整恢复）
│   ├── index.html          # 入口页面
│   ├── app.js              # 主逻辑（播放、歌单、登录、壁纸生成）
│   ├── style.css            # 样式（液态玻璃视觉）
│   ├── particles.js         # 粒子视界背景
│   └── assets/             # 壁纸与图标
│       ├── favicon.svg
│       └── bg-*.webp       # 6 张预置兜底壁纸
├── bytecode/               # 从 PyInstaller 包提取的 Python 字节码存档
│   ├── server.pyc          # 后端代理（Python 3.12 字节码）
│   └── _core_entry.pyc    # 入口（启动 server + 回环 HTTP）
├── scripts/                # 构建脚本参考
│   ├── build-core.bat      # 用 PyInstaller 打包后端
│   └── build-shell.bat     # C++ WebView2 窗口壳构建说明
├── docs/
│   └── architecture.md      # 后端路由、端口、协议说明
├── 使用说明.md              # 终端用户使用手册
├── README.md
├── LICENSE
└── .gitignore
```

## 构建发布物

> 以下命令来自原始发布包的构建笔记，仅供参考。原始 C++ 窗口壳源码（`TahoeShell.cpp`）与 Python 源码已丢失，完整复现需要补齐这两部分。

- 后端打包：见 [`scripts/build-core.bat`](scripts/build-core.bat)
- C++ 窗口壳：需要 Visual Studio Build Tools（C++ 桌面开发 + WebView2 SDK），见 [`scripts/build-shell.bat`](scripts/build-shell.bat)

## 状态说明

| 模块 | 状态 |
|------|------|
| 前端 `web/` | ✅ 完整恢复，可直接阅读与修改 |
| 后端 `server.py` | ⚠️ 仅存字节码（`bytecode/server.pyc`），原始 `.py` 已丢失 |
| 入口 `_core_entry.py` | ⚠️ 仅存字节码（`bytecode/_core_entry.pyc`） |
| C++ 窗口壳 `TahoeShell.cpp` | ❌ 已丢失，无法从 exe 恢复 |
| 发布用 exe | 📦 通过 GitHub Release 分发，不纳入 Git |

## License

[GPL-3.0](LICENSE)

> 本项目调用的网易云音乐接口版权归网易公司所有。本仓库代码仅作学习交流用途。
> 采用 GPL-3.0  copyleft：任何基于本项目的修改、衍生作品必须以相同协议开源，
> 不得闭源或商用后不回馈社区。
