# mplayer 技术架构

本文档面向后续维护者与二次开发者，系统化记录 mplayer 的层级划分、关键技术决策、模块切分、数据流，以及开发过程中踩过的坑与对应的解决方案。

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tauri 主窗口（HWND, transparent: true）                                │
│                                                                      │
│  ┌──────────────────────────┐   ┌─────────────────────────────────┐  │
│  │  mpv 子窗口（HWND）        │   │  WebView2 (Microsoft Edge)       │  │
│  │  - libmpv-2.dll 渲染       │   │  - React + HeroUI UI             │  │
│  │  - vo=gpu-next             │   │  - 透明背景，覆盖在 mpv 之上     │  │
│  │  - 受 video-margin-ratio   │   │  - 状态：zustand                  │  │
│  │    控制渲染区域            │   │                                  │  │
│  └──────────────────────────┘   └─────────────────────────────────┘  │
│         ▲ (Win32 子控件，z-order 高于 webview)                       │
│         │                                                            │
│         │ IPC（Tauri command + event）                               │
│         ▼                                                            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Rust 主进程                                                  │   │
│  │  ┌──────────────────────────────────────────────────────┐    │   │
│  │  │ tauri-plugin-libmpv                                   │    │   │
│  │  │ - dlopen libmpv-wrapper.dll → libmpv-2.dll            │    │   │
│  │  │ - mpv_wrapper_create(wid = TauriWindowHWND)           │    │   │
│  │  │ - command / set_property / get_property / events      │    │   │
│  │  └──────────────────────────────────────────────────────┘    │   │
│  │  ┌──────────────────────────────────────────────────────┐    │   │
│  │  │ peaks.rs（自定义 command）                             │    │   │
│  │  │ - symphonia 流式解码 → max/min 桶化 → 返回 Vec<f32>    │    │   │
│  │  └──────────────────────────────────────────────────────┘    │   │
│  │  + tauri-plugin-dialog / -opener / -fs                       │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

三个进程层：

1. **WebView2 进程**：渲染 React UI。背景透明，让 mpv 视频"穿透"显示。
2. **Tauri Rust 主进程**：粘合层，加载 libmpv，跑 symphonia peaks。
3. **libmpv native**：所有视频解码 + 渲染 + 音频输出在这一层完成。

mpv 子窗口直接 attach 到 Tauri 主窗口（不是 WebView2），所以 mpv 与 WebView2 是**兄弟子控件**，由 Win32 z-order 决定层叠。

---

## 2. 关键技术决策

### 2.1 视频后端：libmpv vs HTML5 video

| 方案 | 优势 | 致命缺点 |
|---|---|---|
| `<video>` / WebCodecs | 零依赖，纯 JS | Chromium 内置解码器只覆盖一小撮主流编码；mkv/wmv/部分 hevc 直接黑屏 |
| video.js / Shaka | 框架成熟 | 同上，本质还是浏览器解码 |
| **libmpv 嵌入** | mpv 内核，几乎全格式；硬解 / 字幕 / 多音轨原生支持 | 多一个 ~94MB DLL；需要 wid 嵌入处理 |
| `<webview>` 嵌入 mpv.exe | 简单 | 子进程通信麻烦，UI 跨进程难协调 |

选 libmpv，体积代价可接受，换来万能播放。

### 2.2 libmpv 集成方式：`tauri-plugin-libmpv` vs 手写 `libmpv2-sys`

| 方案 | 工作量 |
|---|---|
| 手写 `libmpv2-sys` FFI | 3-5 倍，自己处理事件循环、wid embed、`render API` |
| **`tauri-plugin-libmpv` 0.3.2** | 拿来即用：init / observeProperties / command / setProperty / getProperty / setVideoMarginRatio |
| `tauri-plugin-mpv`（JSON IPC） | 要求系统 PATH 已装 mpv.exe，部署不便 |

选第二个。Plugin 内部用 `libmpv-wrapper.dll`（nini22p 自己写的 C 包装层）连接 `libmpv-2.dll`，前端走纯 TypeScript API。

### 2.3 音频波形：WebAudio 解码 vs Rust 离线解码

| 方案 | 缺点 |
|---|---|
| `AudioContext.decodeAudioData` (wavesurfer 默认) | 只支持浏览器原生 codec（mp3/aac/ogg/flac/wav），mkv/wma/dts/ac3 全部失败；大文件全量进 JS 内存可能 OOM |
| **Rust `symphonia` 流式解码** | 几乎所有 codec；流式不爆内存；输出 peaks 数组很小（几 KB） |

选第二个。参考实现是 `ai-vc-studio/frontend` 的做法：

```rust
#[tauri::command]
pub async fn calculate_peaks(file_path: String, samples_per_pixel: u32) -> Result<PeaksData, String>
```

返回 `{ peaks: Vec<f32>, duration, sampleRate, channels }`，前端 `WaveSurfer.create({ peaks: [data.peaks], duration, url: convertFileSrc(path) })` 直接使用，**完全跳过浏览器 decode**。

### 2.4 UI 组件库：HeroUI v3

只用了 HeroUI 的 `Button`，其余 Slider / Tooltip / Menu 全部自实现。

原因：HeroUI v3 的 Slider 基于 react-aria-components 复合组件，又厚又难定制视频进度条 hover-时间-tooltip。Listbox 也类似。自己写 div + 绝对定位反而灵活。

Lucide 是图标体系。最初用 emoji（`▶ ⏸ ⏪ ⏩`），用户反馈"太丑"，统一改 lucide 矢量。

### 2.5 状态：zustand 两个 store + 一个 JSON 文件

| store | 持久化 | 内容 |
|---|---|---|
| `playerStore` | ✗（运行时） | playlist / currentIndex / 播放进度 / 视频尺寸 / fps / mpvReady / fileLoaded / 错误 |
| `settingsStore` | ✓ 经 `lib/persist.ts` 写到 `store.json` 的 `ui` 键 | UI 偏好 + 快捷键绑定 + frameStepMultiplier；带 SCHEMA_VERSION 与迁移 |

两个分开是因为运行时状态变化频繁（time-pos 每 200ms 一次），不应触发持久化写入。

### 2.6 持久化：`tauri-plugin-store` 单文件 JSON

物理位置：`%APPDATA%\dev.mark.mplayer\store.json`，三个顶层键：

| key | 内容 | 写入触发点 |
|---|---|---|
| `ui` | settingsStore 的所有 UI 偏好 + 快捷键绑定 | settingsStore 任意 setter |
| `player` | volume / muted / speed | mpv `volume` / `mute` / `speed` property-change observer |
| `positions` | `{ [path]: seconds }` | time-pos observer（每 5 秒；尾段 5 秒内主动 clear） |

**为什么从 localStorage 迁过来**：localStorage 数据存在 WebView2 LevelDB 二进制里，用户找不到、备份不便。store.json 是人可读 JSON，跨电脑同步只要拷一个文件。

**一次性迁移**：`migrateFromLocalStorage` 在 `ensureInit` 最开头跑一次，把老 key（`mplayer:ui-settings` / `mplayer:settings` / `mplayer:positions`）读出来塞进 store 同名顶层键并删除 localStorage 原值。已迁过的跳过。

**`autoSave: 100`**：plugin-store 内部 100ms 防抖批量写盘，频繁 set 不会拖性能。

**异步 hydrate 模式**：
- zustand store 用默认值初始化，标志 `bootstrapped: false`
- `ensureInit` 异步并行：`bootstrapSettings()`（UI hydrate） + `loadPositionsAsync()`（positions 进缓存）+ `loadSettings()`（player prefs 进缓存）
- hydrate 完后 `bootstrapped: true`；所有 setter 用 `persistIfBootstrapped` 守门，避免在 hydrate 前把默认值覆盖到 store
- mpv init 在 hydrate 完成后才发，确保用真实 volume/speed 启动

### 2.7 单实例 + 启动文件参数

- `tauri-plugin-single-instance`：第二个 mplayer.exe 启动时，把它的 argv 路径转发给已有窗口（`emit("open-files", paths)`），并 `unminimize + set_focus`。避免双开浪费 mpv 实例。
- 首次启动 argv 通过自定义 `get_launch_args` command 让前端取走（`std::mem::take` 后再次调用返回空，防 HMR 重复消费）。
- `bundle.fileAssociations` 让 MSI/NSIS 安装时把 .mp4/.mkv 等 21 种扩展注册到 Windows 默认应用列表。
- 前端 `useLaunchFiles` hook 串联这两条：mount 调一次 `get_launch_args`，并监听 `open-files` 事件，每次都走 `appendToPlaylist + playIndex`。

播放位置（每文件）单独写在 `store.json` 的 `positions` 键，路径为 key、秒数为 value。

---

## 3. 模块切分

### 3.1 前端

```
hooks/
├── useMpv.ts             单例 init promise；observer 注册；playIndex / playNext / playPrev
└── useVideoMargins.ts    状态驱动 setVideoMarginRatio（仅 fullscreen/playlistCollapsed/showWaveform）

lib/
├── mpv.ts                业务命令封装：loadFile / setPaused / togglePause / seekRelative / seekAbsolute /
│                         frameStep / frameBackStep / frameStepBy / setVolumeProp / setMutedProp /
│                         setSpeedProp / setSubtitleTrack / setAudioTrack / parseTrackList / getCurrentTracks
├── shortcuts.ts          ShortcutAction 枚举 + ACTION_LABELS + DEFAULT_SHORTCUTS + eventToCombo / displayCombo /
│                         FRAME_STEP_MIN/MAX/DEFAULT 常量
├── persist.ts            getResumePosition / savePosition / clearPosition / clearAllPositions /
│                         loadSettings / saveSettings
└── format.ts             formatTime / basename / parentDir

store/
├── playerStore.ts        见 §3.1 表
└── settingsStore.ts      见 §3.1 表
```

### 3.2 后端

```
src-tauri/src/
├── main.rs       入口（mobile_entry_point 兼容）
├── lib.rs        plugin 注册 + invoke_handler![peaks::calculate_peaks]
└── peaks.rs      symphonia 解码 → PeaksData
src-tauri/build.rs   编译时复制 lib/*.dll 到 target/<profile>/（详见 §5.1）
```

---

## 4. 数据流

### 4.1 用户打开文件

```
[拖拽 / dialog.open]
        │
        ▼
appendToPlaylist(paths)         playerStore.playlist 增加
        │
        ▼
playIndex(index)
        │
        ├──► waitForMpv()       若 mpvReady=false 轮询 50ms × 5s
        │
        ├──► loadFile(path)     → command("loadfile", [path, "replace"])
        │
        ├──► [resume 逻辑] 轮询 getProperty("duration") 直到 > 0
        │       若 rememberPosition && resume < min(dur*0.95, dur-30) → seekAbsolute(resume)
        │
        └──► setProperty("pause", false)

mpv 异步事件流：
   start-file  → setFileLoaded(false) / setVideoSize(0,0) / setFps(0)
   file-loaded → setFileLoaded(true)
   property-change time-pos / duration / volume / mute / speed / track-list / sid / aid /
                  width / height / container-fps / pause / eof-reached
                  → 各自写入 playerStore
   end-file    → reason=eof 清掉该文件 resume；reason=error 报错 + 自动下一个
```

### 4.2 用户按 Space

```
window 'keydown' (capture phase, 抢在 button 之前)
        │
        ▼
shouldIgnore(target)            过滤 INPUT/TEXTAREA/SELECT/contenteditable
        │
        ▼
eventToCombo(e) = "Space"
        │
        ▼
查 settingsStore.shortcuts → matched = "playPause"
preventDefault + stopPropagation + activeElement.blur()
        │
        ▼
dispatch("playPause") → togglePause()
        │
        ▼
async: getProperty("pause", "flag") → setProperty("pause", !v)
        │
        ▼
mpv 异步：property-change pause → playerStore.setIsPlaying(!v)
```

`togglePause` 从 mpv 真实状态读取再翻转，**不依赖 React store 的 isPlaying**——避免初始事件丢失导致的状态漂移（详见 §6.3）。

### 4.3 用户拖动音量条

```
mousemove (60Hz)
        │
        ▼
setDraggingVolume(v)             乐观本地状态，立刻渲染
queueSendVolume(v)               rAF 节流，每帧最多一次 setVolumeProp
        │                        (IPC 实际频率 ≤ 60Hz，且与渲染对齐)
        ▼ (rAF)
setVolumeProp(target)            一次 IPC

mouseup
        │
        ├──► cancelAnimationFrame(pending)
        ├──► setVolumeProp(final)     强制 commit 终态
        └──► setTimeout(() => setDraggingVolume(null), 200)
             等 mpv property-change 回报后再撤掉乐观值，避免回弹
```

显示用 `displayVolume = draggingVolume ?? volume`，确保拖动期间 UI 不被 IPC 往返延迟干扰。

### 4.4 波形条加载

```
WaveformStrip useEffect(path 变化)
        │
        ├──► getPeaks(path, 512)      LRU 缓存 20 条；命中即返回
        │       │ (未命中)
        │       └──► invoke("calculate_peaks", { filePath, samplesPerPixel: 512 })
        │              symphonia probe → decode all packets → 桶化 max/min → 返回
        │
        ├──► WaveSurfer.create({
        │       container: ref,
        │       peaks: [data.peaks],
        │       duration: data.duration,
        │       url: convertFileSrc(path),  // 给 wavesurfer 的 media 元素
        │       interact: false,            // 我们自己处理点击 seek
        │     })
        │
        └──► useEffect(position 变化) → ws.setTime(position)
            另有一个独立的"光标 div"叠在波形上，即使 wavesurfer media 解码失败也能跟着 mpv 走
```

---

## 5. 构建与打包

### 5.1 DLL 复制（build.rs）

```rust
// src-tauri/build.rs 简化版
copy src-tauri/lib/libmpv-2.dll     → target/<profile>/libmpv-2.dll
copy src-tauri/lib/libmpv-wrapper.dll → target/<profile>/libmpv-wrapper.dll
println!("cargo:rerun-if-changed=...");
```

为什么需要？详见 §6.1。

### 5.2 Tauri 配置要点

```jsonc
// src-tauri/tauri.conf.json
{
  "app": {
    "windows": [{ "transparent": true, "dragDropEnabled": true, ... }],
    "security": {
      "csp": null,
      "assetProtocol": { "enable": true, "scope": ["**"] }  // convertFileSrc 需要
    }
  },
  "bundle": {
    "resources": ["lib/**/*"],   // 打包时把 DLL 装进安装包
    "targets": ["msi", "nsis"]
  }
}
```

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }   # convertFileSrc 配套
symphonia = { version = "0.5", features = ["all"] }        # 全 codec
```

### 5.3 Capabilities

```json
{
  "permissions": [
    "core:default",
    "core:window:default",
    "core:window:allow-set-fullscreen",
    "core:window:allow-is-fullscreen",
    "core:event:default",
    "opener:default",
    "opener:allow-reveal-item-in-dir",
    "libmpv:default",
    "dialog:default",
    "dialog:allow-open",
    "fs:default",
    { "identifier": "fs:allow-read-file", "allow": [{ "path": "**" }] }
  ]
}
```

`core:default` **不包含** window 状态修改！必须显式加 `allow-set-fullscreen`（详见 §6.10）。

---

## 6. 踩坑总结

按踩到的时间顺序排列；每条都给出现象、根因和修复方案。

### 6.1 Windows DLL 搜索顺序：`libmpv-2.dll` 找不到

**现象**：dev 模式下视频区透明、loadfile 报错 `mpv instance not found`。

**根因**：tauri-plugin-libmpv 在 `exe_dir/` 和 `exe_dir/lib/` 找 `libmpv-wrapper.dll`（找得到），但 wrapper.dll 加载时它依赖的 `libmpv-2.dll` 走 **Windows 默认 DLL 搜索顺序**：
1. exe 目录（`target/debug/`）
2. system32 / SysWOW64
3. PATH

**搜索路径里没有"wrapper 自己所在目录"**。所以即使 `libmpv-2.dll` 跟 wrapper 都在 `target/debug/lib/`，wrapper 也找不到 mpv-2，create 返回 NULL 句柄。

**修复**：`build.rs` 在编译时把两个 DLL 复制到 `target/<profile>/`（exe 同级），Windows 默认搜索能命中。

### 6.2 React StrictMode 双重挂载销毁 mpv

**现象**：DevTools 显示 `[mpv] initialized with vo=gpu-next` 后立刻 `loadfile threw: mpv instance not found`。

**根因**：StrictMode 在 dev 故意双重挂载 effect。`useMpv` 的 cleanup 调了 `destroy()`，把刚 init 的 mpv 摧毁；第二次 mount 因 `ready.current=true` 跳过 init。

**修复**：
1. `main.tsx` 去掉 `React.StrictMode`。mpv 是 OS 级单例资源，扛不住双重挂载。
2. cleanup 不再 `destroy()`——让 mpv 跟进程一起退出由 OS 回收。
3. 用 `initPromise` 单例化 init，HMR 重挂载时再次调用是 no-op。

### 6.3 mpv 初始事件丢失 race

**现象**：拖入第一个视频，按 Space 没反应；切第二个 / 再回第一个就好了。

**根因**：mpv 在 `mpv_create` 之后会立刻为每个 `observed_properties` 发一轮 "current value" 事件。Plugin 把它们 emit 到 Tauri 事件总线时，JS 的 `observeProperties()` 监听器还没挂上——事件丢失。`playerStore.isPlaying` 留在默认 `false`，第一次按 Space 调 `setPaused(isPlaying=false)` = "取消暂停"，但 mpv 本来在播，等于空操作。切第二个文件后状态跳变多了几次把 store 同步上来才好。

**修复**：
1. `observeProperties` 挂上后立即 `getProperty('pause' | 'volume' | 'mute' | 'speed')` 显式同步真实值到 store。
2. 新增 `togglePause()` 函数从 mpv 真实状态读 `pause` 再翻转，不依赖 store。所有播放/暂停入口（按钮 / 单击 / 空格）都改用 `togglePause()`。

### 6.4 mpv `force-window=immediate` / `background=#000000` 让 init 挂起

**现象**：把 `force-window` 从 `yes` 改成 `immediate` 并加 `background=#000000` 后，console 不再出现 `[mpv] initialized`，`init()` 既不 resolve 也不 reject。

**根因**：mpv 在解析 init options 时是同步的，这两个组合在 wid 嵌入路径下会触发死锁（来源未深查）。

**修复**：回退到最小可用配置：`hwdec=auto-safe / keep-open=yes / osc=no / input-default-bindings=no / input-vo-keyboard=no / volume / mute / speed`。**任何"似乎合理"的 mpv 选项加进 init 前都得测一遍 init 还能否完成。**

### 6.5 mpv 子窗口与 WebView2 的 z-order

**现象**：视频区透明、空闲态露出桌面；播放列表关闭再打开瞬间被 mpv 覆盖。

**根因**：Win32 子窗口的默认 z-order 是创建顺序的反序——**后创建的在上**。WebView2 在 Tauri 窗口启动时创建，mpv 在 plugin init 时晚创建。所以**mpv 子窗口画在 WebView2 之上**。

后果：
- 在 mpv 子窗口的范围内，无论 React 元素多不透明都看不见——被 mpv 覆盖。
- 但 mpv 的渲染区域可以用 `video-margin-ratio` 缩进；缩进部分由 mpv 自己填背景色，可控。

**修复**：
- 空闲态 / 加载态 / audio-only 用 React 不透明遮罩——前提是当时 mpv 还没创建窗口（默认 `force-window=no`，无文件时 mpv 不出窗口）或者 video-margin-ratio 把那块切走。
- 当文件加载完毕、mpv 出窗口时，遮罩通过 `fileLoaded` 状态自动隐藏。

### 6.6 `setVideoMarginRatio` 异步导致 playlist 被 mpv 覆盖

**现象**：折叠 playlist 后再展开，瞬间看见 mpv 视频盖住了 playlist 的文字。

**根因**：原实现用 `ResizeObserver` 监听 sideRef 尺寸：DOM 渲染 → 测量 → IPC 一连串异步，30-80ms 间隔里 mpv 还在用旧的 `right=0` margin 渲染，盖住了新出现的 playlist 区域。

**修复**：`useVideoMargins` 从 store 直接读 `playlistCollapsed / showWaveform / fullscreen`，**用硬编码尺寸常量算 margin**（PLAYLIST=280, CONTROL=60, WAVEFORM=56），状态变化 → effect 立刻发 IPC，与 React commit 同一拍。再加一个 80ms 的 mount 延迟保险：collapsed→展开时先等 mpv 让出区域，再 mount PlaylistPanel。

> 这是典型的"web 风格异步渲染 vs 桌面同步状态"的不匹配。`ResizeObserver` 适合"被动响应 DOM 变化"，不适合"主动同步 OS 子窗口尺寸"。

### 6.7 React Strict Mode 关掉后 HMR 安全

去掉 StrictMode 后，HMR 重挂载 useMpv 的 cleanup 还是会被调用。我们的 cleanup **只 unlisten observers / events，不 destroy mpv**；下次 mount 时 `ensureInit()` 看到 `initPromise` 已 fulfilled 直接返回，重新挂 observer。mpv 实例在整个进程生命周期内只创建一次，由 OS 回收。

### 6.8 CSS `transform: translateX(%)` 不是相对父容器

**现象**：进度条圆点和音量条圆点卡在最左边不动；只有 fill 条在动。

**根因**：为了 GPU 合成把 thumb 改成 `transform: translateX(calc(${p*100}% - 50%))`——但 **CSS transform 的百分比是相对元素自身宽度**，不是相对父容器。一个 14px 的 thumb，progress=1 时只挪了 7px。

**修复**：thumb 改回 `left: ${p*100}%` + `transform: translate(-50%, -50%)` 居中。`left:%` 是相对父容器的，移动 absolute-positioned 单个小元素的 paint 成本可忽略。fill 仍用 `scaleX(p)`——scale 的百分比就是要"相对自身缩放"，匹配语义。

### 6.9 HeroUI v3 Button variant 重命名

**现象**：HeroUI v2 习惯的 `variant="solid" / "light" / "bordered"` 在 v3 里都报 TS 错。

**修复**：v3 把 variant 整合成 `primary / secondary / tertiary / outline / ghost / danger / danger-soft`。`solid+primary` → `primary`；`light` → `ghost`；`bordered` → `outline`。

### 6.10 Tauri 2 `core:default` 不含 fullscreen

**现象**：`Ctrl+Enter` 走完 KeyboardShortcuts dispatch，控制台无报错，但窗口不全屏。

**根因**：Tauri 2 把 `setFullscreen` 拆到了 `core:window:allow-set-fullscreen` 这种细粒度权限里。`core:default` 只给基础 IPC，不给窗口状态修改。

**修复**：capabilities/default.json 显式追加：
```json
"core:window:default",
"core:window:allow-set-fullscreen",
"core:window:allow-is-fullscreen",
"core:event:default"
```

### 6.11 默认快捷键 `F` 全屏在 webview 中不可靠

**现象**：用户报 `F` 按下无反应。

**根因**：Chromium webview 在 DevTools focused 等场景会拦截 `F` 系列字符键。

**修复**：默认改 `Ctrl+Enter`。同时给老用户做一次性迁移：每次 load 都检查 `shortcuts.fullscreen === "F"` 或空字符串，自动改回 `Ctrl+Enter`。这个"无条件覆盖"的代价是极少数显式选 F 的用户被回退，但 F 本来就不稳定，可接受。

### 6.12 全局键盘事件 vs 按钮原生 Space/Enter

**现象**：点过任意 IconBtn 后按 Space 没切播放/暂停，反而展开了那个按钮的菜单。

**根因**：按钮点过后焦点留在它上面。HeroUI Button 内部用 react-aria，Space/Enter 触发按钮自己的 `onPress`。全局 keydown handler 也跑了一次，两次切换互相抵消。

**修复**：全局 keydown 改 `{ capture: true }`，**比按钮的监听器更早收到事件**。匹配到玩家键就 `preventDefault() + stopPropagation()`，按钮的 "Space → click" 默认行为彻底被阻断。同时 dispatch 后 `activeElement.blur()` 让焦点回 body。

### 6.13 滑块拖动 IPC 风暴

**现象**：拖动音量条有明显延迟感、回弹。

**根因**：每次 mousemove 都发一次 `setVolumeProp` → mpv → property-change → store → render，60Hz 的往返累积出可见滞后。

**修复**（社区通用配方）：
- **乐观更新**：`draggingVolume` 本地状态立刻渲染
- **rAF 节流 IPC**：相邻 mousemove 合并到下一帧
- **终态强制 commit**：mouseup 时取消节流并显式发最终值
- **延迟撤销乐观值**：等 200ms 让 IPC 回程，避免回弹闪烁
- **GPU 合成动画**：fill 用 `transform: scaleX(p)` + `origin-left`，避免 width 改动触发 layout

### 6.14 resume 位置失控

**现象**：第一次拖入 17 秒视频，从末尾开始播。

**根因**：旧版本每 5 秒无脑保存 `time-pos`。短视频在播完前最后保存的位置接近末尾（如 15s/17s），下次 resume 跳到 15s 即末尾。

**修复**（三层防护）：
1. 不保存：`position >= duration - 5` 时主动 `clearPosition`
2. 不 resume：`resume < min(dur*0.95, dur-30)` 才 seek；短视频(<60s)实际禁用 resume
3. EOF 清除：`end-file` reason=eof 时 `clearPosition(currentPath)`
4. 用户可在设置"清空所有已保存的播放进度"一键清除老脏数据

### 6.15 wavesurfer.js `peaks` 路径用 `convertFileSrc`

**现象**：wavesurfer 给 media element 的 url 必须能 fetch；本地路径直接传过去 webview 不认。

**修复**：用 Tauri 的 `convertFileSrc(path)` 转成 `asset://` 协议。需要在 `tauri.conf.json` 启用 `app.security.assetProtocol.enable = true` + `scope: ["**"]`，并在 Cargo.toml 给 `tauri` 加 `protocol-asset` feature。

### 6.16 mpv `frame-step` 多次 IPC vs `seek relative+exact`

**现象**：实现"N 帧跳转"时，循环调 `frame-step` 是 N 次 IPC，慢且不精确。

**修复**：读 `container-fps`，算出 `count / fps` 秒，一次 `seek <delta> relative+exact`。`relative+exact` 才会精确按时间跳，不会 snap 到关键帧。失败时回退到 `frame-step` 循环。

### 6.17 `tauri-plugin-store` 的 `StoreOptions` 必填 `defaults`

**现象**：TS 报错 `Property 'defaults' is missing in type '{ autoSave: number; }'`。

**根因**：`load(path, options?)` 的 options 是 `StoreOptions`，里面 `defaults: { [key: string]: unknown }` 是**必填**字段（即使你不想要默认值）。

**修复**：传 `{ defaults: {}, autoSave: 100 }`。

### 6.18 异步 store hydrate 与 zustand 同步初始化的冲突

**现象**：用 plugin-store 替换 localStorage 后，settingsStore 的初始化变成异步——但 zustand `create()` 要同步给定初始 state。直接在 setter 里发 `persist()` 会在 hydrate 之前就把默认值写回 store，覆盖用户已保存的值。

**修复**：
- store 初始化用 `defaults` + `bootstrapped: false`
- `bootstrapSettings()` 异步读 store，patch 进 zustand，最后 `bootstrapped: true`
- 所有 setter 用 `persistIfBootstrapped` 守门，hydrate 前的修改不写盘
- `useMpv` 的 `ensureInit` `await` 一遍 hydrate 才发 mpv init，确保用真实值启动

### 6.19 `pnpm tauri add libmpv` 在 Windows 上的 setup 失败

**现象**：cargo 依赖加成功、npm 包装好、permissions 写进 capabilities，但末尾的 setup 脚本因为 pnpm 在 Windows 上拼路径有 bug 报错。

**修复**：手动跑 `node node_modules/tauri-plugin-libmpv-api/dist-js/cli.cjs setup-lib`。`start-dev.bat` / `start-dev.ps1` 检测到缺 DLL 时也是直接走这条路径。

### 6.20 Tauri 2 capability 静默拒绝 IPC 导致窗口永不显示

**现象**：装好版本后双击启动，进程在 Task Manager 里能看到 `mplayer.exe` 在跑，但屏幕上**没有任何窗口出现**——既不是崩溃也没有报错。

**根因**：为修冷启动白闪我把 `tauri.conf.json` 改成 `visible: false`，由前端 React 首帧后调 `getCurrentWindow().show()`。但 Tauri 2 的 capability 是**显式白名单**——`core:window:default` **不包含** `allow-show`。前端 IPC 调用被静默 reject（既不抛错也不返回），窗口永远停在 hidden 状态。

**修复（三层）**：
1. capabilities 显式追加 `core:window:allow-show / allow-hide / allow-set-focus / allow-unminimize`（后两者是 single-instance 转发要用的，也是潜在静默 deny）
2. Rust setup 起独立线程 1.5s 后无条件 `window.show()` 兜底——任何前端故障都不会再让用户看不到窗口
3. JS `show()` Promise 加 `.catch(console.error)`，类似问题再次出现 devtools 立刻可见

**经验教训**：Tauri 2 的 capability 设计哲学是"严格白名单 + 静默拒绝"，跟以前 Tauri 1 的 allowlist 静默通过完全相反。**任何 IPC 调用上线前都要在 release build 测一遍**，dev build 因为 capability 检查相对宽松可能误以为 OK。所有 `window.*` 操作建议显式列权限，不要依赖 `core:window:default` 这种 meta 权限。

---

## 7. 性能 / UX 考量

### 7.1 渲染管线
- **mpv 渲染走 native GPU**，前端 webview 几乎只负责 UI 控件，CPU/GPU 占用极低
- **滑块 fill 用 `transform: scaleX`**：GPU 合成层，60Hz 拖动不触发 layout/paint
- **滑块 thumb 用 `left:%` + `translate(-50%, -50%)`**：单元素 layout 成本可忽略；与 fill 的 scale 错峰（transform 百分比相对自身，不能用来在父容器内移动）

### 7.2 IPC 节流
- **拖动音量条 rAF 合并**：60+Hz mousemove 合并为每帧最多一次 `setVolumeProp` IPC
- **拖动进度条仅 mouseup 时 seek**：拖动期间用本地 `dragValue` 渲染，不每帧 IPC
- **乐观更新 + 200ms 延迟撤销**：拖动期间 `displayVolume = draggingVolume ?? volume` 优先用本地值，松手 200ms 后再清；避免 mpv property-change echo 引发回弹

### 7.3 mpv 嵌入相关
- **状态驱动 video-margin-ratio**：从 `playlistCollapsed / showWaveform / fullscreen` 直接算 margin，不用 ResizeObserver；常量 `PLAYLIST=280 / CONTROL=60 / WAVEFORM=56`
- **PlaylistPanel 打开延迟 80ms**：留时间给 mpv 应用 margin IPC，避免 mpv 子窗口短暂覆盖刚 mount 的 playlist
- **未 fullscreen 时 video-margin-ratio = `{ right: 280/w, bottom: (60+56)/h }`**（关闭波形条则 `bottom: 60/h`）：mpv 完全不在 UI 区域渲染，节省 GPU 也保证 UI 不被覆盖

### 7.4 波形管线
- **Rust symphonia 离线解码 peaks**：流式解码不爆内存，几乎所有 codec；返回 `Vec<f32>` 几 KB 量级
- **波形 peaks LRU 缓存 20 条**：切回最近播过的文件零成本
- **WaveformStrip 实际 56px 高、波形条 `barWidth: 2, barGap: 1, samplesPerPixel: 512`**：视觉密度高且解码量适中
- **波形与进度条 `inset-x-4` 对齐**：避免 16px 错位让人感觉光标不同步
- **独立 cursor div 叠在波形上**：即便 wavesurfer `<audio>` media 无法解码（mkv/dts 等），cursor 也跟着 mpv `time-pos` 走

### 7.5 启动期 UX
- **冷启动无白底闪烁** —— 四层保险：
  1. `tauri.conf.json` `visible: false`，OS 窗口先不显示
  2. `index.html` 内联 `<style>` 把 html/body 染 `#0a0a0a`，比 Vite 注入的 CSS 更早
  3. `styles.css` body 改为不透明深色（mpv 子窗口在 webview 之上，安全）
  4. App.tsx 首挂载后双 rAF `window.show()`；并由 Rust 1.5s 兜底无条件 show()，UI 永不卡死
- **PlaylistPanel slide-in / SettingsPanel & GotoFrameDialog fade+scale / ErrorToast slide-down**：每个生灭都过 ~150ms 缓动，消除"突然冒出来"的硬切感
- **拖文件入窗口的 DragHoverOverlay**：onDragDropEvent enter/over/leave 全套监听，全屏虚线框 + Download 图标 + 提示文案，比传统 web 拖拽 UX 强很多
- **GotoFrameDialog 双模式自适应**：有 fps → 帧号；无 fps（纯音频）→ mm:ss / hh:mm:ss 时间输入

### 7.6 单实例与启动参数
- **`tauri-plugin-single-instance`**：第二个 mplayer.exe 启动时把 argv 转发到已有窗口，`unminimize + set_focus + emit("open-files")`，避免重复加载 94MB libmpv
- **`std::mem::take` 消费 launch args**：`get_launch_args` 调一次就清空，HMR / 重渲染重复 invoke 不会重复入队同一文件

### 7.7 文件句柄与优雅关闭

- **关闭时 destroy mpv**：`useGracefulShutdown` hook 拦截 `onCloseRequested`，先 `await destroy()` 让 mpv 解码线程、音频输出、文件 I/O 都有机会 flush 后再退出。500ms 超时兜底——mpv 万一卡死也不会让用户关不掉窗口。完成后 `window.destroy()` 强制销毁窗口（绕过 `CloseRequested`）。
- **回退兜底**：即使本钩子不执行，Windows 进程退出时 OS 也会一次性回收所有句柄；这一层只是让 mpv 的内部状态走完析构流程，行为更像 VLC 而非 Windows Media Player。
- **播放期间的文件锁定**：mpv 在 Windows 上经 C runtime `_wfopen` 打开文件，**默认 share mode 是 `_SH_DENYNO`**——理论上其他进程可以读/写/删/改名这个文件。验证方法：播放某个 .mp4 时在资源管理器里删除它，若 Windows 不报"文件正在被使用"即说明锁定行为已经像 VLC 那样宽松。
- **wavesurfer 的 `<audio>` 句柄**：通过 Tauri `convertFileSrc(path)` 走 `asset://` 协议，由 Tauri 资源处理器**按需短打开**——webview fetch 一段、Tauri 开一次文件读完关一次，并非长时间持有句柄。`ws.destroy()` 时 media element 也会释放所有引用。
- **symphonia peaks 计算**：用 Rust `File::open` + RAII，函数返回时 `Drop` 自动关文件。

---

## 8. 已知限制与未来工作

- Linux / macOS 端 `tauri-plugin-libmpv` 的窗口嵌入路径未经测试
- WaveformStrip 在超长视频（>2h）的 peaks 解码可能耗时 10s 以上——可以加进度条 / Web Worker 化
- mpv 字幕样式 / 滤镜 / 视频比例 / 截图等高级功能未暴露 UI
- store.json 当前 schema v2，未来加字段记得在 `load()` 里合并默认值并 bump SCHEMA_VERSION
- 未做代码签名：Windows SmartScreen 首次运行可能弹"无法识别的发布者"。装机量起来后 SmartScreen 数据库会自动给好评，或买 EV 证书一劳永逸（¥2000+/年）
- 播放列表当前不自动持久化；只能手动 `.m3u8` 导出。如果用户需要"上次列表自动恢复"可加一个 setting + 自动写盘

---

## 9. 关键文件速查

| 关心什么 | 看哪个文件 |
|---|---|
| mpv 怎么 init / 怎么收 event | `src/hooks/useMpv.ts` |
| mpv 命令封装 | `src/lib/mpv.ts` |
| 全局快捷键派发 | `src/components/KeyboardShortcuts.tsx` |
| 快捷键定义 / 默认值 / 工具 | `src/lib/shortcuts.ts` |
| 设置面板 + 录键 UI | `src/components/SettingsPanel.tsx` |
| 设置持久化 + 迁移 | `src/store/settingsStore.ts` |
| 波形条 | `src/components/WaveformStrip.tsx` |
| 波形 Rust 端解码 | `src-tauri/src/peaks.rs` |
| mpv 视频区裁切 | `src/hooks/useVideoMargins.ts` |
| 启动入口 | `start-dev.ps1` / `start-dev.bat` |
| DLL 复制逻辑 | `src-tauri/build.rs` |
| 权限配置 | `src-tauri/capabilities/default.json` |
