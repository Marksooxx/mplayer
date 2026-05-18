import { ListMusic } from "lucide-react";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { PlaylistItem } from "./PlaylistItem";

export function PlaylistPanel() {
  const playlist = usePlayerStore((s) => s.playlist);
  const collapsed = useSettingsStore((s) => s.playlistCollapsed);

  if (collapsed) return null;

  return (
    <aside
      className="flex flex-col h-full border-l border-white/10 bg-neutral-950"
      style={{ width: 280, zIndex: 20 }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/10">
        <ListMusic size={16} className="text-white/70" />
        <span className="flex-1 text-sm font-medium text-white/90">播放列表</span>
        <span className="text-xs text-white/40">{playlist.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {playlist.length === 0 ? (
          <div className="px-3 py-6 text-xs text-white/40 text-center leading-relaxed">
            列表为空<br />
            通过顶部按钮或拖入文件添加
          </div>
        ) : (
          playlist.map((item, idx) => (
            <PlaylistItem key={item.id} item={item} index={idx} />
          ))
        )}
      </div>
    </aside>
  );
}
