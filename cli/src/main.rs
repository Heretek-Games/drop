#![feature(async_fn_traits)]

use crate::commands::connect::config::manage_configuration;
use crate::{
    cli::{Cli, Commands},
    commands::connect::config::Config,
    commands::upload,
};
use clap::Parser;
mod cli;
mod commands;
mod logging;
mod manifest;
mod operator_builder;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    crate::logging::configure_logging()?;

    let cli = Cli::parse();

    let mut config = Config::read();
    match cli.command {
        Commands::Connect { name, option } => {
            manage_configuration(&mut config, name, option).await?
        }
        Commands::Upload { info, name } => {
            let info = info.interactive_configure();
            upload::interface::upload(&info, config, &name).await?;
        }
        Commands::Push {
            path,
            out,
            upload,
            prefix,
            branch,
            depot,
            base,
        } => {
            let options = crate::commands::push::PushOptions {
                branch,
                depot,
                base_manifest: base.map(std::path::PathBuf::from),
            };
            let summary = crate::commands::push::run_with_options(
                std::path::Path::new(&path),
                std::path::Path::new(&out),
                &options,
            )?;
            println!(
                "pushed {} file(s), {} chunk(s) ({} new, {} reused), {} -> {} bytes",
                summary.files,
                summary.chunks,
                summary.new_chunks,
                summary.reused_chunks,
                summary.bytes_in,
                summary.bytes_out
            );

            if let Some(scheme) = upload {
                let operator = crate::commands::push::build_operator(&scheme)?;
                let uploaded = crate::commands::push::upload_dir(
                    &operator,
                    &prefix,
                    std::path::Path::new(&out),
                )
                .await?;
                println!("uploaded {uploaded} object(s) via '{scheme}'");
            }
        }
    };

    Ok(())
}
