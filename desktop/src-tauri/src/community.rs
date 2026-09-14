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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForumThreadView {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub body: String,
    pub locked: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForumThreadRow {
    id: String,
    user_id: String,
    title: String,
    body: String,
    #[serde(default)]
    locked: bool,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

impl From<ForumThreadRow> for ForumThreadView {
    fn from(row: ForumThreadRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            title: row.title,
            body: row.body,
            locked: row.locked,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForumPostView {
    pub id: String,
    pub user_id: String,
    pub body: String,
    pub created_at: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForumPostRow {
    id: String,
    user_id: String,
    body: String,
    #[serde(default)]
    created_at: Option<String>,
}

impl From<ForumPostRow> for ForumPostView {
    fn from(row: ForumPostRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            body: row.body,
            created_at: row.created_at,
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForumThreadDetailView {
    pub thread: ForumThreadView,
    pub posts: Vec<ForumPostView>,
}

#[derive(serde::Deserialize)]
struct ForumThreadsResponse {
    threads: Vec<ForumThreadRow>,
}

#[derive(serde::Deserialize)]
struct ForumThreadDetailResponse {
    thread: ForumThreadRow,
    posts: Vec<ForumPostRow>,
}

async fn fetch_forum_json<T: serde::de::DeserializeOwned>(
    url: url::Url,
    what: &str,
) -> Result<T, String> {
    let response = DROP_CLIENT_ASYNC
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("failed to fetch {what}: {}", response.status()));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// Fetches the public forum threads for a game.
#[tauri::command]
pub async fn fetch_forum_threads(game_id: String) -> Result<Vec<ForumThreadView>, String> {
    let url = generate_url(&["/api/v1/community", &game_id, "threads"], &[])
        .map_err(|e| e.to_string())?;
    let response: ForumThreadsResponse = fetch_forum_json(url, "forum threads").await?;
    Ok(response.threads.into_iter().map(Into::into).collect())
}

/// Fetches a forum thread and its replies.
#[tauri::command]
pub async fn fetch_forum_thread(thread_id: String) -> Result<ForumThreadDetailView, String> {
    let url = generate_url(&["/api/v1/community", "threads", &thread_id], &[])
        .map_err(|e| e.to_string())?;
    let response: ForumThreadDetailResponse = fetch_forum_json(url, "forum thread").await?;
    Ok(ForumThreadDetailView {
        thread: response.thread.into(),
        posts: response.posts.into_iter().map(Into::into).collect(),
    })
}
