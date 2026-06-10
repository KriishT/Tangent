use serde::Serialize;
use std::sync::Mutex;

// HWND of the window that was in the foreground when capture was triggered.
// Stored as isize so it is Send + Sync across the global-shortcut callback and
// the restore_focus command. Windows-only; a no-op elsewhere.
static PREV_HWND: Mutex<Option<isize>> = Mutex::new(None);

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
    store_foreground();
    match active_win_pos_rs::get_active_window() {
        Ok(w) => WorkContext {
            app_name: non_empty(w.app_name),
            title: non_empty(w.title),
            process_path: w
                .process_path
                .to_str()
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty()),
        },
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

#[cfg(windows)]
fn store_foreground() {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let hwnd = GetForegroundWindow();
        *PREV_HWND.lock().unwrap() = Some(hwnd.0 as isize);
    }
}

#[cfg(not(windows))]
fn store_foreground() {}

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
        }
    }
}

#[cfg(not(windows))]
pub fn focus_previous() {}
