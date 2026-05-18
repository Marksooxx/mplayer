import { create } from "zustand";

const STORAGE_KEY = "mplayer:ui-settings";

export interface UiSettings {
  playlistCollapsed: boolean;
  topBarAutoHide: boolean;
  topBarHidden: boolean; // true = 永久隐藏顶栏（关闭 auto-hide 后的"无浮动显示"模式）
}

const defaults: UiSettings = {
  playlistCollapsed: false,
  topBarAutoHide: true,
  topBarHidden: false,
};

function load(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function persist(s: UiSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface SettingsState extends UiSettings {
  settingsOpen: boolean;
  setPlaylistCollapsed: (v: boolean) => void;
  togglePlaylist: () => void;
  setTopBarAutoHide: (v: boolean) => void;
  setTopBarHidden: (v: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

const initial = load();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initial,
  settingsOpen: false,
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
  closeSettings: () => set({ settingsOpen: false }),
}));
