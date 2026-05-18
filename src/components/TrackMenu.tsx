import { useState } from "react";
import { AudioLines, Captions } from "lucide-react";
import { usePlayerStore } from "../store/playerStore";
import { setAudioTrack, setSubtitleTrack } from "../lib/mpv";

type Kind = "sub" | "audio";

interface Props {
  kind: Kind;
  label: string;
}

export function TrackMenu({ kind, label }: Props) {
  const tracks = usePlayerStore((s) => s.tracks);
  const currentSid = usePlayerStore((s) => s.currentSid);
  const currentAid = usePlayerStore((s) => s.currentAid);
  const [open, setOpen] = useState(false);

  const items = tracks.filter((t) => t.type === kind);
  const currentId = kind === "sub" ? currentSid : currentAid;
  const Icon = kind === "sub" ? Captions : AudioLines;

  const handleSelect = async (id: number | "no") => {
    try {
      if (kind === "sub") await setSubtitleTrack(id);
      else await setAudioTrack(id);
    } catch (err) {
      console.error(err);
    }
    setOpen(false);
  };

  const disabled = items.length === 0;

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
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 mb-2 z-50 min-w-[220px] max-h-[300px] overflow-y-auto py-1 rounded-md border border-white/10 bg-neutral-900 shadow-xl text-sm text-white/90">
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
          </div>
        </>
      )}
    </div>
  );
}
