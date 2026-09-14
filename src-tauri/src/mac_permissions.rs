//! macOS privacy pane helpers. Prompts themselves live in context / notifications / voice.

#[tauri::command]
pub fn accessibility_trusted() -> bool {
    crate::context::accessibility_is_trusted()
}

#[tauri::command]
pub fn request_accessibility_prompt() -> bool {
    crate::context::request_accessibility_access();
    crate::context::accessibility_is_trusted()
}

#[tauri::command]
pub fn open_mac_privacy_pane(pane: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        return Err("Only on Mac".into());
    }
    #[cfg(target_os = "macos")]
    {
        let url = match pane.as_str() {
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "notifications" => "x-apple.systempreferences:com.apple.preference.notifications",
            _ => return Err("Unknown privacy pane".into()),
        };
        std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
