use database::borrow_db_checked;
use remote::auth::generate_authorization_header;
use remote::requests::generate_url;
use remote::utils::DROP_CLIENT_ASYNC;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementUnlockRequest {
    pub game_id: String,
    pub key: String,
}

/// Unlocks achievements through the core client API (used by the GSE and
/// RetroAchievements client bridges after they diff newly earned achievements).
#[tauri::command]
pub async fn unlock_achievements(requests: Vec<AchievementUnlockRequest>) -> Result<usize, String> {
    if borrow_db_checked().auth.is_none() {
        return Err("not authenticated".to_string());
    }

    let url =
        generate_url(&["/api/v1/client/achievements/unlock"], &[]).map_err(|e| e.to_string())?;

    let mut unlocked = 0usize;
    for request in requests {
        let response = DROP_CLIENT_ASYNC
            .post(url.clone())
            .header("Authorization", generate_authorization_header())
            .json(&serde_json::json!({
                "gameId": request.game_id,
                "key": request.key,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if response.status().is_success() {
            unlocked += 1;
        }
    }

    Ok(unlocked)
}
