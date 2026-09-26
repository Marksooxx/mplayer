import { create } from "zustand";
import { basename } from "../lib/format";

export interface PlaylistItem {
  id: string;
  path: string;
  name: string;
  /** 添加时的单调递增序号；用于"默认（添加顺序）"排序的恢复点。 */
  seq: number;
}

export interface TrackInfo {
  id: number;
  type: "video" | "audio" | "sub";
  title?: string;
  lang?: string;
  selected: boolean;
  codec?: string;
  /** 视频轨其实是音频文件内嵌的封面图 */
  albumart?: boolean;
  /** 静态图片轨(封面图 / png 等) */
  image?: boolean;
}

interface PlayerState {
  playlist: PlaylistItem[];
  currentIndex: number;
  selectedIndex: number;

  isPlaying: boolean;
  /** 最近一次由暂停转为播放的本地时刻（performance.now()）；外推 mpv 位置的起点下界 */
  playingSince: number;
  position: number;
  /** 上一次 setPosition 时的本地时间戳（performance.now()）；用于 rAF 插值 */
  positionObservedAt: number;
  /**
   * mpv audio-pts：扣除驱动延迟后"正在响"的音频位置（虚拟播放头的主时钟，§6.32）。
   * null = 不可用（seek 后音频尚未开始 / 无音轨）；单曲循环回绕尾巴期间为负值。
   * 不要在 React selector 里订阅它（高频，只给 rAF 读）。
   */
  audioPts: number | null;
  audioPtsObservedAt: number;
  /** 最近一次 mpv playback-restart 事件到达时刻（seek / 加载完成标记，虚拟播放头用） */
  restartAt: number;
  /** mpv eof-reached：播到结尾(keep-open 会随之自动暂停，虚拟播放头据此区分用户暂停) */
  eofReached: boolean;
  /** 每次 start-file 递增：同路径重载（覆盖后重导出）也能触发波形重取 */
  loadSeq: number;
  duration: number;

  volume: number;
  muted: boolean;
  speed: number;

  tracks: TrackInfo[];
  /** 本文件的 track-list 已拿到（start-file 清零）；未知时虚拟播放头不按"无音轨"处理 */
  tracksKnown: boolean;
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
  setAudioPts: (v: number | null) => void;
  markRestart: () => void;
  setEofReached: (v: boolean) => void;
  bumpLoadSeq: () => void;
  setDuration: (v: number) => void;

  setVolume: (v: number) => void;
  setMuted: (v: boolean) => void;
  setSpeed: (v: number) => void;

  setTracks: (t: TrackInfo[]) => void;
  /** start-file：清空音轨表并标记未知 */
  resetTracks: () => void;
  /** file-loaded 主动查询 track-list 之后：即使列表为空也确认已知 */
  markTracksKnown: () => void;
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
let seqCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter}`;
}
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  playlist: [],
  currentIndex: -1,
  selectedIndex: -1,

  isPlaying: false,
  playingSince: 0,
  position: 0,
  positionObservedAt: 0,
  audioPts: null,
  audioPtsObservedAt: 0,
  restartAt: 0,
  eofReached: false,
  loadSeq: 0,
  duration: 0,

  volume: 80,
  muted: false,
  speed: 1,

  tracks: [],
  tracksKnown: false,
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

  setPlaylist: (items) =>
    set((s) => ({
      playlist: items,
      // 同步修复 currentIndex/selectedIndex,避免"列表清空但 currentIndex 还指旧位置"
      // 让 PlayerView 误以为还有 current item
      currentIndex:
        items.length === 0 ? -1 : Math.min(s.currentIndex, items.length - 1),
      selectedIndex:
        items.length === 0 ? -1 : Math.min(s.selectedIndex, items.length - 1),
      // 列表清空时也清掉播放状态,避免 ControlBar 显示残留的 duration/position
      ...(items.length === 0
        ? {
            position: 0,
            duration: 0,
            fileLoaded: false,
            videoWidth: 0,
            videoHeight: 0,
            fps: 0,
            isPlaying: false,
          }
        : {}),
    })),
  appendToPlaylist: (paths) => {
    const newItems = paths.map((p) => ({
      id: nextId(),
      seq: nextSeq(),
      path: p,
      name: basename(p),
    }));
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

  setIsPlaying: (v) =>
    set((s) => ({
      isPlaying: v,
      playingSince: v && !s.isPlaying ? performance.now() : s.playingSince,
    })),
  setPosition: (v) =>
    set({ position: v, positionObservedAt: performance.now() }),
  setAudioPts: (v) =>
    set({ audioPts: v, audioPtsObservedAt: performance.now() }),
  markRestart: () => set({ restartAt: performance.now() }),
  setEofReached: (v) => set({ eofReached: v }),
  bumpLoadSeq: () => set((s) => ({ loadSeq: s.loadSeq + 1 })),
  setDuration: (v) => set({ duration: v }),

  setVolume: (v) => set({ volume: Math.max(0, Math.min(100, v)) }),
  setMuted: (v) => set({ muted: v }),
  setSpeed: (v) => set({ speed: v }),

  // 卸载旧文件时 mpv 可能先报一个空列表：空列表不作为"已知"的依据
  setTracks: (t) => set((s) => ({ tracks: t, tracksKnown: s.tracksKnown || t.length > 0 })),
  resetTracks: () => set({ tracks: [], tracksKnown: false }),
  markTracksKnown: () => set({ tracksKnown: true }),
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
