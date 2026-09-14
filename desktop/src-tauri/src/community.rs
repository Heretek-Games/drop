use remote::requests::generate_url;
use remote::utils::DROP_CLIENT_ASYNC;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewView {
    pub id: String,
    pub user_id: String,
    pub rating: i32,
    pub body: String,
    pub verified: bool,
    pub created_at: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewRow {
    id: String,
    user_id: String,
    rating: i32,
    body: String,
    verified: bool,
    #[serde(default)]
    created_at: Option<String>,
}

/// Fetches the public review list for a game from the community API.
#[tauri::command]
pub async fn fetch_game_reviews(game_id: String) -> Result<Vec<ReviewView>, String> {
    let url = generate_url(&["/api/v1/community", &game_id, "reviews"], &[])
        .map_err(|e| e.to_string())?;

    let response = DROP_CLIENT_ASYNC
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "failed to fetch reviews: {}",
            response.status()
        ));
    }

    let body = response.text().await.map_err(|e| e.to_string())?;
    let rows: Vec<ReviewRow> = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|row| ReviewView {
            id: row.id,
            user_id: row.user_id,
            rating: row.rating,
            body: row.body,
            verified: row.verified,
            created_at: row.created_at,
        })
        .collect())
}
