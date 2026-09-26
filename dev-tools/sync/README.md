# 波形 / 播放头同步 · 离线测试与探针

对应 ARCHITECTURE.md §6.32。改动 `src/lib/playheadClock.ts`、`src/lib/waveTimeline.ts`、
`src/lib/mpv.ts` 的 seek 登记、`src-tauri/src/peaks.rs` / `media_timing.rs` 之后跑一遍。

```bash
pnpm test:sync            # 全部（含 Rust 解码对拍：需要 cargo + ffmpeg，首次编译较慢）
pnpm test:sync --quick    # 跳过 Rust 对拍
```

环境：Node ≥ 22.6（`--experimental-strip-types`）；`seek-chain` 用 `npx -y tsx`（首次会下载 tsx）；
Python 3 + numpy（探针与对拍脚本）；探针直接加载 `src-tauri/lib/libmpv-2.dll`（Windows）。
`probes/` 下弹窗类探针（`pause_frame.py`、`app_pause_e2e.py`）用 `PrintWindow` 取帧，锁屏 / 被遮挡也能测。

## clock/ —— 虚拟播放头

| 文件 | 内容 |
|---|---|
| `edge.test.ts` | 49 条合成事件边界用例：§6.22 暂停不瞬移 / 不后退、后台恢复、暂停中慢 seek、旧值先到 / 晚到、restart 先于落点、连续 seek、方向键连按、帧步进的 pause 0→1 翻转与同批乱序、帧步进后恢复不倒退、拖动松手、循环回绕 / 循环中 seek 到末尾、变速、音轨表未知、无音轨、hold 超时、起播等（含 codex 第 2–5 轮给出的全部反例） |
| `replay.test.ts` | 用 `data/mpv-events/` 里录下的真实 mpv 事件流逐帧（144Hz）回放**旧算法（§6.30 版）与新算法**，真值 = audio-pts 分段线性拟合，对新算法按场景断言 p95 误差上限。可带参数模拟事件链延迟：`node --experimental-strip-types --no-warnings dev-tools/sync/clock/replay.test.ts 20`（只输出指标，稳态误差应 ≈ −20ms） |
| `steps.test.ts` | 用 `data/steps/` 里录下的用户操作序列（暂停中单帧前进 / 后退、播放中单帧、暂停中 seek 视频 / wav、切文件、播放中暂停 / 恢复）断言每次操作后光标落点，以及播放中与恢复时不倒退；开播阶段的倒退单列为 KNOWN（§6.33 已知问题，不判失败） |
| `seek-chain.test.mts` | 导入真实 `src/lib/mpv.ts`（拦截 Tauri IPC），验证相对 seek 目标提示：连按累计、落点乱序、落地后改用当前位置、越界钳制、长暂停后立即按键不计入暂停时长 |

真值的局限：回放真值来自同一串 audio-pts，证明的是"跟上 mpv 的音频时钟"，**不是**屏幕与耳朵之间的
绝对误差——事件链（mpv → Rust → WebView2 → JS）、rAF → 上屏、声卡 / 蓝牙延迟都不在其中。

录制数据：`mpv-events/` 中文件名带 `wasapi` 的是真实声卡（音量 0）录制，其余为 `ao=null`；动作标记
格式为 `seek7.25` / `speed1.5`。`steps/` 除 `ppause24/60`（`vo=gpu-next ao=wasapi volume=0`，真实 VO 时序）外为
`ao=null vo=null` 录制，动作格式同 `probes/record_events.py`（`seek,0.81,absolute` / `frame-step` / `set,pause,yes`）。

## waveform/ —— 波形时间轴

| 文件 | 内容 |
|---|---|
| `timeline.test.ts` | `resamplePeaks` / `axisDuration` / `timeToFrac` / `audioIndexOf`：priming 裁剪、晚起播留空、音频短于视频不拉伸、末桶按真实结尾裁剪、长文件、边界 |
| `check_timing.py` | 跑 Rust `peaks.rs` 的对拍测试，逐个素材与 `expected.json` 里的 **mpv 实播真值**比较（43 项：各编码 / 容器 / 起点偏移 / 缺口 / 多音轨 / 越界 / 不支持的编码应明确报不可用） |
| `expected.json` | 真值表：两个脉冲在 time-pos 坐标下的 onset，全部由 `probes/mpv_onsets.py` 测得；少数已知限制放宽容差并注明原因 |
| `gen_media.py` | 生成 7 个较大的 PCM 素材到 `media/generated/`（不入库）；`check_timing.py` 缺失时会自动调用 |
| `media/` | 入库的小素材（压缩格式 + 人工构造的畸形样本，如 Tracks 在 Cluster 之后的 MKV、首 Cluster 时间戳早于首块、负的块相对时间戳、分片 MP4 缺口、MKV 中途时间戳跳变、多音轨） |

所有素材内容相同：3.000s 静音 + 1.000s 与 2.500s 处 4ms、0.8 幅度的 1kHz 脉冲，差别只在编码、容器和起点。
单独跑 Rust 对拍：`MPLAYER_TIMING_MEDIA=<目录> [MPLAYER_TIMING_AUDIO_INDEX=n] cargo test --lib print_timeline -- --ignored --nocapture`（在 `src-tauri/` 下）。

## probes/ —— 用 libmpv 取证

| 文件 | 用途 |
|---|---|
| `mpv_onsets.py` | 测 mpv 实播时脉冲的 time-pos（`ao=pcm` 写文件、不发声）：`python mpv_onsets.py <文件> [--start 0.7] [--aid 2]`。起点要选在音轨开始之后、第一个脉冲之前、且不在流内缺口里 |
| `record_events.py` | 录制 mpv 事件序列（含用户动作），产出 `clock/data/` 同格式的 JSON，用来补充新的回放用例 |
| `pause_frame.py` | 实测播放中暂停后屏幕停在哪一帧（§6.33）：生成画面编码帧号的视频，用与 App 相同的 vo / hwdec 播放、随机暂停，`PrintWindow` 取 DWM 合成内容解码帧号，与 time-pos、VO 当前帧、暂停瞬间的声音位置对照：`python pause_frame.py [--fps 24,30,60] [--trials 16] [--vo gpu-next]`。会弹出置顶小窗口，锁屏 / 被遮挡也能测 |
| `app_pause_e2e.py` | App 端到端（§6.33）：启动 debug 构建（WebView2 远程调试端口），CDP 发空格暂停、读时间码 OSD，`PrintWindow` 按 mpv `osd-dimensions` 裁出视频区解码帧号，统计 OSD 帧号 = 屏幕帧的比例。`uv run --with websocket-client --with numpy python app_pause_e2e.py [--exe …] [--trials 16]`。会备份 / 还原 App 的 store.json；App 不能已在运行 |
| `seekquery.py` | 实验记录：seek 命令返回后立即查询 time-pos 并不可靠（播放中可能仍是旧值，暂停中 wav 几 ms 后就变成 AO 缓冲虚值），这是 op 状态机不用"查询落点"的依据 |
