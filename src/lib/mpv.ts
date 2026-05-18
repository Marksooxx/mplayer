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
