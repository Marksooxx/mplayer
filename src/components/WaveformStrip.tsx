import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { readFile } from "@tauri-apps/plugin-fs";
import WaveSurfer from "wavesurfer.js";
import { usePlayerStore } from "../store/playerStore";
import { seekAbsolute } from "../lib/mpv";

const MIME_MAP: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/ogg",
  wma: "audio/x-ms-wma",
  mp4: "audio/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  flv: "video/x-flv",
  m4v: "video/mp4",
  wmv: "video/x-ms-wmv",
  ts: "video/mp2t",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
};

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

interface Props {
  height?: number;
}

/** 波形条：所有文件类型都显示在 ControlBar 上方，进度跟随 mpv，点击 seek。 */
export function WaveformStrip({ height = 60 }: Props) {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const fileLoaded = usePlayerStore((s) => s.fileLoaded);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);

  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const item = currentIndex >= 0 ? playlist[currentIndex] : null;
  const path = item?.path;

  // 加载/重建 WaveSurfer
  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    const cleanup = () => {
      if (wsRef.current) {
        try { wsRef.current.destroy(); } catch { /* ignore */ }
        wsRef.current = null;
      }
      if (audioElRef.current) {
        audioElRef.current = null;
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };

    if (!path || !containerRef.current) {
      cleanup();
      return;
    }

    setLoading(true);

    (async () => {
      try {
        const bytes = await readFile(path);
        if (cancelled) return;

        // 销毁旧实例
        cleanup();

        const blob = new Blob([bytes as BlobPart], { type: mimeFor(path) });
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;

        // muted 音频元素：让 wavesurfer 有 media 但不出声（mpv 才是真正播放器）
        const audio = document.createElement("audio");
        audio.muted = true;
        audio.preload = "metadata";
        audioElRef.current = audio;

        if (!containerRef.current) return;

        const ws = WaveSurfer.create({
          container: containerRef.current,
          waveColor: "rgba(255, 255, 255, 0.35)",
          progressColor: "#6366f1",
          cursorColor: "rgba(255, 255, 255, 0.7)",
          cursorWidth: 1,
          height,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          normalize: true,
          interact: false, // 我们自己处理点击 seek
          media: audio,
        });
        wsRef.current = ws;

        ws.on("ready", () => {
          if (cancelled) return;
          setLoading(false);
          // 渲染完后同步当前进度
          const pos = usePlayerStore.getState().position;
          if (pos > 0) {
            try { ws.setTime(pos); } catch { /* ignore */ }
          }
        });

        ws.on("error", (err) => {
          console.error("[wavesurfer] error", err);
          if (!cancelled) {
            setLoading(false);
            setFailed(true);
          }
        });

        await ws.load(url);
      } catch (err) {
        console.error("[waveform] load failed", err);
        if (!cancelled) {
          setLoading(false);
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [path, height]);

  // 同步 mpv 进度到 wavesurfer 光标
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !fileLoaded || duration <= 0) return;
    try {
      ws.setTime(Math.min(position, duration));
    } catch {
      /* ws may not be ready */
    }
  }, [position, duration, fileLoaded]);

  // 点击 seek
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || duration <= 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const target = ratio * duration;
    void seekAbsolute(target);
  };

  if (!item) return null;

  return (
    <div
      className="relative w-full bg-neutral-950 border-t border-white/5 px-2"
      style={{ height }}
    >
      <div
        ref={containerRef}
        className="absolute inset-0 cursor-pointer"
        onClick={handleClick}
        title="点击跳转"
      />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-white/50 text-xs bg-neutral-950/80 pointer-events-none">
          <Loader2 size={14} className="animate-spin" />
          波形解码中...
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-white/40 text-xs pointer-events-none">
          波形不可用
        </div>
      )}
    </div>
  );
}
