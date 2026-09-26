"""App 端到端：播放中按暂停后，时间码 OSD(虚拟播放头)与屏幕上的画面帧是否一致(§6.33)。

启动 debug 构建的 mplayer(带 WebView2 远程调试端口)，打开帧号编码的 24fps 测试视频(静音音轨)，
用 CDP 发空格键暂停 / 恢复、读时间码 OSD(按 T 打开)；PrintWindow 取顶层窗口合成内容，按 mpv
osd-dimensions 的边距裁出视频区解码帧号。锁屏 / 窗口被遮挡时也能测。
会修改 App 的设置(OSD 开关、播放位置记录)，测试前备份、结束后原样还原 %APPDATA%/dev.mark.mplayer/store.json。

--tail：改用 6s 视频，在每圈最后 0.02–0.30s 暂停(单曲循环回绕处，mpv 处理暂停要 94–164ms)；
要求 App 的播放模式是单曲循环。

用法(需先 pnpm tauri build --debug --no-bundle；App 不能已在运行，否则单实例会把文件转给旧实例)：
  uv run --with websocket-client --with numpy python dev-tools/sync/probes/app_pause_e2e.py [--exe <mplayer.exe>] [--trials 16] [--tail] [--work <目录>]
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.request

import numpy as np
import websocket

user32, gdi32 = ctypes.windll.user32, ctypes.windll.gdi32
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
for f, res, args in [
    ("GetDC", ctypes.c_void_p, [ctypes.c_void_p]),
    ("ReleaseDC", ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p]),
    ("GetClientRect", ctypes.c_int, [ctypes.c_void_p, ctypes.POINTER(wt.RECT)]),
    ("GetWindowRect", ctypes.c_int, [ctypes.c_void_p, ctypes.POINTER(wt.RECT)]),
    ("ClientToScreen", ctypes.c_int, [ctypes.c_void_p, ctypes.POINTER(wt.POINT)]),
    ("PrintWindow", ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]),
    ("GetClassNameW", ctypes.c_int, [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]),
    ("GetWindowThreadProcessId", wt.DWORD, [ctypes.c_void_p, ctypes.POINTER(wt.DWORD)]),
    ("IsWindowVisible", ctypes.c_int, [ctypes.c_void_p]),
    ("PostMessageW", ctypes.c_int, [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]),
]:
    getattr(user32, f).restype, getattr(user32, f).argtypes = res, args
for f, res, args in [
    ("CreateCompatibleDC", ctypes.c_void_p, [ctypes.c_void_p]),
    ("CreateCompatibleBitmap", ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]),
    ("SelectObject", ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_void_p]),
    ("GetDIBits", ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]),
    ("DeleteObject", ctypes.c_int, [ctypes.c_void_p]),
    ("DeleteDC", ctypes.c_int, [ctypes.c_void_p]),
]:
    getattr(gdi32, f).restype, getattr(gdi32, f).argtypes = res, args
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
user32.EnumWindows.argtypes = [WNDENUMPROC, ctypes.c_void_p]
user32.EnumChildWindows.argtypes = [ctypes.c_void_p, WNDENUMPROC, ctypes.c_void_p]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD), ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
                ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD)]


W, H, BITS, FPS = 1280, 720, 12, 24
COL = W // BITS


def gen_video(path, secs=20):
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}",
           "-framerate", str(FPS), "-i", "-", "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-g", str(FPS), "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-t", str(secs), path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i in range(secs * FPS):
        img = np.full((H, W), 16, np.uint8)
        for b in range(BITS):
            bit = (i >> (BITS - 1 - b)) & 1
            img[:H // 2, b * COL:(b + 1) * COL] = 235 if bit else 16
            img[H // 2:, b * COL:(b + 1) * COL] = 16 if bit else 235
        p.stdin.write(img.tobytes())
    p.stdin.close()
    assert p.wait() == 0


def capture(hwnd, flags=3):
    rc = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rc))
    w, h = rc.right, rc.bottom
    sdc = user32.GetDC(None)
    mdc = gdi32.CreateCompatibleDC(sdc)
    bmp = gdi32.CreateCompatibleBitmap(sdc, w, h)
    gdi32.SelectObject(mdc, bmp)
    user32.PrintWindow(hwnd, mdc, flags)
    bi = BITMAPINFOHEADER(40, w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = (ctypes.c_ubyte * (w * h * 4))()
    gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    user32.ReleaseDC(None, sdc)
    return np.frombuffer(buf, np.uint8).reshape(h, w, 4)[:, :, :3].mean(axis=2)


def decode_rect(img, x0, y0, vw, vh):
    n, ok = 0, True
    for b in range(BITS):
        x = int(x0 + (b + 0.5) * COL / W * vw)
        t = np.median(img[int(y0 + vh * 0.1):int(y0 + vh * 0.4), max(0, x - 3):x + 4])
        u = np.median(img[int(y0 + vh * 0.6):int(y0 + vh * 0.9), max(0, x - 3):x + 4])
        ok &= (t > 128) != (u > 128) and abs(t - 128) > 60 and abs(u - 128) > 60
        n = (n << 1) | (1 if t > 128 else 0)
    return n if ok else None


def origin(hwnd):
    pt = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y


def windows_of(pid):
    out = []

    def cb(h, _):
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(h):
            out.append(h)
        return True
    user32.EnumWindows(WNDENUMPROC(cb), None)
    return out


def children(h):
    out = []

    def cb(c, _):
        name = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(c, name, 128)
        rc = wt.RECT()
        user32.GetClientRect(c, ctypes.byref(rc))
        out.append((c, name.value, rc.right, rc.bottom))
        return True
    user32.EnumChildWindows(h, WNDENUMPROC(cb), None)
    return out


class Cdp:
    def __init__(self, port):
        for _ in range(60):
            try:
                pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1))
                pages = [p for p in pages if p.get("type") == "page"]
                if pages:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("CDP 端口没有页面")
        self.ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
        self.i = 0

    def call(self, method, **params):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.i:
                return m.get("result", m)

    def js(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")

    def key(self, key, code, vk):
        text = key if len(key) == 1 else ""
        self.call("Input.dispatchKeyEvent", type="keyDown", key=key, code=code, windowsVirtualKeyCode=vk, text=text)
        self.call("Input.dispatchKeyEvent", type="keyUp", key=key, code=code, windowsVirtualKeyCode=vk)


# --tail：页面内逐帧盯 OSD，到达目标时刻(秒)就派发空格(比 CDP 往返准)
TAIL_TRIGGER = """(() => { window.__goal = null; window.__fired = null; const f = () => {
  const d = document.querySelector('div.fixed.top-12.left-3'); const s = d && d.querySelector('span');
  if (window.__goal !== null && s) { const p = s.textContent.split(':');
    const sec = parseFloat(p[p.length - 1]) + (p.length > 1 ? parseInt(p[p.length - 2]) * 60 : 0);
    if (sec >= window.__goal) { window.__goal = null; window.__fired = s.textContent;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })); } }
  requestAnimationFrame(f); }; requestAnimationFrame(f); return 'ok'; })()"""

OSD_JS = """(() => { const d = document.querySelector('div.fixed.top-12.left-3'); if (!d) return null;
  const s = d.querySelectorAll('span'); return { time: s[0]?.textContent, frame: s[2]?.textContent ?? null }; })()"""


def osd_seconds(t):
    parts = t.split(":")
    sec = float(parts[-1])
    mins = int(parts[-2]) if len(parts) >= 2 else 0
    hrs = int(parts[-3]) if len(parts) >= 3 else 0
    return hrs * 3600 + mins * 60 + sec


def main():
    import argparse
    import tempfile
    repo = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", default=os.path.join(repo, "src-tauri", "target", "debug", "mplayer.exe"))
    ap.add_argument("--trials", type=int, default=16)
    ap.add_argument("--work", default=os.path.join(tempfile.gettempdir(), "mplayer-pause-e2e"))
    ap.add_argument("--tail", action="store_true")
    args = ap.parse_args()
    exe, work, trials = args.exe, args.work, args.trials
    os.makedirs(work, exist_ok=True)
    random.seed(11)
    dur = 6 if args.tail else 20
    video = os.path.join(work, "app_frames24_6s.mp4" if args.tail else "app_frames24.mp4")
    if not os.path.exists(video):
        gen_video(video, secs=dur)
    store = os.path.expandvars(r"%APPDATA%\dev.mark.mplayer\store.json")
    if args.tail and json.load(open(store, encoding="utf-8")).get("ui", {}).get("playbackMode") != "loop-single":
        print("--tail 需要 App 播放模式为单曲循环")
        return 2
    backup = os.path.join(work, "store.json.bak")
    shutil.copy2(store, backup)
    env = dict(os.environ, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333")
    proc = subprocess.Popen([exe, video], env=env)
    res = []
    try:
        cdp = Cdp(9333)
        time.sleep(3.0)
        top = [h for h in windows_of(proc.pid)]
        kids = [c for h in top for c in children(h)]
        print("top-level:", top, "children:", [(k[1], k[2], k[3]) for k in kids])
        mpv_kids = [k for k in kids if k[1] == "mpv"]
        mpv_h = mpv_kids[0][0] if mpv_kids else None
        top_h = next(h for h in top if any(k[0] == mpv_h for k in children(h)))
        (tx, ty), (mx, my) = origin(top_h), origin(mpv_h)
        if cdp.js(OSD_JS) is None:
            cdp.key("t", "KeyT", 84)
            time.sleep(0.3)
        a = cdp.js(OSD_JS)
        time.sleep(0.4)
        b = cdp.js(OSD_JS)
        print("OSD", a, b)
        if a and b and a["time"] == b["time"]:
            cdp.key(" ", "Space", 32)  # 没在播就先开播
            time.sleep(1.0)
        if args.tail:
            cdp.js(TAIL_TRIGGER)
        for k in range(trials):
            if args.tail:
                while True:  # 本圈过半后再布置目标，避免刚回绕时误触发
                    o = cdp.js(OSD_JS)
                    if o and 2.5 < osd_seconds(o["time"]) < dur - 0.8:
                        break
                    time.sleep(0.05)
                cdp.js(f"window.__fired = null; window.__goal = {dur - random.uniform(0.02, 0.30)}")
                while cdp.js("window.__fired") is None:
                    time.sleep(0.02)
            else:
                time.sleep(random.uniform(0.8, 1.6))
                cdp.key(" ", "Space", 32)
            time.sleep(0.8)
            o = cdp.js(OSD_JS)
            dims = json.loads(cdp.js("window.__TAURI_INTERNALS__.invoke('plugin:libmpv|get_property', { name: 'osd-dimensions', format: 'string', windowLabel: 'main' })"))
            vx, vy = mx - tx + dims["ml"], my - ty + dims["mt"]
            vw, vh = dims["w"] - dims["ml"] - dims["mr"], dims["h"] - dims["mt"] - dims["mb"]
            scr = decode_rect(capture(top_h, 3), vx, vy, vw, vh)
            t = osd_seconds(o["time"]) if o else None
            rec = {"osd_time": o and o["time"], "osd_frame": o and o["frame"], "screen_frame": scr,
                   "osd_time_frames": None if t is None else round(t * FPS, 3)}
            res.append(rec)
            print(f"#{k + 1:2d} OSD {rec['osd_time']} 帧号 {rec['osd_frame']}  屏幕帧 {scr}  OSD 时间×fps={rec['osd_time_frames']}", flush=True)
            cdp.key(" ", "Space", 32)
    finally:
        try:
            for h in windows_of(proc.pid):
                user32.PostMessageW(h, 0x0010, None, None)  # WM_CLOSE
            proc.wait(timeout=8)
        except Exception:
            subprocess.run([os.path.join(os.environ["SystemRoot"], "System32", "taskkill.exe"), "/PID", str(proc.pid), "/T", "/F"])
        time.sleep(0.5)
        shutil.copy2(backup, store)
        print("store.json 已还原")
    ok = [r for r in res if r["screen_frame"] is not None and r["osd_frame"] is not None]
    match = sum(1 for r in ok if int(r["osd_frame"]) == r["screen_frame"])
    print(f"\n有效 {len(ok)}/{len(res)}：OSD 帧号 = 屏幕帧 {match}/{len(ok)}")
    json.dump(res, open(os.path.join(work, "app_e2e.json"), "w"), ensure_ascii=False, indent=1)
    passed = len(res) == trials and len(ok) == len(res) and match == len(ok)
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
