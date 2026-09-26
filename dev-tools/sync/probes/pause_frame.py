"""实测：播放中按暂停后，屏幕上停的是哪一帧？它和 time-pos、暂停瞬间的声音位置是什么关系？

生成画面编码了帧号的测试视频（12 条竖条 = 12 位二进制帧号，下半部是反码，用于校验），
用与 App 相同的 vo / hwdec 起一个置顶无边框 mpv 窗口，播放中随机时刻暂停，800ms 后：
  (1) PrintWindow 取 DWM 合成的窗口内容，解码屏幕上的帧号（真值）
  (2) mpv screenshot-to-file video 解码 VO 认为的当前帧
  (3) 读 time-pos
再与"暂停命令时刻由 audio-pts 外推的声音位置"所在的帧对照。
用法：python pause_frame.py [--fps 24,60] [--trials 12] [--vo gpu-next] [--ao wasapi] [--json out.json]
运行时屏幕左上角会弹出置顶窗口（锁屏 / 被遮挡也能测）；ao=wasapi 时音量为 0。
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import random
import subprocess
import sys
import tempfile
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DLL_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "src-tauri", "lib"))
os.add_dll_directory(DLL_DIR)
mpv = ctypes.CDLL(os.path.join(DLL_DIR, "libmpv-2.dll"))

user32, gdi32 = ctypes.windll.user32, ctypes.windll.gdi32
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # 物理像素坐标

W, H, BITS = 640, 360, 12
COL = W // BITS
TITLE = "mplayer-pause-frame-probe"


class MpvEvent(ctypes.Structure):
    _fields_ = [("event_id", ctypes.c_int), ("error", ctypes.c_int),
                ("reply_userdata", ctypes.c_uint64), ("data", ctypes.c_void_p)]


class MpvEventProperty(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("format", ctypes.c_int), ("data", ctypes.c_void_p)]


mpv.mpv_create.restype = ctypes.c_void_p
mpv.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
mpv.mpv_set_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
mpv.mpv_get_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
mpv.mpv_get_property_string.restype = ctypes.c_void_p
mpv.mpv_free.argtypes = [ctypes.c_void_p]
mpv.mpv_initialize.argtypes = [ctypes.c_void_p]
mpv.mpv_command.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]
mpv.mpv_wait_event.restype = ctypes.POINTER(MpvEvent)
mpv.mpv_wait_event.argtypes = [ctypes.c_void_p, ctypes.c_double]
mpv.mpv_observe_property.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_char_p, ctypes.c_int]
mpv.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]
mpv.mpv_event_name.restype = ctypes.c_char_p

for f, res, args in [
    ("GetDC", ctypes.c_void_p, [ctypes.c_void_p]),
    ("ReleaseDC", ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p]),
    ("FindWindowW", ctypes.c_void_p, [ctypes.c_wchar_p, ctypes.c_wchar_p]),
    ("GetClientRect", ctypes.c_int, [ctypes.c_void_p, ctypes.POINTER(wt.RECT)]),
    ("PrintWindow", ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]),
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


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD), ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
                ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD)]


def grab_client(hwnd):
    """PrintWindow(PW_CLIENTONLY | PW_RENDERFULLCONTENT)：向 DWM 要该窗口最后一次呈现的内容。
    不受遮挡 / 锁屏影响(实测锁屏时屏幕 DC 截到的是锁屏界面，而这个仍跟随播放逐帧变化)。"""
    rc = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rc))
    w, h = rc.right, rc.bottom
    sdc = user32.GetDC(None)
    mdc = gdi32.CreateCompatibleDC(sdc)
    bmp = gdi32.CreateCompatibleBitmap(sdc, w, h)
    gdi32.SelectObject(mdc, bmp)
    user32.PrintWindow(hwnd, mdc, 1 | 2)
    bi = BITMAPINFOHEADER(40, w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = (ctypes.c_ubyte * (w * h * 4))()
    gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    user32.ReleaseDC(None, sdc)
    return np.frombuffer(buf, np.uint8).reshape(h, w, 4)[:, :, :3].mean(axis=2)


def decode(img):
    """竖条帧号；上下半部不互为反码(撕裂 / 混合 / 被遮挡)时返回 None。"""
    h, w = img.shape
    n, ok = 0, True
    for b in range(BITS):
        x = int((b + 0.5) * COL / W * w)
        t = img[int(h * 0.1):int(h * 0.4), max(0, x - 2):x + 3].mean()
        u = img[int(h * 0.6):int(h * 0.9), max(0, x - 2):x + 3].mean()
        ok &= (t > 128) != (u > 128) and abs(t - 128) > 60 and abs(u - 128) > 60
        n = (n << 1) | (1 if t > 128 else 0)
    return n if ok else None


def gen_video(path, fps, secs):
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}",
           "-framerate", str(fps), "-i", "-", "-f", "lavfi", "-i", f"sine=frequency=440:duration={secs}",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-g", str(fps), "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-shortest", path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i in range(int(secs * fps)):
        img = np.full((H, W), 16, np.uint8)
        for b in range(BITS):
            bit = (i >> (BITS - 1 - b)) & 1
            img[:H // 2, b * COL:(b + 1) * COL] = 235 if bit else 16
            img[H // 2:, b * COL:(b + 1) * COL] = 16 if bit else 235
        p.stdin.write(img.tobytes())
    p.stdin.close()
    assert p.wait() == 0


def decode_png(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={W}:{H}", "-f", "rawvideo",
                          "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    return decode(np.frombuffer(raw, np.uint8).reshape(H, W).astype(float))


def get_prop(h, name):
    p = mpv.mpv_get_property_string(h, name.encode())
    if not p:
        return None
    s = ctypes.string_at(p).decode()
    mpv.mpv_free(p)
    return s


def cmd(h, *a):
    return mpv.mpv_command(h, (ctypes.c_char_p * (len(a) + 1))(*[x.encode() for x in a], None))


def run(fps, trials, vo, ao, tmp):
    secs = 14
    path = os.path.join(tmp, f"frames{fps}.mp4")
    gen_video(path, fps, secs)
    h = mpv.mpv_create()
    opts = {"vo": vo, "ao": ao, "volume": "0", "hwdec": "auto-safe", "keep-open": "yes", "hr-seek": "yes",
            "force-window": "yes", "idle": "yes", "terminal": "no", "border": "no", "ontop": "yes",
            "geometry": f"{W}x{H}+40+40", "title": TITLE, "osc": "no", "osd-level": "0", "osd-bar": "no",
            "input-default-bindings": "no", "input-vo-keyboard": "no", "background-color": "#000000"}
    for k, v in opts.items():
        mpv.mpv_set_option_string(h, k.encode(), v.encode())
    assert mpv.mpv_initialize(h) == 0
    for i, n in enumerate(["pause", "time-pos", "audio-pts"]):
        mpv.mpv_observe_property(h, i + 1, n.encode(), 3 if n == "pause" else 5)
    cmd(h, "loadfile", path, "replace")

    last = {"time-pos": None, "audio-pts": None}
    log = []

    def pump(until):
        while True:
            now = time.perf_counter()
            if now >= until:
                return
            ev = mpv.mpv_wait_event(h, min(0.002, until - now)).contents
            if ev.event_id == 0:
                continue
            t = time.perf_counter()
            if ev.event_id == 22:
                p = ctypes.cast(ev.data, ctypes.POINTER(MpvEventProperty)).contents
                v = None
                if p.format == 5:
                    v = ctypes.cast(p.data, ctypes.POINTER(ctypes.c_double)).contents.value
                elif p.format == 3:
                    v = ctypes.cast(p.data, ctypes.POINTER(ctypes.c_int)).contents.value
                name = p.name.decode()
                if name in last:
                    last[name] = (v, t)
                log.append((t, name, v))
            else:
                log.append((t, mpv.mpv_event_name(ev.event_id).decode(), None))

    pump(time.perf_counter() + 1.5)
    hwnd = user32.FindWindowW(None, TITLE)
    assert hwnd, "找不到 mpv 窗口"
    out = []
    for k in range(trials):
        pump(time.perf_counter() + random.uniform(0.7, 1.4))
        tp_b, ap_b = last["time-pos"], last["audio-pts"]
        t_cmd = time.perf_counter()
        mpv.mpv_set_property_string(h, b"pause", b"yes")
        i0 = len(log)
        pump(t_cmd + 0.8)
        after = [(round((t - t_cmd) * 1000, 1), n, None if v is None else round(v, 5)) for t, n, v in log[i0:]]
        t_pev = next((t for t, n, v in log[i0:] if n == "pause" and v == 1), None)
        sound_cmd = ap_b[0] + (t_cmd - ap_b[1]) if ap_b and ap_b[0] is not None else None
        sound_pev = ap_b[0] + (t_pev - ap_b[1]) if ap_b and ap_b[0] is not None and t_pev else None
        n_screen = decode(grab_client(hwnd))
        shot = os.path.join(tmp, "shot.png")
        cmd(h, "screenshot-to-file", shot, "video")
        n_vo = decode_png(shot)
        tp_set = float(get_prop(h, "time-pos") or "nan")
        efn = get_prop(h, "estimated-frame-number")
        rec = {"fps": fps, "sound_cmd": sound_cmd, "sound_pev": sound_pev, "tp_before": tp_b[0] if tp_b else None,
               "tp_settled": tp_set, "n_screen": n_screen, "n_vo": n_vo, "est_frame": efn, "after": after}
        out.append(rec)
        fs = int(sound_cmd * fps + 1e-6) if sound_cmd is not None else None
        print(f"fps={fps} #{k + 1:2d} 声音={sound_cmd:.4f}(帧{fs} 相位{(sound_cmd * fps - fs):.2f}) "
              f"屏幕帧={n_screen} VO帧={n_vo} time-pos={tp_set:.4f}(帧{tp_set * fps:.2f}) est={efn}", flush=True)
        mpv.mpv_set_property_string(h, b"pause", b"no")
        if tp_set > secs - 3:
            cmd(h, "seek", "1", "absolute")
            pump(time.perf_counter() + 0.6)
    mpv.mpv_terminate_destroy(h)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", default="24,60")
    ap.add_argument("--trials", type=int, default=12)
    ap.add_argument("--vo", default="gpu-next")
    ap.add_argument("--ao", default="wasapi")
    ap.add_argument("--json")
    a = ap.parse_args()
    random.seed(7)
    res = []
    with tempfile.TemporaryDirectory() as tmp:
        for fps in [int(x) for x in a.fps.split(",")]:
            res += run(fps, a.trials, a.vo, a.ao, tmp)
    print("\n汇总(屏幕帧为真值)：")
    for fps in sorted({r["fps"] for r in res}):
        rs = [r for r in res if r["fps"] == fps and r["n_screen"] is not None and r["sound_cmd"] is not None]
        d_sound = [r["n_screen"] - int(r["sound_cmd"] * fps + 1e-6) for r in rs]
        d_tp = [r["n_screen"] - round(r["tp_settled"] * fps) for r in rs]
        d_vo = [r["n_screen"] - r["n_vo"] for r in rs if r["n_vo"] is not None]
        cnt = lambda xs: {d: xs.count(d) for d in sorted(set(xs))}
        print(f"fps={fps} 有效 {len(rs)}：屏幕−声音所在帧 {cnt(d_sound)}；屏幕−time-pos 帧 {cnt(d_tp)}；屏幕−VO 帧 {cnt(d_vo)}")
    if a.json:
        json.dump(res, open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
