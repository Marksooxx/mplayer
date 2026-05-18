import { useState } from "react";
import { Button } from "@heroui/react";
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

  const handleSelect = async (id: number | "no") => {
    try {
      if (kind === "sub") await setSubtitleTrack(id);
      else await setAudioTrack(id);
    } catch (err) {
      console.error(err);
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="outline"
        onPress={() => setOpen((v) => !v)}
        isDisabled={items.length === 0}
      >
        {label}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full right-0 mb-2 z-50 min-w-[200px] max-h-[300px] overflow-y-auto py-1 rounded-md border border-white/10 bg-neutral-900/95 backdrop-blur-md shadow-xl text-sm text-white/90"
          >
            <button
              className={`w-full px-3 py-1.5 text-left hover:bg-white/10 ${currentId === null ? "text-primary-300" : ""}`}
              onClick={() => handleSelect("no")}
            >
              {currentId === null ? "✓ " : "  "}关闭
            </button>
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
