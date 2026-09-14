pub mod backup_manager;
pub mod conditions;
pub mod error;
pub mod ludusavi;
pub mod metadata;
pub mod normalise;
pub mod path;
pub mod placeholder;
pub mod resolver;
pub mod sync;
pub mod transport;

pub use ludusavi::{
    pack_save_archive, sync_post_exit, sync_pre_launch, unpack_save_archive, CloudSaveSyncContext,
    CloudSaveSyncManager, LudusaviBackupResponse, LudusaviClient, LudusaviFileResult,
    LudusaviGameResult, LudusaviOverall,
};
pub use sync::{
    decide_pre_launch, sync_post_exit_with, sync_pre_launch_with, PreLaunchDecision, SyncAction,
    DEFAULT_SLOT,
};
pub use transport::{parse_latest_snapshot, CloudSaveTransport, RemoteSaveSnapshot};
