"""实验：seek 命令返回后立即 get_property(time-pos) 是否已是新落点？(暂停 / 播放、wav / mp4)

结论(§6.32)：不可靠。播放中的视频可能仍返回旧位置；暂停中的纯音频几 ms 后就变成
"落点 − AO 缓冲"的虚值。所以虚拟播放头不用查询结果当落点。
用法：python seekquery.py <媒体文件> [...]
"""
import ctypes, os, sys, time
D = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "src-tauri", "lib"))
os.add_dll_directory(D)
m = ctypes.CDLL(os.path.join(D, "libmpv-2.dll"))
class E(ctypes.Structure):
    _fields_ = [("id", ctypes.c_int), ("err", ctypes.c_int), ("ud", ctypes.c_uint64), ("data", ctypes.c_void_p)]
m.mpv_create.restype = ctypes.c_void_p
m.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
m.mpv_initialize.argtypes = [ctypes.c_void_p]
m.mpv_command.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]
m.mpv_wait_event.restype = ctypes.POINTER(E)
m.mpv_wait_event.argtypes = [ctypes.c_void_p, ctypes.c_double]
m.mpv_get_property.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
m.mpv_set_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
m.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]

def cmd(h, *a):
    arr = (ctypes.c_char_p * (len(a) + 1))(*[x.encode() for x in a], None)
    return m.mpv_command(h, arr)

def g(h, n):
    d = ctypes.c_double(0)
    r = m.mpv_get_property(h, n.encode(), 5, ctypes.byref(d))
    return round(d.value, 4) if r == 0 else None

def pump(h, secs):
    end = time.perf_counter() + secs
    while time.perf_counter() < end:
        m.mpv_wait_event(h, 0.01)

for path in sys.argv[1:]:
    h = m.mpv_create()
    for k, v in [("ao", "null"), ("vo", "null"), ("terminal", "no"), ("hr-seek", "yes"), ("keep-open", "yes"), ("idle", "yes")]:
        m.mpv_set_option_string(h, k.encode(), v.encode())
    m.mpv_initialize(h)
    cmd(h, "loadfile", path, "replace")
    pump(h, 1.0)
    res = []
    for paused in ("no", "yes"):
        m.mpv_set_property_string(h, b"pause", paused.encode())
        pump(h, 0.3)
        for target in ("2.25", "0.81", "3.5"):
            before = g(h, "time-pos")
            cmd(h, "seek", target, "absolute")
            imm = g(h, "time-pos")            # 命令返回后立刻(同线程，µs 级)
            time.sleep(0.003)
            after3 = g(h, "time-pos")         # 3ms 后(≈ 一次 IPC 往返)
            pump(h, 0.4)
            res.append(f"pause={paused} seek {target}: before={before} immediate={imm} +3ms={after3} +400ms={g(h,'time-pos')}")
    print(os.path.basename(path)); [print("  " + r) for r in res]
    m.mpv_terminate_destroy(h)
