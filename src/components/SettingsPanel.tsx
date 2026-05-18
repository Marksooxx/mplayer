import { X } from "lucide-react";
import { useSettingsStore } from "../store/settingsStore";

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex items-start justify-between gap-3 p-3 rounded-md hover:bg-white/5 cursor-pointer">
      <div className="flex-1">
        <div className="text-sm text-white/90">{label}</div>
        {description && <div className="text-xs text-white/50 mt-0.5">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 w-10 h-5 rounded-full transition-colors ${
          checked ? "bg-primary-500" : "bg-white/20"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </button>
    </label>
  );
}

export function SettingsPanel() {
  const open = useSettingsStore((s) => s.settingsOpen);
  const close = useSettingsStore((s) => s.closeSettings);
  const topBarAutoHide = useSettingsStore((s) => s.topBarAutoHide);
  const topBarHidden = useSettingsStore((s) => s.topBarHidden);
  const setTopBarAutoHide = useSettingsStore((s) => s.setTopBarAutoHide);
  const setTopBarHidden = useSettingsStore((s) => s.setTopBarHidden);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={close}
    >
      <div
        className="w-[420px] max-w-[90vw] rounded-lg bg-neutral-900 border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h2 className="text-base font-medium text-white">设置</h2>
          <button
            onClick={close}
            className="p-1 rounded hover:bg-white/10 text-white/70"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-2">
          <div className="px-3 py-2 text-xs text-white/40 uppercase tracking-wide">界面</div>
          <Toggle
            label="顶部文件名条悬浮显示"
            description="开启后顶部文件名条默认隐藏，鼠标移到窗口顶部时浮现 2.5 秒后再次隐藏"
            checked={topBarAutoHide && !topBarHidden}
            onChange={(v) => {
              setTopBarHidden(false);
              setTopBarAutoHide(v);
            }}
          />
          <Toggle
            label="完全隐藏顶部文件名条"
            description="关掉浮动显示功能，顶部永远不会出现文件名条"
            checked={topBarHidden}
            onChange={(v) => {
              setTopBarHidden(v);
            }}
          />
        </div>

        <div className="px-4 py-3 border-t border-white/10 text-xs text-white/40">
          mplayer · Tauri 2 + HeroUI v3 + libmpv
        </div>
      </div>
    </div>
  );
}
