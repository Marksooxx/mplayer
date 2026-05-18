import { create } from "zustand";
import { DEFAULT_SHORTCUTS, type ShortcutAction } from "../lib/shortcuts";

const STORAGE_KEY = "mplayer:ui-settings";

export interface UiSettings {
  playlistCollapsed: boolean;
  topBarAutoHide: boolean;
  topBarHidden: boolean; // true = 永久隐藏顶栏
  shortcuts: Record<ShortcutAction, string>;
}

const defaults: UiSettings = {
  playlistCollapsed: false,
  topBarAutoHide: true,
  topBarHidden: false,
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

function load(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    // 合并 shortcuts，保证新版本新增的 action 也有默认值
    return {
      ...defaults,
      ...parsed,
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(parsed.shortcuts ?? {}) },
    };
  } catch {
    return defaults;
  }
}

function persist(s: UiSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota */
  }
}

interface SettingsState extends UiSettings {
  settingsOpen: boolean;
  recordingAction: ShortcutAction | null;

  setPlaylistCollapsed: (v: boolean) => void;
  togglePlaylist: () => void;
  setTopBarAutoHide: (v: boolean) => void;
  setTopBarHidden: (v: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;

  setShortcut: (action: ShortcutAction, combo: string) => void;
  resetShortcuts: () => void;
  beginRecording: (action: ShortcutAction) => void;
  cancelRecording: () => void;
}

const initial = load();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initial,
  settingsOpen: false,
  recordingAction: null,

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
}));
