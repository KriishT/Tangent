use serde::Serialize;
use std::sync::Mutex;

// Window/process to return focus to after capture. Captured BEFORE our overlay shows.
static PREV_HWND: Mutex<Option<isize>> = Mutex::new(None);
static PREV_PID: Mutex<Option<u64>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug)]
pub struct WorkContext {
    pub app_name: Option<String>,
    pub title: Option<String>,
    /// Full path to the foreground app's executable (e.g. Cursor.exe).
    pub process_path: Option<String>,
}

/// Reads the active (foreground) window's app + title and remembers its handle
/// so we can return focus to it after capture. MUST be called BEFORE we show
/// our own overlay, otherwise the overlay becomes the "active window".
pub fn capture_context() -> WorkContext {
    match active_win_pos_rs::get_active_window() {
        Ok(w) => {
            remember_focus(w.process_id);
            #[cfg(windows)]
            store_foreground_hwnd();
            WorkContext {
                app_name: non_empty(w.app_name),
                title: non_empty(w.title),
                process_path: w
                    .process_path
                    .to_str()
                    .map(|s| s.to_string())
                    .filter(|s| !s.trim().is_empty()),
            }
        }
        Err(_) => WorkContext {
            app_name: None,
            title: None,
            process_path: None,
        },
    }
}

fn non_empty(s: String) -> Option<String> {
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

fn remember_focus(pid: u64) {
    if pid > 0 {
        *PREV_PID.lock().unwrap() = Some(pid);
    }
}

#[cfg(windows)]
fn store_foreground_hwnd() {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let hwnd = GetForegroundWindow();
        *PREV_HWND.lock().unwrap() = Some(hwnd.0 as isize);
    }
}

/// Re-activates the window that was focused before the capture overlay appeared.
#[cfg(windows)]
pub fn focus_previous() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    let prev = *PREV_HWND.lock().unwrap();
    if let Some(h) = prev {
        if h != 0 {
            unsafe {
                let _ = SetForegroundWindow(HWND(h as *mut core::ffi::c_void));
            }
            return;
        }
    }
}

#[cfg(target_os = "macos")]
pub fn focus_previous() {
    focus_previous_by_pid();
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn focus_previous() {}

/// Activate the process that owned the foreground window at capture time (macOS).
#[cfg(target_os = "macos")]
fn focus_previous_by_pid() {
    let pid = *PREV_PID.lock().unwrap();
    if let Some(pid) = pid {
        let script = format!(
            r#"tell application "System Events" to set frontmost of (first process whose unix id is {pid}) to true"#,
            pid = pid
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
    }
}
