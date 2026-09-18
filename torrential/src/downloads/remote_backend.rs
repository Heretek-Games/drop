use std::io;

use anyhow::anyhow;
use async_trait::async_trait;
use droplet_rs::versions::types::{MinimumFileObject, VersionBackend, VersionFile};
use futures_util::TryStreamExt as _;
use log::warn;
use reqwest::header::{HeaderMap, HeaderValue, RANGE};
use tokio_util::io::StreamReader;

/// A storage backend that streams file content from a remote depot endpoint
/// over HTTP range requests.
#[derive(Clone, Debug)]
pub struct RemoteVersionBackend {
    pub stream_url: String,
    pub headers: HeaderMap,
    pub client: reqwest::Client,
}

impl RemoteVersionBackend {
    /// Creates a new `RemoteVersionBackend` with default client timeouts.
    #[must_use]
    pub fn new(stream_url: String, headers: HeaderMap) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            stream_url,
            headers,
            client,
        }
    }

    /// Creates a `RemoteVersionBackend` with a custom reqwest client.
    #[must_use]
    pub fn with_client(stream_url: String, headers: HeaderMap, client: reqwest::Client) -> Self {
        Self {
            stream_url,
            headers,
            client,
        }
    }
}

#[async_trait]
impl VersionBackend for RemoteVersionBackend {
    fn require_whole_files(&self) -> bool {
        false
    }

    async fn list_files(&self) -> anyhow::Result<Vec<VersionFile>> {
        // Remote depot metadata is provided through the manifest; file listing is not required.
        Ok(Vec::new())
    }

    async fn peek_file(&self, sub_path: String) -> anyhow::Result<VersionFile> {
        Ok(VersionFile {
            relative_filename: sub_path,
            permission: 0o644,
            size: 0,
        })
    }

    async fn reader(
        &self,
        file: &VersionFile,
        start: u64,
        end: u64,
    ) -> anyhow::Result<Box<dyn MinimumFileObject>> {
        if end <= start {
            return Err(anyhow!("invalid range: end ({end}) <= start ({start})"));
        }

        let mut request = self.client.get(&self.stream_url);

        // Forward configured headers (e.g. auth tokens, loopback RPC secret)
        request = request.headers(self.headers.clone());

        // Range header: bytes=start-(end-1)
        let end_inclusive = end.saturating_sub(1);
        let range_val = format!("bytes={start}-{end_inclusive}");
        let header_val = HeaderValue::from_str(&range_val)
            .map_err(|e| anyhow!("invalid range header value: {e}"))?;
        request = request.header(RANGE, header_val);

        // Also supply query parameters for endpoints that support explicit offsets
        request = request.query(&[
            ("offset", start.to_string()),
            ("length", (end - start).to_string()),
            ("file", file.relative_filename.clone()),
        ]);

        let response = request
            .send()
            .await
            .map_err(|e| anyhow!("remote depot request failed: {e}"))?;
        let status = response.status();

        if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
            warn!(
                "remote depot error status {status} for file '{}' range {start}..{end}",
                file.relative_filename
            );
            return Err(anyhow!(
                "remote depot returned error status {status} for file '{}' range {start}..{end}",
                file.relative_filename
            ));
        }

        let byte_stream = response.bytes_stream().map_err(io::Error::other);

        let stream_reader = StreamReader::new(byte_stream);
        Ok(Box::new(stream_reader))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        extract::Query,
        http::{HeaderMap as AxumHeaders, StatusCode},
        response::IntoResponse,
        routing::get,
    };
    use serde::Deserialize;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    #[derive(Deserialize)]
    struct RangeQuery {
        offset: Option<u64>,
        length: Option<u64>,
    }

    async fn mock_range_handler(
        headers: AxumHeaders,
        Query(query): Query<RangeQuery>,
    ) -> impl IntoResponse {
        // Verify auth header if sent
        if let Some(auth) = headers.get("authorization")
            && auth != "Bearer test-secret"
        {
            return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        }

        let (offset, length) = if let (Some(o), Some(l)) = (query.offset, query.length) {
            (o, l)
        } else if let Some(range) = headers.get("range").and_then(|v| v.to_str().ok()) {
            if let Some(stripped) = range.strip_prefix("bytes=") {
                let parts: Vec<&str> = stripped.split('-').collect();
                let start: u64 = parts[0].parse().unwrap_or(0);
                let end: u64 = parts[1].parse().unwrap_or(start);
                (start, end - start + 1)
            } else {
                (0, 0)
            }
        } else {
            (0, 0)
        };

        let mut data = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        for i in 0..length {
            data.push(u8::try_from((offset + i) % 256).unwrap_or(0));
        }

        (StatusCode::PARTIAL_CONTENT, data).into_response()
    }

    #[tokio::test]
    async fn test_remote_backend_range_reader() -> anyhow::Result<()> {
        let app = Router::new().route("/depot/stream", get(mock_range_handler));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();

        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                eprintln!("mock depot server error: {err}");
            }
        });

        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer test-secret"),
        );

        let stream_url = format!("http://127.0.0.1:{port}/depot/stream");
        let backend = RemoteVersionBackend::new(stream_url, headers);

        let file = VersionFile {
            relative_filename: "test.bin".to_string(),
            permission: 0o644,
            size: 100,
        };

        let mut reader = backend.reader(&file, 10, 15).await?;
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).await?;

        assert_eq!(buf.len(), 5);
        assert_eq!(buf, vec![10, 11, 12, 13, 14]);

        Ok(())
    }
}
