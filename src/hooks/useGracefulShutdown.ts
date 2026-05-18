import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { destroy as destroyMpv } from "tauri-plugin-libmpv-api";

/**
 * 拦截窗口关闭事件，先优雅地销毁 mpv 实例（停所有解码线程、关文件句柄），
 * 再让窗口真正关闭。500ms 超时兜底，避免 mpv 卡死导致用户关不掉窗口。
 *
 * 注：Windows 进程退出本来就会让 OS 回收所有句柄，**所以即使本钩子不执行，
 * 文件句柄也不会残留占用**。这一层只是让 mpv 内部状态有机会做最后的 flush，
 * 不再"粗暴 kill"，行为更像 VLC。
 */
export function useGracefulShutdown(): void {
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let closing = false;

    void win
      .onCloseRequested(async (event) => {
        if (closing) return; // 防止递归（destroy() 之后再触发）
        closing = true;
        event.preventDefault();

        console.log("[shutdown] window close requested, destroying mpv...");
        // 500ms 内必须返回，否则强制关窗
        await Promise.race([
          destroyMpv().catch((err) => {
            console.warn("[shutdown] mpv destroy failed (non-fatal)", err);
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
        console.log("[shutdown] closing window");
        // destroy() 跳过 CloseRequested，直接销毁窗口
        try {
          await win.destroy();
        } catch (err) {
          console.error("[shutdown] window.destroy failed", err);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, []);
}
