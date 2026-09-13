// axum requires every route handler to be `async`, even when it performs no
// awaits, so `unused_async` is not actionable in this module.
#![allow(clippy::unused_async)]

use std::{
    collections::HashMap,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue},
    response::IntoResponse,
};
use reqwest::{StatusCode, header::CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncRead, ReadBuf};
use tokio_util::io::ReaderStream;

use crate::{server::download::fetch_instance_games, state::AppState};

#[must_use]
pub async fn healthcheck() -> StatusCode {
    StatusCode::OK
}

#[derive(Deserialize)]
pub struct InvalidateBody {
    game: String,
    version: String,
}

#[must_use]
pub async fn invalidate(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<InvalidateBody>,
) -> StatusCode {
    state.context_cache.remove(&(payload.game, payload.version));
    StatusCode::OK
}

struct SpeedtestStream {
    remaining: usize,
}

impl SpeedtestStream {
    fn new() -> Self {
        SpeedtestStream {
            remaining: 1024 * 1024 * 50,
        }
    }

    fn content_length(&self) -> usize {
        self.remaining
    }
}

const ZERO: [u8; 1024] = [0u8; _];

impl AsyncRead for SpeedtestStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 || self.remaining == 0 {
            return Poll::Ready(Ok(()));
        }

        let amount = buf.remaining().min(self.remaining).min(ZERO.len());
        buf.put_slice(&ZERO[..amount]);
        self.remaining -= amount;

        Poll::Ready(Ok(()))
    }
}

/// Streams a fixed 50 MiB of zeroes for clients to measure download speed.
pub async fn speedtest() -> impl IntoResponse {
    let speedtest = SpeedtestStream::new();
    let content_length = speedtest.content_length();
    let body = Body::from_stream(ReaderStream::new(speedtest));

    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert("Content-Length", content_length.into());

    (headers, body)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameData {
    version_id: String,
    compression: String,
}

#[derive(Serialize)]
struct Manifest {
    content: HashMap<String, Vec<GameData>>,
}

/// Returns the depot's manifest of available games and versions as JSON.
///
/// # Errors
///
/// Returns `INTERNAL_SERVER_ERROR` when the connected Drop server cannot be
/// queried for the instance games.
pub async fn manifest(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, StatusCode> {
    let games = fetch_instance_games(&state).await?;

    let mut content = HashMap::new();
    for game in games {
        content.insert(
            game.id,
            game.versions
                .into_iter()
                .map(|v| GameData {
                    version_id: v.version_id,
                    compression: "none".to_owned(),
                })
                .collect::<Vec<GameData>>(),
        );
    }

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    Ok((headers, json!(Manifest { content }).to_string()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use tokio::io::AsyncReadExt;

    use super::SpeedtestStream;

    #[tokio::test]
    async fn speedtest_stream_produces_bounded_zeroes() {
        let mut stream = SpeedtestStream::new();
        let mut buf = [0u8; 1024];

        let mut total = 0;
        while total < 2048 {
            let read = stream.read(&mut buf).await.unwrap();
            assert!(read > 0);
            assert!(buf[..read].iter().all(|byte| *byte == 0));
            total += read;
        }

        assert_eq!(total, 2048);
        assert_eq!(stream.content_length(), 50 * 1024 * 1024 - 2048);
    }
}
