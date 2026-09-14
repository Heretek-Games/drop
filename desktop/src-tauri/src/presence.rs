use database::borrow_db_checked;
use remote::auth::generate_authorization_header;
use remote::requests::generate_url;
use remote::utils::DROP_CLIENT_ASYNC;

/// Reports local presence through the core client API (rich presence, #20).
#[tauri::command]
pub async fn report_presence(status: String, game_id: Option<String>) -> Result<(), String> {
    if borrow_db_checked().auth.is_none() {
        return Err("not authenticated".to_string());
    }

    let url = generate_url(&["/api/v1/client/presence"], &[]).map_err(|e| e.to_string())?;
    let response = DROP_CLIENT_ASYNC
        .put(url)
        .header("Authorization", generate_authorization_header())
        .json(&serde_json::json!({ "status": status, "gameId": game_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("presence update failed: {}", response.status()));
    }
    Ok(())
}

/// Clears local presence (explicit offline / sign-out).
#[tauri::command]
pub async fn clear_presence() -> Result<(), String> {
    if borrow_db_checked().auth.is_none() {
        return Err("not authenticated".to_string());
    }

    let url = generate_url(&["/api/v1/client/presence"], &[]).map_err(|e| e.to_string())?;
    let response = DROP_CLIENT_ASYNC
        .delete(url)
        .header("Authorization", generate_authorization_header())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("presence clear failed: {}", response.status()));
    }
    Ok(())
}
