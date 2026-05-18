mod peaks;

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager};

/// 启动参数里所有"看起来像文件路径"的参数
/// （首位 argv[0] 是 exe 本身，跳过；带 -- / --foo 的 flag 也跳过）
fn collect_path_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect()
}

/// 启动时拿到的文件路径（首次启动后由前端通过 get_launch_args 取走）
struct LaunchArgs(Mutex<Vec<String>>);

#[tauri::command]
fn get_launch_args(state: tauri::State<LaunchArgs>) -> Vec<String> {
    // take 而不是 clone：取走后清空，避免前端 HMR 反复触发
    let mut g = state.0.lock().unwrap();
    std::mem::take(&mut *g)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_paths = collect_path_args(std::env::args());

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = collect_path_args(args);
            if !paths.is_empty() {
                let _ = app.emit("open-files", &paths);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchArgs(Mutex::new(initial_paths)))
        .invoke_handler(tauri::generate_handler![
            peaks::calculate_peaks,
            get_launch_args
        ])
        .setup(|app| {
            // 兜底显示窗口：tauri.conf.json 启动是 visible:false（避免冷启动白闪），
            // 由前端 React 首帧后调 show()。如果前端因任何原因失败（权限缺失、JS 异常、
            // WebView2 异常），用一个独立线程在 1.5 秒后强行 show() 一次，
            // 保证用户至少看到窗口，能进一步排错（F12 console）。
            if let Some(w) = app.get_webview_window("main") {
                let w_clone = w.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    let _ = w_clone.show();
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
