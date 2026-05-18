import { useState } from "react";
import { MarqueeText } from "./MarqueeText";
import { usePlayerStore, type PlaylistItem as PlaylistItemType } from "../store/playerStore";
import { playIndex } from "../hooks/useMpv";
import { parentDir } from "../lib/format";

interface Props {
  item: PlaylistItemType;
  index: number;
}

export function PlaylistItem({ item, index }: Props) {
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const selectedIndex = usePlayerStore((s) => s.selectedIndex);
  const setSelectedIndex = usePlayerStore((s) => s.setSelectedIndex);
  const removeFromPlaylist = usePlayerStore((s) => s.removeFromPlaylist);
  const moveToTop = usePlayerStore((s) => s.moveToTop);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const isCurrent = currentIndex === index;
  const isSelected = selectedIndex === index;

  const handleClick = () => setSelectedIndex(index);
  const handleDoubleClick = () => {
    void playIndex(index);
  };
  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedIndex(index);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const closeMenu = () => setMenu(null);

  const openInFolder = async () => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(item.path);
    } catch (err) {
      console.error("revealItemInDir failed", err);
    }
    closeMenu();
  };

  const handleRemove = () => {
    removeFromPlaylist(item.id);
    closeMenu();
  };
  const handleMoveTop = () => {
    moveToTop(item.id);
    closeMenu();
  };

  const bgClass = isCurrent
    ? "bg-primary-500/30 border-l-2 border-primary-400"
    : isSelected
      ? "bg-white/10"
      : "hover:bg-white/5";

  return (
    <>
      <div
        className={`group flex flex-col gap-0.5 px-3 py-2 cursor-pointer transition-colors ${bgClass}`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContext}
        title={item.path}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`shrink-0 w-4 text-center text-xs ${
              isCurrent ? "text-primary-300" : "text-white/40"
            }`}
          >
            {isCurrent ? "▶" : index + 1}
          </span>
          <div className="flex-1 min-w-0 text-sm text-white/90">
            <MarqueeText text={item.name} />
          </div>
        </div>
        <div className="pl-6 text-[10px] text-white/30 truncate">{parentDir(item.path)}</div>
      </div>
      {menu && (
        <>
          <div className="fixed inset-0 z-50" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
          <div
            className="fixed z-50 min-w-[180px] py-1 rounded-md border border-white/10 bg-neutral-900/95 backdrop-blur-md shadow-xl text-sm text-white/90"
            style={{ left: menu.x, top: menu.y }}
          >
            <button className="w-full px-3 py-1.5 text-left hover:bg-white/10" onClick={handleMoveTop}>移到顶部</button>
            <button className="w-full px-3 py-1.5 text-left hover:bg-white/10" onClick={openInFolder}>在文件夹中显示</button>
            <button className="w-full px-3 py-1.5 text-left hover:bg-red-500/30 text-red-300" onClick={handleRemove}>从列表移除</button>
          </div>
        </>
      )}
    </>
  );
}
