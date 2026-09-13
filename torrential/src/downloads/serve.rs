use std::{
    io::Error,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

use aes::cipher::{KeyIvInit, StreamCipher};
use axum::{
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use droplet_rs::{
    manifest::ChunkData,
    versions::types::{MinimumFileObject, VersionFile},
};
use futures_util::{Stream, StreamExt, stream};
use log::{error, info, warn};
use pin_project_lite::pin_project;
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Semaphore, SemaphorePermit},
};
use tokio_util::io::ReaderStream;

use crate::{
    DownloadContext, GLOBAL_CONTEXT_SEMAPHORE,
    downloads::{cache::ChunkCache, download::create_download_context},
    state::AppState,
};

type Aes128Ctr64LE = ctr::Ctr64LE<aes::Aes128>;

pin_project! {
    struct SemaphoreStream<'a, T>
        where T: Stream
    {
        #[pin]
        stream: T,
        semaphore: SemaphorePermit<'a>,
    }
}

impl<'a, T: Stream> SemaphoreStream<'a, T> {
    fn new(stream: T, permit: SemaphorePermit<'a>) -> Self {
        Self {
            stream,
            semaphore: permit,
        }
    }
}

impl<T: Stream> Stream for SemaphoreStream<'_, T> {
    type Item = T::Item;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.project();
        this.stream.poll_next(cx)
    }
}

/// Number of file descriptors the process may hold open, used to bound the
/// number of concurrent source readers. Falls back to a conservative default if
/// the platform limit cannot be read.
static FILE_OPEN_LIMIT: LazyLock<usize> = LazyLock::new(|| {
    file_open_limit::get().unwrap_or_else(|err| {
        warn!("failed to read open file limit, defaulting to 512: {err:?}");
        512
    })
});
static FILE_SEMAPHORE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(*FILE_OPEN_LIMIT));

/// Serves an encrypted depot chunk.
///
/// # Errors
///
/// Returns a status code when the context cannot be created, the chunk is not
/// present in the manifest, or the chunk has too many parts to serve safely.
pub async fn serve_file(
    State(state): State<Arc<AppState>>,
    AxumPath((game_id, version_name, chunk_id)): AxumPath<(String, String, String)>,
) -> Result<Response, StatusCode> {
    let context = get_or_create_context(&state, game_id, version_name).await?;
    context.reset_last_access();

    let chunk_data = lookup_chunk(&chunk_id, &context)?;
    if chunk_data.files.len() >= *FILE_OPEN_LIMIT {
        return Err(StatusCode::INSUFFICIENT_STORAGE);
    }

    // Read-through cache: hits skip source storage entirely; misses fill the
    // cache best-effort. Any cache failure falls back to streaming directly.
    if state.chunk_cache.enabled() {
        if let Some(path) = state.chunk_cache.hit(&chunk_data.checksum) {
            if let Some(response) = serve_from_file(&path, &context, &chunk_data).await {
                return Ok(response);
            }
            // The entry is unusable (size mismatch or unreadable): drop it so
            // the miss path can refill instead of warning on every request.
            state.chunk_cache.invalidate(&chunk_data.checksum);
        }

        if let Some(path) = fill_cache(&state.chunk_cache, &context, &chunk_data).await
            && let Some(response) = serve_from_file(&path, &context, &chunk_data).await
        {
            return Ok(response);
        }
    }

    serve_from_source(&context, &chunk_data).await
}

/// Streams a chunk directly from the source backend.
async fn serve_from_source(
    context: &DownloadContext,
    chunk_data: &ChunkData,
) -> Result<Response, StatusCode> {
    let file_count =
        u32::try_from(chunk_data.files.len()).map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;
    let permit = FILE_SEMAPHORE
        .acquire_many(file_count)
        .await
        .map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;

    let mut streams = Vec::with_capacity(chunk_data.files.len());
    let mut content_length = 0usize;

    for file_entry in &chunk_data.files {
        let reader = get_file_reader(
            context,
            file_entry.filename.clone(),
            file_entry.start,
            file_entry.start + file_entry.length,
        )
        .await?;

        streams.push(ReaderStream::new(reader));
        content_length += file_entry.length;
    }

    let stream = stream::iter(streams).flatten();
    Ok(encrypted_response(
        stream,
        content_length,
        context.manifest.key,
        chunk_data.iv,
        permit,
    ))
}

/// Serves a chunk straight from the content-addressed cache file. Returns `None`
/// when the file is missing, the wrong size, or cannot be opened, so the caller
/// can fall back to source streaming.
async fn serve_from_file(
    path: &Path,
    context: &DownloadContext,
    chunk_data: &ChunkData,
) -> Option<Response> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let actual = file.metadata().await.ok()?.len();
    let expected: u64 = chunk_data.files.iter().map(|f| f.length as u64).sum();
    if actual != expected {
        warn!(
            "chunk cache entry {} is {actual} bytes, expected {expected}; ignoring",
            chunk_data.checksum
        );
        return None;
    }

    let content_length = chunk_data.files.iter().map(|f| f.length).sum();
    let permit = FILE_SEMAPHORE.acquire().await.ok()?;

    Some(encrypted_response(
        ReaderStream::new(file),
        content_length,
        context.manifest.key,
        chunk_data.iv,
        permit,
    ))
}

/// Fills the cache with the plaintext chunk bytes. Returns the published cache
/// path on success, or `None` (leaving the caller to stream directly).
async fn fill_cache(
    cache: &ChunkCache,
    context: &DownloadContext,
    chunk_data: &ChunkData,
) -> Option<PathBuf> {
    let expected: u64 = chunk_data.files.iter().map(|f| f.length as u64).sum();
    let guard = cache.reserve(&chunk_data.checksum, expected)?;

    let file_count = u32::try_from(chunk_data.files.len()).ok()?;
    let permit = FILE_SEMAPHORE.acquire_many(file_count).await.ok()?;

    let mut file = match tokio::fs::File::create(&guard.temp_path).await {
        Ok(file) => file,
        Err(e) => {
            warn!("chunk cache fill failed to create temp file: {e}");
            return None;
        }
    };

    // The cache holds decrypted bytes; keep the file private even if the
    // containing directory's permissions were widened.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = file
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .await
        {
            warn!("chunk cache fill failed to restrict temp file permissions: {e}");
        }
    }

    let mut written: u64 = 0;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];

    for file_entry in &chunk_data.files {
        let mut reader = match context
            .backend
            .reader(
                &VersionFile {
                    relative_filename: file_entry.filename.clone(),
                    permission: 0,
                    size: 0,
                },
                file_entry.start as u64,
                (file_entry.start + file_entry.length) as u64,
            )
            .await
        {
            Ok(reader) => reader,
            Err(e) => {
                warn!("chunk cache fill failed to open reader: {e:?}");
                return None;
            }
        };

        loop {
            let read = match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => read,
                Err(e) => {
                    warn!("chunk cache fill copy failed: {e}");
                    return None;
                }
            };
            if let Err(e) = file.write_all(&buffer[..read]).await {
                warn!("chunk cache fill write failed: {e}");
                return None;
            }
            hasher.update(&buffer[..read]);
            written += read as u64;
        }
    }

    if let Err(e) = file.flush().await {
        warn!("chunk cache fill flush failed: {e}");
        return None;
    }
    drop(file);
    drop(permit);

    if written != expected {
        warn!(
            "chunk cache fill size mismatch for {}: wrote {written}, expected {expected}",
            chunk_data.checksum
        );
        return None;
    }

    // The cache key is the SHA-256 plaintext digest. Refuse to publish bytes
    // that do not hash to it (corrupt source, partial read, bad manifest).
    let digest = to_hex(hasher.finalize().as_slice());
    if !digest.eq_ignore_ascii_case(&chunk_data.checksum) {
        warn!(
            "chunk cache fill checksum mismatch for {}: computed {digest}",
            chunk_data.checksum
        );
        return None;
    }

    if guard.commit(written) {
        cache.hit(&chunk_data.checksum)
    } else {
        None
    }
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// Applies the manifest AES-CTR keystream to a plaintext byte stream and builds
/// the encrypted HTTP response. The permit is held for the lifetime of the body.
fn encrypted_response<S>(
    stream: S,
    content_length: usize,
    key: [u8; 16],
    iv: [u8; 16],
    permit: SemaphorePermit<'static>,
) -> Response
where
    S: Stream<Item = Result<Bytes, Error>> + Send + 'static,
{
    let mut cipher = Aes128Ctr64LE::new(&key.into(), &iv.into());
    let encrypted_stream = stream.chunks(16).map(move |raw| -> Result<Bytes, Error> {
        let data: Result<Vec<Bytes>, Error> = raw.into_iter().collect();
        let mut data = data?.concat();

        cipher.apply_keystream(&mut data);

        Ok(data.into())
    });
    let permit_stream = SemaphoreStream::new(encrypted_stream, permit);
    let body: Body = Body::from_stream(permit_stream);

    let mut headers = HeaderMap::new();
    headers.insert(
        "Content-Type",
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert("Content-Length", content_length.into());

    (headers, body).into_response()
}

async fn acquire_permit() -> Result<SemaphorePermit<'static>, StatusCode> {
    GLOBAL_CONTEXT_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

/**
 * Needs to be cloned for reference reasons
 */
fn lookup_chunk(chunk_id: &str, context: &DownloadContext) -> Result<ChunkData, StatusCode> {
    context
        .manifest
        .chunks
        .get(chunk_id)
        .cloned()
        .ok_or(StatusCode::NOT_FOUND)
}

async fn get_file_reader(
    context: &DownloadContext,
    relative_filename: String,
    start: usize,
    end: usize,
) -> Result<Box<dyn MinimumFileObject>, StatusCode> {
    context
        .backend
        .reader(
            &VersionFile {
                relative_filename: relative_filename.clone(),
                permission: 0,
                size: 0,
            },
            start as u64,
            end as u64,
        )
        .await
        .map_err(|v| {
            error!("reader error for '{relative_filename}': {v:?}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn get_or_create_context(
    state: &Arc<AppState>,
    game_id: String,
    version_name: String,
) -> Result<Arc<DownloadContext>, StatusCode> {
    let key = (game_id.clone(), version_name.clone());

    if let Some(context) = state.context_cache.get(&key) {
        return Ok(Arc::clone(&context));
    }

    let permit = acquire_permit().await?;

    // Another request may have created the context while we waited.
    if let Some(context) = state.context_cache.get(&key) {
        return Ok(Arc::clone(&context));
    }

    info!("generating context for {game_id}...");
    let context = create_download_context(state, game_id.clone(), version_name.clone()).await?;
    state.context_cache.insert(key.clone(), Arc::new(context));

    info!("continuing download for {game_id}");

    drop(permit);

    state
        .context_cache
        .get(&key)
        .map(|context| Arc::clone(&context))
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)
}
