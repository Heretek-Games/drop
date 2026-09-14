//! Drop Input — controller remapping and virtual gamepad abstraction (#18).
//!
//! The platform backends live behind [`InputBackend`]: `uinput`/`evdev` on
//! Linux and `ViGEm` on Windows create the virtual device, while this crate
//! owns the pure mapping logic (deadzones, gyro-to-mouse, button remaps) so it
//! stays testable without touching `/dev/uinput` or a driver.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GamepadButton {
    South,
    East,
    West,
    North,
    LeftBumper,
    RightBumper,
    LeftStick,
    RightStick,
    Start,
    Select,
    DpadUp,
    DpadDown,
    DpadLeft,
    DpadRight,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stick {
    pub x: f32,
    pub y: f32,
}

impl Stick {
    #[must_use]
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    #[must_use]
    pub fn magnitude(&self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gyro {
    pub pitch: f32,
    pub yaw: f32,
    pub roll: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GamepadState {
    pub left_stick: Stick,
    pub right_stick: Stick,
    pub left_trigger: f32,
    pub right_trigger: f32,
    pub buttons: Vec<GamepadButton>,
    pub gyro: Option<Gyro>,
}

impl Default for GamepadState {
    fn default() -> Self {
        Self {
            left_stick: Stick::new(0.0, 0.0),
            right_stick: Stick::new(0.0, 0.0),
            left_trigger: 0.0,
            right_trigger: 0.0,
            buttons: Vec::new(),
            gyro: None,
        }
    }
}

/// A virtual gamepad device. Real implementations wrap uinput (Linux) or ViGEm
/// (Windows); [`MockBackend`] records states for tests.
pub trait InputBackend: Send + Sync {
    type Error;

    fn create(&mut self) -> Result<(), Self::Error>;
    fn push_state(&mut self, state: &GamepadState) -> Result<(), Self::Error>;
    fn destroy(&mut self) -> Result<(), Self::Error>;
}

/// Zeroes an axis value inside the deadzone and rescales the remainder to the
/// full unit range so movement still starts from zero at the deadzone edge.
#[must_use]
pub fn apply_deadzone(value: f32, deadzone: f32) -> f32 {
    let deadzone = deadzone.clamp(0.0, 1.0);
    let magnitude = value.abs();
    if magnitude <= deadzone {
        return 0.0;
    }
    let scaled = (magnitude - deadzone) / (1.0 - deadzone);
    scaled.clamp(0.0, 1.0).copysign(value)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MouseDelta {
    pub dx: f32,
    pub dy: f32,
}

/// Converts gyro yaw/pitch into a mouse delta for gyro-aiming. `sensitivity` is
/// in pixels per degree and `deadzone` is in degrees.
#[must_use]
pub fn map_gyro_to_mouse(gyro: &Gyro, sensitivity: f32, deadzone: f32) -> MouseDelta {
    MouseDelta {
        dx: deadzone_degrees(gyro.yaw, deadzone) * sensitivity,
        dy: deadzone_degrees(gyro.pitch, deadzone) * sensitivity,
    }
}

fn deadzone_degrees(value: f32, deadzone: f32) -> f32 {
    if value.abs() <= deadzone {
        0.0
    } else {
        value
    }
}

/// Applies a deadzone to both sticks of a state.
#[must_use]
pub fn normalize_sticks(state: &GamepadState, deadzone: f32) -> GamepadState {
    let mut normalized = state.clone();
    normalized.left_stick = Stick::new(
        apply_deadzone(state.left_stick.x, deadzone),
        apply_deadzone(state.left_stick.y, deadzone),
    );
    normalized.right_stick = Stick::new(
        apply_deadzone(state.right_stick.x, deadzone),
        apply_deadzone(state.right_stick.y, deadzone),
    );
    normalized
}

/// Records every pushed state; used by the desktop to dry-run mappings.
#[derive(Debug, Default)]
pub struct MockBackend {
    pub created: bool,
    pub states: Vec<GamepadState>,
}

impl InputBackend for MockBackend {
    type Error = std::convert::Infallible;

    fn create(&mut self) -> Result<(), Self::Error> {
        self.created = true;
        Ok(())
    }

    fn push_state(&mut self, state: &GamepadState) -> Result<(), Self::Error> {
        self.states.push(state.clone());
        Ok(())
    }

    fn destroy(&mut self) -> Result<(), Self::Error> {
        self.created = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadzone_zeros_small_input_and_scales_large_input() {
        assert_eq!(apply_deadzone(0.05, 0.2), 0.0);
        assert_eq!(apply_deadzone(-0.05, 0.2), 0.0);
        // 0.6 is 0.4 into the 0.8 usable range => 0.5
        assert!((apply_deadzone(0.6, 0.2) - 0.5).abs() < 1e-6);
        assert_eq!(apply_deadzone(1.0, 0.2), 1.0);
    }

    #[test]
    fn gyro_mapping_respects_deadzone_and_sensitivity() {
        let gyro = Gyro {
            pitch: 2.0,
            yaw: 10.0,
            roll: 0.0,
        };
        let delta = map_gyro_to_mouse(&gyro, 2.0, 0.5);
        assert_eq!(delta.dx, 20.0);
        assert_eq!(delta.dy, 4.0);

        let idle = map_gyro_to_mouse(
            &Gyro {
                pitch: 0.1,
                yaw: 0.1,
                roll: 0.0,
            },
            2.0,
            0.5,
        );
        assert_eq!(idle, MouseDelta { dx: 0.0, dy: 0.0 });
    }

    #[test]
    fn normalize_sticks_applies_deadzone_per_axis() {
        let state = GamepadState {
            left_stick: Stick::new(0.1, 0.9),
            ..Default::default()
        };
        let normalized = normalize_sticks(&state, 0.2);
        assert_eq!(normalized.left_stick.x, 0.0);
        assert!(normalized.left_stick.y > 0.8);
    }

    #[test]
    fn mock_backend_tracks_lifecycle() {
        let mut backend = MockBackend::default();
        assert!(backend.create().is_ok());
        assert!(backend.created);
        assert!(backend.push_state(&GamepadState::default()).is_ok());
        assert_eq!(backend.states.len(), 1);
        assert!(backend.destroy().is_ok());
        assert!(!backend.created);
    }
}
