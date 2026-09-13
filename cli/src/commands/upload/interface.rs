use std::path::Path;

use crate::{
    cli::UploadInfo,
    commands::connect::{config::Config, config_option::ConfigOption},
    manifest::{ClosureFactory, CompressionOption, DepotManifest, generate_v2_manifest},
    operator_builder::OperatorBuilder,
};
use futures::AsyncWriteExt;
use log::info;
use opendal::{FuturesAsyncWriter, Operator};
use tokio_util::compat::{Compat, FuturesAsyncWriteCompatExt};

pub async fn upload(
    upload_info: &UploadInfo,
    config: Config,
    name: &Option<String>,
) -> anyhow::Result<()> {
    let game_id = upload_info.game_id.clone();
    let path = upload_info.path.clone();
    let version_id = upload_info.version_id.clone();

    let operator = get_operator(config, name)?;

    let mut existing_depot_manifest = get_depot_manifest(&operator).await?;

    info!("Uploading chunks");

    generate_v2_manifest(
        Path::new(&path),
        ClosureFactory::new(
            async move |id: String| {
                info!("Uploading chunk id {id}");
                operator
                    .writer(&format!("{game_id}/{version_id}/{id}"))
                    .await
                    .unwrap()
                    .into_futures_async_write()
                    .compat_write()
            },
            |writer: Compat<FuturesAsyncWriter>| async {
                writer.into_inner().close().await.unwrap();
            },
        ),
    )
    .await?;

    info!("Finished uploading chunks");

    existing_depot_manifest.append(
        upload_info.game_id.to_string(),
        upload_info.version_id.to_string(),
        CompressionOption::None,
    );
    Ok(())
}

async fn get_depot_manifest(operator: &Operator) -> Result<DepotManifest, anyhow::Error> {
    let existing_depot_manifest = operator.read("manifest.json").await?.to_bytes();
    let existing_depot_manifest: DepotManifest =
        serde_json::from_slice(existing_depot_manifest.as_ref())?;
    Ok(existing_depot_manifest)
}

fn get_operator(config: Config, name: &Option<String>) -> anyhow::Result<Operator> {
    let operator = match if let Some(name) = name {
        config
            .get(name)
            .ok_or(anyhow::anyhow!("Name does not exist"))?
    } else {
        config.get_active().ok_or(anyhow::anyhow!(
            "No active connection set. Please specify with --name"
        ))?
    } {
        ConfigOption::S3(s3_config) => s3_config.build()?,
    };
    Ok(operator)
}
