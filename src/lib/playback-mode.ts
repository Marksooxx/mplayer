/**
 * 播放模式定义。循环顺序：列表循环 → 单曲循环 → 随机 → 列表循环 …
 */
export type PlaybackMode = "loop-playlist" | "loop-single" | "shuffle";

export const PLAYBACK_MODE_DEFAULT: PlaybackMode = "loop-playlist";

export const PLAYBACK_MODE_CYCLE: PlaybackMode[] = [
  "loop-playlist",
  "loop-single",
  "shuffle",
];

export const PLAYBACK_MODE_LABELS: Record<PlaybackMode, string> = {
  "loop-playlist": "列表循环",
  "loop-single": "单曲循环",
  shuffle: "随机播放",
};

export function nextMode(current: PlaybackMode): PlaybackMode {
  const i = PLAYBACK_MODE_CYCLE.indexOf(current);
  return PLAYBACK_MODE_CYCLE[(i + 1) % PLAYBACK_MODE_CYCLE.length];
}

/** 给定当前 index 和列表长度，按 mode 算下一个 index。返回 -1 表示停止（无后续）。 */
export function pickNextIndex(
  mode: PlaybackMode,
  currentIndex: number,
  total: number,
): number {
  if (total <= 0) return -1;
  if (total === 1) return mode === "loop-single" || mode === "loop-playlist" ? 0 : -1;

  switch (mode) {
    case "loop-single":
      // 由调用方走"seek 0 + unpause"路径，不走 playIndex；这里返回 current 作占位
      return currentIndex;
    case "loop-playlist":
      return (currentIndex + 1) % total;
    case "shuffle": {
      // 任意不同于 current 的随机 index
      let next = Math.floor(Math.random() * total);
      if (next === currentIndex) next = (next + 1) % total;
      return next;
    }
  }
}
