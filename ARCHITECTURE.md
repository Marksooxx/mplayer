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
├── useMpv.ts             单例 init promise；observer 注册（含 audio-pts）；playIndex / playNext / playPrev
├── useCursorAnimation.ts 虚拟播放头单例：rAF + 订阅分发（算法在 lib/playheadClock.ts）
└── useVideoMargins.ts    状态驱动 setVideoMarginRatio（仅 fullscreen/playlistCollapsed/showWaveform）

lib/
├── mpv.ts                业务命令封装：loadFile / setPaused / togglePause / seekRelative / seekAbsolute /
│                         frameStep / frameBackStep / frameStepBy / setVolumeProp / setMutedProp /
│                         setSpeedProp / setSubtitleTrack / setAudioTrack / addSubtitle / setSubDelay /
│                         getSubDelay / stopPlayback / parseTrackList / getCurrentTracks
├── shortcuts.ts          ShortcutAction 枚举 + ACTION_LABELS + DEFAULT_SHORTCUTS + eventToCombo / displayCombo /
│                         FRAME_STEP_MIN/MAX/DEFAULT 常量
├── playheadClock.ts      播放头时钟从动（audio-pts / hold / coast / 循环取模 / slew），纯逻辑
├── waveTimeline.ts       波形唯一时间轴：axisDuration / resamplePeaks / timeToFrac / fracToTime
├── peaks.ts              getPeaks（LRU + 进行中请求去重）/ toDb
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
├── lib.rs        plugin 注册 + invoke_handler![peaks::calculate_peaks, peaks::file_fingerprint, …]
├── peaks.rs      symphonia 流式解码 → 自适应分桶 PeaksData（含 startTime）
└── media_timing.rs  MP4 elst / MKV CodecDelay 只读解析（波形对齐 mpv 时间轴）
src-tauri/build.rs   编译时复制 lib/*.dll 到 target/<profile>/（详见 §5.1）
```

---

## 4. 数据流

### 4.1 用户打开文件

```
[拖拽 / dialog.open]
        │
        ▼
classifyDrops(paths)            按扩展分流：.srt/.ass/.ssa/.sub/.vtt/.idx/.smi/.sup
                                → addSubtitle()（仅当 currentIndex≥0 时）
                                其它 → 进 playlist 入列分支（详见 §4.5）
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
WaveformStrip
        │
        ├──► getPeaks(path)           LRU 20 条 + 进行中请求去重；键 = 路径::v2::size:mtime
        │       │ (未命中)
        │       └──► invoke("calculate_peaks", { filePath })
        │              symphonia 流式解码 → 16 帧起的自适应分桶(≤16384 桶) max/min
        │              + startTime(MP4 elst / MKV CodecDelay / MP3 LAME delay，§6.32)
        │
        ├──► axis = fileLoaded && mpv duration > 0 ? mpv duration : peaks 结束时刻
        │    bins = resamplePeaks(peaks, axis, 容器 CSS 宽度)   按真实时间摆放、留空、裁剪
        │    ws.load("", [bins], axis)       wavesurfer 只当绘制器：无 url、无 <audio>
        │
        └──► useVirtualPlayhead((displayed) => {
               ws.getRenderer().renderProgress(timeToFrac(displayed, axis))   已播放填色
               WaveformCursor.left = timeToFrac(displayed, axis)              光标
             })
            rAF 驱动（144Hz），与 ProgressFill / ProgressThumb 同源同帧；点击 seek 用
            fracToTime 反算 —— 光标、填色、点击、peaks 共用同一时间轴。详见 §6.22 / §6.32
```

### 4.5 字幕加载（外部）

```
入口 A：drag&drop                         入口 B：TrackMenu「加载字幕文件…」
  PlayerView.onDragDropEvent('drop')        plugin-dialog open({ filters: 8 种扩展 })
        │                                       │
        └──► classifyDrops → subs[]             └──► path
                ↓                                       ↓
            (currentIndex≥0 才走;                addSubtitle(path)
             否则丢弃,字幕没有"独立播放"语义)
                            ↓
                  addSubtitle(path)
                            │
                            ▼
                  mpv command("sub-add", [path, "select"])
                            │
                            ▼
                  mpv 异步:track-list property-change
                            │
                            ▼
                  TrackMenu 重渲染列出新增 sub 轨道,sid 自动选中

字幕延迟同步:
  TrackMenu 打开时(open 状态切 true)
        │
        ▼
  getSubDelay() → setProperty("sub-delay")
        │
        ▼
  按钮 ±100ms / 重置 0 → setSubDelay(value)
```

mpv 1.x 起 `sub-add path select` 既加入也激活字幕轨;`sub-delay` 是浮点秒，正值=字幕延后显示。

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

**修复**：`useVideoMargins` 从 store 直接读 `playlistCollapsed / showWaveform / fullscreen / playlistWidth`，**用尺寸常量 + 用户拖动设置算 margin**（CONTROL=60, WAVEFORM=56；PLAYLIST 跟随 settings.playlistWidth），状态变化 → effect 立刻发 IPC，与 React commit 同一拍。

> 这是典型的"web 风格异步渲染 vs 桌面同步状态"的不匹配。`ResizeObserver` 适合"被动响应 DOM 变化"，不适合"主动同步 OS 子窗口尺寸"。

> **后续演进（见 §6.23）**：早期版本还配了 80ms `renderPlaylist` 延迟（让 mpv 先让出空间再 mount PlaylistPanel）解决"mpv 短暂盖文字"。后来发现这个延迟反而引入了"DOM 缺席瞬态"漏光问题。最终方案是 PlaylistPanel 始终挂载 + `transform: translateX` 滑入滑出，从根上消除 mount/unmount 间隙；同时 mpv 加 `background-color=#000000` 兜底，"mpv 盖文字"的可能性也被压到零。**80ms 延迟已废弃。**

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

### 6.21 不透明 body 背景挡住 mpv 视频（视频区全黑）

**现象**：升级版本后视频文件打开是黑色一片（不是 mpv 解码失败——位置 / 时长 / fps 都对，音频也响）。

**根因**：为修冷启动白闪，我把 `styles.css` 和 `index.html` 的 `body` 背景从 `transparent` 改成 `#0a0a0a`。但是 **mpv 子窗口在 Win32 z-order 中位于 WebView2 之下**（之前以为"创建顺序晚 → 在上"，实际相反或者跟 plugin 行为有关——总之经验证 mpv 在 webview 之下）。视频通过 webview body 的 `transparent` 区域**透出**给用户看。一旦 body 染色不透明，整个视频区被 webview 自己的不透明颜色盖死，mpv 还在正常解码但全被挡住。

**修复**：
- `styles.css` body `background: transparent !important`（用 `!important` 防止以后再被覆盖）
- `index.html` 内联 `<style>` 同样 `background: transparent`
- 冷启动白闪改靠 `tauri.conf.json visible:false` + React 首帧 `requestAnimationFrame×2` 后 `getCurrentWindow().show()` 防御。Rust setup 里 1.5s 兜底（详见 §6.20）
- 空闲态 / 加载态 / audio-only 期间没有 mpv 视频可以透出，由 `PlayerView` 自己的不透明深色 overlay (`bg-neutral-950`) 来兜底盖住透明的视频区

**经验教训**：libmpv 的 wid 嵌入路径绝对不能容忍 webview body 不透明。这条铁律值得在 styles.css 里加大注释提醒。先前以为只有"audio 文件没视频"这种边缘场景会暴露问题，但实际**任何视频文件**都会因这个 bug 而黑屏；只是早期版本测试集中在音频上才没发现。

---

### 6.20 Tauri 2 capability 静默拒绝 IPC 导致窗口永不显示

**现象**：装好版本后双击启动，进程在 Task Manager 里能看到 `mplayer.exe` 在跑，但屏幕上**没有任何窗口出现**——既不是崩溃也没有报错。

**根因**：为修冷启动白闪我把 `tauri.conf.json` 改成 `visible: false`，由前端 React 首帧后调 `getCurrentWindow().show()`。但 Tauri 2 的 capability 是**显式白名单**——`core:window:default` **不包含** `allow-show`。前端 IPC 调用被静默 reject（既不抛错也不返回），窗口永远停在 hidden 状态。

**修复（三层）**：
1. capabilities 显式追加 `core:window:allow-show / allow-hide / allow-set-focus / allow-unminimize`（后两者是 single-instance 转发要用的，也是潜在静默 deny）
2. Rust setup 起独立线程 1.5s 后无条件 `window.show()` 兜底——任何前端故障都不会再让用户看不到窗口
3. JS `show()` Promise 加 `.catch(console.error)`，类似问题再次出现 devtools 立刻可见

**经验教训**：Tauri 2 的 capability 设计哲学是"严格白名单 + 静默拒绝"，跟以前 Tauri 1 的 allowlist 静默通过完全相反。**任何 IPC 调用上线前都要在 release build 测一遍**，dev build 因为 capability 检查相对宽松可能误以为 OK。所有 `window.*` 操作建议显式列权限，不要依赖 `core:window:default` 这种 meta 权限。

---

### 6.22 Cursor"瞬移 + 退回"的双重根因 —— 模块级单例 + 显式 snap 模式

**现象时间线（4 轮迭代）**：
1. v1：暂停瞬间 cursor 向前"跳一小段"（最初报告）
2. v2（CSS transition 100ms 平滑）：跳改成"软跳"但仍可见
3. v3（rAF + dt 外推 + pause 冻结 `lastExtrapolated`）：跳消失，但播放中 cursor 周期性抖动；暂停后仍偶尔向前
4. v4（虚拟播放头 + PAUSE_FREEZE 280ms + SEEK_THRESHOLD_PAUSED=5ms 自动 snap）：向前跳没了，但**改成向后退一点**——用户原话"暂停时光标往后小退一点点"

**根因 A：hook 局部状态被父组件重渲染重置**

`useCursorAnimation` 最初把 `displayed / lastTickTime` 等放在 `useEffect` 局部变量，依赖数组 `[ref, updater]`。父组件 `ControlBar` 在 mpv 每 ~33ms 一次的 `time-pos` 事件下重渲染，子组件 `ProgressFill / ProgressThumb` 也跟着重渲染 → 传入的 inline `updater` 引用变 → `useEffect` cleanup + 重 setup → 局部 `displayed` 重置为 `s.position`。每秒被重置 30 次，dt 累加完全丢失连续性。表现就是播放中持续微抖、暂停瞬间瞬移。

**修复 A**：把 rAF 状态提到**模块级单例**（`useCursorAnimation.ts` 顶部）。整个 app 共享一个 tick，订阅者通过 `useVirtualPlayhead(callback)` 注册回调；父组件重渲染不影响模块级 `displayed`。`useCursorAnimation(ref, updater)` 成为 `useVirtualPlayhead` 的薄包装。所有 cursor（ProgressFill / ProgressThumb / WaveformCursor）+ `WaveSurfer.setTime` 都接到同一个 tick，绝对同步。

**根因 B：mpv 暂停时 `position` 不能可靠反映"用户视觉真实位置"**

暂停瞬间 mpv 内部状态会有几十毫秒**多方向浮动**：
- 先发出最后几次 `time-pos`（buffered frames），值比真实位置**略前**
- 然后回退一帧到"暂停显示的上一帧"位置，值比真实位置**略后**

任何"自动 snap 到 mpv `position`"的逻辑都会跟着这种浮动抖动。修复 A 的 `SEEK_THRESHOLD_PAUSED=5ms` 自动 snap 就吃了 root cause B 的亏——把 cursor 拽回 mpv 报的"略后位置"。

**修复 B**：暂停时**完全不自动 snap**。只在用户主动操作（`seek*` / `frameStep*` / `loadFile`）时由调用方显式调 `forcePlayheadSnap()` 触发一次性 snap。`mpv.ts` 内所有这些函数前都加了这一行：

```ts
export async function seekAbsolute(seconds: number) {
  forcePlayheadSnap();
  await command("seek", [seconds, "absolute"]);
}
```

`forcePlayheadSnap()` 同时立即解除 PAUSE_FREEZE 280ms 冻结窗，确保用户暂停后立刻按 Ctrl+→ 单帧步进有视觉反馈。代价：暂停时 cursor 跟 mpv 实际位置可能有几十毫秒偏差，但稳定不动（肉眼几乎不可见）。

**经验教训**：
- 高频外部事件（mpv property change 30Hz）+ 子组件 inline 函数 → 隐式高频 `useEffect` cleanup/restart。任何"用 useEffect 持有 rAF 局部状态"的模式都会被这种重渲染节奏摧毁。**模块级单例 + Hook 内只挂订阅** 是最稳的桥接。
- **不要相信外部状态机（mpv / OS / hardware）在状态转换边界上的瞬时值**。"暂停发生时 mpv 报的 position"不等于"用户视觉上停在哪一帧"，两者可能差几帧。边界上的事件值会多方向浮动，跟着浮动 = 跟着抖。
- "自动检测 seek + 自动 snap"的阈值永远是 trade-off。退路是**让调用方告诉播放头何时需要 snap**（forcePlayheadSnap 模式），完全消除被动猜测。

### 6.23 PlaylistPanel 切换"白色漏光" —— DOM 缺席瞬态 + 透明窗穿透到桌面

**现象**：折叠/展开 PlaylistPanel 的瞬间，右侧 280px 区域闪一下"白色漏光"——能看到桌面或底层应用（深色主题用户看起来则是"灰光"或当前桌面壁纸）。

**几轮错误的方向（值得记录避免再走）**：
1. **猜：WebView2 默认背景白色**。加 `<meta name="color-scheme" content="dark">`。冷启动闪改善了一些，运行时切换还是漏。
2. **猜：mpv margin IPC 还没生效就 mount 了组件**。加 80ms `renderPlaylist` 延迟、加 250ms `guard` 黑底占位。改善但仍偶发（mpv IPC 实际生效时间不稳定）。
3. **猜：mpv vo 配置问题，让 mpv 自己填黑色**。设 `background=#000000`——但这跟旧 `force-window=immediate` 组合让 init 死锁（详见 §6.4）。

**真正根因**（社区调研 + 多方文档交叉验证）：

Tauri `transparent: true` 让窗口本身透明 —— 透明区域不是"WebView2 默认背景"，而是真的**穿透到桌面合成**。`color-scheme: dark` 只影响 WebView2 内部的内容色（input border / scrollbar），**不影响透明窗的穿透**。

PlaylistPanel `mount/unmount` 与 `setVideoMarginRatio` IPC 异步之间有 80-200ms 的"**DOM 缺席瞬态**"：那 280px 区域既没有不透明 DOM 占位、mpv 又因 margin 已让出不在那绘制 → 直接穿透到桌面 → 用户桌面 / IDE / 浏览器是什么色就显示什么色。

**根治方案（双重保险，从两端封堵）**：

1. **应用层（消除 DOM 缺席瞬态）**：PlaylistPanel 改为**始终挂载** + `position: absolute right-0` + `transform: translateX(width)` 把自己滑到屏外。DOM 永远占住右侧 `playlistWidth` 不透明黑底位置，mpv margin 切换无论快慢都不会露底。`transform` 是 compositor-only 属性，零 layout/paint，纯 GPU 合成动画。同时给 panel 加 `contain: layout paint` 隔离样式变化对外层的影响。
2. **mpv 层（即使 DOM 缺席也兜底）**：mpv init 选项加 `background-color=#000000` + `background=color`（mpv 0.40+ 语义），让 `video-margin-ratio` 让出的区域用纯黑帧填充而不是透明。即使 panel 滑动中 mpv 还没及时扩展 margin，露出的也是黑色不是桌面。

注意 `background=color` 是 mpv 0.40 引入的**新含义**（如何处理 alpha 帧），跟老版本的 `--background` 是颜色值不同。zhongfly 的 windows build 是 mpv 0.40+ 没问题。如果哪天换更老版本，要改成 `--background=#000000`。

**经验教训**：
- **Tauri 透明窗的"透明"是真的穿透到桌面合成**，不是 WebView2 内部默认色。一切"漏光"类问题都要先问"这块区域有没有 (不透明 DOM 占位 OR mpv 在这绘制不透明帧)"——任何一个都行但**必须有一个**，否则一定漏。
- **补漏（延迟、guard、color-scheme）治标不治本**。消除"DOM 缺席瞬态"+ mpv 端填黑兜底才是根治。
- mpv 在透明窗下的最佳配置是 `background-color=#000000 + background=color` 强制填黑，而不是依赖默认行为。
- **WebView2 `WEBVIEW2_DEFAULT_BACKGROUND_COLOR` 环境变量**（社区调研里查到的另一个工具）能在 controller 创建前锁定底层背景色，但仅支持 alpha=0 全透或 alpha=FF 全不透；对透明窗（要 mpv 透出来）只能设 `00000000`，对运行时漏光帮助不大。我们没用这个。

### 6.24 mpv `force-window=yes` + `background-color=#000000` 在 wid embed 模式可行

**现象延伸**：§6.4 记录过 `force-window=immediate + background=#000000` 让 init 死锁。这次重新引入 mpv 背景填色的需求时，担心会复现。

**实测结论**：
- `force-window=immediate`（立即出窗口，无视频时也维持）+ `background=#000000`：**死锁**
- 不设 `force-window`（默认 `auto`）+ `background-color=#000000` + `background=color`：**OK**，init 正常
- `force-window=yes`（有内容才出窗口）+ 上述背景选项：**OK**

mpv 0.40 把选项重命名了：旧 `--background` → `--background-color`（颜色值），新 `--background` 现在表示"如何处理带 alpha 的帧"（`color` / `tiles` / `none`），两个独立。旧名字配新值会直接报错或解析错误。

**经验教训**：mpv 初始化选项是"地雷区"——看起来无害的两个选项组合可能死锁/挂起，且没有任何错误日志。新加 mpv 选项的规范流程：**release build 测一遍 init 能否完成 + 视频能否播 + 切换文件能否切**，缺一不可。

> **后续生产实施（见 §6.28）**：`force-window=yes + idle=yes + background-color=#000000 + background=color` 后来被实际启用以根除首次视频加载瞬间桌面穿透。

### 6.25 mpv `time-pos` property-change 在无音频 / 部分容器场景下不持续发出

**现象**：拖入一段没有音轨的 mp4 / webm（或部分 m4v / ts 容器），mpv 正常播放（双击有暂停反馈、duration 显示正常、画面也在走），但**进度条停在 0 不动**；切换到普通有音轨视频又一切正常。

**根因**：mpv 的 property change 通知不是 100% 可靠的——某些 demuxer / 无 audio renderer 的回调路径下，`time-pos` 只在 file-loaded 那一刻发一次"初始值 0"，之后**不再周期性 emit**。`useMpv` 的 observer 没有事件可监听，store 里的 `position` 一直停在 0。`useCursorAnimation` 虽然在 rAF 里推动 displayed，但虚拟播放头要么以 store.position 为 anchor 做外推、要么在 PAUSE 检测下不外推——anchor 一直是 0，导致光标看上去没动。

**修复**（两层兜底，互相独立）：

1. **`file-loaded` 后主动 sync** —— 监听到 `file-loaded` 事件立刻 `getProperty('pause' | 'time-pos' | 'duration')` 一次填回 store。覆盖"切文件后第一帧的初始值丢失"。
2. **1Hz 轮询 fallback** —— `useMpv` mount 时挂一个 `setInterval(1000)`：满足 `mpvReady && isPlaying && currentIndex≥0 && fileLoaded` 才发 `getProperty('time-pos')`，差异 > 100ms 才覆盖 `store.position`。这个阈值是为了让正常的 property-change 链（在能跑的视频上 ~30Hz）继续主导更新，**只在它沉默时**补一次。

为什么不无脑提高 polling 频率？两个原因：
- IPC 不便宜，1Hz 即可让"进度条停滞"问题在用户感知上消失（位置最多落后 1 秒，rAF 虚拟播放头会平滑外推填空）
- 跟 property-change 30Hz 频率重叠会让 store.position 来回被两个 source 写,反而引入抖动

**经验教训**：libmpv property observer 是"高可用但非保证"——把它当成主信道，但每个核心同步都要有 fallback 路径。`time-pos` 是受这种漏发影响最严重的属性（高频且核心交互依赖），其它属性（duration / volume / mute）只在变化时发，一次成功就够，不需要 polling。

### 6.26 fixed-positioned 子代被 transform/contain/filter 父链"吞掉"——React Portal 才能真正脱离

**现象**：PlaylistItem 的右键菜单（`position: fixed`）本来应该跟着鼠标点位置出现，但在 PlaylistPanel 里点右键**完全看不见菜单**；移到顶部 TopBar 区域点右键又能正常出现。怀疑 z-index 被压低，加到 z-[9999] 还是看不见。

**根因（耗时多轮才定位）**：CSS 规范里 fixed 元素的 containing block **默认是 viewport**，但只要祖先链上**任何一个**祖先满足以下条件，containing block 就被改为那个祖先：

- `transform` 任意非 `none` 值（**最常踩的坑**）
- `perspective` 非 `none`
- `filter` 非 `none`
- `will-change` 包含 `transform` / `filter` / `perspective`
- `backdrop-filter` 非 `none`
- `contain: paint` / `contain: layout` / `contain: strict`

PlaylistPanel 为了滑入滑出动画用了 `transform: translateX(0/width)`（详见 §6.23），它的 transform 把所有内部 fixed 子代的"viewport 锚定"拉到了 panel 的边界框内。panel 自己宽 280px，菜单 `left: e.clientX (鼠标全局 X)` 会被解读为"相对 panel 左上角"——结果菜单实际渲染在屏幕外面，看不见。

**早期错误猜测**：以为是 `contain: paint`，移除后无效；以为是 z-index，提到 9999 也无效。直到读到 MDN containing-block 规范才意识到 transform 也算。

**修复**：用 React `createPortal(menuJSX, document.body)` 把菜单的 DOM 节点直接挂到 `<body>` 下。**Portal 只移动 DOM 不影响 React tree**——事件冒泡仍按 React tree（菜单 onClick 还能拿到 PlaylistItem 的 state 闭包），但 CSS 渲染（containing block 计算）按真实 DOM 父链——body 下没有任何 transform/contain 祖先，fixed 定位重新锚定到 viewport。

```tsx
{menu && createPortal(
  <>
    <div className="fixed inset-0 z-[120]" onClick={closeMenu} />
    <div className="fixed z-[121] ..." style={{ left: menu.x, top: menu.y }}>...</div>
  </>,
  document.body,
)}
```

**经验教训**：
- 任何"我用了 transform 做合成器动画"的容器，**它内部的 fixed 定位元素都已经不是 fixed-to-viewport 了**。这是 CSS 的隐式行为，跟 `position: fixed` 字面意思完全相反。
- 不止 transform——`contain: paint`/`filter`/`will-change: transform`/`backdrop-filter` 都有同样副作用。任何用了它们做合成器优化的容器都要警惕。
- Portal 是逃逸唯一可靠方案。z-index、translate offset 等"调位置"补救都治标不治本，跨 viewport 边界还会因不同分辨率失效。

### 6.27 全屏整体 auto-hide 太粗暴 —— 改为顶/底独立 edge-reveal

**现象/反馈**：早期版本全屏后 TopBar + ControlBar + WaveformStrip 整体跟 3s mouse-idle 一起隐藏；用户报告"想看一眼进度只能动一下鼠标，整组 UI 跳出来打断观看"。

**改进设计**：

| 区域 | 触发条件 | 隐藏条件 |
|---|---|---|
| TopBar (文件名) | 鼠标 y < 80px | y ≥ 80px 立即隐 |
| 底部容器 (Waveform+ControlBar) | 鼠标 y > height − 140px | y ≤ height − 140px 立即隐 |
| 鼠标光标 | 显示 | 3s 不动则 `cursor-hidden` class |

两边独立：用户瞄一眼进度只用把鼠标推到底部，TopBar 不会跟着冒出来；想看文件名只挪到顶部，进度条不会跟着出。

**关键实现**（`useFullscreenReveal` hook in `App.tsx`）：

- 非全屏：`topVisible = bottomVisible = true`，cursor 永久可见
- 全屏 mount：初始 `false`（避免进入全屏先闪一下）
- `mousemove` 监听器：每帧分别算 `nearTop / nearBottom`
- TopBar 改用受外控的 `fullscreenTopVisible` prop（**不再** `if (fullscreen) return null`）
- 底部容器在全屏时切到 `position: absolute; bottom: 0` + `transform: translateY(bottomVisible ? 0 : 110%)`，**transition 走 GPU 合成**（不是 display: none / opacity ramp，避免 reflow）；非全屏退回 flex 子项布局

**经验教训**：
- "auto-hide 整组 UI" 在媒体播放器场景下是反习惯的——VLC / PotPlayer / Windows Movies&TV 都是分区域 edge-reveal。UX 决策要看主流软件的成熟约定。
- 滑入滑出**永远用 `transform: translateY`**，不用 `display: none ↔ block` 也不用 `height: 0 ↔ auto`——前两者会 reflow，translateY 是 compositor-only。
- 全屏切换是高频状态转换，TopBar / ControlBar 这类长期 mount 的组件**不能内部 early return null**——隐藏靠样式而非卸载，重新出现没有"重挂载"成本，prop 受控逻辑也更清晰。

### 6.28 首次视频加载瞬间桌面穿透 —— `force-window=yes + idle=yes` 让 mpv 子窗口永远在场

**现象**：双击 mp4 启动 mplayer（或在空闲态拖入第一个文件）的瞬间，视频区会闪一下桌面/底层应用——用户原话"播放器自动打开加载视频的时候，会一瞬间播放区域能够看到软件下面的桌面"。

**根因**：mpv 默认 `force-window=no`，**没文件就不创建 OS 子窗口**。整个启动流程是：

1. Tauri 主窗口创建（transparent: true）
2. mpv plugin init（仅 libmpv 实例，无子窗口）
3. 用户拖入文件 → `loadfile` → mpv demux/decode → 拿到第一帧 → 创建子窗口 → 出图

第 1~2 步之间的视频区是**纯透明穿透到桌面**（没 mpv 子窗口、没 DOM 占位）；第 3 步的"创建子窗口到第一帧"间还有几十到几百毫秒。这段时间用户就看到了桌面或底层窗口。

§6.23 解决的是 PlaylistPanel 切换时的运行时漏光（用 DOM 始终占位 + mpv 填黑兜底），但启动期主区还是没 mpv 子窗口可填——DOM 那里是 PlayerView 的 idle overlay 不透明黑底，能盖住到 file-loaded 前；但 file-loaded 那一刹 idle overlay 被 fileLoaded → showOverlay=false 撤掉，**而 mpv 子窗口还在创建中**，那一两帧的窗口空缺就漏给桌面了。

**修复**：mpv init options 加 `force-window=yes` + `idle=yes`。

- `force-window=yes`：**没文件也创建子窗口**。Tauri 窗口出来的同时 mpv 子窗口就在那填黑（来自 §6.24 验证可行的 `background-color=#000000 + background=color`），整个生命周期里"主区有 mpv 子窗口"都是真的。
- `idle=yes`：mpv 配合 force-window 用——播放完一个文件不退出 mpv 循环，待下个 `loadfile`，子窗口持续在。

不能用 `force-window=immediate`：跟 background 选项组合会让 init 死锁（§6.4 / §6.24 已验证）。`yes` 是"载入第一个 file 时若没有视频/封面才创建空窗口"，跟我们要的"启动就创建"等价但不死锁。

**经验教训**：
- 早期 §6.21 / §6.23 已经梳理过"透明窗下任何视频区都必须有 DOM 占位 OR mpv 子窗口填充"的铁律，但**子窗口创建时刻** 这个边界条件被忽视了。把"子窗口存在性"从"loadfile 之后"提前到"plugin init 之后"，就消除了所有"加载瞬间穿透"场景。
- mpv idle / force-window 不只是"无文件时显示什么"的问题，而是"OS 子窗口存在与否"的开关。Tauri 透明窗这种依赖子窗口当遮罩的方案下，这俩选项几乎是必开的。

### 6.29 单曲循环不无缝 —— JS event-driven loop 永远做不到 sample-accurate

**现象**：playbackMode = `loop-single`,可循环音频(在 DAW 里 sample-accurate 无缝)在 mplayer 里 loop 起点能听到一瞬空白/卡顿。视频文件循环也有同样的画面短暂停顿,只是听觉不如音频敏感。

**根因**:早期实现走 JS event-driven 路径:

```
mpv 解码到文件末尾
  └─► mpv 发出 eof-reached property-change 事件
        └─► IPC 跨进程边界 (mpv → Tauri → WebView2 → JS)
              └─► useMpv observer 回调 → handleEof()
                    └─► await seekAbsolute(0)        ← IPC 1
                          └─► mpv 解码器跳到起始 (有 demux + 解码 lead-in)
                                └─► await setProperty('pause', false)  ← IPC 2
                                      └─► 终于继续播放
```

整条链路的累计延迟在硬件上有 30-150ms 不等(IPC roundtrip 各 ~5-20ms,event 派发 ~5ms,demux seek ~10-50ms,解码器 lead-in 50-100ms);音频输出缓冲被掏空 → 你听到的"loop 瞬间空白"。**JS 永远做不到 sample-accurate 循环** —— 即使把 IPC 和 event 优化到零,解码器的 seek lead-in 也不可能为零。

**修复**:让 mpv 在解码器层自己循环。mpv 内置 `loop-file=inf` 属性 ——

- 解码器从文件末尾 sample 直接接到起始 sample,**audio output 缓冲连续不掉一帧**
- 不发 `eof-reached` 事件,JS observer 完全旁路
- 零 IPC,零 JS roundtrip
- 行为跟 DAW 的 sample-accurate loop 一致

实现是 `src/hooks/useLoopMode.ts` 一个 sidecar hook:监听 `settingsStore.playbackMode`,变成 `loop-single` 时 `setProperty('loop-file', 'inf')`,其它模式 `setProperty('loop-file', 'no')`。`loop-file` 是 mpv global property,`loadfile` 后保持,不需要每次切文件 reaffirm。

`useMpv.handleEof` 里的 `loop-single` 分支保留作 fallback:某些容器/编码下 `loop-file` 万一不生效,仍能靠 JS seek(0)+unpause 兜底续播 —— 代价是非无缝,但比 EOF 后停下来强。

**经验教训**:
- **任何要"无缝"的事情都不能走 JS event loop** —— Web 技术栈跟 native audio 引擎的延迟量级差两个数量级(JS event/IPC 是毫秒级,解码器 sample 是亚毫秒级)。要无缝就必须下沉到引擎(mpv / native audio API)自己处理。
- 这同样适用于 **gapless playback**(连播两个文件无空隙)。mpv 有 `prefetch-playlist=yes` + `--gapless-audio=yes` 可以实现,目前没接 —— 留作未来优化。如果用户报告播放列表切歌有空白,按同样原理走 mpv 内部 prefetch 而不是 JS 监听 EOF 再加载下一首。
- 类比:这跟 §6.22 "不要相信外部状态机在状态转换边界上的瞬时值" 同根 —— **状态转换边界上 JS 的及时性都不够用**,要么下沉到 native,要么接受不无缝。

### 6.30 光标"差一点 1:1" —— 陈旧度补偿 + PLL 式连续微调(时钟从动)

**现象**:§6.22 的虚拟播放头方案落地后,光标不再瞬移/抖动,但用户仍反馈"没有 1:1 完美对应的感觉"——光标与音画之间存在感知得到、但说不清的几十 ms 级偏差。

**根因(三个系统性误差源,全部低于 §6.22 方案的修正阈值)**:

1. **snap 采用的 position 是陈旧的**。`store.position` 走 "mpv 发出 → Rust → Tauri IPC → JS 事件循环 → 下一个 rAF 消费" 链路,消费时已过期 5~40ms。`playerStore.setPosition` 一直记录着 `positionObservedAt` 时间戳,但从未被消费(死代码)。每次 snap(seek 后/loadFile 后/初始化)都注入一个随机常量滞后。
2. **<300ms 的误差永不收敛**。播放中 displayed 纯 dt 自由累加,只有偏差 >300ms 才 snap——snap 注入的滞后、以及每次暂停/恢复循环因 mpv pause-retreat(§6.22 根因 B)注入的几十 ms 偏移,全部**永久保留且可累积**。
3. **相对 seek 按关键帧对齐**。mpv 默认 `hr-seek` 配置下方向键快进/快退落在关键帧上,长 GOP 视频"跳 5 秒、落在几秒外"。(`frameStepBy` 早已用 `relative+exact`,§6.16,但方向键和进度条没用。)

**修复(时钟从动 clock-slaving,`useCursorAnimation.ts`)**:

1. **陈旧度补偿(age compensation)**:外推真值 = `position + (now − max(positionObservedAt, playStartedAt)) × speed`,上限 `AGE_CAP=1.5s`(覆盖 §6.25 的 1Hz fallback poll,再旧视为停滞不外推)。`playStartedAt` 下界必不可少——恢复播放的瞬间若从 `positionObservedAt` 起算,会把整个暂停时长外推进去导致 snap 到天文数字。
2. **PLL 式连续微调(slew)**:播放中每帧 `err = 外推真值 − displayed`;|err| > 300ms 硬 snap(真 seek/loop 回绕兜底),否则按时间常数 `SLEW_TAU=0.4s` 指数收敛,修正速率钳制在 `±10% × speed`(数学上保证光标永不倒退:`dt×speed − 0.1×dt×speed > 0`)。任何来源的小偏差 ~1s 内无感归零。
3. **暂停行为完全不变**:不自动修正(§6.22 教训仍然成立),暂停期间的残留偏差交给恢复播放后的 slew 处理。
4. **`hr-seek=yes`** 进 mpv init 选项:所有 seek 精确到时间点。代价是长 GOP 上 seek 稍慢,对帧级检查工具是正确的 trade-off。
5. **顺带修复拖拽边角 bug**:tick 的拖动分支原来每帧 `lastSeenPosition = s.position`,会把松手后 200ms 乐观窗内到达的 seek 回报静默吞掉——暂停态下 `forceNextSnap` 从此等不到"下一次 position 变化",光标停在点击处而非 mpv 实际落点(非精确 seek 时代两者可差数秒)。修复:拖动分支不消费 `lastSeenPosition`。
6. **"真在播"门控 `playing = isPlaying && fileLoaded`**:mpv `idle=yes` 且无文件时 pause=false → `isPlaying=true` 但 position 永远 0——若按播放处理,displayed 空转累加、被外推上限拽回,0.3s 一次锯齿 snap(UI 不可见但污染调试统计;真机实测空闲 40s 攒了 ~118 次)。门控后空闲期完全静默,稳态播放 10s 实测 snap 增量为 0。

**验证工具**:`SyncDebugOverlay.tsx`(默认 `Ctrl+Shift+D`,已注册为 ShortcutAction 可在设置面板重绑;状态不持久化)。实时显示本帧残差 err、5s 窗口 avg/min/max、position 观测频率(事件链正常 ~30Hz / poll 兜底 ~1Hz)、观测陈旧度 age、硬 snap 计数。把"1:1 的感觉"变成可测数字。衍生产品功能:`TimecodeOsd.tsx`(默认 `T`)——左上角毫秒级时间码 + 帧号 OSD,数据源同为虚拟播放头,帧号换算与 GotoFrameDialog 一致(`round(displayed × fps)`)。

**经验教训**:
- **异步观测值必须带时间戳消费**。跨 IPC 的时钟读数在到达时已是历史值,"读到什么就用什么"每次都注入随机滞后。记录观测时刻、消费时外推,是所有"UI 从动外部时钟"场景的标配(游戏 netcode 的 entity interpolation 同理)。
- **"自由跑 + 大阈值 snap"会让小误差永生**。阈值之下需要一条连续收敛路径(slew/PLL),阈值只留给真正的不连续事件(seek)。收敛速率必须钳制在感知阈值内,否则修正本身变成新的抖动源。
- 外推的起点必须限定在"时钟确实在走"的时段内(`playStartedAt` 下界),否则暂停/恢复边界会产生巨大伪 seek——又是 §6.22 "状态转换边界" 的变体。

### 6.31 波形缓存键缺内容指纹 —— 同路径覆盖后静音区显示旧波形

**现象**:用户报告(长期使用仅出现一次):某文件的**静音区域**上显示着波形。重启后消失,无法复现。

**根因**:`peaks.ts` 的 LRU 缓存键只有 `路径::samplesPerPixel`,不含任何内容指纹。触发链:播放文件 A → 波形入缓存 → **同路径**文件被重新导出/覆盖(AI 配音工作流里 mt/aivc 重渲染同名 wav 是常态)→ 再次播放 → mpv 播的是新音频,波形图给的是旧内容 → 新版本的静音区叠着旧版本的波形。缓存在内存(20 条 LRU),重启/换播 20 个文件后自动消失——完美解释"只见过一次"。

**为什么不是别的**:wavesurfer `normalize: true` 放大近静音文件的噪声底也能造成"静音区有波形",但那是**每次打开该文件都复现**的确定性现象,与一次性不符。

**修复**:Rust 端加 `file_fingerprint` 命令(`std::fs::metadata` 取 size + mtime_ms,微秒级开销),`getPeaks` 先取指纹再拼缓存键 `路径::spp::size:mtime`。stat 失败(文件消失/网络盘抖动)退化为路径级键,行为与旧版一致,不影响可用性。

**更正(§6.32)**:指纹键只有在 `getPeaks` 被重新调用时才起作用,而当时 WaveformStrip 的取数只依赖路径,同一路径覆盖后重新打开并不会重取——此处"旧波形立即失效"的说法并不成立。§6.32 让取数依赖加载代次(`loadSeq`)才真正补上;缓存键现为 `路径::v2::a<音轨序号>::size:mtime`。

**经验教训**:**凡是"按路径缓存派生数据"的地方,路径都不是身份,内容才是**。文件会被原地覆盖——尤其在媒体生产工作流里。廉价的 size+mtime 指纹能挡住 99.9% 的失效场景(碰撞需要"同大小 + 同 mtime + 不同内容",实际不发生)。

### 6.32 波形 ↔ 声音"一直差一点" —— time-pos 不是音频时钟 + 波形没有时间轴

**现象**:§6.30 之后 SyncDebugOverlay 的 err 已是 ±几 ms,但用户仍反馈"波形和声音的同步一直有点小问题,以前只是减少了"。err 的定义是"外推值 − displayed",只衡量光标对外推值的跟随;"外推值本身离声音多远"和"波形画在哪"这两类整体偏移它测不到——本节的根因全在这里。

**根因 A:time-pos 不等于"正在响"的位置**(离线 libmpv ctypes 探针 + 真实 WASAPI 事件录制 + loopback 对拍;App 内 Ctrl+Shift+D 的 `tp−ap` 可直接看到)

1. **单曲循环(loop-file=inf)回绕**:解码端先 seek 回 0,time-pos 立刻报 0.0 并冻结,而 AO 缓冲里上一圈的尾巴还要再响约 250ms(ao=null 下约 350ms)。旧算法 |err|>300ms 硬 snap 到 0 → 光标提前回绕;之后约 −250ms 的误差低于阈值,只能按 10% 慢追,2s 片段一圈追不完——回放实测平均领先 146ms、峰值 262ms。
2. **视频文件**:time-pos = 刚送进 VO 队列的视频帧 pts(mpv `video.c` 在 `vo_queue_frame` 之前赋值),比声音超前 1–2 帧:vo=null 实测 24fps +44~49ms、60fps +33ms;App 内 gpu-next 实测 24fps `tp−ap` ≈ +36ms。
3. **seek / 起播**:time-pos 立刻报落点,音频要再过 20–50ms 才真正开始;旧算法立即外推 → 光标先走,领先 14–55ms、约 1s 收敛。
4. **变速**:1→1.5 倍时 mpv 时钟真实回退约 146ms(loopback 证实声音同样回退),10% slew 需约 1s → 平均领先 56ms。
5. **暂停恢复**:音频真实起点相对暂停位置浮动 −31~+15ms,slew 慢追 → p95 22ms。

**根因 B:波形没有时间轴,只是被拉满宽度**(ffmpeg 生成 1.000s / 2.500s 脉冲测试音,mpv `ao=pcm` 录真实输出 vs symphonia 解码对拍)

1. symphonia 0.5.5 不应用容器起点 / priming(`enable_gapless` 只作用于 MP3/Ogg;isomp4 解析了 elst 但不用;mkv 无 CodecDelay 处理;AAC 解码器不裁):LAME MP3 +25.06ms、AAC(m4a/mp4/mkv)+21.3~23.2ms、音轨晚于视频起播(elst 空编辑 / mkv 首块时间戳)−178~−500ms。mpv 全部会应用。
2. wavesurfer 把 peaks 均匀铺满画布,横轴 = symphonia 解码时长;WaveformCursor 按 mpv duration 定位;带 `url` 时 wavesurfer 自己的进度/光标又按 `<audio>.duration` 定位——三个时长来源。音频短于视频(mov 3.0s / 3.5s)时 1s 处错 167ms、2.5s 处错 417ms。
3. spp=512 的桶起点量化:桶内瞬态从桶起点开始亮,WAV 也平均偏早 5.5~8.9ms(24kHz TTS 13~17ms)。
4. 每帧 `ws.setTime` 给真实 `<audio>` 赋 currentTime = 每帧一次完整 media seek(暂停时同值也 seek),纯浪费主线程。

**修复**

- 时钟(`src/lib/playheadClock.ts` 纯逻辑;`useCursorAnimation.ts` 只剩 rAF / 订阅分发):
  - 新观测 `audio-pts`(= 已写入 pts − speed × 驱动延迟),有音轨时作主时钟;tick 改用 rAF 帧时间戳;"有音轨"以 track-list 的 `selected` 为准,三态:start-file 置为未知(`tracksKnown=false`),非空 track-list 事件或 file-loaded 主动查询后才确认——未知时不按"无音轨"处理(否则起播时会在音频出声前开走)。
  - **用户操作(op)**:seek / 帧步进 / loadFile 前由调用方 `forcePlayheadSnap()` 登记。事件到达 JS 的时刻不能说明 mpv 何时产生它(插件每个事件单独 spawn 转发,操作发出后、mpv 执行前产生的旧值照样晚到);命令返回后立即查询 time-pos 也不可靠(实测播放中 mp4 仍可能读到旧值,暂停中 wav 3ms 后已是 AO 缓冲虚值)。所以 seek / 加载类 op 以 mpv 的 `playback-restart` 事件(`store.restartAt`)为"完成"标记,属于本次操作的回报 = op 之后、完成之前到达的 time-pos(按观测时刻比较,落点与 restart 常在同一帧内先后到达):
    - **目标提示**:seek 类 op 登记时带上预期落点(绝对 seek = 目标秒数;相对 seek / 多帧步进 = mpv 当前位置 + 位移,基准与 mpv 相对 seek 一致取 time-pos,播放中外推的起点不早于恢复播放时刻;连按方向键时上一次 seek 尚未执行——最新位置回报还不在它的目标附近——就在它的目标上累计(mpv 也会把排队中的相对 seek 合并),1.5s 兜底;加载 = 0;按时长钳制)。有目标时只认与目标相差 ≤0.12s(容纳视频帧对齐,循环按环形距离)的回报为落点——操作前在途的旧位置、暂停 seek 后 mpv 报出的 AO 缓冲虚值(纯音频暂停 seek 完成约 50ms 后出现,ao=null 实录 −184ms)都在容差外;完成后 300ms 仍无相符回报,直接显示目标本身。帧步进没有目标提示;
    - 暂停态:跟随相符的回报(视频完成后才到的"真实显示帧"也会采用,例 0.81→0.8333);无目标时跟随完成之前到达的回报,完成标记被乱序转发得比落点早时采用完成后的第一条;暂停跟随最多 3s;
    - 播放态:光标钉在落点(hold,不走),直到"完成之后(且若中途恢复过播放,则恢复之后)"的首个有效 audio-pts 再对齐。这条 audio 必须与落点(尚无落点时与目标)相容:外推值 − 参照 ∈ [−0.1s, 0.25s + 完成后流逝时间 × speed],循环按环形距离,否则视为乱序晚到的旧值、等下一条;对齐带不后退保护(落后 <150ms 时保持不动,由 slew 以 90% 速度等外推追上);解除后 0.5s 内新到的 audio-pts 若偏差 >30ms 直接对齐(兜住小幅 seek 时旧值恰好通过相容检查的情况,时钟源切到 time-pos 即关闭该窗口);超时 2s 兜底;确认无音轨时拿到落点(或按目标)后解除;
    - mpv 的 `frame-step` 不产生 restart,`frame-back-step` 的落点晚于它自己的 restart 约 55ms 到达,两者都按"帧步进"语义登记:暂停中一直跟随回报,直到下一次操作 / 恢复播放;帧步进会先报 pause=0 再与落点同批报 pause=1,200ms 内不因音频时钟解除钉住(防同批事件乱序);
    - 早于最近一次 op 的 audio-pts 一律作废;`frameStepBy` 的登记挪到查 fps 的 IPC 之后、发 seek 之前。
  - 暂停态没有 op 时不采用任何 position 回报(涵盖并取代旧的 280ms 冻结窗);暂停中窗口后台 >1s 后恢复也保持原值。
  - 回绕等内部原因 audio-pts 短暂为 null → **coast**(按 dt 惯性前进、不修正);回绕尾巴的负值 + duration;单曲循环时 displayed 与误差都按 duration 取模(op 钉住期间不取模);audio-pts 播放中 >600ms 不更新视为停更,退回 time-pos(1Hz poll 兜底)。
  - 变速后首个新观测直接 snap;恢复播放后首个新观测若光标落后则一步追上(只向前)。
  - 无音轨 / aid=no:退回 time-pos 外推(旧行为)。
  - `useMpv`:start-file 时 duration 归零、audioPts 置 null、tracks 清空、`loadSeq` 递增;file-loaded 的兜底查询(pause / time-pos / duration / track-list / aid)落地前核对 loadSeq;1Hz poll 只在事件链沉默 >500ms 时触发,请求在途期间 position / audio / restart / loadSeq 任一变化则作废。
- 波形(`src-tauri/src/peaks.rs` + `media_timing.rs`,前端 `src/lib/waveTimeline.ts`):
  - 流式分桶(不再整文件样本常驻内存),每桶 16 帧起,满 16384 桶时相邻合并、帧数翻倍;
  - 返回 `startTime`(解码第 0 帧在 mpv 时间轴上的秒数):MP4 elst;MKV = 音轨首包 − 首个 Cluster 的 Timestamp(mpv demux_mkv 的 `probe_first_timestamp` 就以它为 start_time)− CodecDelay,Info / Tracks 排在 Cluster 之后时按 SeekHead 跳过去读;裸 MP3 = −LAME delay。**不开** `enable_gapless`:无 Xing 头的 MP3 会按估算帧数截尾 26ms,而 mpv 不截;
  - 按包时间戳补齐 >10ms 的流内缺口(分片 MP4 首样本时长被拉长、MKV 中途时间戳跳变、解码失败被跳过的包),累计上限 6h;时间戳一律按 i64 处理(symphonia mkv 对负的块相对时间戳做 u64 减法,release 回绕、debug 溢出 panic——dev profile 已对该依赖关闭 overflow-checks,与 release 一致),|startTime| ≥ 1 天视为异常退回 0;采样率以解码输出为准;
  - 按 mpv 当前选中的音轨选轨:`audioIndex` = 选中音轨在音轨中的序号,Rust 按容器顺序取第 N 条音轨(MP4 数 hdlr=soun 的 trak、MKV 数 TrackType=2 的 TrackEntry——symphonia 对 MP4 里解不了的音轨不给采样率,无法与视频轨区分);序号越界或所选音轨 symphonia 解不了时明确报"不可用",不再拿别的音轨冒充;aid=no 时取第一条作预览;缓存键含音轨;
  - 前端唯一时间轴 axis = mpv duration,peaks 按真实时间重采样到每 CSS px 一格:晚起播左侧留空、音频短于视频右侧留空、priming / 尾 padding 被裁、末桶按真实结尾裁剪;光标、已播放填色、点击 seek 共用 `timeToFrac / fracToTime`;mpv 时长确认(fileLoaded && duration>0)前不按猜测的轴重画、不画填色、不接受点击;
  - WaveformStrip 取数依赖 `[path, audioIndex, loadSeq]`,peaks 与加载代次绑定:同一路径被覆盖后重导出再打开也会重取(§6.31 的指纹缓存此前在同路径重开时根本没有被调用),新加载完成后只画本次加载取到的 peaks,不会把旧 peaks 摆到新时长上;加载完成前旧图原样保留;
  - wavesurfer 只当绘制器:不传 url(它内部的 `<audio>` 没有 src、不加载文件)、`cursorWidth: 0`(只留 WaveformCursor)、进度直写 `getRenderer().renderProgress()`、数据更新用 `ws.load('', …)`(7.12.7 的 `setOptions` 重绘的是旧 audioData;`Decoder.normalize` 会原地改写传入数组,所以每次传新数组);
  - `getPeaks` 去掉 spp 参数(LevelMeter 同键共享)并缓存进行中请求(file-loaded 时两组件并发不再各解码一次)。

**验证**(下列测试、录制数据与取证探针均在 `dev-tools/sync/`,`pnpm test:sync` 全跑、`--quick` 跳过 Rust 对拍;说明见该目录 README)

- 波形:38 个样本、43 项对拍(`dev-tools/sync/waveform/check_timing.py` 调 `peaks.rs` 带 `#[ignore]` 的对拍测试:`MPLAYER_TIMING_MEDIA=<dir> [MPLAYER_TIMING_AUDIO_INDEX=n] cargo test --lib -- --ignored --nocapture`)。能解码的样本中,WAV/FLAC/Ogg、LAME·无头 MP3、AAC m4a·ADTS·无 elst m4a·mp4·mkv、音轨延迟起播的 mp4·mkv·mov、10s 起点偏移 mkv、MP4 内 MP3、Tracks 在 Cluster 之后的 mkv 与 mpv 实播 onset 相差 0.1–0.23ms(= 一个 16 帧桶;ADTS / 无 elst m4a / 无头 MP3 两边都含 priming,一致);改前 21–500ms。首 Cluster 时间戳≠首块的 mkv 与 mpv 一致(+100ms);分片 MP4 缺口样本在缺口后测得 mpv 1.580、本实现 1.580;MKV 中途 +300ms 缺口样本 mpv 2.793、本实现 2.800(该测量受 seek 落点影响)。多音轨:第 2 条音轨延迟 300ms 的 mkv 选第 2 条时 onset 1.300(= mpv 默认播放的那条);AC3+AAC 的 mkv / mp4 选 AC3 时报不可用、选 AAC 时正确;序号越界报不可用。负块相对时间戳的畸形 mkv:onset 0.995(mpv 0.9995)。样本中 Opus、AC3、mkv 内 PCM 解码失败(symphonia 不支持)。
- 时钟:录制的真实 mpv 事件流逐帧(144Hz)回放旧 / 新算法,真值 = audio-pts 分段线性拟合:2s 单曲循环 平均 +146→+0.1ms、峰值 262→2.2ms;mp4 24fps +49→−0.2ms;60fps +35→−0.4ms;wav seek 后 0.6s +17.5→−2.4ms;变速后 1.5s wav +56→+4.2ms、mp4 +107→+1.2ms;暂停恢复 wav −7.4→+0.2ms(p95 22→1.8ms)、mp4 +47→+2.6ms。注意:真值来自同一串 audio-pts,它证明的是"跟上 mpv 的音频时钟",不是屏幕与耳朵之间的绝对误差;模拟 L ms 事件链延迟时稳态误差 ≈ −L。
- 暂停 / 帧步进(评审员用 libmpv 录制的真实序列):暂停中连按 5 次单帧前进、4 次单帧后退、播放中单帧前进,光标均精确落到 mpv time-pos(改前单帧前进每步落后约 1 帧);暂停中 seek 视频落到真实显示帧 0.8333(旧实现停在 0.81)、wav 停在 0.81 不采用 184ms 虚值,随后恢复播放不倒退。49 条合成边界用例全过(含 codex 第三、四、五轮给出的全部乱序反例:方向键连按(落点合并 / 逐次执行)、旧 time-pos 先到、无落点时旧 audio 先到、迟到的合法音频、循环回绕后解除、1.5 倍速、音轨表未知时起播、快速对齐不被 time-pos 带跳、暂停 restart→虚值→真落点、无相符回报时显示目标):§6.22 暂停不瞬移、后台恢复、暂停中慢 seek + 旧值先到、restart 先于落点、连续两次 seek、restart 永不到、旧 audio 在 restart 前 / 后晚到、小幅向前 / 向后 seek + 旧锚点、暂停 seek 后立即恢复(不回退到虚值)、拖动松手、帧步进同批乱序、帧步进后恢复不倒退、循环 seek 到末尾、audio 停更、无音轨(含 restart 先于落点)、音轨中途关闭、hold 超时、起播。
- 相对 seek 目标累计(导入真实 `mpv.ts`、模拟 IPC):连按 3 次 +5 → 15/20/25;第一次落点在第二次之后才到仍正确累计;落地后按当前位置;越界钳制;长暂停后立即 +5 不把暂停时长算进目标(修复前 +1.5s)。
- App 内(debug 构建,−45dBFS 测试音,op 状态机之前的版本):单曲循环跨回绕 5s 窗口误差 −6.2~+6.5ms;24fps mp4 `tp−ap` = +35.6ms(即旧算法在视频里的偏早量)、src=audio、err 个位数 ms;音频短于视频时波形右侧留空、刻度与进度条同轴。op 状态机这一版未能在 App 内复测(测试时桌面已锁屏)。

**未解决 / 未测**

- 事件链单程延迟(mpv → Rust → emit → WebView2 → JS)与 rAF → 上屏延迟仍未补偿,光标整体会晚这两段(推测合计 10–25ms,需高速摄像实测)。"用户可调视觉偏移"待实测后再定,默认只能是 0,且必须融进外推真值而非渲染层叠加(否则暂停瞬间精确回退该偏移,§6.22)。
- 事件归属仍是"目标提示 + 完成标记 + 相容性检查"的组合推断,插件没有原生序号;帧步进没有目标提示;极端乱序(旧值被延迟到完成标记之后且与落点相差 <0.25s)时靠解除后 0.5s 快速对齐兜底。loop 内部回绕的 restart 若恰好落在用户 seek 与其自身 restart 之间,op 会被提前判完成(需 seek 落在回绕前约 50ms 内)。frame-back-step 若超过 200ms 才出落点且期间短暂播放,未验证。
- 视频暂停态光标语义:正常播放中按暂停时,光标停在音频时钟位置,画面帧(time-pos)约超前 1 帧;帧步进 / seek 后才精确落到帧 pts。帧步进后恢复播放时光标领先约 1 帧,按"不后退"设计约 1s 内收敛到 <12ms。
- 单曲循环回绕尾巴按 mpv duration 换算:duration 是估算值(无 Xing 头 VBR MP3)时尾巴期间有 |周期−duration| 的偏差。
- mpv duration 本身不可靠时轴也跟着错:无 Xing 头 VBR MP3 实测高估 2 倍 / 播放中持续增长;只有音频的 MP4 带空编辑时 time-pos 会超过 duration(波形尾部被裁、光标在末端停住)。与 ControlBar 同轴,未另行处理。
- 音轨映射只覆盖容器内置音轨(外部音轨文件、mpv 过滤掉的轨不在映射内);多段 MP4 edit list 只取首段;MKV 的 Info 后置 + 非默认 TimestampScale 只按规范实现,没有实测样本;symphonia 0.5.5 解不了 Opus / AC3 / E-AC3 / DTS / mkv 内 PCM → 这些音轨无波形(不是错位)。
- 组件卸载或切文件后,在途的 Rust 解码任务不会取消(长文件快速切换会并发解码)。
- 长文件的视觉精度受 3px bar 网格限制(3 分钟 / 1200px ≈ 一根 bar 450ms,±半根),与时钟无关;wavesurfer 把画布宽取整到 3px 网格,最右 1–2px 不画。

**经验教训**

- 调试指标只能测到它定义里的东西。err 做到 ±几 ms 后仍"感觉差一点",来源必然在 err 的定义之外:时钟源的语义、绘制的坐标系。
- 外部引擎报的"位置"先确认是谁的位置:time-pos 是文件 / 视频位置,audio-pts 才是"正在响"的位置,两者在循环回绕、seek、视频、变速这些边界上差几十到几百 ms。
- 跨进程事件的到达顺序不代表产生顺序。判断"这条回报属不属于我的操作",要用引擎自己发出的完成标记(playback-restart)加内容相容性检查,不能只看 JS 侧的到达时刻;"命令返回后立即查询"同样不是权威值。
- 画在屏幕上的数据必须带自己的时间轴(起点 + 每点时长),不能靠"数组铺满宽度"与另一条时间轴碰巧对齐。
- 合成测试要按真实事件序列造:帧步进的 pause 0→1 翻转、frame-back-step 落点晚于 restart、暂停 seek 后的 AO 虚值,都是只看文档推不出来、必须录下来才知道的。

---

## 7. 性能 / UX 考量

### 7.1 渲染管线
- **mpv 渲染走 native GPU**，前端 webview 几乎只负责 UI 控件，CPU/GPU 占用极低
- **滑块 fill 用 `transform: scaleX`**：GPU 合成层，144Hz 拖动不触发 layout/paint
- **滑块 thumb 用 `left:%` + `translate(-50%, -50%)`**：单元素 layout 成本可忽略；与 fill 的 scale 错峰（transform 百分比相对自身，不能用来在父容器内移动，详见 §6.8）
- **虚拟播放头单例**（`useCursorAnimation.ts`）：rAF 状态（`displayed / lastTickTime / pauseFreezeUntil` 等）放在**模块级**，全局只一个 tick。所有 cursor（ProgressFill / ProgressThumb / WaveformCursor / wavesurfer.setTime）通过 `useVirtualPlayhead(cb)` 订阅同一帧，绝对同步。父组件高频重渲染不会重启 rAF / 重置 `displayed`（旧实现把状态放 useEffect 局部 + 依赖 updater 会被父渲染节奏摧毁，详见 §6.22）。播放中以 mpv `audio-pts`(扣除驱动延迟的"正在响"位置)为主时钟,按"陈旧度补偿外推 + PLL 式 slew 微调"从动;seek 后 hold、回绕 coast、单曲循环取模,算法在 `lib/playheadClock.ts`(详见 §6.30 / §6.32;Ctrl+Shift+D 开 SyncDebugOverlay 实测)
- **进度条父容器加 `contain: layout paint`**：隔离 thumb 的 `left:%` layout pass，不波及外层 ControlBar 其他元素
- **PlaylistPanel `contain: layout paint` + `will-change: transform`**：滑入滑出动画跑在合成器层，跟 cursor 高频 DOM 写入互不干扰

### 7.2 IPC 节流
- **拖动音量条 rAF 合并**：60+Hz mousemove 合并为每帧最多一次 `setVolumeProp` IPC
- **拖动进度条仅 mouseup 时 seek**：拖动期间用本地 `dragValue` 渲染，不每帧 IPC
- **乐观更新 + 200ms 延迟撤销**：拖动期间 `displayVolume = draggingVolume ?? volume` 优先用本地值，松手 200ms 后再清；避免 mpv property-change echo 引发回弹

### 7.3 mpv 嵌入相关
- **状态驱动 video-margin-ratio**：从 `playlistCollapsed / showWaveform / fullscreen` 直接算 margin，不用 ResizeObserver；常量 `CONTROL=60 / WAVEFORM=56`，`PLAYLIST` 跟随 `settings.playlistWidth`（200–600 用户可拖动）
- **PlaylistPanel 始终挂载 + `transform: translateX` 滑入滑出**：放弃了早期的"延迟 80ms mount"和"过渡 guard 占位"两条补漏路径，根治方案是消除"DOM 缺席瞬态"本身。`position: absolute right-0 top-0 bottom-0` 脱离 flex 布局，`transform: translateX(0)` 显示、`translateX(width)` 滑出屏外；transition 220ms cubic-bezier，纯合成器动画；resizing 时关 transition 避免拖宽度卡顿。详见 §6.23
- **mpv 启动选项 `background-color=#000000 + background=color + force-window=yes + idle=yes`**：
  - `background-color + background=color`：让 video-margin-ratio 让出的区域用纯黑帧填充而不是透明。即使 PlaylistPanel 滑动过程 mpv margin 还没及时同步，露出区域也是黑色不是桌面（§6.23 漏光修复的双重保险之一）
  - `force-window=yes + idle=yes`：**没文件也创建子窗口并保持存在**。Tauri 窗口出来的同时 mpv 子窗口就在那填黑，整个生命周期"主区永远有 mpv 子窗口"——消除"从启动到首次 file-loaded"之间的桌面穿透闪烁（详见 §6.28）。注意不能用 `force-window=immediate`，跟 background 组合死锁（§6.4 / §6.24）
- **未 fullscreen 时 video-margin-ratio = `{ right: playlistWidth/w, bottom: (60+56)/h }`**（关闭波形条则 `bottom: 60/h`；playlist 折叠时 `right: 0`）：mpv 完全不在 UI 区域渲染，节省 GPU 也保证 UI 不被覆盖

### 7.4 波形管线
- **Rust symphonia 离线解码 peaks**：流式解码 + 流式分桶（16 帧起、≤16384 桶自适应），内存与 IPC 体积有上界；附带 `startTime` 把波形对齐到 mpv 时间轴（§6.32）
- **波形 peaks LRU 缓存 20 条**：切回最近播过的文件零成本；键含 `size+mtime` 内容指纹，同路径覆盖后旧波形立即失效（§6.31）
- **WaveformStrip 实际 56px 高、波形条 `barWidth: 2, barGap: 1`**：peaks 先按真实时间重采样到每 CSS px 一格再交给 wavesurfer（§6.32）
- **波形与进度条 `inset-x-4` 对齐**：避免 16px 错位让人感觉光标不同步
- **唯一时间轴**：光标（独立 cursor div）、已播放填色、点击 seek、peaks 摆放共用 `waveTimeline.ts` 的同一映射，轴长 = mpv duration；wavesurfer 内部的 `<audio>` 不设 src、不加载文件（§6.32）
- **波形跟随当前音轨**：按 mpv 选中音轨在容器中的序号解码，切音轨后重取；同一路径被覆盖后重载也会重取（取数依赖加载代次）

### 7.5 启动期 UX
- **冷启动无白底闪烁** —— 多层保险（注意：body **不能**染色，必须 `transparent`，否则 mpv 视频被遮死，见 §6.21）：
  1. `tauri.conf.json` `visible: false`，OS 窗口先不显示
  2. `index.html` 静态 `<div id="boot-bg">` 黑底占位（`position:fixed; inset:0; z-index:9999; background:#0a0a0a`），浏览器 parse HTML 阶段就在 DOM 里——比 Vite/React 加载早。`<meta name="color-scheme" content="dark">` 让 WebView2 内部默认色变深，吸收任何 WebView2 自身的瞬态露白
  3. `styles.css` html/body `background: transparent !important`（带警告注释，防止以后被人改回）
  4. `App.tsx` 首挂载后双 `requestAnimationFrame`：第一帧后 `window.show()` 让窗口可见（用户看到 boot-bg 黑底），第二帧后 `document.getElementById("boot-bg")?.remove()` 撤掉占位（露出 PlayerView idle overlay 同色黑底）。整个过渡视觉上是黑→黑→黑，零白闪
  5. Rust setup 起独立线程 1.5s 后无条件 `window.show()` 兜底——即使前端阻塞，用户看到的也是 boot-bg 黑色，不会是透明窗穿透到桌面
  6. **mpv 子窗口在 init 时就创建**（`force-window=yes + idle=yes`）：从用户视觉上 mpv 子窗口跟 Tauri 窗口"同时出生"，全程填黑帧；之后无论怎样 loadfile / 切歌 / 加载首个视频，子窗口都不会再"消失重建"，根除了 §6.28 描述的首次加载瞬间穿透
- **PlaylistPanel slide-in / SettingsPanel & GotoFrameDialog fade+scale / ErrorToast slide-down**：每个生灭都过 ~150ms 缓动，消除"突然冒出来"的硬切感
- **拖文件入窗口的 DragHoverOverlay**：onDragDropEvent enter/over/leave 全套监听，全屏虚线框 + Download 图标 + 提示文案，比传统 web 拖拽 UX 强很多
- **GotoFrameDialog 双模式自适应**：有 fps → 帧号；无 fps（纯音频）→ mm:ss / hh:mm:ss 时间输入

### 7.6 单实例与启动参数
- **`tauri-plugin-single-instance`**：第二个 mplayer.exe 启动时把 argv 转发到已有窗口，`unminimize + set_focus + emit("open-files")`，避免重复加载 94MB libmpv
- **`std::mem::take` 消费 launch args**：`get_launch_args` 调一次就清空，HMR / 重渲染重复 invoke 不会重复入队同一文件

### 7.8 全屏 UX

- **顶/底独立 edge-reveal**（`useFullscreenReveal` in App.tsx）：鼠标接近顶部 80px 显示 TopBar，接近底部 140px 显示 WaveformStrip + ControlBar，离开立即隐藏。两侧独立——看进度时 TopBar 不会跟着冒出来打扰，反之亦然
- **底部容器全屏切布局**：非全屏走 flex 占位；全屏改 `position: absolute; bottom: 0` + `transform: translateY(110%)` 滑入滑出，纯合成器层动画 220ms cubic-bezier；TopBar 同样靠 `fullscreenTopVisible` prop 切显示而非卸载（避免重挂载）
- **鼠标 3s 静止隐藏光标**：`document.body.classList.add('cursor-hidden')`，跟控件 reveal 解耦——光标隐了控件依然可触发；切换非全屏时强制清掉这个 class

### 7.9 字幕

- **drop-zone 按扩展分流**：PlayerView 的 `onDragDropEvent('drop')` 用 `classifyDrops` 把 8 种字幕扩展（srt / ass / ssa / sub / vtt / idx / smi / sup）分到 `addSubtitle()`，其余走 `appendToPlaylist`。字幕需要已有当前播放（`currentIndex ≥ 0`）才入通道，否则丢弃
- **TrackMenu 扩展项**（仅 sub 类型）：分隔线下追加「加载字幕文件…」（plugin-dialog filter 同 8 种扩展）+ 字幕延迟 −100ms / +100ms / 重置 0。延迟显示等宽数字 `tabular-nums`，避免抖动
- **菜单打开时拉一次 `sub-delay`**：保证 ±100ms 操作以 mpv 真实值为起点，而不是本地 stale 值

### 7.7 文件句柄与优雅关闭

- **关闭时 destroy mpv**：`useGracefulShutdown` hook 拦截 `onCloseRequested`，先 `await destroy()` 让 mpv 解码线程、音频输出、文件 I/O 都有机会 flush 后再退出。500ms 超时兜底——mpv 万一卡死也不会让用户关不掉窗口。完成后 `window.destroy()` 强制销毁窗口（绕过 `CloseRequested`）。
- **回退兜底**：即使本钩子不执行，Windows 进程退出时 OS 也会一次性回收所有句柄；这一层只是让 mpv 的内部状态走完析构流程，行为更像 VLC 而非 Windows Media Player。
- **播放期间的文件锁定**：mpv 在 Windows 上经 C runtime `_wfopen` 打开文件，**默认 share mode 是 `_SH_DENYNO`**——理论上其他进程可以读/写/删/改名这个文件。验证方法：播放某个 .mp4 时在资源管理器里删除它，若 Windows 不报"文件正在被使用"即说明锁定行为已经像 VLC 那样宽松。
- **wavesurfer 不再持有媒体文件**：只传 peaks 不传 url，WebView 内没有加载该文件的 `<audio>` 元素（§6.32）。
- **symphonia peaks 计算**：用 Rust `File::open` + RAII，函数返回时 `Drop` 自动关文件。

---

## 8. 已知限制与未来工作

- Linux / macOS 端 `tauri-plugin-libmpv` 的窗口嵌入路径未经测试
- WaveformStrip 在超长视频（>2h）的 peaks 解码可能耗时 10s 以上——可以加进度条 / Web Worker 化
- 波形只覆盖容器内置音轨（按 mpv 当前选中音轨取）；symphonia 解不了 Opus / AC3 / DTS 等 → 所选音轨无波形（§6.32）
- 事件链延迟与上屏延迟未补偿（光标整体约晚 10–25ms，推测，需实测后再决定是否加用户可调视觉偏移，§6.32）
- mpv 字幕样式 / 滤镜 / 视频比例 / 截图等高级功能未暴露 UI
- store.json 当前 schema v2，未来加字段记得在 `load()` 里合并默认值并 bump SCHEMA_VERSION
- 未做代码签名：Windows SmartScreen 首次运行可能弹"无法识别的发布者"。装机量起来后 SmartScreen 数据库会自动给好评，或买 EV 证书一劳永逸（¥2000+/年）
- 播放列表当前不自动持久化；只能手动 `.m3u8` 导出。如果用户需要"上次列表自动恢复"可加一个 setting + 自动写盘

---

## 9. 关键文件速查

| 关心什么 | 看哪个文件 |
|---|---|
| mpv 怎么 init / 怎么收 event / 1Hz fallback poll | `src/hooks/useMpv.ts` |
| mpv 命令封装（含 `addSubtitle` / `setSubDelay` / `stopPlayback` / `forcePlayheadSnap`） | `src/lib/mpv.ts` |
| 虚拟播放头单例（rAF / 订阅分发） | `src/hooks/useCursorAnimation.ts` |
| 播放头时钟算法（audio-pts / hold / coast / 循环取模 / slew） | `src/lib/playheadClock.ts` |
| 波形时间轴（peaks 重采样 / time↔x 映射） | `src/lib/waveTimeline.ts` |
| 同步误差调试 overlay（Ctrl+Shift+D） | `src/components/SyncDebugOverlay.tsx` |
| 时间码 / 帧号 OSD（T） | `src/components/TimecodeOsd.tsx` |
| 全局快捷键派发 | `src/components/KeyboardShortcuts.tsx` |
| 快捷键定义 / 默认值 / 工具 | `src/lib/shortcuts.ts` |
| 设置面板 + 录键 UI | `src/components/SettingsPanel.tsx` |
| 设置持久化 + 迁移 | `src/store/settingsStore.ts` |
| 波形条 | `src/components/WaveformStrip.tsx` |
| 波形 Rust 端解码（流式分桶 / startTime） | `src-tauri/src/peaks.rs` |
| 容器起点解析（MP4 elst / MKV CodecDelay） | `src-tauri/src/media_timing.rs` |
| mpv 视频区裁切 | `src/hooks/useVideoMargins.ts` |
| PlaylistPanel transform 滑入滑出 | `src/components/PlaylistPanel.tsx` |
| PlaylistItem 右键菜单 Portal | `src/components/PlaylistItem.tsx` |
| ControlBar（音量百分比 / Ctrl+点击重置 / 波形 toggle） | `src/components/ControlBar.tsx` |
| TrackMenu（音轨 / 字幕轨 / 加载外部字幕 / 字幕延迟） | `src/components/TrackMenu.tsx` |
| PlayerView（drop 分流字幕 vs 媒体） | `src/components/PlayerView.tsx` |
| 全屏 edge-reveal hook（顶/底独立带） | `src/App.tsx` (`useFullscreenReveal`) |
| 单曲循环 mpv loop-file 同步（无缝循环） | `src/hooks/useLoopMode.ts` |
| 冷启动黑底占位 | `index.html` (`#boot-bg`) |
| 启动入口 | `start-dev.ps1` / `start-dev.bat` |
| DLL 复制逻辑 | `src-tauri/build.rs` |
| 权限配置 | `src-tauri/capabilities/default.json` |
