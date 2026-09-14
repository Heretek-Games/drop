use database::borrow_db_checked;
use remote::auth::generate_authorization_header;
use remote::requests::generate_url;
use remote::utils::DROP_CLIENT_ASYNC;

/// Fetches the authenticated client's WebRTC ICE server configuration
/// (`GET /api/v1/client/ice`). The webview uses the result to build an
/// `RTCPeerConnection`.
#[tauri::command]
pub async fn fetch_ice_config() -> Result<serde_json::Value, String> {
    if borrow_db_checked().auth.is_none() {
        return Err("not authenticated".to_string());
    }

    let url = generate_url(&["/api/v1/client/ice"], &[]).map_err(|e| e.to_string())?;
    let response = DROP_CLIENT_ASYNC
        .get(url)
        .header("Authorization", generate_authorization_header())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "failed to fetch ICE configuration: {}",
            response.status()
        ));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}
