use power::{decide, PowerDecision, PowerPolicy, PowerState};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPowerDecision {
    /// One of `"allow"`, `"throttle"`, or `"pause"`.
    pub decision: String,
    /// Throttle multiplier when `decision == "throttle"`.
    pub factor: Option<f32>,
}

#[cfg(target_os = "linux")]
fn current_power_state() -> Option<PowerState> {
    power::read_linux_power_state()
}

#[cfg(not(target_os = "linux"))]
fn current_power_state() -> Option<PowerState> {
    None
}

/// Handheld power policy decision for the download manager. When the battery
/// state is unknown (desktop, or no battery) downloads are unrestricted.
#[tauri::command]
pub fn download_power_decision() -> DownloadPowerDecision {
    let state = current_power_state().unwrap_or(PowerState {
        on_battery: false,
        battery_percent: 100.0,
        charging: false,
    });

    match decide(state, PowerPolicy::default()) {
        PowerDecision::Allow => DownloadPowerDecision {
            decision: "allow".to_string(),
            factor: None,
        },
        PowerDecision::Throttle(factor) => DownloadPowerDecision {
            decision: "throttle".to_string(),
            factor: Some(factor),
        },
        PowerDecision::Pause => DownloadPowerDecision {
            decision: "pause".to_string(),
            factor: None,
        },
    }
}
