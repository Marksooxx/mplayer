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

      await init({
        initialOptions: {
          vo: "gpu-next",
          hwdec: "auto-safe",
          "keep-open": "yes",
          "force-window": "yes",
          osc: "no",
          "input-default-bindings": "no",
          "input-vo-keyboard": "no",
          volume: settings.volume,
          mute: settings.muted ? "yes" : "no",
          speed: settings.speed,
        },
        observedProperties: OBSERVED,
      });

      const store = usePlayerStore.getState();
      store.setVolume(settings.volume);
      store.setMuted(settings.muted);
      store.setSpeed(settings.speed);

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
        if (ev.event === "end-file" && ev.reason === "error") {
          const s = usePlayerStore.getState();
          s.setError(`播放失败：${s.playlist[s.currentIndex]?.name ?? "未知文件"}`);
          const next = s.currentIndex + 1;
          if (next < s.playlist.length) {
            void playIndex(next);
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
  try {
    await loadFile(item.path);
    const resume = getResumePosition(item.path);
    if (resume && resume > 5) {
      // small delay so mpv can load file before seek; file-loaded event would be more robust
      setTimeout(() => {
        void seekAbsolute(resume);
      }, 250);
    }
    await setProperty("pause", false);
  } catch (err) {
    s.setError(`无法加载文件：${item.name}`);
    console.error(err);
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
