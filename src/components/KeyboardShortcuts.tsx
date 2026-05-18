import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import {
  frameBackStep,
  frameStep,
  seekRelative,
  setMutedProp,
  setVolumeProp,
  togglePause,
} from "../lib/mpv";
import { playNext, playPrev } from "../hooks/useMpv";
import { eventToCombo, type ShortcutAction } from "../lib/shortcuts";

function shouldIgnore(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

async function toggleFullscreen(setFullscreen: (v: boolean) => void): Promise<void> {
  try {
    const win = getCurrentWindow();
    const cur = await win.isFullscreen();
    console.log(`[fullscreen] toggle: current=${cur} → ${!cur}`);
    await win.setFullscreen(!cur);
    setFullscreen(!cur);
  } catch (err) {
    console.error("[fullscreen] setFullscreen failed", err);
  }
}

async function exitFullscreen(setFullscreen: (v: boolean) => void): Promise<void> {
  try {
    const win = getCurrentWindow();
    const cur = await win.isFullscreen();
    if (cur) {
      await win.setFullscreen(false);
      setFullscreen(false);
    }
  } catch (err) {
    console.error("[fullscreen] exit failed", err);
  }
}

function dispatch(
  action: ShortcutAction,
  setFullscreen: (v: boolean) => void,
): void {
  const state = usePlayerStore.getState();
  const hasMedia = state.currentIndex >= 0;
  switch (action) {
    case "playPause":
      if (hasMedia) void togglePause();
      break;
    case "seekBack":
      if (hasMedia) void seekRelative(-5);
      break;
    case "seekForward":
      if (hasMedia) void seekRelative(5);
      break;
    case "frameBack":
      if (hasMedia) void frameBackStep();
      break;
    case "frameForward":
      if (hasMedia) void frameStep();
      break;
    case "volumeUp":
      void setVolumeProp(Math.min(100, state.volume + 5));
      break;
    case "volumeDown":
      void setVolumeProp(Math.max(0, state.volume - 5));
      break;
    case "mute":
      void setMutedProp(!state.muted);
      break;
    case "fullscreen":
      void toggleFullscreen(setFullscreen);
      break;
    case "exitFullscreen":
      void exitFullscreen(setFullscreen);
      break;
    case "prevTrack":
      void playPrev();
      break;
    case "nextTrack":
      void playNext();
      break;
    case "gotoFrame":
      useSettingsStore.getState().openGotoFrame();
      break;
  }
}

export function KeyboardShortcuts() {
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnore(e.target)) return;

      // SettingsPanel 正在录键时不让快捷键触发
      const { recordingAction, shortcuts } = useSettingsStore.getState();
      if (recordingAction) return;

      const combo = eventToCombo(e);
      // 查表：找到第一个绑定到该 combo 的 action
      let matched: ShortcutAction | null = null;
      for (const [k, v] of Object.entries(shortcuts) as [ShortcutAction, string][]) {
        if (v === combo) {
          matched = k;
          break;
        }
      }
      if (!matched) return;
      console.log(`[shortcut] ${combo} → ${matched}`);

      // 抢先阻断默认行为，避免按钮的 Space/Enter→click 二次触发
      e.preventDefault();
      e.stopPropagation();

      const active = document.activeElement;
      if (active instanceof HTMLButtonElement) active.blur();

      dispatch(matched, setFullscreen);
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [setFullscreen]);

  return null;
}
