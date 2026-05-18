import { usePlayerStore } from "../store/playerStore";
import { PlaylistItem } from "./PlaylistItem";

export function PlaylistPanel() {
  const playlist = usePlayerStore((s) => s.playlist);

  return (
    <aside
      className="flex flex-col h-full border-l border-white/10 bg-black/60 backdrop-blur-md"
      style={{ width: 280, zIndex: 20 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-sm font-medium text-white/90">播放列表</span>
        <span className="text-xs text-white/40">{playlist.length} 项</span>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {playlist.length === 0 ? (
          <div className="px-3 py-6 text-xs text-white/40 text-center">
            列表为空 — 通过顶部按钮或拖入文件添加
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
