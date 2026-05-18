import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlayerStore } from "../store/playerStore";
import {
  frameBackStep,
  frameStep,
  seekRelative,
  setMutedProp,
  setVolumeProp,
  setPaused,
} from "../lib/mpv";

/**
 * 仅当焦点在可输入元素内时跳过快捷键；按钮不跳过——我们用 capture 阶段
 * 抢先 preventDefault，按钮的 Space/Enter→click 默认行为不会再触发。
 */
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

export function KeyboardShortcuts() {
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnore(e.target)) return;

      const state = usePlayerStore.getState();
      const hasMedia = state.currentIndex >= 0;

      // 这些键需要抢先：避免 button 收到 Space/Enter 触发自己的 onPress
      const isPlayerKey =
        e.key === " " ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "f" ||
        e.key === "F" ||
        e.key === "m" ||
        e.key === "M" ||
        e.key === "Escape";

      if (!isPlayerKey) return;

      // capture 阶段抢先 + stopPropagation + preventDefault，确保按钮原生 click 不触发
      e.preventDefault();
      e.stopPropagation();

      // 让焦点离开当前按钮，避免后续 Space 仍命中
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement) active.blur();

      switch (e.key) {
        case " ": {
          if (hasMedia) void setPaused(state.isPlaying);
          break;
        }
        case "ArrowLeft": {
          if (!hasMedia) break;
          if (e.ctrlKey) void frameBackStep();
          else void seekRelative(-5);
          break;
        }
        case "ArrowRight": {
          if (!hasMedia) break;
          if (e.ctrlKey) void frameStep();
          else void seekRelative(5);
          break;
        }
        case "ArrowUp":
          void setVolumeProp(Math.min(100, state.volume + 5));
          break;
        case "ArrowDown":
          void setVolumeProp(Math.max(0, state.volume - 5));
          break;
        case "f":
        case "F":
          void (async () => {
            const win = getCurrentWindow();
            const cur = await win.isFullscreen();
            await win.setFullscreen(!cur);
            setFullscreen(!cur);
          })();
          break;
        case "Escape":
          void (async () => {
            const win = getCurrentWindow();
            const cur = await win.isFullscreen();
            if (cur) {
              await win.setFullscreen(false);
              setFullscreen(false);
            }
          })();
          break;
        case "m":
        case "M":
          void setMutedProp(!state.muted);
          break;
      }
    };

    // capture: true 让我们在按钮的 keydown listener 之前先收到事件
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [setFullscreen]);

  return null;
}
