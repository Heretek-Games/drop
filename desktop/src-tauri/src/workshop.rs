use database::borrow_db_checked;
use remote::auth::generate_authorization_header;
use remote::requests::generate_url;
use remote::utils::DROP_CLIENT_ASYNC;

async fn fetch_authenticated_json(path: &[&str]) -> Result<serde_json::Value, String> {
    if borrow_db_checked().auth.is_none() {
        return Err("not authenticated".to_string());
    }

    let url = generate_url(path, &[]).map_err(|e| e.to_string())?;
    let response = DROP_CLIENT_ASYNC
        .get(url)
        .header("Authorization", generate_authorization_header())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("request failed: {}", response.status()));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// The authenticated user's Workshop mod subscriptions (with mod metadata).
#[tauri::command]
pub async fn fetch_workshop_subscriptions() -> Result<serde_json::Value, String> {
    fetch_authenticated_json(&["/api/v1/client/workshop/subscriptions"]).await
}

/// A Workshop mod's releases (used to read the `mod.json` manifest).
#[tauri::command]
pub async fn fetch_workshop_mod(
    game_id: String,
    key: String,
) -> Result<serde_json::Value, String> {
    fetch_authenticated_json(&["/api/v1/workshop", &game_id, "mods", &key]).await
}
