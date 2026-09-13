//! Join/leave a ZeroTier network through the local ZeroTier One service.
//!
//! The desktop does not embed a ZeroTier client, so room membership is applied
//! by invoking `zerotier-cli` (which talks to the platform service). Joining
//! typically requires administrator/root privileges; failures are surfaced to
//! the user with an actionable message rather than failing silently.

use std::process::Command;

/// Shown when no ZeroTier CLI can be found on the host.
pub const NOT_INSTALLED: &str =
    "ZeroTier is not installed. Install ZeroTier One and sign in to join multiplayer rooms.";

fn candidates() -> Vec<String> {
    #[allow(unused_mut)]
    let mut paths = vec!["zerotier-cli".to_string()];

    #[cfg(target_os = "linux")]
    {
        paths.push("/usr/sbin/zerotier-cli".to_string());
        paths.push("/usr/bin/zerotier-cli".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        paths.push("/Library/Application Support/ZeroTier/One/zerotier-cli".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        paths.push("C:\\ProgramData\\ZeroTier\\One\\zerotier-cli.bat".to_string());
    }

    paths
}

/// Join the given ZeroTier network (`zerotier-cli join <nwid>`).
pub fn join_network(network_id: &str) -> Result<(), String> {
    run("join", network_id)
}

/// Leave the given ZeroTier network (`zerotier-cli leave <nwid>`).
pub fn leave_network(network_id: &str) -> Result<(), String> {
    run("leave", network_id)
}

fn run(verb: &str, network_id: &str) -> Result<(), String> {
    if network_id.trim().is_empty() {
        return Err("missing ZeroTier network id".to_string());
    }

    for candidate in candidates() {
        match Command::new(&candidate).args([verb, network_id]).output() {
            Ok(output) if output.status.success() => return Ok(()),
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let message = if !stderr.is_empty() { stderr } else { stdout };
                // "already a member" is harmless for join.
                if message.to_lowercase().contains("already") {
                    return Ok(());
                }
                return Err(if message.is_empty() {
                    format!("zerotier-cli {verb} failed")
                } else {
                    message
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.to_string()),
        }
    }

    Err(NOT_INSTALLED.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_network_id_is_rejected() {
        assert!(join_network("").is_err());
        assert!(leave_network("   ").is_err());
    }

    #[test]
    fn candidates_include_the_bare_command() {
        assert!(candidates()
            .iter()
            .any(|candidate| candidate == "zerotier-cli"));
    }
}
