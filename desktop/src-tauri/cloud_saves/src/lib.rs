pub mod backup_manager;
pub mod conditions;
pub mod error;
pub mod ludusavi;
pub mod metadata;
pub mod normalise;
pub mod path;
pub mod placeholder;
pub mod provision;
pub mod resolver;
pub mod sync;
pub mod transport;

pub use ludusavi::{
    CloudSaveSyncContext, CloudSaveSyncManager, LudusaviBackupResponse, LudusaviClient,
    LudusaviFileResult, LudusaviGameResult, LudusaviOverall, pack_save_archive, sync_post_exit,
    sync_pre_launch, unpack_save_archive,
};
pub use sync::{
    DEFAULT_SLOT, PreLaunchDecision, SyncAction, decide_pre_launch, sync_post_exit_with,
    sync_pre_launch_with,
};
pub use transport::{CloudSaveTransport, RemoteSaveSnapshot, parse_latest_snapshot};
