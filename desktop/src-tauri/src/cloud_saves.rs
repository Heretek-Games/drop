use database::{borrow_db_checked, db::DATA_ROOT_DIR};
use remote::auth::generate_authorization_header;
use remote::requests::generate_url;
use remote::utils::DROP_CLIENT_ASYNC;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSaveSlotView {
    pub index: i32,
    pub history_count: usize,
    pub latest_object_id: Option<String>,
    pub latest_checksum: Option<String>,
    pub last_used_client_id: Option<String>,
    pub created_at: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSlotRow {
    index: i32,
    #[serde(default)]
    history_object_ids: Vec<String>,
    #[serde(default)]
    history_checksums: Vec<String>,
    #[serde(default)]
    last_used_client_id: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

fn ensure_authenticated() -> Result<(), String> {
    if borrow_db_checked().auth.is_none() {
        return Err("not authenticated".to_string());
    }
    Ok(())
}

/// Lists the caller's cloud save slots for a game.
#[tauri::command]
pub async fn fetch_cloud_save_slots(game_id: String) -> Result<Vec<CloudSaveSlotView>, String> {
    ensure_authenticated()?;

    let url = generate_url(&["/api/v1/client/saves", &game_id], &[]).map_err(|e| e.to_string())?;
    let response = DROP_CLIENT_ASYNC
        .get(url)
        .header("Authorization", generate_authorization_header())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "failed to fetch cloud save slots: {}",
            response.status()
        ));
    }

    let body = response.text().await.map_err(|e| e.to_string())?;
    let rows: Vec<SaveSlotRow> = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|row| CloudSaveSlotView {
            index: row.index,
            history_count: row.history_object_ids.len(),
            latest_object_id: row.history_object_ids.last().cloned(),
            latest_checksum: row.history_checksums.last().cloned(),
            last_used_client_id: row.last_used_client_id,
            created_at: row.created_at,
        })
        .collect())
}

/// Downloads a snapshot object into `<data>/saves/downloads` and returns its path.
#[tauri::command]
pub async fn download_cloud_save_object(object_id: String) -> Result<String, String> {
    ensure_authenticated()?;

    let url =
        generate_url(&["/api/v1/client/object", &object_id], &[]).map_err(|e| e.to_string())?;
    let response = DROP_CLIENT_ASYNC
        .get(url)
        .header("Authorization", generate_authorization_header())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "failed to download cloud save object: {}",
            response.status()
        ));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let dir = DATA_ROOT_DIR.join("saves").join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{object_id}.tar.zst"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
