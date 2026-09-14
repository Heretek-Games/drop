use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::{commands::connect::config_option::ConfigOptionCli, interactive_variable};

#[derive(Parser)]
#[command(version, about, long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    /// Specify data file path
    #[arg(short, long)]
    pub data: Option<String>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Configures downpour endpoints
    Connect {
        #[arg(short, long)]
        name: Option<String>,
        #[command(subcommand)]
        option: ConfigOptionCli,
    },
    /// Uploads new game version to depot
    Upload {
        #[clap(flatten)]
        info: UploadInfoCli,
        #[arg(short, long)]
        /// Alias of a given connection
        name: Option<String>,
    },
    /// Publishes a local depot directory as content-addressed chunks
    Push {
        /// Directory to publish
        #[arg(short, long, default_value_t = String::from("."))]
        path: String,
        /// Output directory for chunks + manifest
        #[arg(short, long, default_value_t = String::from("dist"))]
        out: String,
        /// Upload scheme (memory, s3); when set, chunks + manifest are uploaded
        #[arg(short, long)]
        upload: Option<String>,
        /// Object-store key prefix for the upload
        #[arg(long, default_value_t = String::new())]
        prefix: String,
    },
}

#[derive(Args)]
pub struct UploadInfo {
    pub path: String,
    pub game_id: String,
    pub version_id: String,
}
#[derive(Args)]
pub struct UploadInfoCli {
    /// Relative path to new version files
    #[arg(short, long, default_value_t = String::from("."))]
    pub path: String,
    /// ID of game to attach to
    #[arg(short, long)]
    pub game_id: Option<String>,
    /// Version ID to attach to
    #[arg(short, long)]
    pub version_id: Option<String>,
}
impl UploadInfoCli {
    pub fn interactive_configure(self) -> UploadInfo {
        let path = self.path;
        interactive_variable!(self, game_id, "Game ID");
        interactive_variable!(self, version_id, "Version ID");
        UploadInfo {
            path,
            game_id,
            version_id,
        }
    }
}

#[derive(ValueEnum, Copy, Clone, Debug, PartialEq, Eq)]
pub enum UploadStyle {
    S3,
}
