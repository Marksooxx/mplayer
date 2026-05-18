import { create } from "zustand";
import { basename } from "../lib/format";

export interface PlaylistItem {
  id: string;
  path: string;
  name: string;
}

export interface TrackInfo {
  id: number;
  type: "video" | "audio" | "sub";
  title?: string;
  lang?: string;
  selected: boolean;
  codec?: string;
}

interface PlayerState {
  playlist: PlaylistItem[];
  currentIndex: number;
  selectedIndex: number;

  isPlaying: boolean;
  position: number;
  /** 上一次 setPosition 时的本地时间戳（performance.now()）；用于 rAF 插值 */
  positionObservedAt: number;
  duration: number;

  volume: number;
  muted: boolean;
  speed: number;

  tracks: TrackInfo[];
  currentSid: number | null;
  currentAid: number | null;

  fullscreen: boolean;
  controlsVisible: boolean;

  mpvReady: boolean;
  fileLoaded: boolean; // 当 mpv 真正加载了视频帧（file-loaded 事件）才置 true
  dragHover: boolean; // 文件正在被拖入窗口（drag enter/over），用于显示放置区提示
  dragPosition: number | null; // 进度条正在被拖动时的目标位置（秒）；松手后清空
  videoWidth: number;  // 0 表示无视频流（纯音频）
  videoHeight: number;
  fps: number;         // container-fps，无视频流时为 0
  errorMsg: string | null;

  setPlaylist: (items: PlaylistItem[]) => void;
  appendToPlaylist: (paths: string[]) => PlaylistItem[];
  removeFromPlaylist: (id: string) => void;
  moveToTop: (id: string) => void;

  setCurrentIndex: (idx: number) => void;
  setSelectedIndex: (idx: number) => void;

  setIsPlaying: (v: boolean) => void;
  setPosition: (v: number) => void;
  setDuration: (v: number) => void;

  setVolume: (v: number) => void;
  setMuted: (v: boolean) => void;
  setSpeed: (v: number) => void;

  setTracks: (t: TrackInfo[]) => void;
  setCurrentSid: (v: number | null) => void;
  setCurrentAid: (v: number | null) => void;

  setFullscreen: (v: boolean) => void;
  setControlsVisible: (v: boolean) => void;

  setMpvReady: (v: boolean) => void;
  setFileLoaded: (v: boolean) => void;
  setDragHover: (v: boolean) => void;
  setDragPosition: (v: number | null) => void;
  setVideoSize: (w: number, h: number) => void;
  setFps: (v: number) => void;
  setError: (msg: string | null) => void;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter}`;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  playlist: [],
  currentIndex: -1,
  selectedIndex: -1,

  isPlaying: false,
  position: 0,
  positionObservedAt: 0,
  duration: 0,

  volume: 80,
  muted: false,
  speed: 1,

  tracks: [],
  currentSid: null,
  currentAid: null,

  fullscreen: false,
  controlsVisible: true,

  mpvReady: false,
  fileLoaded: false,
  dragHover: false,
  dragPosition: null,
  videoWidth: 0,
  videoHeight: 0,
  fps: 0,
  errorMsg: null,

  setPlaylist: (items) => set({ playlist: items }),
  appendToPlaylist: (paths) => {
    const newItems = paths.map((p) => ({ id: nextId(), path: p, name: basename(p) }));
    let result: PlaylistItem[] = [];
    set((s) => {
      result = [...s.playlist, ...newItems];
      return { playlist: result };
    });
    return newItems;
  },
  removeFromPlaylist: (id) =>
    set((s) => {
      const idx = s.playlist.findIndex((it) => it.id === id);
      if (idx < 0) return {};
      const next = s.playlist.filter((it) => it.id !== id);
      let nextIdx = s.currentIndex;
      let nextSel = s.selectedIndex;
      if (idx < s.currentIndex) nextIdx -= 1;
      else if (idx === s.currentIndex) nextIdx = -1;
      if (idx < s.selectedIndex) nextSel -= 1;
      else if (idx === s.selectedIndex) nextSel = -1;
      return { playlist: next, currentIndex: nextIdx, selectedIndex: nextSel };
    }),
  moveToTop: (id) =>
    set((s) => {
      const idx = s.playlist.findIndex((it) => it.id === id);
      if (idx <= 0) return {};
      const next = [...s.playlist];
      const [item] = next.splice(idx, 1);
      next.unshift(item);
      let nextCur = s.currentIndex;
      if (s.currentIndex === idx) nextCur = 0;
      else if (s.currentIndex < idx) nextCur += 1;
      return { playlist: next, currentIndex: nextCur };
    }),

  setCurrentIndex: (idx) => set({ currentIndex: idx, selectedIndex: idx }),
  setSelectedIndex: (idx) => set({ selectedIndex: idx }),

  setIsPlaying: (v) => set({ isPlaying: v }),
  setPosition: (v) =>
    set({ position: v, positionObservedAt: performance.now() }),
  setDuration: (v) => set({ duration: v }),

  setVolume: (v) => set({ volume: Math.max(0, Math.min(100, v)) }),
  setMuted: (v) => set({ muted: v }),
  setSpeed: (v) => set({ speed: v }),

  setTracks: (t) => set({ tracks: t }),
  setCurrentSid: (v) => set({ currentSid: v }),
  setCurrentAid: (v) => set({ currentAid: v }),

  setFullscreen: (v) => set({ fullscreen: v }),
  setControlsVisible: (v) => set({ controlsVisible: v }),

  setMpvReady: (v) => set({ mpvReady: v }),
  setFileLoaded: (v) => set({ fileLoaded: v }),
  setDragHover: (v) => set({ dragHover: v }),
  setDragPosition: (v) => set({ dragPosition: v }),
  setVideoSize: (w, h) => set({ videoWidth: w, videoHeight: h }),
  setFps: (v) => set({ fps: v }),
  setError: (msg) => set({ errorMsg: msg }),
}));
