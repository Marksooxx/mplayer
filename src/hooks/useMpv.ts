import { useEffect, useRef } from "react";
import {
  init,
  destroy,
  observeProperties,
  listenEvents,
  setProperty,
  type MpvObservableProperty,
} from "tauri-plugin-libmpv-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
] as const satisfies MpvObservableProperty[];

let initialized = false;
let lastSavedAt = 0;

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
  const ready = useRef(false);

  useEffect(() => {
    if (initialized || ready.current) return;
    ready.current = true;
    initialized = true;

    let unlistenProps: (() => void) | undefined;
    let unlistenEvents: (() => void) | undefined;

    const setup = async () => {
      const settings = loadSettings();

      // 一次性尝试 init；如果 gpu-next vo 失败，回退 gpu
      const baseOptions: Record<string, string | number | boolean> = {
        hwdec: "auto-safe",
        "keep-open": "yes",
        "force-window": "yes",
        osc: "no",
        "input-default-bindings": "no",
        "input-vo-keyboard": "no",
        // 强制让 mpv 把日志事件抛上来，便于调试
        "msg-level": "all=v",
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
          return;
        }
      }

      const store = usePlayerStore.getState();
      store.setVolume(settings.volume);
      store.setMuted(settings.muted);
      store.setSpeed(settings.speed);
      store.setMpvReady(true);

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
        }
      });

      unlistenEvents = await listenEvents((ev) => {
        // 把 mpv 内部日志透传到 devtools 便于排错
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
          return;
        }
        if (ev.event === "end-file") {
          console.log("[mpv] end-file reason=" + ev.reason + " error=" + ev.error);
          if (ev.reason === "error") {
            const s = usePlayerStore.getState();
            const item = s.playlist[s.currentIndex];
            s.setError(`播放失败：${item?.name ?? "未知文件"}（mpv error=${ev.error}）`);
            const next = s.currentIndex + 1;
            if (next < s.playlist.length) {
              setTimeout(() => void playIndex(next), 500);
            }
          }
        }
      });

    };

    void setup();

    return () => {
      unlistenProps?.();
      unlistenEvents?.();
      void destroy();
      initialized = false;
      usePlayerStore.getState().setMpvReady(false);
    };
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenP = win.onResized(() => {
      // mpv handles its own sizing via attached window handle
    });
    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, []);
}

export async function playIndex(index: number): Promise<void> {
  const s = usePlayerStore.getState();
  if (index < 0 || index >= s.playlist.length) return;
  const item = s.playlist[index];
  s.setCurrentIndex(index);
  s.setError(null);

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
