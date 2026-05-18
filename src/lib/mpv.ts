import {
  command,
  setProperty,
  getProperty,
} from "tauri-plugin-libmpv-api";
import type { TrackInfo } from "../store/playerStore";

export async function loadFile(path: string): Promise<void> {
  await command("loadfile", [path, "replace"]);
}

export async function setPaused(paused: boolean): Promise<void> {
  await setProperty("pause", paused);
}

/**
 * 切换播放/暂停 —— 从 mpv 真实状态读取，不依赖 React store 的 isPlaying。
 * 修复"初始事件错过导致 isPlaying 一直 false"的 race。
 */
export async function togglePause(): Promise<void> {
  try {
    const paused = await getProperty("pause", "flag");
    if (paused === null) return;
    await setProperty("pause", !paused);
  } catch (err) {
    console.error("[mpv] togglePause failed", err);
  }
}

export async function seekRelative(deltaSeconds: number): Promise<void> {
  await command("seek", [deltaSeconds, "relative"]);
}

export async function seekAbsolute(seconds: number): Promise<void> {
  await command("seek", [seconds, "absolute"]);
}

export async function frameStep(): Promise<void> {
  await command("frame-step");
}

export async function frameBackStep(): Promise<void> {
  await command("frame-back-step");
}

/**
 * 多帧跳转。优先用 fps 算精确时间 seek（一次 IPC），失败回退到逐帧调用。
 * - count > 0 向前；count < 0 向后；0 不动。
 * - audio-only 拿不到 fps 时按 0.04s/帧（25fps 兜底）算时间。
 */
export async function frameStepBy(count: number): Promise<void> {
  if (count === 0) return;
  try {
    let fps: number | null = null;
    try {
      const v = await getProperty("container-fps", "double");
      if (typeof v === "number" && v > 0) fps = v;
    } catch { /* ignore */ }
    if (fps === null) fps = 25; // 兜底
    const delta = count / fps;
    // relative+exact 保证按时间精确 seek 而不是跳到关键帧
    await command("seek", [delta, "relative+exact"]);
  } catch (err) {
    console.warn("[mpv] frameStepBy seek failed, falling back to frame-step loop", err);
    const n = Math.abs(count);
    for (let i = 0; i < n; i++) {
      if (count > 0) await frameStep();
      else await frameBackStep();
    }
  }
}

export async function setVolumeProp(volume: number): Promise<void> {
  await setProperty("volume", Math.max(0, Math.min(100, volume)));
}

export async function setMutedProp(muted: boolean): Promise<void> {
  await setProperty("mute", muted);
}

export async function setSpeedProp(speed: number): Promise<void> {
  await setProperty("speed", speed);
}

export async function setSubtitleTrack(sid: number | "no"): Promise<void> {
  await setProperty("sid", sid as unknown as string | number);
}

export async function setAudioTrack(aid: number | "no"): Promise<void> {
  await setProperty("aid", aid as unknown as string | number);
}

export async function stopPlayback(): Promise<void> {
  await command("stop");
}

interface MpvTrackRaw {
  id: number;
  type: string;
  title?: string;
  lang?: string;
  selected?: boolean;
  codec?: string;
}

export function parseTrackList(raw: unknown): TrackInfo[] {
  if (!Array.isArray(raw)) return [];
  return (raw as MpvTrackRaw[])
    .filter((t) => t && (t.type === "video" || t.type === "audio" || t.type === "sub"))
    .map((t) => ({
      id: t.id,
      type: t.type as "video" | "audio" | "sub",
      title: t.title,
      lang: t.lang,
      selected: !!t.selected,
      codec: t.codec,
    }));
}

export async function getCurrentTracks(): Promise<TrackInfo[]> {
  try {
    const raw = await getProperty("track-list", "node");
    return parseTrackList(raw);
  } catch {
    return [];
  }
}
