# mplayer

基于 **Tauri 2 + HeroUI v3 + libmpv** 的 Windows 桌面视频播放器。

- 视频解码 / 渲染：原生 libmpv 嵌入到 Tauri 窗口（GPU 加速）
- 界面：React 19 + HeroUI v3 + Tailwind v4
- 状态管理：zustand
- 体积小、原生窗口、支持几乎所有主流视频/音频格式

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2.9 |
| 视频后端 | libmpv (mpv-2.dll) + `tauri-plugin-libmpv` 0.3.2 |
| 前端框架 | React 19 + Vite 7 + TypeScript 5.8 |
| UI 组件库 | HeroUI v3.0.5 |
| 样式 | Tailwind CSS v4 |
| 状态 | zustand 5 |
| 文件对话框 | `@tauri-apps/plugin-dialog` |
| 文件管理器集成 | `@tauri-apps/plugin-opener`（在资源管理器中显示） |

---

## 环境要求

- Windows 10 / 11
- [Node.js](https://nodejs.org/) ≥ 22
- [pnpm](https://pnpm.io/) ≥ 10（推荐通过 `npm i -g pnpm` 安装）
- [Rust toolchain](https://rustup.rs/)（首次编译时下载约 1GB 依赖）
- Microsoft Visual Studio C++ 构建工具（Rust 在 Windows 上需要 MSVC link.exe）

---

## 快速开始

### 方式一：双击启动

直接双击根目录下的 `start-dev.bat`：

```
start-dev.bat
```

脚本会自动：

1. 检查 `pnpm` / `cargo` 是否在 PATH
2. 缺失依赖时自动 `pnpm install`
3. 缺失 `libmpv-2.dll` 时自动从 GitHub Releases 下载并放入 `src-tauri/lib/`
4. 调用 `pnpm tauri dev` 启动开发服务

首次运行会编译大量 Rust crate，耗时约 3-10 分钟，属正常现象。

### 方式二：手动命令

```powershell
pnpm install
# 首次需要下载 libmpv DLL（约 100MB）
node .\node_modules\tauri-plugin-libmpv-api\dist-js\cli.cjs setup-lib
pnpm tauri dev
```

---

## 界面与交互

### 布局
- **顶栏 TopBar**：「打开文件」按钮 + 当前文件名 + 计数
- **主区 PlayerView**：视频画面（透明 webview 覆盖在 libmpv 渲染层之上）
- **右侧 PlaylistPanel**：常驻播放列表，固定宽度 280px；文件名过长时**自动横向滚动（marquee）**
- **底栏 ControlBar**：常驻播放控件（进度 / 播放控制 / 音量 / 倍速 / 音轨 / 字幕 / 全屏）

### 鼠标交互
| 区域 | 动作 | 行为 |
| --- | --- | --- |
| 视频画面 | 单击 | 播放 / 暂停（与双击通过 250ms 时间窗区分） |
| 视频画面 | 双击 | 切换全屏 |
| 视频画面 | 滚轮 | 调整音量 ±2 |
| 视频画面 | 拖入文件 | 加入播放列表，若原本为空则自动播放 |
| 进度条 | 鼠标悬停 | 显示该位置对应时间 |
| 进度条 | 拖动 | 实时预览，松手后 seek |
| 音量条 | 点击 / 拖动 | 实时设置 |
| 喇叭图标 | 单击 | 静音 / 取消静音 |
| 播放列表项 | 单击 | 仅选中（不切歌） |
| 播放列表项 | 双击 | 切换到该项播放 |
| 播放列表项 | 右键 | 弹出菜单：移到顶部 / 在文件夹中显示 / 从列表移除 |

### 键盘快捷键
| 按键 | 功能 |
| --- | --- |
| `Space` | 播放 / 暂停 |
| `←` / `→` | 后退 / 前进 5 秒 |
| **`Ctrl + ←` / `Ctrl + →`** | **单帧后退 / 前进** |
| `↑` / `↓` | 音量 ±5 |
| `F` 或 双击 | 切换全屏 |
| `M` | 静音切换 |
| `Esc` | 退出全屏 |

### 自动行为
- 打开多个文件时自动开始播放第一个
- 单个文件播放完毕自动播下一个（EOF 自动接续）
- 全屏 3 秒不动时控件与鼠标自动隐藏，移动鼠标恢复
- 关闭后再次打开同一文件，自动跳转到上次位置（每 5 秒持久化进度到 `localStorage`）
- 音量、静音、倍速跨会话记忆

---

## 支持的格式

得益于 libmpv（即 mpv 内核），支持几乎所有主流格式。「打开文件」对话框默认筛选：

- **视频**：mp4, mkv, webm, avi, mov, flv, m4v, wmv, ts, mpg, mpeg, rmvb
- **音频**：mp3, flac, wav, ogg, m4a, aac, wma, opus

> 通过「全部文件」过滤器可加载任意 libmpv 支持的格式（包括 hevc/av1 等）。

---

## 项目结构

```
mplayer/
├── start-dev.bat                 # 一键启动开发服务
├── README.md
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
│
├── src/                          # 前端
│   ├── main.tsx                  # 入口
│   ├── App.tsx                   # 三栏布局
│   ├── styles.css                # tailwind + heroui-styles + marquee
│   ├── components/
│   │   ├── TopBar.tsx
│   │   ├── PlayerView.tsx        # 透明视频区 + 单/双击 + 拖拽 + 滚轮
│   │   ├── ControlBar.tsx        # 底部常驻控件
│   │   ├── PlaylistPanel.tsx     # 右侧常驻播放列表
│   │   ├── PlaylistItem.tsx      # 列表项 + 右键菜单
│   │   ├── MarqueeText.tsx       # 长文件名横向滚动
│   │   ├── TrackMenu.tsx         # 音轨 / 字幕轨切换
│   │   └── KeyboardShortcuts.tsx # 全局快捷键
│   ├── hooks/
│   │   ├── useMpv.ts             # mpv 初始化、属性监听、播放控制
│   │   └── useVideoMargins.ts    # 同步 UI 占位到 mpv video-margin-ratio
│   ├── store/
│   │   └── playerStore.ts        # zustand 全局状态
│   └── lib/
│       ├── mpv.ts                # 业务命令封装
│       ├── persist.ts            # 进度 / 偏好持久化
│       └── format.ts             # 时间 / 路径格式化
│
└── src-tauri/                    # Tauri 后端
    ├── Cargo.toml                # tauri 2 + tauri-plugin-libmpv + dialog + opener
    ├── tauri.conf.json           # transparent: true, resources: lib/**
    ├── capabilities/default.json
    ├── lib/                      # 由 setup-lib 自动下载
    │   ├── libmpv-2.dll
    │   └── libmpv-wrapper.dll
    └── src/
        ├── main.rs
        └── lib.rs                # 注册三个插件
```

---

## 打包发布

测试通过后执行：

```powershell
pnpm tauri build
```

产物位于 `src-tauri/target/release/bundle/`：

- `msi/mplayer_0.1.0_x64_en-US.msi` — Windows Installer 安装包
- `nsis/mplayer_0.1.0_x64-setup.exe` — NSIS 安装程序

`src-tauri/lib/*.dll` 由 `tauri.conf.json` 的 `bundle.resources` 自动随包发布，最终安装包大小约 ~120MB（libmpv-2.dll 本身约 94MB）。

---

## 已知问题与限制

- 仅在 Windows 10/11 下完整测试。`tauri-plugin-libmpv` 的 Linux / macOS 嵌入式渲染仍处实验阶段。
- 首次 `pnpm tauri dev` 编译 Rust 依赖耗时较长，请耐心等待。
- 拖动进度条期间不会暂停播放（mpv 的 seek 命令本身已优化，体感不抖）；如需暂停-拖动-恢复行为可在 `ControlBar.tsx` 的 `handleProgressDown` 中扩展。

---

## 第三方依赖与鸣谢

- [nini22P/tauri-plugin-libmpv](https://github.com/nini22P/tauri-plugin-libmpv) — Tauri 2 的 libmpv 嵌入插件
- [zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild) — Windows 下的 libmpv-2.dll 构建
- [HeroUI v3](https://heroui.com/) — React UI 组件库
- [Tauri](https://tauri.app/) — 桌面应用框架

## License

MPL-2.0（与 `tauri-plugin-libmpv` 保持一致）
