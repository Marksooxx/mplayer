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
  duration: number;

  volume: number;
  muted: boolean;
  speed: number;

  tracks: TrackInfo[];
  currentSid: number | null;
  currentAid: number | null;

  fullscreen: boolean;
  controlsVisible: boolean;

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
  duration: 0,

  volume: 80,
  muted: false,
  speed: 1,

  tracks: [],
  currentSid: null,
  currentAid: null,

  fullscreen: false,
  controlsVisible: true,

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
  setPosition: (v) => set({ position: v }),
  setDuration: (v) => set({ duration: v }),

  setVolume: (v) => set({ volume: Math.max(0, Math.min(100, v)) }),
  setMuted: (v) => set({ muted: v }),
  setSpeed: (v) => set({ speed: v }),

  setTracks: (t) => set({ tracks: t }),
  setCurrentSid: (v) => set({ currentSid: v }),
  setCurrentAid: (v) => set({ currentAid: v }),

  setFullscreen: (v) => set({ fullscreen: v }),
  setControlsVisible: (v) => set({ controlsVisible: v }),

  setError: (msg) => set({ errorMsg: msg }),
}));
