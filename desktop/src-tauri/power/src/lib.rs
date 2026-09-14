//! Handheld power management policy (#18).
//!
//! Pure decision logic that maps battery state to download behaviour. The
//! desktop feeds it a [`PowerState`] (from the OS battery API) and applies the
//! resulting [`PowerDecision`] to the download manager: pause on critically low
//! battery, throttle on low battery, and run unthrottled when charging or on
//! mains power.

/// Current power source / battery state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PowerState {
    /// True when running on battery rather than mains power.
    pub on_battery: bool,
    /// Battery charge percentage in `0.0..=100.0`.
    pub battery_percent: f32,
    /// True while the battery is actively charging.
    pub charging: bool,
}

/// Thresholds controlling the decision.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PowerPolicy {
    /// At or below this percentage, pause downloads.
    pub pause_below_percent: f32,
    /// At or below this percentage, throttle downloads.
    pub throttle_below_percent: f32,
    /// Multiplier applied when throttling (`0.0..=1.0`).
    pub throttle_factor: f32,
}

impl Default for PowerPolicy {
    fn default() -> Self {
        Self {
            pause_below_percent: 5.0,
            throttle_below_percent: 25.0,
            throttle_factor: 0.5,
        }
    }
}

impl PowerPolicy {
    /// Validate the thresholds.
    ///
    /// # Errors
    /// Returns a message when the factor is outside `0.0..=1.0` or the pause
    /// threshold is not below the throttle threshold.
    pub fn validate(&self) -> Result<(), String> {
        if !self.throttle_factor.is_finite() || !(0.0..=1.0).contains(&self.throttle_factor) {
            return Err("throttle_factor must be within 0.0..=1.0".to_string());
        }
        if self.pause_below_percent >= self.throttle_below_percent {
            return Err("pause_below_percent must be below throttle_below_percent".to_string());
        }
        Ok(())
    }
}

/// What the download manager should do.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PowerDecision {
    Allow,
    Throttle(f32),
    Pause,
}

/// Decide download behaviour for a power state under a policy.
#[must_use]
pub fn decide(state: PowerState, policy: PowerPolicy) -> PowerDecision {
    if state.charging || !state.on_battery {
        return PowerDecision::Allow;
    }

    let percent = state.battery_percent.clamp(0.0, 100.0);
    if percent <= policy.pause_below_percent {
        PowerDecision::Pause
    } else if percent <= policy.throttle_below_percent {
        PowerDecision::Throttle(policy.throttle_factor.clamp(0.0, 1.0))
    } else {
        PowerDecision::Allow
    }
}

/// Parse the sysfs `capacity`/`status` files of a battery into a [`PowerState`].
#[must_use]
pub fn parse_linux_power_state(capacity: &str, status: &str) -> PowerState {
    let battery_percent = capacity
        .trim()
        .parse::<f32>()
        .unwrap_or(0.0)
        .clamp(0.0, 100.0);
    let status = status.trim().to_ascii_lowercase();
    let charging = status == "charging" || status == "full";
    let on_battery = status == "discharging";
    PowerState {
        on_battery,
        battery_percent,
        charging,
    }
}

/// Read the first battery under `/sys/class/power_supply`.
///
/// Returns `None` on non-Linux platforms or when no battery is present, so the
/// caller can fall back to an unthrottled policy.
#[cfg(target_os = "linux")]
#[must_use]
pub fn read_linux_power_state() -> Option<PowerState> {
    let entries = std::fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_uppercase();
        if !name.starts_with("BAT") {
            continue;
        }
        let path = entry.path();
        let capacity = std::fs::read_to_string(path.join("capacity")).ok()?;
        let status = std::fs::read_to_string(path.join("status")).ok()?;
        return Some(parse_linux_power_state(&capacity, &status));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn battery(percent: f32) -> PowerState {
        PowerState {
            on_battery: true,
            battery_percent: percent,
            charging: false,
        }
    }

    #[test]
    fn mains_and_charging_are_unrestricted() {
        let policy = PowerPolicy::default();
        assert_eq!(
            decide(
                PowerState {
                    on_battery: false,
                    battery_percent: 10.0,
                    charging: false,
                },
                policy
            ),
            PowerDecision::Allow
        );
        assert_eq!(
            decide(
                PowerState {
                    on_battery: true,
                    battery_percent: 3.0,
                    charging: true,
                },
                policy
            ),
            PowerDecision::Allow
        );
    }

    #[test]
    fn thresholds_pause_and_throttle_on_battery() {
        let policy = PowerPolicy::default();
        assert_eq!(decide(battery(3.0), policy), PowerDecision::Pause);
        assert_eq!(decide(battery(5.0), policy), PowerDecision::Pause);
        assert_eq!(decide(battery(20.0), policy), PowerDecision::Throttle(0.5));
        assert_eq!(decide(battery(80.0), policy), PowerDecision::Allow);
    }

    #[test]
    fn clamps_out_of_range_inputs() {
        let policy = PowerPolicy {
            throttle_factor: 5.0,
            ..Default::default()
        };
        // Factor is clamped on use (validation still reports it).
        assert_eq!(decide(battery(20.0), policy), PowerDecision::Throttle(1.0));
        assert_eq!(decide(battery(150.0), policy), PowerDecision::Allow);
    }

    #[test]
    fn policy_validation_rejects_bad_thresholds() {
        assert!(PowerPolicy::default().validate().is_ok());
        assert!(
            PowerPolicy {
                throttle_factor: 1.5,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            PowerPolicy {
                pause_below_percent: 30.0,
                throttle_below_percent: 20.0,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn parses_linux_power_state() {
        assert_eq!(
            parse_linux_power_state("42\n", "Discharging\n"),
            PowerState {
                on_battery: true,
                battery_percent: 42.0,
                charging: false,
            }
        );
        assert_eq!(
            parse_linux_power_state("100", "Full"),
            PowerState {
                on_battery: false,
                battery_percent: 100.0,
                charging: true,
            }
        );
        assert_eq!(
            parse_linux_power_state("garbage", "Unknown"),
            PowerState {
                on_battery: false,
                battery_percent: 0.0,
                charging: false,
            }
        );
    }
}
