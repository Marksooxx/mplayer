import { Button } from "@heroui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlayerStore } from "../store/playerStore";
import { playIndex } from "../hooks/useMpv";

const VIDEO_EXTENSIONS = [
  "mp4", "mkv", "webm", "avi", "mov", "flv", "m4v", "wmv", "ts", "mpg", "mpeg", "rmvb",
];

const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "ogg", "m4a", "aac", "wma", "opus"];

export function TopBar() {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const appendToPlaylist = usePlayerStore((s) => s.appendToPlaylist);

  const handleOpen = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        { name: "媒体文件", extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
        { name: "视频", extensions: VIDEO_EXTENSIONS },
        { name: "音频", extensions: AUDIO_EXTENSIONS },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    const startEmpty = playlist.length === 0;
    const added = appendToPlaylist(paths);
    if (startEmpty && added.length > 0) {
      void playIndex(0);
    }
  };

  const current = currentIndex >= 0 ? playlist[currentIndex] : null;

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 bg-black/50 backdrop-blur-md border-b border-white/10"
      style={{ zIndex: 20, position: "relative" }}
    >
      <Button size="sm" variant="primary" onPress={handleOpen}>
        打开文件
      </Button>
      <div className="flex-1 min-w-0 text-sm text-white/80 truncate">
        {current ? current.name : "未加载文件 — 点击「打开文件」或拖入文件"}
      </div>
      <div className="text-xs text-white/40">
        {playlist.length > 0 ? `${currentIndex + 1} / ${playlist.length}` : ""}
      </div>
    </div>
  );
}
