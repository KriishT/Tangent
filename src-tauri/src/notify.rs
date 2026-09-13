//! Desktop notifications. On macOS the plugin is often silent while the app is
//! frontmost or unsigned, so we also post via `display notification`.

#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn clip(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        s.to_string()
    } else {
        s.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
    }
}

#[tauri::command]
pub fn native_notify(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let title = applescript_escape(&clip(&title, 80));
        let body = applescript_escape(&clip(&body, 180));
        let script = format!(
            r#"display notification "{body}" with title "{title}" sound name "default""#
        );
        let status = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(
                "macOS notification was blocked — System Settings → Notifications → Tangent".into(),
            );
        }
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Ok(())
    }
}
