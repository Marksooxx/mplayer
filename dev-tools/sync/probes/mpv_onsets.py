"""用仓库自带的 libmpv-2.dll 测 mpv 实播时脉冲在 time-pos 坐标下的位置（波形对拍的真值）。

方法：headless 实例 ao=pcm（写文件，不发声）、vo=null、--start=S 精确 seek；
脉冲 onset = 输出第 0 个样本的 time-pos + 输出中 |x|>0.3 的首样本序号 / 采样率。
输出第 0 个样本的 time-pos：有视频时 = playback-restart 时的 time-pos（initial-audio-sync
把音频裁到首个视频帧，例如 S=0.7、25fps → 0.72）；纯音频时 = S（hr-seek 精确落在 S。
ao=pcm 不按实时速度跑，纯音频文件读到 restart 时 mpv 早已往前播了，读数不可用）。起点 S 要选在音轨开始之后、
第一个待测脉冲之前、且不落在流内缺口里（落在缺口里测量会失真）。

用法：
  python mpv_onsets.py <file> [--start 0.7] [--aid N]
输出 JSON：{"file", "start", "aid", "tp_restart", "duration", "onsets"}
"""
import argparse
import ctypes
import json
import os
import struct
import sys
import tempfile
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DLL_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "src-tauri", "lib"))
os.add_dll_directory(DLL_DIR)
mpv = ctypes.CDLL(os.path.join(DLL_DIR, "libmpv-2.dll"))


class MpvEvent(ctypes.Structure):
    _fields_ = [("event_id", ctypes.c_int), ("error", ctypes.c_int),
                ("reply_userdata", ctypes.c_uint64), ("data", ctypes.c_void_p)]


mpv.mpv_create.restype = ctypes.c_void_p
mpv.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
mpv.mpv_initialize.argtypes = [ctypes.c_void_p]
mpv.mpv_command.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]
mpv.mpv_wait_event.restype = ctypes.POINTER(MpvEvent)
mpv.mpv_wait_event.argtypes = [ctypes.c_void_p, ctypes.c_double]
mpv.mpv_get_property_string.restype = ctypes.c_void_p
mpv.mpv_get_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
mpv.mpv_free.argtypes = [ctypes.c_void_p]
mpv.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]

EV_END_FILE, EV_FILE_LOADED, EV_PLAYBACK_RESTART, EV_SHUTDOWN = 7, 8, 21, 1


def get_str(h, name):
    p = mpv.mpv_get_property_string(h, name.encode())
    if not p:
        return None
    s = ctypes.string_at(p).decode("utf-8", "replace")
    mpv.mpv_free(p)
    return s


def read_float_wav(path):
    raw = open(path, "rb").read()
    i, ch, sr, data = 12, 1, 48000, b""
    while i < len(raw) - 8:
        cid = raw[i:i + 4]
        size = struct.unpack("<I", raw[i + 4:i + 8])[0]
        body = raw[i + 8:i + 8 + size]
        if cid == b"fmt ":
            _, ch, sr = struct.unpack("<HHI", body[:8])
        elif cid == b"data":
            data = raw[i + 8:]  # ao_pcm 可能没回填 data 大小
            break
        i += 8 + size + (size & 1)
    x = np.frombuffer(data[: len(data) // 4 * 4], dtype="<f4")
    return sr, x.reshape(-1, ch)[:, 0]


def onset_indices(x, sr):
    idx = np.flatnonzero(np.abs(x) > 0.3)
    out, last = [], -(10 ** 9)
    for i in idx:
        if i - last > sr // 10:
            out.append(int(i))
        last = i
    return out


def measure(path, start, aid=None):
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    h = mpv.mpv_create()
    opts = [("ao", "pcm"), ("ao-pcm-file", wav), ("ao-pcm-waveheader", "yes"), ("vo", "null"),
            ("audio-format", "float"), ("idle", "no"), ("keep-open", "no"), ("hr-seek", "yes"),
            ("terminal", "no"), ("config", "no"), ("start", str(start))]
    if aid is not None:
        opts.append(("aid", str(aid)))
    for k, v in opts:
        mpv.mpv_set_option_string(h, k.encode(), v.encode("utf-8"))
    assert mpv.mpv_initialize(h) == 0
    mpv.mpv_command(h, (ctypes.c_char_p * 4)(b"loadfile", path.encode("utf-8"), b"replace", None))
    info = {"tp_restart": None, "duration": None, "has_video": False}
    deadline = time.perf_counter() + 60
    while time.perf_counter() < deadline:
        ev = mpv.mpv_wait_event(h, 5.0).contents
        if ev.event_id == EV_PLAYBACK_RESTART and info["tp_restart"] is None:
            tp = get_str(h, "time-pos")
            info["tp_restart"] = float(tp) if tp else None
        if ev.event_id == EV_FILE_LOADED:
            d = get_str(h, "duration")
            info["duration"] = float(d) if d else None
            info["has_video"] = get_str(h, "current-tracks/video/id") is not None
        if ev.event_id in (EV_END_FILE, EV_SHUTDOWN):
            break
    mpv.mpv_terminate_destroy(h)
    sr, x = read_float_wav(wav)
    os.remove(wav)
    base = info["tp_restart"] if info["has_video"] and info["tp_restart"] is not None else start
    return {
        "file": os.path.basename(path), "start": start, "aid": aid,
        "has_video": info["has_video"], "tp_restart": info["tp_restart"], "duration": info["duration"],
        "onsets": [round(base + i / sr, 6) for i in onset_indices(x, sr)],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--start", type=float, default=0.7)
    ap.add_argument("--aid", type=int, default=None)
    a = ap.parse_args()
    print(json.dumps(measure(os.path.abspath(a.file), a.start, a.aid), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
