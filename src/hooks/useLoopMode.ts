import { useEffect } from "react";
import { setProperty } from "tauri-plugin-libmpv-api";
import { useSettingsStore } from "../store/settingsStore";
import { usePlayerStore } from "../store/playerStore";

/**
 * 监听 settings.playbackMode 变化,同步到 mpv 的 loop-file 属性。
 *
 * 为什么不靠 JS handleEof:loop-single 走 [mpv eof-reached event] →
 * [JS observer 回调] → [setProperty seek 0] → [IPC roundtrip] →
 * [mpv 解码起始位置] → [setProperty pause=false] 这条链路,有双 IPC +
 * JS event 派发 + 解码 lead-in 的延迟,加起来就是用户能听到的"loop
 * 瞬间一小段空白",DAW 里同样的音频无缝是因为它走解码器层 sample-
 * accurate 循环。
 *
 * mpv 的 loop-file=inf 把循环下沉到解码器层 ——
 *   - 零 IPC,零 JS roundtrip
 *   - 解码器从文件结尾 sample 直接接到文件起始 sample
 *   - audio output 缓冲连续,不掉一帧
 * 跟 DAW 同等的无缝体验。设了它之后 mpv 不会触发 eof-reached,
 * useMpv 的 handleEof loop-single 分支自然不会再走到(保留作 fallback
 * 兜底,以防某些容器/编码下 loop-file 不生效)。
 *
 * loop-file 是 mpv global property,loadfile 后保持,不需要每次切文件
 * reaffirm。
 */
export function useLoopMode(): void {
  const playbackMode = useSettingsStore((s) => s.playbackMode);
  const mpvReady = usePlayerStore((s) => s.mpvReady);

  useEffect(() => {
    if (!mpvReady) return;
    void setProperty("loop-file", playbackMode === "loop-single" ? "inf" : "no")
      .catch((err) => console.error("[loop-file] sync failed", err));
  }, [playbackMode, mpvReady]);
}
