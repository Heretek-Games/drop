// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
fn is_nvidia_gpu() -> bool {
    // The NVIDIA driver exposes its GPUs under this sysfs path; probing it is
    // more reliable than parsing `lspci` output which may not be installed.
    let Some(nvidia_dir) = std::fs::read_dir("/sys/module/nvidia").ok() else {
        return false;
    };
    let _ = nvidia_dir;
    std::fs::metadata("/sys/module/nvidia").is_ok()
}

/// WebKitGTK's DMABUF renderer crashes with `Error 71 (Protocol error)
/// dispatching to Wayland display.` on NVIDIA + Wayland (WebKitGTK bug, see
/// https://github.com/tauri-apps/tauri/issues/9394). Disable it before GTK
/// initializes so the client launches on Wayland NVIDIA systems. An explicit
/// value set by the user in the environment always wins.
#[cfg(target_os = "linux")]
fn configure_webkit_nvidia_workaround() {
    if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err()
        && std::env::var("WAYLAND_DISPLAY")
            .map(|d| !d.is_empty())
            .unwrap_or(false)
        && std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
        && is_nvidia_gpu()
    {
        // Called before any thread is spawned (Tauri/GTK init happens later in
        // `run()`), so mutating the environment here is safe.
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    configure_webkit_nvidia_workaround();
    drop_app_lib::run();
}
