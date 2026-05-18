import { create } from "zustand";
import {
  DEFAULT_SHORTCUTS,
  FRAME_STEP_DEFAULT,
  FRAME_STEP_MAX,
  FRAME_STEP_MIN,
  type ShortcutAction,
} from "../lib/shortcuts";
import {
  PLAYBACK_MODE_DEFAULT,
  nextMode,
  type PlaybackMode,
} from "../lib/playback-mode";
import { loadUiRaw, persistUi } from "../lib/persist";

const SCHEMA_VERSION = 2;

export interface UiSettings {
  playlistCollapsed: boolean;
  topBarAutoHide: boolean;
  topBarHidden: boolean; // true = 永久隐藏顶栏
  showWaveform: boolean; // 底部波形条显隐
  rememberPosition: boolean; // 记忆每个文件上次播放位置
  frameStepMultiplier: number; // Shift+←/→ 多帧步进的帧数
  alwaysOnTop: boolean; // 窗口置顶
  playbackMode: PlaybackMode; // 列表循环 / 单曲循环 / 随机
  playlistWidth: number; // 右侧播放列表宽度（px），可拖左边缘调整
  shortcuts: Record<ShortcutAction, string>;
}

export const PLAYLIST_WIDTH_MIN = 200;
export const PLAYLIST_WIDTH_MAX = 600;
export const PLAYLIST_WIDTH_DEFAULT = 280;

function clampPlaylistWidth(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return PLAYLIST_WIDTH_DEFAULT;
  return Math.max(PLAYLIST_WIDTH_MIN, Math.min(PLAYLIST_WIDTH_MAX, Math.round(n)));
}

const defaults: UiSettings = {
  playlistCollapsed: false,
  topBarAutoHide: true,
  topBarHidden: false,
  showWaveform: true,
  rememberPosition: true,
  frameStepMultiplier: FRAME_STEP_DEFAULT,
  alwaysOnTop: false,
  playbackMode: PLAYBACK_MODE_DEFAULT,
  playlistWidth: PLAYLIST_WIDTH_DEFAULT,
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

function clampMultiplier(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return FRAME_STEP_DEFAULT;
  return Math.max(FRAME_STEP_MIN, Math.min(FRAME_STEP_MAX, Math.round(n)));
}

function merge(parsed: unknown): UiSettings {
  if (!parsed || typeof parsed !== "object") return defaults;
  const p = parsed as Partial<UiSettings>;
  const merged: UiSettings = {
    ...defaults,
    ...p,
    shortcuts: { ...DEFAULT_SHORTCUTS, ...(p.shortcuts ?? {}) },
    frameStepMultiplier: clampMultiplier(p.frameStepMultiplier),
    playlistWidth: clampPlaylistWidth(p.playlistWidth),
  };
  // 强制迁移：旧版本默认全屏键是 "F"（与浏览器/系统 Find/全屏键冲突）
  if (merged.shortcuts.fullscreen === "F" || !merged.shortcuts.fullscreen) {
    merged.shortcuts.fullscreen = DEFAULT_SHORTCUTS.fullscreen;
  }
  return merged;
}

function persist(s: UiSettings): void {
  persistUi({ ...s, version: SCHEMA_VERSION });
}

interface SettingsState extends UiSettings {
  settingsOpen: boolean;
  recordingAction: ShortcutAction | null;
  gotoFrameOpen: boolean;
  bootstrapped: boolean; // store 加载完成才置 true，避免在 hydrate 前覆盖到 store

  setPlaylistCollapsed: (v: boolean) => void;
  togglePlaylist: () => void;
  setTopBarAutoHide: (v: boolean) => void;
  setTopBarHidden: (v: boolean) => void;
  setShowWaveform: (v: boolean) => void;
  setRememberPosition: (v: boolean) => void;
  setFrameStepMultiplier: (v: number) => void;
  setAlwaysOnTop: (v: boolean) => void;
  toggleAlwaysOnTop: () => void;
  setPlaybackMode: (m: PlaybackMode) => void;
  cyclePlaybackMode: () => void;
  setPlaylistWidth: (v: number) => void;
  openSettings: () => void;
  closeSettings: () => void;

  setShortcut: (action: ShortcutAction, combo: string) => void;
  resetShortcuts: () => void;
  beginRecording: (action: ShortcutAction) => void;
  cancelRecording: () => void;

  openGotoFrame: () => void;
  closeGotoFrame: () => void;
}

// 一个辅助：仅在 bootstrap 完成后才写回 store，否则会把还没读出来的旧值覆盖成默认
function persistIfBootstrapped(getter: () => SettingsState, patch: Partial<UiSettings>) {
  const s = getter();
  if (!s.bootstrapped) return;
  persist({ ...stripUi(s), ...patch });
}

function stripUi(s: SettingsState): UiSettings {
  return {
    playlistCollapsed: s.playlistCollapsed,
    topBarAutoHide: s.topBarAutoHide,
    topBarHidden: s.topBarHidden,
    showWaveform: s.showWaveform,
    rememberPosition: s.rememberPosition,
    frameStepMultiplier: s.frameStepMultiplier,
    alwaysOnTop: s.alwaysOnTop,
    playbackMode: s.playbackMode,
    playlistWidth: s.playlistWidth,
    shortcuts: s.shortcuts,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...defaults,
  settingsOpen: false,
  recordingAction: null,
  gotoFrameOpen: false,
  bootstrapped: false,

  setPlaylistCollapsed: (v) => {
    set({ playlistCollapsed: v });
    persistIfBootstrapped(get, { playlistCollapsed: v });
  },
  togglePlaylist: () => {
    const v = !get().playlistCollapsed;
    set({ playlistCollapsed: v });
    persistIfBootstrapped(get, { playlistCollapsed: v });
  },
  setTopBarAutoHide: (v) => {
    set({ topBarAutoHide: v });
    persistIfBootstrapped(get, { topBarAutoHide: v });
  },
  setTopBarHidden: (v) => {
    set({ topBarHidden: v });
    persistIfBootstrapped(get, { topBarHidden: v });
  },
  setShowWaveform: (v) => {
    set({ showWaveform: v });
    persistIfBootstrapped(get, { showWaveform: v });
  },
  setRememberPosition: (v) => {
    set({ rememberPosition: v });
    persistIfBootstrapped(get, { rememberPosition: v });
  },
  setFrameStepMultiplier: (v) => {
    const clamped = clampMultiplier(v);
    set({ frameStepMultiplier: clamped });
    persistIfBootstrapped(get, { frameStepMultiplier: clamped });
  },
  setAlwaysOnTop: (v) => {
    set({ alwaysOnTop: v });
    persistIfBootstrapped(get, { alwaysOnTop: v });
  },
  toggleAlwaysOnTop: () => {
    const v = !get().alwaysOnTop;
    set({ alwaysOnTop: v });
    persistIfBootstrapped(get, { alwaysOnTop: v });
  },
  setPlaybackMode: (m) => {
    set({ playbackMode: m });
    persistIfBootstrapped(get, { playbackMode: m });
  },
  cyclePlaybackMode: () => {
    const m = nextMode(get().playbackMode);
    set({ playbackMode: m });
    persistIfBootstrapped(get, { playbackMode: m });
  },
  setPlaylistWidth: (v) => {
    const clamped = clampPlaylistWidth(v);
    set({ playlistWidth: clamped });
    persistIfBootstrapped(get, { playlistWidth: clamped });
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false, recordingAction: null }),

  setShortcut: (action, combo) => {
    const current = get().shortcuts;
    const next: Record<ShortcutAction, string> = { ...current, [action]: combo };
    for (const [k, v] of Object.entries(next) as [ShortcutAction, string][]) {
      if (k !== action && v === combo) next[k] = "";
    }
    set({ shortcuts: next, recordingAction: null });
    persistIfBootstrapped(get, { shortcuts: next });
  },
  resetShortcuts: () => {
    const fresh = { ...DEFAULT_SHORTCUTS };
    set({ shortcuts: fresh });
    persistIfBootstrapped(get, { shortcuts: fresh });
  },
  beginRecording: (action) => set({ recordingAction: action }),
  cancelRecording: () => set({ recordingAction: null }),

  openGotoFrame: () => set({ gotoFrameOpen: true }),
  closeGotoFrame: () => set({ gotoFrameOpen: false }),
}));

/**
 * 在 App mount 时调用一次：从 tauri-plugin-store 异步加载持久化设置，
 * patch 到 zustand。完成后 bootstrapped=true，后续 setter 才会写回。
 */
export async function bootstrapSettings(): Promise<void> {
  try {
    const raw = await loadUiRaw();
    if (raw !== undefined) {
      const m = merge(raw);
      useSettingsStore.setState({ ...m, bootstrapped: true });
      return;
    }
  } catch (err) {
    console.warn("[settings] bootstrap failed", err);
  }
  useSettingsStore.setState({ bootstrapped: true });
}
