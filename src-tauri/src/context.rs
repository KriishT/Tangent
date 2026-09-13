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
    /// Browser tab URL when we can read it (macOS Apple Events).
    pub url: Option<String>,
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
            let ctx = WorkContext {
                app_name: non_empty(w.app_name),
                title: non_empty(w.title),
                process_path: w
                    .process_path
                    .to_str()
                    .map(|s| s.to_string())
                    .filter(|s| !s.trim().is_empty()),
                url: None,
            };
            #[cfg(target_os = "macos")]
            {
                return enrich_macos(ctx, Some(w.process_id));
            }
            #[cfg(not(target_os = "macos"))]
            {
                return ctx;
            }
        }
        Err(_) => {
            let ctx = WorkContext {
                app_name: None,
                title: None,
                process_path: None,
                url: None,
            };
            #[cfg(target_os = "macos")]
            {
                return enrich_macos(ctx, None);
            }
            #[cfg(not(target_os = "macos"))]
            {
                return ctx;
            }
        }
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

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Option<String> {
    let out = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(target_os = "macos")]
fn take_richer_title(ctx: &mut WorkContext, candidate: &str) {
    let app = ctx.app_name.as_deref().unwrap_or("");
    let current = ctx.title.as_deref().unwrap_or("");
    if candidate.is_empty() || candidate.eq_ignore_ascii_case(app) {
        return;
    }
    if current.is_empty() || current.eq_ignore_ascii_case(app) || candidate.len() > current.len() {
        ctx.title = Some(candidate.to_string());
    }
}

/// Map the frontmost process to an AppleScript browser name (app name or bundle path).
#[cfg(target_os = "macos")]
fn browser_app_name(app: &str, process_path: &str) -> Option<&'static str> {
    let blob = format!("{app} {process_path}").to_ascii_lowercase();
    if blob.contains("safari") && !blob.contains("chrome") {
        return Some("Safari");
    }
    if blob.contains("firefox") || blob.contains("zen browser") {
        return Some("Firefox");
    }
    if blob.contains("brave") {
        return Some("Brave Browser");
    }
    if blob.contains("microsoft edge") || blob.contains("edgemac") {
        return Some("Microsoft Edge");
    }
    if blob.contains("arc.app") || blob.contains("/arc.app") || blob.contains("company.thebrowser.arc")
    {
        return Some("Arc");
    }
    if blob.split(|c: char| !c.is_ascii_alphanumeric()).any(|p| p == "arc") {
        return Some("Arc");
    }
    if blob.contains("vivaldi") {
        return Some("Vivaldi");
    }
    if blob.contains("orion") {
        return Some("Orion");
    }
    if blob.contains("dia.app") || blob.contains("browsercompany.dia") {
        return Some("Dia");
    }
    if blob.contains("chromium") {
        return Some("Chromium");
    }
    if blob.contains("google chrome") || blob.contains("chrome.app") || blob.contains("com.google.chrome")
    {
        return Some("Google Chrome");
    }
    None
}

#[cfg(target_os = "macos")]
fn browser_script(app_name: &str) -> String {
    if app_name == "Safari" {
        return r#"tell application "Safari"
  if (count of windows) is 0 then return ""
  set t to name of front document
  set u to URL of front document
  return t & linefeed & u
end tell"#
            .to_string();
    }
    if app_name == "Firefox" {
        return r#"tell application "Firefox"
  if (count of windows) is 0 then return ""
  return name of front window
end tell"#
            .to_string();
    }
    format!(
        r#"tell application "{app_name}"
  if (count of windows) is 0 then return ""
  set t to title of active tab of front window
  set u to URL of active tab of front window
  return t & linefeed & u
end tell"#
    )
}

#[cfg(target_os = "macos")]
fn front_window_title_via_system_events(app: Option<&str>) -> Option<String> {
    let script = if let Some(name) = app.filter(|s| !s.trim().is_empty()) {
        let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
        format!(
            r#"tell application "System Events"
  tell process "{escaped}"
    if (count of windows) is 0 then return ""
    get name of front window
  end tell
end tell"#
        )
    } else {
        r#"tell application "System Events"
  tell (first process whose frontmost is true)
    if (count of windows) is 0 then return ""
    get name of front window
  end tell
end tell"#
            .to_string()
    };
    run_osascript(&script)
}

/// Focused window title + document path via Accessibility (editors, browsers, Finder).
#[cfg(target_os = "macos")]
fn ax_focused_window(pid: u64) -> (Option<String>, Option<String>) {
    use core_foundation::base::{CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
    }

    fn copy_attr(element: *mut c_void, name: &str) -> Option<CFTypeRef> {
        if element.is_null() {
            return None;
        }
        let key = CFString::new(name);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut value)
        };
        if err != 0 || value.is_null() {
            None
        } else {
            Some(value)
        }
    }

    fn copy_attr_string(element: *mut c_void, name: &str) -> Option<String> {
        let value = copy_attr(element, name)?;
        let is_string = unsafe { CFGetTypeID(value) == CFStringGetTypeID() };
        if !is_string {
            unsafe { CFRelease(value as *const c_void) };
            return None;
        }
        let s = unsafe { CFString::wrap_under_create_rule(value as CFStringRef) };
        let out = s.to_string();
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    if pid == 0 || pid > i32::MAX as u64 {
        return (None, None);
    }
    let app = unsafe { AXUIElementCreateApplication(pid as i32) };
    if app.is_null() {
        return (None, None);
    }
    let window = copy_attr(app, "AXFocusedWindow").or_else(|| copy_attr(app, "AXMainWindow"));
    let (title, document) = if let Some(win) = window {
        let title = copy_attr_string(win as *mut c_void, "AXTitle");
        let document = copy_attr_string(win as *mut c_void, "AXDocument");
        unsafe { CFRelease(win as *const c_void) };
        (title, document)
    } else {
        (None, None)
    };
    unsafe { CFRelease(app as *const c_void) };
    (title, document)
}

#[cfg(target_os = "macos")]
fn title_from_document(document: &str) -> Option<String> {
    let raw = document.strip_prefix("file://").unwrap_or(document);
    let decoded = urlencoding::decode(raw).ok()?.into_owned();
    let path = decoded.trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(target_os = "macos")]
fn enrich_macos(mut ctx: WorkContext, pid: Option<u64>) -> WorkContext {
    let app = ctx.app_name.clone().unwrap_or_default();
    let path = ctx.process_path.clone().unwrap_or_default();

    if let Some(browser) = browser_app_name(&app, &path) {
        if let Some(raw) = run_osascript(&browser_script(browser)) {
            let mut lines = raw.lines();
            if let Some(title) = lines.next().map(str::trim).filter(|s| !s.is_empty()) {
                take_richer_title(&mut ctx, title);
            }
            if let Some(url) = lines.next().map(str::trim).filter(|s| !s.is_empty()) {
                ctx.url = Some(url.to_string());
            }
        }
    }

    if let Some(pid) = pid.or(*PREV_PID.lock().unwrap()) {
        let (ax_title, ax_doc) = ax_focused_window(pid);
        if let Some(t) = ax_title.as_deref() {
            take_richer_title(&mut ctx, t);
        }
        let title = ctx.title.as_deref().unwrap_or("");
        if title.is_empty() || title.eq_ignore_ascii_case(&app) {
            if let Some(doc) = ax_doc.as_deref().and_then(title_from_document) {
                take_richer_title(&mut ctx, &doc);
            }
        }
    }

    let title = ctx.title.as_deref().unwrap_or("");
    if title.is_empty() || title.eq_ignore_ascii_case(&app) {
        if let Some(win) = front_window_title_via_system_events(ctx.app_name.as_deref()) {
            take_richer_title(&mut ctx, &win);
        }
    }
    ctx
}

/// Shows the macOS Accessibility prompt so window titles / focus restore work.
#[cfg(target_os = "macos")]
pub fn request_accessibility_access() {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    }

    // kAXTrustedCheckOptionPrompt — prompt the user if not already trusted.
    use core_foundation::base::TCFType;
    let key = core_foundation::string::CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let yes = core_foundation::boolean::CFBoolean::true_value();
    let dict = core_foundation::dictionary::CFDictionary::from_CFType_pairs(&[(
        key.as_CFType(),
        yes.as_CFType(),
    )]);
    unsafe {
        AXIsProcessTrustedWithOptions(
            dict.as_concrete_TypeRef() as *const std::ffi::c_void,
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_accessibility_access() {}
