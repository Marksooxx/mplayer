"""录制 mpv 真实事件序列（property-change 与各类事件的到达时刻），供 clock/ 下的回放测试使用。

用仓库自带的 libmpv-2.dll 起一个 headless 实例（默认 ao=null、vo=null，不发声不出画），
观察 pause / time-pos / audio-pts / duration / eof-reached，并在首个 playback-restart 之后
按给定时刻执行用户动作。输出 JSON 数组：{"t": 秒, "name", "v"} / {"t", "ev"} / {"t", "act"}。

用法：
  python record_events.py <媒体文件> <输出.json> <总时长秒> [opt=val ...] -- <相对restart秒>:<动作> ...
动作：
  frame-step / frame-back-step
  seek,<秒>,<absolute|relative|relative+exact>
  set,<属性>,<值>            例如 set,pause,yes / set,speed,1.5 / set,loop-file,inf
例：暂停后连按 5 次单帧前进
  python record_events.py v.mp4 out.json 4 -- 0.5:set,pause,yes 1:frame-step 1.5:frame-step 2:frame-step
想录真实声卡的时序可加 ao=wasapi volume=0（会占用默认输出设备）。
"""
import ctypes
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DLL_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "src-tauri", "lib"))
os.add_dll_directory(DLL_DIR)
mpv = ctypes.CDLL(os.path.join(DLL_DIR, "libmpv-2.dll"))


class MpvEvent(ctypes.Structure):
    _fields_ = [("event_id", ctypes.c_int), ("error", ctypes.c_int),
                ("reply_userdata", ctypes.c_uint64), ("data", ctypes.c_void_p)]


class MpvEventProperty(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("format", ctypes.c_int), ("data", ctypes.c_void_p)]


mpv.mpv_create.restype = ctypes.c_void_p
mpv.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
mpv.mpv_set_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
mpv.mpv_initialize.argtypes = [ctypes.c_void_p]
mpv.mpv_command.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]
mpv.mpv_wait_event.restype = ctypes.POINTER(MpvEvent)
mpv.mpv_wait_event.argtypes = [ctypes.c_void_p, ctypes.c_double]
mpv.mpv_observe_property.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_char_p, ctypes.c_int]
mpv.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]
mpv.mpv_event_name.restype = ctypes.c_char_p

FMT_FLAG, FMT_DOUBLE = 3, 5
EV_NONE, EV_PROPERTY_CHANGE = 0, 22


def main():
    args = sys.argv[1:]
    if len(args) < 3:
        print(__doc__)
        return 2
    sep = args.index("--") if "--" in args else len(args)
    path, outp, total = args[0], args[1], float(args[2])
    opts = dict(a.split("=", 1) for a in args[3:sep])
    acts = []
    for a in args[sep + 1:]:
        at, cmd = a.split(":", 1)
        acts.append((float(at), cmd.split(",")))

    h = mpv.mpv_create()
    base = {"vo": "null", "ao": "null", "terminal": "no", "idle": "yes", "keep-open": "yes", "hr-seek": "yes"}
    base.update(opts)
    for k, v in base.items():
        mpv.mpv_set_option_string(h, k.encode(), v.encode())
    assert mpv.mpv_initialize(h) == 0
    props = [("pause", FMT_FLAG), ("time-pos", FMT_DOUBLE), ("audio-pts", FMT_DOUBLE),
             ("duration", FMT_DOUBLE), ("eof-reached", FMT_FLAG)]
    for i, (n, f) in enumerate(props):
        mpv.mpv_observe_property(h, i + 1, n.encode(), f)

    t0 = time.perf_counter()
    mpv.mpv_command(h, (ctypes.c_char_p * 4)(b"loadfile", os.path.abspath(path).encode(), b"replace", None))
    log, restart, ai = [], None, 0
    while time.perf_counter() - t0 < total:
        now = time.perf_counter() - t0
        if restart is not None and ai < len(acts) and now - restart >= acts[ai][0]:
            cmd = acts[ai][1]
            ai += 1
            log.append({"t": round(now, 6), "act": ",".join(cmd)})
            if cmd[0] == "set":
                mpv.mpv_set_property_string(h, cmd[1].encode(), cmd[2].encode())
            else:
                mpv.mpv_command(h, (ctypes.c_char_p * (len(cmd) + 1))(*[x.encode() for x in cmd], None))
        ev = mpv.mpv_wait_event(h, 0.001).contents
        if ev.event_id == EV_NONE:
            continue
        t = round(time.perf_counter() - t0, 6)
        if ev.event_id == EV_PROPERTY_CHANGE:
            p = ctypes.cast(ev.data, ctypes.POINTER(MpvEventProperty)).contents
            v = None
            if p.format == FMT_DOUBLE:
                v = round(ctypes.cast(p.data, ctypes.POINTER(ctypes.c_double)).contents.value, 7)
            elif p.format == FMT_FLAG:
                v = ctypes.cast(p.data, ctypes.POINTER(ctypes.c_int)).contents.value
            log.append({"t": t, "name": p.name.decode(), "v": v})
        else:
            name = mpv.mpv_event_name(ev.event_id).decode()
            if name == "playback-restart" and restart is None:
                restart = t
            log.append({"t": t, "ev": name})
    mpv.mpv_terminate_destroy(h)
    json.dump(log, open(outp, "w", encoding="utf-8"), separators=(",", ":"))
    print(f"{len(log)} events -> {outp}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
