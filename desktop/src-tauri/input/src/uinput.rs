//! Linux `uinput` virtual gamepad backend (#18).
//!
//! Creates a virtual Xbox-style gamepad via `/dev/uinput` and pushes state as
//! `input_event` structs. Device setup and the state→event mapping are kept
//! separate: [`state_to_events`] is pure and unit-tested, while [`UinputBackend`]
//! performs the ioctls/writes. Creating a device requires write access to
//! `/dev/uinput`; when it is missing, `create()` returns the OS error rather
//! than pretending the device exists.

use std::io;
use std::os::fd::RawFd;

use super::{GamepadButton, GamepadState, InputBackend};

const UINPUT_MAX_NAME_SIZE: usize = 80;
const ABS_CNT: usize = 64;

const EV_SYN: u16 = 0;
const EV_KEY: u16 = 1;
const EV_ABS: u16 = 3;
const SYN_REPORT: u16 = 0;

const ABS_X: u16 = 0;
const ABS_Y: u16 = 1;
const ABS_Z: u16 = 2;
const ABS_RX: u16 = 3;
const ABS_RY: u16 = 4;
const ABS_RZ: u16 = 5;
const ABS_HAT0X: u16 = 0x10;
const ABS_HAT0Y: u16 = 0x11;

const BTN_SOUTH: u16 = 0x130;
const BTN_EAST: u16 = 0x131;
const BTN_NORTH: u16 = 0x133;
const BTN_WEST: u16 = 0x134;
const BTN_TL: u16 = 0x136;
const BTN_TR: u16 = 0x137;
const BTN_SELECT: u16 = 0x13a;
const BTN_START: u16 = 0x13b;
const BTN_THUMBL: u16 = 0x13d;
const BTN_THUMBR: u16 = 0x13e;

// _IOW('U', n, int) / _IO('U', n) as computed by linux/uinput.h.
const UI_SET_EVBIT: libc::c_ulong = 0x4004_5564;
const UI_SET_KEYBIT: libc::c_ulong = 0x4004_5565;
const UI_SET_ABSBIT: libc::c_ulong = 0x4004_5567;
const UI_DEV_CREATE: libc::c_ulong = 0x5501;
const UI_DEV_DESTROY: libc::c_ulong = 0x5502;

const STICK_MAX: i32 = 32_767;
const TRIGGER_MAX: i32 = 255;

const BUTTON_MAP: &[(GamepadButton, u16)] = &[
    (GamepadButton::South, BTN_SOUTH),
    (GamepadButton::East, BTN_EAST),
    (GamepadButton::North, BTN_NORTH),
    (GamepadButton::West, BTN_WEST),
    (GamepadButton::LeftBumper, BTN_TL),
    (GamepadButton::RightBumper, BTN_TR),
    (GamepadButton::LeftStick, BTN_THUMBL),
    (GamepadButton::RightStick, BTN_THUMBR),
    (GamepadButton::Start, BTN_START),
    (GamepadButton::Select, BTN_SELECT),
];

/// A platform-neutral event produced by the mapping (used for tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappedEvent {
    pub kind: u16,
    pub code: u16,
    pub value: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InputId {
    bustype: u16,
    vendor: u16,
    product: u16,
    version: u16,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct UinputUserDev {
    name: [libc::c_char; UINPUT_MAX_NAME_SIZE],
    id: InputId,
    /// The kernel's `ff_effects_max` is 32-bit; the two padding fields after it
    /// in `uinput_user_dev` are covered by the explicit arrays below.
    ff_effects_max: u32,
    absmax: [i32; ABS_CNT],
    absmin: [i32; ABS_CNT],
    absfuzz: [i32; ABS_CNT],
    absflat: [i32; ABS_CNT],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InputEvent {
    time: libc::timeval,
    type_: u16,
    code: u16,
    value: i32,
}

/// Map a gamepad state to the absolute/key events a virtual device should emit.
///
/// Every button is emitted on every frame (pressed = 1, released = 0) so the
/// host reliably observes releases. D-pad directions are folded onto
/// `ABS_HAT0X`/`ABS_HAT0Y`.
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn state_to_events(state: &GamepadState) -> Vec<MappedEvent> {
    let axis = |value: f32| (value.clamp(-1.0, 1.0) * STICK_MAX as f32).round() as i32;
    let trigger = |value: f32| (value.clamp(0.0, 1.0) * TRIGGER_MAX as f32).round() as i32;

    let pressed = |button: GamepadButton| state.buttons.contains(&button);
    let hat = |negative: bool, positive: bool| match (negative, positive) {
        (true, _) => -1,
        (false, true) => 1,
        _ => 0,
    };

    let mut events = vec![
        MappedEvent {
            kind: EV_ABS,
            code: ABS_X,
            value: axis(state.left_stick.x),
        },
        MappedEvent {
            kind: EV_ABS,
            code: ABS_Y,
            value: axis(state.left_stick.y),
        },
        MappedEvent {
            kind: EV_ABS,
            code: ABS_RX,
            value: axis(state.right_stick.x),
        },
        MappedEvent {
            kind: EV_ABS,
            code: ABS_RY,
            value: axis(state.right_stick.y),
        },
        MappedEvent {
            kind: EV_ABS,
            code: ABS_Z,
            value: trigger(state.left_trigger),
        },
        MappedEvent {
            kind: EV_ABS,
            code: ABS_RZ,
            value: trigger(state.right_trigger),
        },
        MappedEvent {
            kind: EV_ABS,
            code: ABS_HAT0X,
            value: hat(
                pressed(GamepadButton::DpadLeft),
                pressed(GamepadButton::DpadRight),
            ),
        },
        MappedEvent {
            kind: EV_ABS,
            code: ABS_HAT0Y,
            value: hat(
                pressed(GamepadButton::DpadUp),
                pressed(GamepadButton::DpadDown),
            ),
        },
    ];

    for (button, code) in BUTTON_MAP {
        events.push(MappedEvent {
            kind: EV_KEY,
            code: *code,
            value: i32::from(pressed(*button)),
        });
    }

    events
}

/// Virtual gamepad backed by `/dev/uinput`.
#[derive(Debug, Default)]
pub struct UinputBackend {
    fd: Option<RawFd>,
}

impl UinputBackend {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn ioctl(fd: RawFd, request: libc::c_ulong, value: libc::c_ulong) -> io::Result<()> {
        // SAFETY: `fd` is a valid uinput file descriptor opened in `create`, and
        // the request/value pair is a fixed ioctl from linux/uinput.h.
        let result = unsafe { libc::ioctl(fd, request, value) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn configure(fd: RawFd) -> io::Result<()> {
        for event_type in [EV_KEY, EV_ABS, EV_SYN] {
            Self::ioctl(fd, UI_SET_EVBIT, libc::c_ulong::from(event_type))?;
        }
        for (_, code) in BUTTON_MAP {
            Self::ioctl(fd, UI_SET_KEYBIT, libc::c_ulong::from(*code))?;
        }
        for axis in [
            ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ, ABS_HAT0X, ABS_HAT0Y,
        ] {
            Self::ioctl(fd, UI_SET_ABSBIT, libc::c_ulong::from(axis))?;
        }

        let mut device = UinputUserDev {
            name: [0; UINPUT_MAX_NAME_SIZE],
            id: InputId {
                // BUS_USB, a generic Microsoft-style pad id.
                bustype: 0x03,
                vendor: 0x045e,
                product: 0x028e,
                version: 1,
            },
            ff_effects_max: 0,
            absmax: [0; ABS_CNT],
            absmin: [0; ABS_CNT],
            absfuzz: [0; ABS_CNT],
            absflat: [0; ABS_CNT],
        };
        for (index, byte) in b"Drop Virtual Gamepad".iter().enumerate() {
            device.name[index] = *byte as libc::c_char;
        }
        for axis in [ABS_X, ABS_Y, ABS_RX, ABS_RY] {
            let index = usize::from(axis);
            device.absmin[index] = -STICK_MAX;
            device.absmax[index] = STICK_MAX;
        }
        for axis in [ABS_Z, ABS_RZ] {
            let index = usize::from(axis);
            device.absmin[index] = 0;
            device.absmax[index] = TRIGGER_MAX;
        }
        for axis in [ABS_HAT0X, ABS_HAT0Y] {
            let index = usize::from(axis);
            device.absmin[index] = -1;
            device.absmax[index] = 1;
        }

        // SAFETY: `device` is a fully initialized repr(C) uinput_user_dev.
        let written = unsafe {
            libc::write(
                fd,
                std::ptr::addr_of!(device).cast(),
                std::mem::size_of::<UinputUserDev>(),
            )
        };
        if written < 0 {
            return Err(io::Error::last_os_error());
        }

        Self::ioctl(fd, UI_DEV_CREATE, 0)
    }
}

impl InputBackend for UinputBackend {
    type Error = io::Error;

    fn create(&mut self) -> Result<(), Self::Error> {
        if self.fd.is_some() {
            return Ok(());
        }
        let path = std::ffi::CString::new("/dev/uinput")
            .map_err(|_| io::Error::other("invalid uinput path"))?;
        // SAFETY: opening a fixed device path with no ownership transfer concerns.
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        match Self::configure(fd) {
            Ok(()) => {
                self.fd = Some(fd);
                Ok(())
            }
            Err(error) => {
                // SAFETY: `fd` was opened above and is not stored anywhere.
                unsafe { libc::close(fd) };
                Err(error)
            }
        }
    }

    fn push_state(&mut self, state: &GamepadState) -> Result<(), Self::Error> {
        let Some(fd) = self.fd else {
            return Err(io::Error::other("virtual gamepad has not been created"));
        };

        let zero = libc::timeval {
            tv_sec: 0,
            tv_usec: 0,
        };
        let mut events: Vec<InputEvent> = state_to_events(state)
            .into_iter()
            .map(|event| InputEvent {
                time: zero,
                type_: event.kind,
                code: event.code,
                value: event.value,
            })
            .collect();
        events.push(InputEvent {
            time: zero,
            type_: EV_SYN,
            code: SYN_REPORT,
            value: 0,
        });

        // SAFETY: `events` is a contiguous array of repr(C) input_event values,
        // and `fd` is our open uinput descriptor.
        let bytes = unsafe {
            std::slice::from_raw_parts(
                events.as_ptr().cast::<u8>(),
                std::mem::size_of_val(events.as_slice()),
            )
        };
        let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if written < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn destroy(&mut self) -> Result<(), Self::Error> {
        if let Some(fd) = self.fd.take() {
            let _ = Self::ioctl(fd, UI_DEV_DESTROY, 0);
            // SAFETY: `fd` is the descriptor opened in `create` and just removed.
            unsafe { libc::close(fd) };
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Stick;

    fn value_of(events: &[MappedEvent], code: u16) -> i32 {
        events
            .iter()
            .find(|event| event.code == code)
            .map(|event| event.value)
            .unwrap_or_default()
    }

    #[test]
    fn sticks_and_triggers_scale_to_native_ranges() {
        let state = GamepadState {
            left_stick: Stick::new(1.0, -1.0),
            right_stick: Stick::new(0.5, 0.0),
            left_trigger: 1.0,
            right_trigger: 0.5,
            ..Default::default()
        };
        let events = state_to_events(&state);

        assert_eq!(value_of(&events, ABS_X), STICK_MAX);
        assert_eq!(value_of(&events, ABS_Y), -STICK_MAX);
        assert_eq!(
            value_of(&events, ABS_RX),
            (0.5 * STICK_MAX as f32).round() as i32
        );
        assert_eq!(value_of(&events, ABS_Z), TRIGGER_MAX);
        assert_eq!(value_of(&events, ABS_RZ), 128);
    }

    #[test]
    fn values_are_clamped() {
        let state = GamepadState {
            left_stick: Stick::new(5.0, -5.0),
            left_trigger: 3.0,
            ..Default::default()
        };
        let events = state_to_events(&state);
        assert_eq!(value_of(&events, ABS_X), STICK_MAX);
        assert_eq!(value_of(&events, ABS_Y), -STICK_MAX);
        assert_eq!(value_of(&events, ABS_Z), TRIGGER_MAX);
    }

    #[test]
    fn buttons_and_dpad_emit_press_and_release() {
        let mut state = GamepadState {
            buttons: vec![GamepadButton::South, GamepadButton::DpadUp],
            ..Default::default()
        };
        let pressed = state_to_events(&state);
        assert_eq!(value_of(&pressed, BTN_SOUTH), 1);
        assert_eq!(value_of(&pressed, BTN_EAST), 0);
        assert_eq!(value_of(&pressed, ABS_HAT0Y), -1);
        assert_eq!(value_of(&pressed, ABS_HAT0X), 0);

        state.buttons.clear();
        let released = state_to_events(&state);
        assert_eq!(value_of(&released, BTN_SOUTH), 0);
        assert_eq!(value_of(&released, ABS_HAT0Y), 0);
    }

    #[test]
    fn push_state_before_create_is_an_error() {
        let mut backend = UinputBackend::new();
        let result = backend.push_state(&GamepadState::default());
        assert!(result.is_err());
        assert!(backend.destroy().is_ok());
    }
}
