/**
 * 媒体扩展名集中定义 —— 打开对话框过滤、拖拽分类、playlist「不支持」标记
 * 都从这里取。与 src-tauri/tauri.conf.json 的 fileAssociations 手动保持一致
 * （改这里时记得同步那边，Windows 关联表才会把对应类型路由进 mplayer）。
 */
export const VIDEO_EXTENSIONS = [
  "mp4", "m4v", "mkv", "webm", "avi", "mov", "flv", "f4v", "wmv", "asf",
  "ts", "m2ts", "mts", "mpg", "mpeg", "m2v", "vob", "3gp", "3g2", "divx",
  "ogv", "ogm", "rm", "rmvb",
];

export const AUDIO_EXTENSIONS = [
  "mp3", "flac", "wav", "wave", "ogg", "oga", "opus", "m4a", "m4b", "aac",
  "wma", "mka", "ac3", "eac3", "dts", "aiff", "aif", "ape", "alac", "amr",
];

export const SUBTITLE_EXTENSIONS = [
  "srt", "ass", "ssa", "sub", "vtt", "idx", "smi", "sup",
];

const MEDIA_SET = new Set<string>([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);
const SUBTITLE_SET = new Set<string>(SUBTITLE_EXTENSIONS);

/** 取小写扩展名（不含点）；无扩展名返回 "" */
export function extOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** mplayer(libmpv) 可播放的视频/音频文件 */
export function isSupportedMedia(path: string): boolean {
  return MEDIA_SET.has(extOf(path));
}

export function isSubtitle(path: string): boolean {
  return SUBTITLE_SET.has(extOf(path));
}

/** playlist 中第一个可播放项的下标；全部不支持时返回 -1 */
export function firstSupportedIndex(items: { path: string }[]): number {
  return items.findIndex((it) => isSupportedMedia(it.path));
}
