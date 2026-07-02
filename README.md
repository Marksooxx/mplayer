# mplayer

基于 **Tauri 2 + HeroUI v3 + libmpv** 的 Windows 桌面视频播放器。

- 视频解码 / 渲染：原生 libmpv 嵌入到 Tauri 窗口（GPU 加速，几乎全格式覆盖）
- 界面：React 19 + HeroUI v3 + Tailwind v4，Lucide 矢量图标
- 音频波形：Rust `symphonia` 离线解码 peaks + `wavesurfer.js` 渲染
- 状态：zustand，UI 设置 + 播放进度 + 自定义快捷键全部持久化
- 体积小、原生窗口、纯 Rust + WebView2，无 Chromium 进程

---

## 功能一览

- 播放列表（常驻右侧，280px，可折叠；长文件名 marquee 滚动；右键菜单移到顶部 / 在文件夹中显示 / 移除；选中项 `Delete` 直接删除并停止当前播放；4 种排序模式可切换）
- 底部常驻控件：上一首 / 单帧后退 / 播放暂停 / 单帧前进 / 下一首 / 时间 / 进度条 / 音量（百分比显示，**Ctrl+点击恢复 80%**）/ 倍速 / 音轨 / 字幕 / 波形 toggle / 播放列表切换 / 设置 / 全屏
- 底部音频波形条（可关，控件区直接切换）：Rust `symphonia` 解码所有 mpv 支持格式的音轨，wavesurfer.js 渲染条柱，光标随 mpv `time-pos` 同步，点击 seek
- 顶栏文件名条：默认悬浮显示（鼠标到顶部时浮现，2.5s 后淡出），可在设置中切换为"永久隐藏"
- 字幕：**拖入 .srt/.ass/.ssa/.sub/.vtt/.idx/.smi/.sup 自动加载并激活**；字幕菜单里可手动「加载字幕文件…」+ 字幕延迟 ±100ms 精调与重置
- 跳转到指定帧（`Ctrl+F` 弹窗输入）：显示当前文件帧率 / 当前帧 / 总帧数，回车精确跳转
- 时间码 / 帧号 OSD（`T` 或设置内开关）：视频区左上角实时显示毫秒级时间 + 当前帧号，与进度条 / 波形光标同一时钟源，帧级检查 / 对轨专用
- 同步误差监视器（`Ctrl+Shift+D`，调试用）：实时显示 UI 光标相对 mpv 时钟的残差（ms）、5s 统计、事件频率
- 全自定义快捷键：19 个动作可在设置面板逐条录键 / 清除 / 恢复默认
- 三档跳转：裸键 ±5 秒（粗）/ Shift+←/→ ±N 帧（中，N 设置内 1-100 可调）/ Ctrl+←/→ ±1 帧（细）
- 记忆每个文件的上次播放位置（短文件、近末尾、自然播完都不 resume；可一键清空）
- 倍速 / 音量 / 静音跨会话保存
- 拖入文件 / 多选打开 / 自动播下一首 / **全屏顶/底独立 edge-reveal**（鼠标推到顶部显示文件名，推到底部显示进度+波形；3s 不动隐藏鼠标）
- 设置默认播放器：MSI/NSIS 安装时自动注册 .mp4/.mkv 等 21 种后缀到 Windows「默认应用」/「打开方式」
- 单实例：双击多个文件不会开新进程，已开窗口接收路径并追加播放
- 播放列表导入导出：M3U8 格式，与 VLC / mpv / Potplayer 互通

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2.11 |
| 视频后端 | libmpv (`libmpv-2.dll`) + `tauri-plugin-libmpv` 0.3.2 |
| 音频波形解码 | `symphonia` 0.5（Rust，全 codec） |
| 音频波形渲染 | `wavesurfer.js` 7.12 |
| 前端框架 | React 19 + Vite 7 + TypeScript 5.8 |
| UI 组件库 | HeroUI v3.0.5（仅 Button，其余自实现） |
| 图标 | `lucide-react` |
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`） |
| 状态 | zustand 5 |
| 持久化 | `tauri-plugin-store`（`%APPDATA%\dev.mark.mplayer\store.json` 人可读 JSON） |
| 单实例 | `tauri-plugin-single-instance`（双击转发文件路径） |
| 文件对话框 | `@tauri-apps/plugin-dialog` |
| 文件读取（peaks 输入） | `@tauri-apps/plugin-fs` + Tauri `asset://` 协议 |
| 文件管理器集成 | `@tauri-apps/plugin-opener`（`revealItemInDir`） |

> 完整技术决策、模块切分、数据流和踩坑总结见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 环境要求

- Windows 10 / 11
- [Node.js](https://nodejs.org/) ≥ 22
- [pnpm](https://pnpm.io/) ≥ 10（`npm i -g pnpm`）
- [Rust toolchain](https://rustup.rs/)（首次编译需下载 ~1GB 依赖）
- Microsoft Visual Studio C++ 构建工具（Rust 在 Windows 上需要 MSVC link.exe）

---

## 快速开始

### 方式一：双击启动

直接双击根目录下的 `start-dev.bat`：

```
start-dev.bat
```

脚本会自动：

1. 通过 PowerShell 加载用户 profile（fnm 激活 node，pnpm / cargo 进入 PATH）
2. 检查 `node` / `pnpm` / `cargo` 三者是否就位
3. 缺失 `node_modules` 时自动 `pnpm install`
4. 缺失 `libmpv-2.dll` 时自动调 `setup-lib` 从 GitHub Releases 下载到 `src-tauri/lib/`
5. 调用 `pnpm tauri dev`

> `start-dev.bat` 仅是轻量入口，真正的逻辑在 `start-dev.ps1`。这样设计是因为双击 `.bat` 启动的 `cmd.exe` 不会跑 PowerShell profile，`fnm` 管理的 node 路径不会在 PATH 里。

首次运行需要编译 Rust 依赖，耗时 3-10 分钟，属正常现象。

### 方式二：手动命令

```powershell
pnpm install
# 首次运行：下载 libmpv DLL（约 100MB）
node .\node_modules\tauri-plugin-libmpv-api\dist-js\cli.cjs setup-lib
pnpm tauri dev
```

---

## 界面与交互

### 布局
- **TopBar（浮层）**：顶部 60px 触发区悬停时浮现文件名 + 打开按钮，2.5s 不动后淡出。不挤占视频区。
- **PlayerView（主区）**：透明区，mpv 子窗口在其后渲染视频。空闲态 / 加载态用 React 不透明遮罩兜底。
- **PlaylistPanel（右侧 280px）**：常驻；折叠后释放空间给视频。
- **WaveformStrip（56px）**：ControlBar 上方常驻波形条，可在设置里关闭。
- **ControlBar（底部 ~60px）**：播放控件 + 音量 + 倍速 + 轨道 + 列表 / 设置 / 全屏。

### 鼠标交互
| 区域 | 动作 | 行为 |
| --- | --- | --- |
| 视频画面 | 单击 | 播放 / 暂停（与双击通过 250ms 时间窗区分） |
| 视频画面 | 双击 | 切换全屏 |
| 视频画面 | 滚轮 | 调整音量 ±2 |
| 视频画面 | 拖入媒体文件 | 加入播放列表，若原本为空则自动播放 |
| 视频画面 | 拖入字幕文件 | `.srt/.ass/.ssa/.sub/.vtt/.idx/.smi/.sup` 直接 `sub-add select` 加载到当前播放 |
| 进度条 | 鼠标悬停 | 显示该位置对应时间 |
| 进度条 | 拖动 | 实时预览，松手 seek |
| 音量条 | 点击 / 拖动 | 乐观 UI + rAF 节流 IPC，无延迟感 |
| 音量条 | **Ctrl + 点击** | **恢复音量到 80% 并取消静音** |
| 喇叭图标 | 单击 | 静音 / 取消静音 |
| 波形条 | 点击 | 跳转到该位置（同 mpv `seek absolute`） |
| 播放列表项 | 单击 | 仅选中（不切歌） |
| 播放列表项 | 双击 | 切换到该项播放 |
| 播放列表项 | 右键 | 弹出菜单：移到顶部 / 在文件夹中显示 / 从列表移除 |
| 播放列表项 | **选中 + Delete** | **从列表删除；若是当前播放则同步停止 mpv 播放** |
| 播放列表标题栏 | 排序按钮 | 4 种排序：默认（添加顺序） / A→Z / Z→A / 按路径分组 |

### 键盘快捷键（可在设置中重新绑定）
| 按键 | 默认功能 |
| --- | --- |
| `Space` | 播放 / 暂停 |
| `←` / `→` | 后退 / 前进 5 秒 |
| **`Shift + ←` / `Shift + →`** | **多帧后退 / 前进**（默认 3 帧，1-100 可调） |
| **`Ctrl + ←` / `Ctrl + →`** | **单帧后退 / 前进** |
| **`Ctrl + F`** | **跳转到指定帧号**（弹窗输入） |
| **`T`** | **时间码 / 帧号 OSD 切换**（左上角毫秒级时间 + 帧号） |
| `↑` / `↓` | 音量 ±5 |
| `PageUp` / `PageDown` | 上一个 / 下一个视频 |
| **`Ctrl + Enter`** 或 双击 | 切换全屏 |
| **`Ctrl + T`** | **窗口置顶切换**（小窗看视频常用） |
| **`Ctrl + R`** | **播放模式切换**：列表循环 → 单曲循环 → 随机播放 |
| `M` | 静音切换 |
| `Esc` | 退出全屏 |
| `Ctrl + Shift + D` | 同步误差监视器（调试工具，显示光标 vs mpv 时钟残差） |

> 设置 → 「键盘快捷键」可逐条录键 / 清除 / 恢复默认。同一组合键绑到多个动作时旧动作自动清空。

### 自动行为
- 打开多个文件 → 自动开始播放第一个
- 单文件播完 → 自动播下一首（EOF 接续）；列表末尾停止
- 全屏 **edge-reveal**：鼠标进入顶部 80px 显示 TopBar，进入底部 140px 显示进度+波形+控件；离开立即隐藏。两区独立，不相互打扰。3 秒不动还会隐藏鼠标光标
- 关闭后再次打开同一文件 → 跳转到上次位置（每 5 秒持久化进度；短视频 / 末尾 / 已播完不 resume）
- 音量、静音、倍速跨会话记忆
- 拖入媒体文件 → 加入播放列表；拖入字幕文件 → 直接挂载到当前播放
- 每次启动**清空播放列表**（避免无用上次列表残留；如需保存请用列表面板顶栏的 💾 导出 M3U8）

---

## 设置面板

底部 ControlBar 上的 ⚙ 按钮打开。

### 界面
- **顶部文件名条悬浮显示**（默认开）：鼠标进入顶部 60px 触发区时浮现，离开后 2.5s 淡出
- **完全隐藏顶部文件名条**：彻底关闭顶栏浮层
- **显示底部音频波形条**（默认开）：关闭后释放 56px 空间给视频
- **显示 L/R 文件级峰值**（默认开）：ControlBar 时间右侧整文件 dBFS 峰值，判断削波风险
- **显示时间码 / 帧号 OSD**（默认关）：视频区左上角毫秒级时间 + 当前帧号；快捷键 `T` 随时切换，状态持久化

### 播放
- **记忆每个文件的上次播放位置**（默认开）：再次打开同一文件时自动跳转
- **清空已保存的播放进度**：实时显示当前条数，一键清空 localStorage 里所有进度记录
- **Shift+←/→ 步进帧数**：数字输入（1-100，默认 3），裸键 ±5 秒 与 Ctrl ±1 帧 的中间档

### 键盘快捷键
- 19 个动作每行一个按钮显示当前绑定；点击 → 进入录键模式 → 下一次 keydown 写入新绑定（Esc 取消）
- `×` 清除单个绑定（动作不响应任何键，但 ControlBar 按钮照用）
- 「恢复默认」一键重置所有绑定

---

## 支持的格式

得益于 libmpv 内核，几乎所有主流格式都能播。「打开文件」对话框默认筛选：

- **视频**：mp4, mkv, webm, avi, mov, flv, m4v, wmv, ts, mpg, mpeg, rmvb
- **音频**：mp3, flac, wav, ogg, m4a, aac, wma, opus

> 通过「全部文件」过滤器可加载任何 libmpv 支持的容器 / 编码。

---

## 项目结构

```
mplayer/
├── start-dev.bat / start-dev.ps1     # 一键启动开发服务
├── README.md
├── ARCHITECTURE.md                   # 技术架构 + 决策 + 踩坑
├── package.json / pnpm-lock.yaml
├── vite.config.ts / tsconfig.json
├── index.html
│
├── src/                              # 前端
│   ├── main.tsx                      # 入口（无 StrictMode）
│   ├── App.tsx                       # 顶层布局
│   ├── styles.css                    # tailwind + heroui-styles + marquee 动画
│   ├── components/
│   │   ├── TopBar.tsx                # 顶部浮层文件名条
│   │   ├── PlayerView.tsx            # 透明视频区 + 单/双击 + 拖拽 + 滚轮
│   │   ├── ControlBar.tsx            # 底部常驻控件
│   │   ├── WaveformStrip.tsx         # 波形可视化
│   │   ├── PlaylistPanel.tsx         # 右侧常驻列表
│   │   ├── PlaylistItem.tsx          # 列表项 + marquee + 右键菜单
│   │   ├── MarqueeText.tsx           # 通用长文本横向滚动
│   │   ├── TrackMenu.tsx             # 音轨 / 字幕轨切换
│   │   ├── SettingsPanel.tsx         # 设置 modal（含快捷键编辑器）
│   │   ├── GotoFrameDialog.tsx       # Ctrl+F 跳转帧弹窗
│   │   ├── TimecodeOsd.tsx           # T 键切换：毫秒时间码 + 帧号 OSD
│   │   ├── SyncDebugOverlay.tsx      # Ctrl+Shift+D：光标同步误差监视器
│   │   └── KeyboardShortcuts.tsx     # 全局快捷键派发器
│   ├── hooks/
│   │   ├── useMpv.ts                 # mpv init / observers / playIndex
│   │   ├── useCursorAnimation.ts     # 虚拟播放头单例（rAF + 时钟从动）
│   │   └── useVideoMargins.ts        # 状态驱动 mpv video-margin-ratio
│   ├── store/
│   │   ├── playerStore.ts            # 播放器全局状态
│   │   └── settingsStore.ts          # UI 设置 + 快捷键绑定
│   └── lib/
│       ├── mpv.ts                    # mpv 命令封装（setPaused/togglePause/seek/frameStepBy 等）
│       ├── shortcuts.ts              # ShortcutAction 枚举 + 标签 + 默认绑定 + combo 工具
│       ├── persist.ts                # 进度 + 设置 localStorage 读写
│       └── format.ts                 # 时间 / 路径格式化
│
└── src-tauri/                        # Tauri 后端
    ├── Cargo.toml                    # tauri 2 + tauri-plugin-libmpv + symphonia + plugins
    ├── tauri.conf.json               # transparent:true / asset 协议 / bundle.resources
    ├── capabilities/default.json     # 显式 fullscreen / fs / opener 权限
    ├── build.rs                      # 编译时复制 DLL 到 target/<profile>/
    ├── lib/                          # 由 setup-lib 下载
    │   ├── libmpv-2.dll
    │   └── libmpv-wrapper.dll
    └── src/
        ├── main.rs
        ├── lib.rs                    # plugin 注册 + invoke_handler
        └── peaks.rs                  # symphonia 离线 peaks 计算 (Tauri command)
```

---

## 打包发布

```powershell
pnpm tauri build
```

产物位于 `src-tauri/target/release/bundle/`：

- `msi/mplayer_0.1.0_x64_en-US.msi` — Windows Installer
- `nsis/mplayer_0.1.0_x64-setup.exe` — NSIS 安装程序

`src-tauri/lib/*.dll` 由 `tauri.conf.json` 的 `bundle.resources` 自动随包发布；最终安装包约 ~120MB（其中 `libmpv-2.dll` ~94MB）。

---

## 配置文件位置

所有用户偏好和播放进度都保存在：

```
%APPDATA%\dev.mark.mplayer\store.json
```

人可读 JSON，三个顶层键：
- `ui` — UI 偏好（面板状态、波形开关、记忆位置开关、单帧步进数、快捷键绑定）
- `player` — 播放器偏好（音量 / 静音 / 倍速）
- `positions` — 每文件上次播放位置 `{ "D:\\xxx.mp4": 137 }`

**首次升级**会自动把旧版本残留在 WebView2 localStorage 里的同名键迁移过来并删除原值。

> 想跨电脑同步设置？直接拷贝这个 `store.json` 即可。播放列表**不会**自动持久化（关掉就清空），如需保存请在播放列表面板头部点 💾 导出 `.m3u8`。

---

## 设默认播放器

### 安装版（MSI / NSIS）
安装后扩展名已注册到系统：
```
设置 → 应用 → 默认应用 → 按文件类型选默认应用 → 找 .mp4 → 选 mplayer
```
或右键任意 .mp4 → 打开方式 → mplayer。

### 绿色版
1. 把 `mplayer.exe` + `libmpv-2.dll` + `libmpv-wrapper.dll` 三个文件拷到一个**稳定路径**（如 `D:\Apps\mplayer\`）
2. 右键 .mp4 → 打开方式 → 选择其他应用 → 在这台电脑上选择应用 → 找到刚才的 `mplayer.exe`
3. 勾选「始终使用此应用打开 .mp4 文件」

> ⚠️ **绿色版不能移动文件夹**：Windows 关联会指向旧路径。要换位置就重新关联一次。三个文件必须**同目录**。

---

## 已知限制

- 仅在 Windows 10/11 完整测试。`tauri-plugin-libmpv` 的 Linux / macOS 嵌入式渲染仍处实验阶段。
- 首次 `pnpm tauri dev` 编译 Rust 依赖耗时较长。
- 拖动进度条期间不会暂停播放（mpv `seek` 已做关键帧优化，体感不抖）。
- **资源管理器多选 ≥ 16 个文件按 Enter 没反应**：Windows Shell 对传统 desktop 应用触发"默认动词"有数量上限（注册表 `MultipleInvokePromptMinimum`，默认 15）；VLC / MPC-HC / PotPlayer 同样受此限制。
  - **快速绕开**：直接把文件拖入 mplayer 窗口（`onDragDropEvent`，无数量限制）。
  - **永久修复**：根目录运行 `raise-explorer-multi-limit.ps1`，把阈值提到 100。
    ```powershell
    .\raise-explorer-multi-limit.ps1            # 提到 100，询问后重启 Explorer
    .\raise-explorer-multi-limit.ps1 -Value 200 # 自定义
    .\raise-explorer-multi-limit.ps1 -Reset     # 恢复默认 15
    ```

---

## TODO

- **实现 `IDropTarget` / `IExecuteCommand` COM 接口**，从根上消除"多选 16+ 没反应"限制——让 Shell 一次性把整批文件作为 `IDataObject` 传给 mplayer，而不是逐个 spawn exe。约 ~260 行 Rust（`windows` crate）+ NSIS / MSI 注册脚本 + LocalServer32 启动分支。参考 Notepad++ / Sublime / VS Code 的 DropHandler 实现。**优先级低**：野外没有视频播放器这么做，工程量换长期体验，等使用频率上来再做。
- Linux / macOS 嵌入式渲染验证。
- WaveformStrip 超长视频（>2h）peaks 解码 Web Worker 化。
- 自动恢复上次播放列表（开关 + 自动写盘）。

---

## 第三方依赖与鸣谢

- [nini22P/tauri-plugin-libmpv](https://github.com/nini22P/tauri-plugin-libmpv) — Tauri 2 的 libmpv 嵌入插件
- [zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild) — Windows 下的 libmpv-2.dll 构建
- [Symphonia](https://github.com/pdeljanov/Symphonia) — Rust 纯解码库（音频波形）
- [wavesurfer.js](https://wavesurfer.xyz/) — 波形渲染
- [HeroUI v3](https://heroui.com/) — React UI 组件库
- [Lucide](https://lucide.dev/) — 矢量图标
- [Tauri](https://tauri.app/) — 桌面应用框架

---

## License

MPL-2.0（与 `tauri-plugin-libmpv` 保持一致）
