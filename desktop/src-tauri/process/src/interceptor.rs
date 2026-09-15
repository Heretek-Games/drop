use std::{path::Path, process::Command};

use crate::error::ProcessError;

/// Lifecycle interceptor for game processes, enabling extensions such as
/// `drop-gse` (Goldberg Steam Emulator + Mesh VPN) to patch binaries,
/// configure room broadcasts, and cleanly restore state on exit.
pub trait LaunchInterceptor: Send + Sync + 'static {
    /// Unique identifier for this interceptor (e.g. "drop-gse")
    fn id(&self) -> &'static str;

    /// Runs before the game process is spawned. Can inspect game directory,
    /// modify command-line arguments/environment, or deploy emulator DLLs/configs.
    fn pre_launch(
        &self,
        _game_id: &str,
        _install_dir: &Path,
        _command: &mut Command,
    ) -> Result<(), ProcessError> {
        Ok(())
    }

    /// Runs while the game process is running (e.g. monitoring heartbeats or mesh status).
    fn on_running(&self, _game_id: &str, _pid: u32) -> Result<(), ProcessError> {
        Ok(())
    }

    /// Runs immediately after the game process terminates.
    /// Restores file backups, tears down ephemeral mesh networks, and cleans up configs.
    fn post_exit(
        &self,
        _game_id: &str,
        _install_dir: &Path,
        _exit_status: Option<i32>,
    ) -> Result<(), ProcessError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    struct MockInterceptor {
        pre_launch_called: Arc<AtomicBool>,
        post_exit_called: Arc<AtomicBool>,
    }

    impl LaunchInterceptor for MockInterceptor {
        fn id(&self) -> &'static str {
            "mock-interceptor"
        }

        fn pre_launch(
            &self,
            _game_id: &str,
            _install_dir: &Path,
            _command: &mut Command,
        ) -> Result<(), ProcessError> {
            self.pre_launch_called.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn post_exit(
            &self,
            _game_id: &str,
            _install_dir: &Path,
            _exit_status: Option<i32>,
        ) -> Result<(), ProcessError> {
            self.post_exit_called.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn test_launch_interceptor_trait_object() {
        let pre = Arc::new(AtomicBool::new(false));
        let post = Arc::new(AtomicBool::new(false));
        let interceptor: Arc<dyn LaunchInterceptor> = Arc::new(MockInterceptor {
            pre_launch_called: pre.clone(),
            post_exit_called: post.clone(),
        });

        assert_eq!(interceptor.id(), "mock-interceptor");

        let mut cmd = Command::new("echo");
        let path = Path::new("/tmp");
        assert!(interceptor.pre_launch("game-1", path, &mut cmd).is_ok());
        assert!(pre.load(Ordering::SeqCst));

        assert!(interceptor.on_running("game-1", 1234).is_ok());

        assert!(interceptor.post_exit("game-1", path, Some(0)).is_ok());
        assert!(post.load(Ordering::SeqCst));
    }
}
