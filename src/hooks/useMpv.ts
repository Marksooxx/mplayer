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
  getResumePosition,
  loadSettings,
  savePosition,
  saveSettings,
} from "../lib/persist";

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
] as const satisfies MpvObservableProperty[];

let initPromise: Promise<void> | null = null;
let lastSavedAt = 0;

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const settings = loadSettings();
    const baseOptions: Record<string, string | number | boolean> = {
      hwdec: "auto-safe",
      "keep-open": "yes",
      osc: "no",
      "input-default-bindings": "no",
      "input-vo-keyboard": "no",
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
            if (cur && Date.now() - lastSavedAt > 5000) {
              savePosition(cur.path, v);
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
              const next = s.currentIndex + 1;
              if (next < s.playlist.length) {
                void playIndex(next);
              }
            }
            break;
          case "width":
            s.setVideoSize(ev.data ?? 0, s.videoHeight);
            break;
          case "height":
            s.setVideoSize(s.videoWidth, ev.data ?? 0);
            break;
        }
      });

      if (cancelled) {
        unlistenProps?.();
        return;
      }

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
          return;
        }
        if (ev.event === "start-file") {
          // 切到下一个文件时，先把"已加载"标志置 false（让 PlayerView 显示加载中或空闲态）
          const s = usePlayerStore.getState();
          s.setFileLoaded(false);
          s.setVideoSize(0, 0);
          return;
        }
        if (ev.event === "end-file") {
          console.log("[mpv] end-file reason=" + ev.reason + " error=" + ev.error);
          if (ev.reason === "error") {
            const s = usePlayerStore.getState();
            const item = s.playlist[s.currentIndex];
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

    return () => {
      cancelled = true;
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
    const resume = getResumePosition(item.path);
    if (resume && resume > 5) {
      setTimeout(() => {
        void seekAbsolute(resume);
      }, 300);
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
