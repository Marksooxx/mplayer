/**
 * mpv 生命周期与 React 集成
 *
 * 注意事项：
 * 1. mpv 实例是 OS 级资源，按 Tauri 窗口 label 全局唯一。无法承受
 *    StrictMode 的双重挂载 → 双重 destroy。
 * 2. `init` 在 plugin 端是幂等的（同 label 已存在则返回成功不重建），
 *    所以多次调用安全。
 * 3. 我们在 effect cleanup 里 **不 destroy** mpv —— 让它跟着进程退出
 *    被 OS 一并回收即可。这样 HMR 重新挂载组件时不会破坏现有 mpv。
 * 4. observer/listener 是 per-mount 的，cleanup 时正常解绑，避免 HMR
 *    后双倍订阅。
 */
import { useEffect } from "react";
import {
  init,
  observeProperties,
  listenEvents,
  setProperty,
  getProperty,
  type MpvObservableProperty,
} from "tauri-plugin-libmpv-api";
import { usePlayerStore } from "../store/playerStore";
import {
  loadFile,
  parseTrackList,
  seekAbsolute,
  setVolumeProp,
  setMutedProp,
  setSpeedProp,
} from "../lib/mpv";
import {
  STORE_KEYS,
  clearPosition,
  getResumePosition,
  loadPositionsAsync,
  loadSettings,
  savePosition,
  saveSettings,
} from "../lib/persist";
import { migrateFromLocalStorage } from "../lib/storage";
import {
  bootstrapSettings,
  useSettingsStore,
} from "../store/settingsStore";
import { pickNextIndex } from "../lib/playback-mode";

const OBSERVED = [
  ["pause", "flag"],
  ["time-pos", "double", "none"],
  ["duration", "double", "none"],
  ["volume", "double"],
  ["mute", "flag"],
  ["speed", "double"],
  ["track-list", "node"],
  ["sid", "int64", "none"],
  ["aid", "int64", "none"],
  ["eof-reached", "flag", "none"],
  ["width", "int64", "none"],
  ["height", "int64", "none"],
  ["container-fps", "double", "none"],
] as const satisfies MpvObservableProperty[];

let initPromise: Promise<void> | null = null;
let lastSavedAt = 0;

/** 文件自然播完时根据 playbackMode 决定下一步：循环 / 单曲 / 随机 */
async function handleEof(): Promise<void> {
  const mode = useSettingsStore.getState().playbackMode;
  const s = usePlayerStore.getState();
  const total = s.playlist.length;
  if (total === 0) return;

  if (mode === "loop-single") {
    // 单曲循环：seek 到开头并恢复播放（mpv 在 EOF 后 pause=true，先放回去再 seek）
    try {
      await seekAbsolute(0);
      await setProperty("pause", false);
    } catch (err) {
      console.error("[mpv] loop-single restart failed", err);
    }
    return;
  }

  const next = pickNextIndex(mode, s.currentIndex, total);
  if (next < 0) return; // 不应到这里（loop-playlist/shuffle 都不返回 -1）
  void playIndex(next);
}

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // 先一次性把老版本残留在 webview localStorage 的数据迁到 store.json
    await migrateFromLocalStorage([
      { lsKey: "mplayer:ui-settings", storeKey: STORE_KEYS.UI },
      { lsKey: "mplayer:settings", storeKey: STORE_KEYS.PLAYER },
      { lsKey: "mplayer:positions", storeKey: STORE_KEYS.POSITIONS },
    ]);
    // 再把 store 里的设置加载出来：UI 偏好同步进 settingsStore，
    // positions 进缓存，player prefs 进 prefsCache。三件事并行，再统一拿设置喂 mpv。
    await Promise.all([
      bootstrapSettings(),
      loadPositionsAsync(),
      loadSettings(),
    ]);
    const settings = await loadSettings();
    const baseOptions: Record<string, string | number | boolean> = {
      hwdec: "auto-safe",
      "keep-open": "yes",
      osc: "no",
      "input-default-bindings": "no",
      "input-vo-keyboard": "no",
      // ★ 漏光防御 ★
      // Tauri transparent:true + WebView2 透明区域会穿透到桌面。
      // 三层组合保证 mpv 子窗口永远是不透明黑色,从根上消除"mpv 子窗口创建
      // 但还没绘制视频帧"那一瞬透到桌面:
      //   - background-color=#000000  非视频区填充色为纯黑
      //   - background=color          强制用 background-color 填充而不是 alpha
      //                               透明(mpv 0.40+ 新语义)
      //   - force-window=yes          mpv init 时立即创建子窗口并持续存在,
      //                               不等 file-loaded → 用户从启动到加载第
      //                               一个视频期间也看到黑底而不是透明穿透
      //                               (注意:不能用 immediate,会跟 background
      //                                 组合死锁,见 §6.4)
      "background-color": "#000000",
      background: "color",
      "force-window": "yes",
      "idle": "yes",
      volume: settings.volume,
      mute: settings.muted ? "yes" : "no",
      speed: settings.speed,
    };

    try {
      await init({
        initialOptions: { ...baseOptions, vo: "gpu-next" },
        observedProperties: OBSERVED,
      });
      console.log("[mpv] initialized with vo=gpu-next");
    } catch (err1) {
      console.warn("[mpv] gpu-next init failed, retrying with vo=gpu", err1);
      try {
        await init({
          initialOptions: { ...baseOptions, vo: "gpu" },
          observedProperties: OBSERVED,
        });
        console.log("[mpv] initialized with vo=gpu");
      } catch (err2) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        console.error("[mpv] init failed twice", err2);
        usePlayerStore.getState().setError(`mpv 初始化失败：${msg}`);
        initPromise = null; // 允许下次重试
        throw err2;
      }
    }

    const store = usePlayerStore.getState();
    store.setVolume(settings.volume);
    store.setMuted(settings.muted);
    store.setSpeed(settings.speed);
    store.setMpvReady(true);
  })();
  return initPromise;
}

/** wait for mpvReady or timeout */
async function waitForMpv(timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (usePlayerStore.getState().mpvReady) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export function useMpv(): void {
  useEffect(() => {
    let cancelled = false;
    let unlistenProps: (() => void) | undefined;
    let unlistenEvents: (() => void) | undefined;

    void (async () => {
      try {
        await ensureInit();
      } catch {
        return; // 错误已 toast
      }
      if (cancelled) return;

      unlistenProps = await observeProperties(OBSERVED, (ev) => {
        const s = usePlayerStore.getState();
        switch (ev.name) {
          case "pause":
            s.setIsPlaying(!ev.data);
            break;
          case "time-pos": {
            const v = ev.data ?? 0;
            s.setPosition(v);
            const cur = s.playlist[s.currentIndex];
            if (
              cur &&
              Date.now() - lastSavedAt > 5000 &&
              useSettingsStore.getState().rememberPosition
            ) {
              const dur = s.duration;
              // 不保存尾部 5 秒内的位置 —— 避免短文件累积"近末尾"进度，下次再开
              // 误以为要 resume 到末尾。播完后 end-file/eof 还会再清一次。
              if (dur > 0 && v >= dur - 5) {
                clearPosition(cur.path);
              } else {
                savePosition(cur.path, v);
              }
              lastSavedAt = Date.now();
            }
            break;
          }
          case "duration":
            s.setDuration(ev.data ?? 0);
            break;
          case "volume":
            s.setVolume(ev.data);
            saveSettings({ volume: ev.data, muted: s.muted, speed: s.speed });
            break;
          case "mute":
            s.setMuted(ev.data);
            saveSettings({ volume: s.volume, muted: ev.data, speed: s.speed });
            break;
          case "speed":
            s.setSpeed(ev.data);
            saveSettings({ volume: s.volume, muted: s.muted, speed: ev.data });
            break;
          case "track-list":
            s.setTracks(parseTrackList(ev.data));
            break;
          case "sid":
            s.setCurrentSid(ev.data);
            break;
          case "aid":
            s.setCurrentAid(ev.data);
            break;
          case "eof-reached":
            if (ev.data) {
              void handleEof();
            }
            break;
          case "width":
            s.setVideoSize(ev.data ?? 0, s.videoHeight);
            break;
          case "height":
            s.setVideoSize(s.videoWidth, ev.data ?? 0);
            break;
          case "container-fps":
            s.setFps(ev.data ?? 0);
            break;
        }
      });

      if (cancelled) {
        unlistenProps?.();
        return;
      }

      // 关键补救：mpv 在 init 时就发了一轮"current value"事件，但那时
      // 我们的 JS observeProperties 还没挂上，事件丢了。这里显式 getProperty
      // 把当前真实值同步回 store，否则首次按 Space 会读到默认值 isPlaying=false
      // 然后调用 setPaused(false) ≡ 空操作。
      void (async () => {
        try {
          const pause = await getProperty("pause", "flag");
          if (typeof pause === "boolean") usePlayerStore.getState().setIsPlaying(!pause);
        } catch { /* ignore */ }
        try {
          const vol = await getProperty("volume", "double");
          if (typeof vol === "number") usePlayerStore.getState().setVolume(vol);
        } catch { /* ignore */ }
        try {
          const muted = await getProperty("mute", "flag");
          if (typeof muted === "boolean") usePlayerStore.getState().setMuted(muted);
        } catch { /* ignore */ }
        try {
          const sp = await getProperty("speed", "double");
          if (typeof sp === "number") usePlayerStore.getState().setSpeed(sp);
        } catch { /* ignore */ }
      })();

      unlistenEvents = await listenEvents((ev) => {
        if (ev.event === "log-message") {
          const lvl = ev.level;
          const text = `[mpv:${ev.prefix}] ${ev.text.trimEnd()}`;
          if (lvl === "fatal" || lvl === "error") console.error(text);
          else if (lvl === "warn") console.warn(text);
          else if (lvl === "info" || lvl === "status") console.log(text);
          else console.debug(text);
          return;
        }
        if (ev.event === "file-loaded") {
          console.log("[mpv] file-loaded");
          usePlayerStore.getState().setFileLoaded(true);
          // mpv property-change 在某些容器/无音频流场景下首次 file-loaded
          // 后偶尔不发 time-pos/pause/duration —— 表现为"播放但进度条不动"。
          // 这里主动 getProperty 一次兜底。
          void (async () => {
            const ss = usePlayerStore.getState();
            try {
              const pause = await getProperty("pause", "flag");
              if (typeof pause === "boolean") ss.setIsPlaying(!pause);
            } catch { /* ignore */ }
            try {
              const pos = await getProperty("time-pos", "double");
              if (typeof pos === "number") ss.setPosition(pos);
            } catch { /* ignore */ }
            try {
              const dur = await getProperty("duration", "double");
              if (typeof dur === "number") ss.setDuration(dur);
            } catch { /* ignore */ }
          })();
          return;
        }
        if (ev.event === "start-file") {
          // 切到下一个文件时，先把"已加载"标志置 false（让 PlayerView 显示加载中或空闲态）
          const s = usePlayerStore.getState();
          s.setFileLoaded(false);
          s.setVideoSize(0, 0);
          s.setFps(0);
          return;
        }
        if (ev.event === "end-file") {
          console.log("[mpv] end-file reason=" + ev.reason + " error=" + ev.error);
          const s = usePlayerStore.getState();
          const item = s.playlist[s.currentIndex];
          if (ev.reason === "eof" && item) {
            // 自然播完：清掉这条记录，下次再开它从 0 开始
            clearPosition(item.path);
          }
          if (ev.reason === "error") {
            s.setFileLoaded(false);
            s.setError(`播放失败：${item?.name ?? "未知文件"}（mpv error=${ev.error}）`);
            const next = s.currentIndex + 1;
            if (next < s.playlist.length) {
              setTimeout(() => void playIndex(next), 500);
            }
          }
        }
      });

      if (cancelled) {
        unlistenEvents?.();
      }
    })();

    // time-pos fallback polling:某些容器(尤其无音频视频)mpv 不持续发
    // time-pos property change → 进度条停在 0 不动。每 1s 主动 poll 一次
    // mpv 真实 time-pos 兜底。播放中且有 currentIndex 才 poll,避免空载浪费。
    const pollInterval = setInterval(() => {
      const s = usePlayerStore.getState();
      if (!s.mpvReady || !s.isPlaying || s.currentIndex < 0 || !s.fileLoaded) return;
      void (async () => {
        try {
          const pos = await getProperty("time-pos", "double");
          if (typeof pos === "number" && !Number.isNaN(pos)) {
            const cur = usePlayerStore.getState().position;
            // 只在差异 > 100ms 时更新,避免覆盖正常的 property-change 事件链
            if (Math.abs(pos - cur) > 0.1) {
              usePlayerStore.getState().setPosition(pos);
            }
          }
        } catch { /* ignore */ }
      })();
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      unlistenProps?.();
      unlistenEvents?.();
      // 注意：不 destroy()。mpv 实例随进程退出由 OS 回收。
    };
  }, []);
}

export async function playIndex(index: number): Promise<void> {
  const s = usePlayerStore.getState();
  if (index < 0 || index >= s.playlist.length) return;
  const item = s.playlist[index];
  s.setCurrentIndex(index);
  s.setError(null);
  s.setFileLoaded(false);
  s.setVideoSize(0, 0);
  s.setFps(0);

  if (!s.mpvReady) {
    console.log("[mpv] waiting for ready before loadfile", item.path);
    const ok = await waitForMpv(5000);
    if (!ok) {
      s.setError("mpv 尚未初始化完成，请稍候再试");
      return;
    }
  }

  console.log("[mpv] loadfile", item.path);
  try {
    await loadFile(item.path);

    if (useSettingsStore.getState().rememberPosition) {
      const resume = getResumePosition(item.path);
      if (resume && resume > 5) {
        // mpv 在 loadfile 返回后还要花一刻解析元数据；轮询 duration 直到拿到
        let dur = 0;
        const startMs = Date.now();
        while (Date.now() - startMs < 2000) {
          try {
            const v = await getProperty("duration", "double");
            if (typeof v === "number" && v > 0) {
              dur = v;
              break;
            }
          } catch { /* mpv may not have parsed yet */ }
          await new Promise((r) => setTimeout(r, 50));
        }
        // 只有当 resume 同时满足两条才恢复：
        //   1) 距末尾还有 ≥ 30 秒（短视频 < 60s 实质禁用 resume）
        //   2) 不超过 95% 时长（长视频也要避免靠近末尾）
        // 这样避免"看完了又回到末尾"的尴尬。
        const safeMax = Math.min(dur * 0.95, dur - 30);
        if (dur > 0 && resume < safeMax) {
          console.log(`[mpv] resume to ${resume}s (duration=${dur}, safeMax=${safeMax})`);
          await seekAbsolute(resume);
        } else if (dur > 0) {
          console.log(`[mpv] skipping resume (resume=${resume}s, duration=${dur}s, safeMax=${safeMax}s) — starting from 0`);
          clearPosition(item.path);
        }
      }
    }

    await setProperty("pause", false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[mpv] loadfile threw", err);
    s.setError(`无法加载 ${item.name}：${msg}`);
  }
}

export async function playNext(): Promise<void> {
  const s = usePlayerStore.getState();
  await playIndex(Math.min(s.currentIndex + 1, s.playlist.length - 1));
}

export async function playPrev(): Promise<void> {
  const s = usePlayerStore.getState();
  await playIndex(Math.max(s.currentIndex - 1, 0));
}

export async function applyVolume(v: number): Promise<void> {
  await setVolumeProp(v);
}

export async function applyMuted(v: boolean): Promise<void> {
  await setMutedProp(v);
}

export async function applySpeed(v: number): Promise<void> {
  await setSpeedProp(v);
}
