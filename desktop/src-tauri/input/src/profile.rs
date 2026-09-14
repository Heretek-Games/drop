//! Per-game controller layout profiles (#18 shareable input configs).
//!
//! A profile is a serializable, shareable description of a controller layout:
//! stick deadzone, gyro tuning, and button remaps. Profiles are validated before
//! use and applied to a [`GamepadState`] by [`apply_profile`].

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::{GamepadButton, GamepadState, Gyro, normalize_sticks};

/// One button remap (press `from`, report `to`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ButtonRemap {
    pub from: GamepadButton,
    pub to: GamepadButton,
}

/// A shareable controller layout profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControllerProfile {
    pub name: String,
    /// Stick deadzone in `0.0..=1.0`.
    pub deadzone: f32,
    /// Gyro multiplier (1.0 = unchanged).
    pub gyro_sensitivity: f32,
    #[serde(default)]
    pub remaps: Vec<ButtonRemap>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileError {
    EmptyName,
    InvalidDeadzone,
    InvalidGyroSensitivity,
    DuplicateRemapFrom(GamepadButton),
}

impl fmt::Display for ProfileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProfileError::EmptyName => write!(formatter, "profile name is required"),
            ProfileError::InvalidDeadzone => {
                write!(formatter, "deadzone must be within 0.0..=1.0")
            }
            ProfileError::InvalidGyroSensitivity => {
                write!(
                    formatter,
                    "gyro sensitivity must be a finite, non-negative number"
                )
            }
            ProfileError::DuplicateRemapFrom(button) => {
                write!(formatter, "duplicate remap source: {button:?}")
            }
        }
    }
}

impl std::error::Error for ProfileError {}

/// Validate a profile before applying or sharing it.
///
/// # Errors
/// Returns a [`ProfileError`] for an empty name, out-of-range deadzone,
/// non-finite/negative gyro sensitivity, or two remaps sharing a source button.
pub fn validate_profile(profile: &ControllerProfile) -> Result<(), ProfileError> {
    if profile.name.trim().is_empty() {
        return Err(ProfileError::EmptyName);
    }
    if !(0.0..=1.0).contains(&profile.deadzone) {
        return Err(ProfileError::InvalidDeadzone);
    }
    if !profile.gyro_sensitivity.is_finite() || profile.gyro_sensitivity < 0.0 {
        return Err(ProfileError::InvalidGyroSensitivity);
    }
    let mut seen = Vec::new();
    for remap in &profile.remaps {
        if seen.contains(&remap.from) {
            return Err(ProfileError::DuplicateRemapFrom(remap.from));
        }
        seen.push(remap.from);
    }
    Ok(())
}

/// Rewrite button presses through a profile's remaps, preserving order and
/// de-duplicating results.
#[must_use]
pub fn remap_buttons(buttons: &[GamepadButton], remaps: &[ButtonRemap]) -> Vec<GamepadButton> {
    let mut mapped = Vec::new();
    for button in buttons {
        let target = remaps
            .iter()
            .find(|remap| remap.from == *button)
            .map_or(*button, |remap| remap.to);
        if !mapped.contains(&target) {
            mapped.push(target);
        }
    }
    mapped
}

/// Apply a profile to a gamepad state: deadzone the sticks, scale gyro, and
/// remap buttons.
#[must_use]
pub fn apply_profile(state: &GamepadState, profile: &ControllerProfile) -> GamepadState {
    let mut next = normalize_sticks(state, profile.deadzone);
    next.gyro = state.gyro.map(|gyro| Gyro {
        pitch: gyro.pitch * profile.gyro_sensitivity,
        yaw: gyro.yaw * profile.gyro_sensitivity,
        roll: gyro.roll * profile.gyro_sensitivity,
    });
    next.buttons = remap_buttons(&state.buttons, &profile.remaps);
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Stick;

    fn profile() -> ControllerProfile {
        ControllerProfile {
            name: "Deck".to_string(),
            deadzone: 0.2,
            gyro_sensitivity: 2.0,
            remaps: vec![ButtonRemap {
                from: GamepadButton::South,
                to: GamepadButton::East,
            }],
        }
    }

    #[test]
    fn round_trips_through_json() {
        let serialized = serde_json::to_string(&profile()).expect("serialize");
        let restored: ControllerProfile = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(restored, profile());
    }

    #[test]
    fn validation_rejects_bad_values() {
        let mut bad_name = profile();
        bad_name.name = "  ".to_string();
        assert_eq!(validate_profile(&bad_name), Err(ProfileError::EmptyName));

        let mut bad_deadzone = profile();
        bad_deadzone.deadzone = 1.5;
        assert_eq!(
            validate_profile(&bad_deadzone),
            Err(ProfileError::InvalidDeadzone)
        );

        let mut bad_gyro = profile();
        bad_gyro.gyro_sensitivity = -1.0;
        assert_eq!(
            validate_profile(&bad_gyro),
            Err(ProfileError::InvalidGyroSensitivity)
        );

        let mut duplicate = profile();
        duplicate.remaps.push(ButtonRemap {
            from: GamepadButton::South,
            to: GamepadButton::North,
        });
        assert_eq!(
            validate_profile(&duplicate),
            Err(ProfileError::DuplicateRemapFrom(GamepadButton::South))
        );
    }

    #[test]
    fn apply_profile_deadzones_scales_and_remaps() {
        let state = GamepadState {
            left_stick: Stick::new(0.1, 0.9),
            buttons: vec![GamepadButton::South],
            gyro: Some(Gyro {
                pitch: 1.0,
                yaw: 2.0,
                roll: 0.0,
            }),
            ..Default::default()
        };
        let applied = apply_profile(&state, &profile());

        assert_eq!(applied.left_stick.x, 0.0);
        assert!(applied.left_stick.y > 0.8);
        assert_eq!(applied.buttons, vec![GamepadButton::East]);

        let applied_gyro = applied.gyro.expect("gyro preserved");
        assert_eq!(applied_gyro.yaw, 4.0);
    }

    #[test]
    fn remap_dedupes_repeated_targets() {
        let buttons = [GamepadButton::South, GamepadButton::North];
        let remaps = [
            ButtonRemap {
                from: GamepadButton::South,
                to: GamepadButton::East,
            },
            ButtonRemap {
                from: GamepadButton::North,
                to: GamepadButton::East,
            },
        ];
        assert_eq!(remap_buttons(&buttons, &remaps), vec![GamepadButton::East]);
    }
}
