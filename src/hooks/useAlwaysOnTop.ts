import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "../store/settingsStore";

/**
 * 监听 settings.alwaysOnTop 变化，同步到 Tauri 窗口的 set_always_on_top。
 * 等 bootstrap 完成才动作，避免在 hydrate 之前把默认值 false 写到窗口。
 */
export function useAlwaysOnTop(): void {
  const alwaysOnTop = useSettingsStore((s) => s.alwaysOnTop);
  const bootstrapped = useSettingsStore((s) => s.bootstrapped);

  useEffect(() => {
    if (!bootstrapped) return;
    getCurrentWindow()
      .setAlwaysOnTop(alwaysOnTop)
      .catch((err) => console.error("[alwaysOnTop] setAlwaysOnTop failed", err));
  }, [alwaysOnTop, bootstrapped]);
}
