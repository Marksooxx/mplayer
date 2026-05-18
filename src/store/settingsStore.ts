import { create } from "zustand";
import {
  DEFAULT_SHORTCUTS,
  FRAME_STEP_DEFAULT,
  FRAME_STEP_MAX,
  FRAME_STEP_MIN,
  type ShortcutAction,
} from "../lib/shortcuts";

const STORAGE_KEY = "mplayer:ui-settings";
const SCHEMA_VERSION = 2;

export interface UiSettings {
  playlistCollapsed: boolean;
  topBarAutoHide: boolean;
  topBarHidden: boolean; // true = 永久隐藏顶栏
  showWaveform: boolean; // 底部波形条显隐
  rememberPosition: boolean; // 记忆每个文件上次播放位置
  frameStepMultiplier: number; // Shift+←/→ 多帧步进的帧数
  shortcuts: Record<ShortcutAction, string>;
}

const defaults: UiSettings = {
  playlistCollapsed: false,
  topBarAutoHide: true,
  topBarHidden: false,
  showWaveform: true,
  rememberPosition: true,
  frameStepMultiplier: FRAME_STEP_DEFAULT,
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

function clampMultiplier(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return FRAME_STEP_DEFAULT;
  return Math.max(FRAME_STEP_MIN, Math.min(FRAME_STEP_MAX, Math.round(n)));
}

function load(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);

    const merged: UiSettings = {
      ...defaults,
      ...parsed,
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(parsed.shortcuts ?? {}) },
      frameStepMultiplier: clampMultiplier(parsed.frameStepMultiplier),
    };

    // 强制迁移：旧版本默认全屏键是 "F"（与浏览器/系统 Find/全屏键冲突，部分焦点
    // 状态下不触发）；现在默认 Ctrl+Enter。无条件覆盖仍为 "F" 的旧值。
    // 副作用：极少数把 fullscreen 明确改为 "F" 的用户会被回退到默认；
    //        但因为 "F" 实际上工作不可靠，这是可接受的代价。
    if (merged.shortcuts.fullscreen === "F" || !merged.shortcuts.fullscreen) {
      merged.shortcuts.fullscreen = DEFAULT_SHORTCUTS.fullscreen;
    }

    return merged;
  } catch {
    return defaults;
  }
}

function persist(s: UiSettings): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...s, version: SCHEMA_VERSION }),
    );
  } catch {
    /* ignore quota */
  }
}

interface SettingsState extends UiSettings {
  settingsOpen: boolean;
  recordingAction: ShortcutAction | null;
  gotoFrameOpen: boolean;

  setPlaylistCollapsed: (v: boolean) => void;
  togglePlaylist: () => void;
  setTopBarAutoHide: (v: boolean) => void;
  setTopBarHidden: (v: boolean) => void;
  setShowWaveform: (v: boolean) => void;
  setRememberPosition: (v: boolean) => void;
  setFrameStepMultiplier: (v: number) => void;
  openSettings: () => void;
  closeSettings: () => void;

  setShortcut: (action: ShortcutAction, combo: string) => void;
  resetShortcuts: () => void;
  beginRecording: (action: ShortcutAction) => void;
  cancelRecording: () => void;

  openGotoFrame: () => void;
  closeGotoFrame: () => void;
}

const initial = load();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initial,
  settingsOpen: false,
  recordingAction: null,
  gotoFrameOpen: false,

  setPlaylistCollapsed: (v) => {
    set({ playlistCollapsed: v });
    persist({ ...get(), playlistCollapsed: v });
  },
  togglePlaylist: () => {
    const v = !get().playlistCollapsed;
    set({ playlistCollapsed: v });
    persist({ ...get(), playlistCollapsed: v });
  },
  setTopBarAutoHide: (v) => {
    set({ topBarAutoHide: v });
    persist({ ...get(), topBarAutoHide: v });
  },
  setTopBarHidden: (v) => {
    set({ topBarHidden: v });
    persist({ ...get(), topBarHidden: v });
  },
  setShowWaveform: (v) => {
    set({ showWaveform: v });
    persist({ ...get(), showWaveform: v });
  },
  setRememberPosition: (v) => {
    set({ rememberPosition: v });
    persist({ ...get(), rememberPosition: v });
  },
  setFrameStepMultiplier: (v) => {
    const clamped = clampMultiplier(v);
    set({ frameStepMultiplier: clamped });
    persist({ ...get(), frameStepMultiplier: clamped });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false, recordingAction: null }),

  setShortcut: (action, combo) => {
    const current = get().shortcuts;
    const next: Record<ShortcutAction, string> = { ...current, [action]: combo };
    // 冲突处理：如果其它 action 已绑定相同 combo，清空它（按用户最新意图）
    for (const [k, v] of Object.entries(next) as [ShortcutAction, string][]) {
      if (k !== action && v === combo) next[k] = "";
    }
    set({ shortcuts: next, recordingAction: null });
    persist({ ...get(), shortcuts: next });
  },
  resetShortcuts: () => {
    const fresh = { ...DEFAULT_SHORTCUTS };
    set({ shortcuts: fresh });
    persist({ ...get(), shortcuts: fresh });
  },
  beginRecording: (action) => set({ recordingAction: action }),
  cancelRecording: () => set({ recordingAction: null }),

  openGotoFrame: () => set({ gotoFrameOpen: true }),
  closeGotoFrame: () => set({ gotoFrameOpen: false }),
}));
