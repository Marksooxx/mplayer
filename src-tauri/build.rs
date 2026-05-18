use std::path::PathBuf;

fn main() {
    // 把 src-tauri/lib/*.dll 在编译时复制到 target/{debug,release}/，
    // 这样 tauri-plugin-libmpv 在 dev/release 模式都能在 exe 同级找到。
    copy_libmpv_dlls();

    tauri_build::build();
}

fn copy_libmpv_dlls() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let lib_dir = manifest_dir.join("lib");

    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    // OUT_DIR 形如 .../target/<profile>/build/<crate>-<hash>/out
    // 我们要把 dll 复制到 .../target/<profile>/
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let target_dir = out_dir
        .ancestors()
        .find(|p| p.file_name().is_some_and(|n| n == profile.as_str()))
        .map(PathBuf::from);

    let Some(target_dir) = target_dir else {
        println!("cargo:warning=could not locate target/{profile}");
        return;
    };

    if !lib_dir.exists() {
        println!(
            "cargo:warning=src-tauri/lib not found at {} — run `node node_modules/tauri-plugin-libmpv-api/dist-js/cli.cjs setup-lib`",
            lib_dir.display()
        );
        return;
    }

    let dlls = [
        "libmpv-wrapper.dll",
        "libmpv-2.dll",
        "libmpv-wrapper.dylib",
        "libmpv-wrapper.so",
    ];

    for name in dlls {
        let src = lib_dir.join(name);
        if !src.exists() {
            continue;
        }
        let dst = target_dir.join(name);
        match std::fs::copy(&src, &dst) {
            Ok(_) => println!(
                "cargo:warning=copied {} -> {}",
                src.display(),
                dst.display()
            ),
            Err(e) => println!("cargo:warning=failed to copy {}: {}", src.display(), e),
        }
        println!("cargo:rerun-if-changed={}", src.display());
    }
}
