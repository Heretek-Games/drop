//! Goldberg-family `steam_settings/` config generation.

use std::path::Path;

use crate::EmulatorFlavor;
use crate::error::EngineError;

/// Directory name for emulator settings inside the game folder.
pub const SETTINGS_DIR: &str = "steam_settings";

/// Runtime configuration written into `<game_dir>/steam_settings/`.
#[derive(Debug, Clone)]
pub struct SteamSettings {
    pub app_id: u32,
    /// One address per line → `custom_broadcasts.txt`.
    pub custom_broadcasts: Vec<String>,
    /// Interface list → `steam_interfaces.txt`.
    pub interfaces: Vec<String>,
}

impl SteamSettings {
    pub fn render_custom_broadcasts(&self) -> String {
        if self.custom_broadcasts.is_empty() {
            // No mesh peers: keep LAN discovery on the default broadcast target.
            "127.0.0.1:47584\n".to_string()
        } else {
            let mut out = self
                .custom_broadcasts
                .iter()
                .map(|peer| {
                    if peer.contains(':') {
                        peer.clone()
                    } else {
                        format!("{peer}:47584")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            out.push('\n');
            out
        }
    }

    pub fn render_steam_appid(&self) -> String {
        self.app_id.to_string()
    }

    pub fn render_steam_interfaces(&self) -> String {
        self.interfaces.join("\n")
    }

    /// Minimal `configs.main.ini`. Keys differ slightly between forks.
    pub fn render_configs_main_ini(&self, flavor: EmulatorFlavor) -> String {
        let listener_key = match flavor {
            EmulatorFlavor::GbeFork => "listener_port",
            EmulatorFlavor::GseFork => "listen_port",
        };
        let mut out = String::new();
        out.push_str("[main::connectivity]\n");
        out.push_str(&format!("{listener_key}=47584\n"));
        out.push_str("disable_lan_only=0\n");
        out.push_str("disable_networking=0\n");
        out
    }

    /// Write all settings files into `<game_dir>/steam_settings/`.
    pub fn write_to(
        &self,
        game_dir: &Path,
        flavor: EmulatorFlavor,
    ) -> Result<(), EngineError> {
        let dir = game_dir.join(SETTINGS_DIR);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("configs.main.ini"), self.render_configs_main_ini(flavor))?;
        std::fs::write(dir.join("steam_appid.txt"), self.render_steam_appid())?;
        std::fs::write(
            dir.join("steam_interfaces.txt"),
            self.render_steam_interfaces(),
        )?;
        std::fs::write(
            dir.join("custom_broadcasts.txt"),
            self.render_custom_broadcasts(),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcasts_default_to_localhost_when_no_peers() {
        let settings = SteamSettings {
            app_id: 480,
            custom_broadcasts: vec![],
            interfaces: vec![],
        };
        assert_eq!(settings.render_custom_broadcasts(), "127.0.0.1:47584\n");
    }

    #[test]
    fn broadcasts_append_default_port() {
        let settings = SteamSettings {
            app_id: 480,
            custom_broadcasts: vec!["10.242.0.5".into(), "10.242.0.6:5000".into()],
            interfaces: vec![],
        };
        assert_eq!(
            settings.render_custom_broadcasts(),
            "10.242.0.5:47584\n10.242.0.6:5000\n"
        );
    }

    #[test]
    fn writes_all_settings_files() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = SteamSettings {
            app_id: 1234,
            custom_broadcasts: vec!["10.0.0.2".into()],
            interfaces: vec!["SteamUser021".into()],
        };
        settings
            .write_to(tmp.path(), EmulatorFlavor::GbeFork)
            .unwrap();

        let dir = tmp.path().join(SETTINGS_DIR);
        assert_eq!(
            std::fs::read_to_string(dir.join("steam_appid.txt")).unwrap(),
            "1234"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("steam_interfaces.txt")).unwrap(),
            "SteamUser021"
        );
        assert!(
            std::fs::read_to_string(dir.join("configs.main.ini"))
                .unwrap()
                .contains("listener_port=47584")
        );
    }

    #[test]
    fn flavor_changes_ini_key() {
        let settings = SteamSettings {
            app_id: 1,
            custom_broadcasts: vec![],
            interfaces: vec![],
        };
        assert!(
            settings
                .render_configs_main_ini(EmulatorFlavor::GseFork)
                .contains("listen_port=47584")
        );
    }
}
