//! Apple Calendar via Calendar.app (macOS). No OAuth — user grants Automation.

use serde::{Deserialize, Serialize};

const CALENDAR_NAME: &str = "Tangent";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleCalendarStatus {
    pub available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleEventParams {
    pub summary: String,
    pub description: String,
    pub start_local: String,
    pub end_local: String,
    #[serde(default)]
    pub reminder_minutes: Vec<i32>,
    pub existing_event_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleCheckInSlot {
    pub start_local: String,
    pub end_local: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleCheckInParams {
    pub enabled: bool,
    pub existing_event_ids: Option<Vec<String>>,
    pub slots: Vec<AppleCheckInSlot>,
}

#[tauri::command]
pub fn apple_calendar_available() -> AppleCalendarStatus {
    AppleCalendarStatus {
        available: cfg!(target_os = "macos"),
    }
}

#[tauri::command]
pub fn apple_calendar_connect() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        ensure_calendar()?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Apple Calendar is available on Mac.".into())
    }
}

#[tauri::command]
pub fn apple_calendar_upsert_event(params: AppleEventParams) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        ensure_calendar()?;
        if let Some(id) = params.existing_event_id.as_deref().filter(|s| !s.is_empty()) {
            let _ = delete_event_by_uid(id);
        }
        let alarm = params.reminder_minutes.first().copied().unwrap_or(15);
        create_event(
            &params.summary,
            &params.description,
            &params.start_local,
            &params.end_local,
            Some(alarm),
            None,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = params;
        Err("Apple Calendar is available on Mac.".into())
    }
}

#[tauri::command]
pub fn apple_calendar_delete_event(event_id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if event_id.trim().is_empty() {
            return Ok(());
        }
        delete_event_by_uid(&event_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = event_id;
        Ok(())
    }
}

#[tauri::command]
pub fn apple_calendar_sync_checkin(params: AppleCheckInParams) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(ids) = &params.existing_event_ids {
            for id in ids {
                let _ = delete_event_by_uid(id);
            }
        }
        if !params.enabled || params.slots.is_empty() {
            return Ok(vec![]);
        }
        ensure_calendar()?;
        let mut created = Vec::new();
        for slot in &params.slots {
            let id = create_event(
                "Check Tangent",
                "Created by Tangent",
                &slot.start_local,
                &slot.end_local,
                Some(0),
                Some("FREQ=DAILY"),
            )?;
            created.push(id);
        }
        Ok(created)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = params;
        Ok(vec![])
    }
}

#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn parse_local(s: &str) -> Result<(i32, i32, i32, i32, i32), String> {
    let (date, time) = s
        .split_once('T')
        .ok_or_else(|| format!("Invalid datetime: {s}"))?;
    let d: Vec<&str> = date.split('-').collect();
    let t: Vec<&str> = time.split(':').collect();
    if d.len() < 3 || t.len() < 2 {
        return Err(format!("Invalid datetime: {s}"));
    }
    Ok((
        d[0].parse().map_err(|_| "year")?,
        d[1].parse().map_err(|_| "month")?,
        d[2].parse().map_err(|_| "day")?,
        t[0].parse().map_err(|_| "hour")?,
        t[1].parse().map_err(|_| "minute")?,
    ))
}

#[cfg(target_os = "macos")]
fn date_script(var: &str, local: &str) -> Result<String, String> {
    let (y, mo, d, h, mi) = parse_local(local)?;
    Ok(format!(
        r#"set {var} to current date
set year of {var} to {y}
set month of {var} to {mo}
set day of {var} to {d}
set hours of {var} to {h}
set minutes of {var} to {mi}
set seconds of {var} to 0"#
    ))
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<String, String> {
    let out = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.trim().is_empty() {
            "Calendar.app blocked Tangent. System Settings → Privacy & Security → Calendars, and allow Tangent to control Calendar.".into()
        } else {
            err.trim().to_string()
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn ensure_calendar() -> Result<(), String> {
    let name = applescript_escape(CALENDAR_NAME);
    let script = format!(
        r#"tell application "Calendar"
  if not (exists calendar "{name}") then
    make new calendar with properties {{name:"{name}"}}
  end if
  return "ok"
end tell"#
    );
    run_osascript(&script)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn create_event(
    summary: &str,
    description: &str,
    start_local: &str,
    end_local: &str,
    alarm_minutes: Option<i32>,
    recurrence: Option<&str>,
) -> Result<String, String> {
    let name = applescript_escape(CALENDAR_NAME);
    let summary = applescript_escape(&summary.chars().take(120).collect::<String>());
    let description = applescript_escape(description);
    let start = date_script("startDate", start_local)?;
    let end = date_script("endDate", end_local)?;
    let alarm = if let Some(mins) = alarm_minutes {
        format!(
            r#"
    tell newEvent
      make new display alarm at end with properties {{trigger interval:-{mins}}}
    end tell"#
        )
    } else {
        String::new()
    };
    let recur = if let Some(rule) = recurrence {
        format!(
            r#"
    set recurrence of newEvent to "{}"#,
            applescript_escape(rule)
        )
    } else {
        String::new()
    };
    let script = format!(
        r#"{start}
{end}
tell application "Calendar"
  tell calendar "{name}"
    set newEvent to make new event with properties {{summary:"{summary}", description:"{description}", start date:startDate, end date:endDate}}{recur}{alarm}
    return uid of newEvent
  end tell
end tell"#
    );
    let uid = run_osascript(&script)?;
    if uid.is_empty() {
        Err("Calendar.app did not return an event id.".into())
    } else {
        Ok(uid)
    }
}

#[cfg(target_os = "macos")]
fn delete_event_by_uid(uid: &str) -> Result<(), String> {
    let name = applescript_escape(CALENDAR_NAME);
    let uid = applescript_escape(uid);
    let script = format!(
        r#"tell application "Calendar"
  tell calendar "{name}"
    set matches to (every event whose uid is "{uid}")
    if (count of matches) > 0 then delete item 1 of matches
  end tell
end tell"#
    );
    run_osascript(&script)?;
    Ok(())
}
