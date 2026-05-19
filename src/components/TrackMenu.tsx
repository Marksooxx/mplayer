import { useEffect, useState } from "react";
import { AudioLines, Captions, FolderOpen, RotateCcw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlayerStore } from "../store/playerStore";
import {
  addSubtitle,
  getSubDelay,
  setAudioTrack,
  setSubDelay,
  setSubtitleTrack,
} from "../lib/mpv";

type Kind = "sub" | "audio";

interface Props {
  kind: Kind;
  label: string;
}

const SUBTITLE_FILTER = [
  {
    name: "字幕文件",
    extensions: ["srt", "ass", "ssa", "sub", "vtt", "idx", "smi", "sup"],
  },
];

export function TrackMenu({ kind, label }: Props) {
  const tracks = usePlayerStore((s) => s.tracks);
  const currentSid = usePlayerStore((s) => s.currentSid);
  const currentAid = usePlayerStore((s) => s.currentAid);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const [open_, setOpen] = useState(false);
  const [subDelay, setLocalSubDelay] = useState(0);

  const items = tracks.filter((t) => t.type === kind);
  const currentId = kind === "sub" ? currentSid : currentAid;
  const Icon = kind === "sub" ? Captions : AudioLines;

  // 字幕菜单打开时拉一次 sub-delay 同步显示
  useEffect(() => {
    if (kind !== "sub" || !open_) return;
    void getSubDelay().then(setLocalSubDelay);
  }, [kind, open_]);

  const handleSelect = async (id: number | "no") => {
    try {
      if (kind === "sub") await setSubtitleTrack(id);
      else await setAudioTrack(id);
    } catch (err) {
      console.error(err);
    }
    setOpen(false);
  };

  const handleLoadSub = async () => {
    if (currentIndex < 0) {
      // 没有当前播放,提示无效
      setOpen(false);
      return;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      filters: SUBTITLE_FILTER,
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      await addSubtitle(selected);
    } catch (err) {
      console.error("[sub-add] failed", err);
    }
    setOpen(false);
  };

  const adjustDelay = async (delta: number) => {
    const next = Math.round((subDelay + delta) * 1000) / 1000;
    setLocalSubDelay(next);
    try {
      await setSubDelay(next);
    } catch (err) {
      console.error("[sub-delay] failed", err);
    }
  };

  const resetDelay = async () => {
    setLocalSubDelay(0);
    try {
      await setSubDelay(0);
    } catch (err) {
      console.error("[sub-delay reset] failed", err);
    }
  };

  // 音轨菜单仍然在无轨道时 disable;字幕菜单永远启用(为了能加载外部字幕)
  const disabled = kind === "audio" && items.length === 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label={label}
        title={label}
        className="inline-flex items-center gap-1.5 h-9 px-2.5 rounded-md text-sm text-white/85 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <Icon size={16} />
        <span>{label}</span>
        <span className="text-[10px] text-white/40 tabular-nums">
          {items.length > 0 ? `(${items.length})` : ""}
        </span>
      </button>
      {open_ && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 mb-2 z-50 min-w-[240px] max-h-[400px] overflow-y-auto py-1 rounded-md border border-white/10 bg-neutral-900 shadow-xl text-sm text-white/90">
            <button
              className={`w-full px-3 py-1.5 text-left hover:bg-white/10 ${currentId === null ? "text-primary-300" : ""}`}
              onClick={() => handleSelect("no")}
            >
              {currentId === null ? "✓ " : "  "}关闭{label}
            </button>
            {items.length === 0 && (
              <div className="px-3 py-2 text-xs text-white/40">无可用轨道</div>
            )}
            {items.map((t) => (
              <button
                key={t.id}
                className={`w-full px-3 py-1.5 text-left hover:bg-white/10 ${currentId === t.id ? "text-primary-300" : ""}`}
                onClick={() => handleSelect(t.id)}
              >
                {currentId === t.id ? "✓ " : "  "}
                #{t.id} {t.title ?? t.lang ?? "未命名"} {t.codec ? `(${t.codec})` : ""}
              </button>
            ))}

            {/* 字幕扩展选项:加载外部 + 延迟调整 */}
            {kind === "sub" && (
              <>
                <div className="my-1 border-t border-white/10" />
                <button
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2 disabled:opacity-30"
                  disabled={currentIndex < 0}
                  onClick={handleLoadSub}
                  title={currentIndex < 0 ? "需要先加载视频" : ""}
                >
                  <FolderOpen size={14} /> 加载字幕文件…
                </button>
                <div className="my-1 border-t border-white/10" />
                <div className="px-3 pt-2 pb-1 text-[11px] text-white/45 uppercase tracking-wide">
                  字幕延迟
                </div>
                <div className="flex items-center gap-1 px-3 pb-2">
                  <button
                    type="button"
                    onClick={() => void adjustDelay(-0.1)}
                    className="h-7 px-2 rounded text-xs text-white/80 border border-white/15 hover:border-white/40 hover:text-white tabular-nums"
                    title="-100ms"
                  >
                    -100ms
                  </button>
                  <span className="flex-1 text-center text-xs text-white/90 tabular-nums">
                    {subDelay >= 0 ? "+" : ""}
                    {subDelay.toFixed(3)} s
                  </span>
                  <button
                    type="button"
                    onClick={() => void adjustDelay(0.1)}
                    className="h-7 px-2 rounded text-xs text-white/80 border border-white/15 hover:border-white/40 hover:text-white tabular-nums"
                    title="+100ms"
                  >
                    +100ms
                  </button>
                  <button
                    type="button"
                    onClick={() => void resetDelay()}
                    className="h-7 w-7 inline-flex items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10"
                    title="重置为 0"
                  >
                    <RotateCcw size={12} />
                  </button>
                </div>
                <div className="px-3 pb-2 text-[10px] text-white/35">
                  提示:也可以直接把 .srt/.ass 等字幕文件拖入视频区自动加载
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
