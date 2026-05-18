/**
 * 快捷键动作枚举与默认绑定。
 * 字符串值是 combo 表达式，形如：
 *   - 单键：  "Space"、"F"、"ArrowLeft"、"PageUp"
 *   - 组合：  "Ctrl+ArrowLeft"、"Shift+M"
 * 修饰符固定大小写：Ctrl / Shift / Alt / Meta，顺序固定。
 */

export type ShortcutAction =
  | "playPause"
  | "seekBack"
  | "seekForward"
  | "frameBack"
  | "frameForward"
  | "gotoFrame"
  | "volumeUp"
  | "volumeDown"
  | "mute"
  | "fullscreen"
  | "exitFullscreen"
  | "prevTrack"
  | "nextTrack";

export const ACTION_ORDER: ShortcutAction[] = [
  "playPause",
  "seekBack",
  "seekForward",
  "frameBack",
  "frameForward",
  "gotoFrame",
  "volumeUp",
  "volumeDown",
  "mute",
  "fullscreen",
  "exitFullscreen",
  "prevTrack",
  "nextTrack",
];

export const ACTION_LABELS: Record<ShortcutAction, string> = {
  playPause: "播放 / 暂停",
  seekBack: "快退 5 秒",
  seekForward: "快进 5 秒",
  frameBack: "单帧后退",
  frameForward: "单帧前进",
  gotoFrame: "跳转到指定帧",
  volumeUp: "音量 +5",
  volumeDown: "音量 -5",
  mute: "静音切换",
  fullscreen: "切换全屏",
  exitFullscreen: "退出全屏",
  prevTrack: "上一个视频",
  nextTrack: "下一个视频",
};

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  playPause: "Space",
  seekBack: "ArrowLeft",
  seekForward: "ArrowRight",
  frameBack: "Ctrl+ArrowLeft",
  frameForward: "Ctrl+ArrowRight",
  gotoFrame: "Ctrl+F",
  volumeUp: "ArrowUp",
  volumeDown: "ArrowDown",
  mute: "M",
  fullscreen: "Ctrl+Enter",
  exitFullscreen: "Escape",
  prevTrack: "PageUp",
  nextTrack: "PageDown",
};

/** 从 KeyboardEvent 取出标准化 combo 字符串。 */
export function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  let k = e.key;
  if (k === " ") k = "Space";
  // 单字母统一大写，避免大小写不一致
  if (/^[a-z]$/.test(k)) k = k.toUpperCase();
  parts.push(k);
  return parts.join("+");
}

/** 把 combo 字符串渲染成人类友好的形式（用于设置面板显示）。 */
export function displayCombo(combo: string): string {
  if (!combo) return "未绑定";
  return combo
    .replace(/\bArrowLeft\b/g, "←")
    .replace(/\bArrowRight\b/g, "→")
    .replace(/\bArrowUp\b/g, "↑")
    .replace(/\bArrowDown\b/g, "↓")
    .replace(/\bPageUp\b/g, "PgUp")
    .replace(/\bPageDown\b/g, "PgDn")
    .replace(/\bEscape\b/g, "Esc")
    .replace(/\bEnter\b/g, "↵")
    .replace(/\bBackspace\b/g, "⌫")
    .replace(/\+/g, " + ");
}

/** 判断按键是否为仅修饰键（按下时不应触发命中）。 */
export function isPureModifier(key: string): boolean {
  return key === "Control" || key === "Shift" || key === "Alt" || key === "Meta";
}
