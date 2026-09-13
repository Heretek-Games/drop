use std::{
    io::Error,
    path::PathBuf,
    sync::{Arc, LazyLock},
};

use aes::cipher::{KeyIvInit, StreamCipher};
use axum::{
    body::Body,
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use dashmap::{DashMap, mapref::one::RefMut};
use droplet_rs::{
    manifest::ChunkData,
    versions::types::{MinimumFileObject, VersionFile},
};
use futures_util::{Stream, StreamExt, stream};
use log::{error, info, warn};
use pin_project_lite::pin_project;
use reqwest::StatusCode;
use tokio::{
    io::AsyncWriteExt,
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

impl<T: Stream> Stream for SemaphoreStream<'_, T>
where
    T: Stream,
{
    type Item = T::Item;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.project();
        this.stream.poll_next(cx)
    }
}

static SEMPAHORE_COUNT: LazyLock<usize> =
    LazyLock::new(|| file_open_limit::get().expect("failed to count max open files"));
static FILE_SEMAPHORE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(*SEMPAHORE_COUNT));

pub async fn serve_file(
    State(state): State<Arc<AppState>>,
    Path((game_id, version_name, chunk_id)): Path<(String, String, String)>,
) -> Result<Response, StatusCode> {
    let context_cache = &state.context_cache;

    let mut context = get_or_create_context(&state, context_cache, game_id, version_name).await?;
    context.reset_last_access();

    let chunk_data = lookup_chunk(&chunk_id, &context)?;
    if chunk_data.files.len() >= *SEMPAHORE_COUNT {
        return Err(StatusCode::INSUFFICIENT_STORAGE);
    }

    // Read-through cache: hits skip source storage entirely; misses fill the
    // cache best-effort and fall back to direct streaming on any failure.
    if state.chunk_cache.enabled() {
        if let Some(path) = state.chunk_cache.hit(&chunk_data.checksum) {
            return serve_from_file(&path, &context, &chunk_data).await;
        }

        if let Some(path) = fill_cache(&state.chunk_cache, &mut context, &chunk_data).await {
            return serve_from_file(&path, &context, &chunk_data).await;
        }
    }

    let permit = FILE_SEMAPHORE
        .acquire_many(chunk_data.files.len().try_into().unwrap())
        .await
        .map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;
    let mut streams = Vec::with_capacity(chunk_data.files.len());
    let mut content_length = 0usize;

    for file_entry in &chunk_data.files {
        let reader = get_file_reader(
            &mut context,
            file_entry.filename.clone(),
            file_entry.start,
            file_entry.start + file_entry.length,
        )
        .await?;

        let stream = ReaderStream::new(reader);
        streams.push(stream);
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

/// Serves a chunk straight from the content-addressed cache file.
async fn serve_from_file(
    path: &std::path::Path,
    context: &RefMut<'_, (String, String), DownloadContext>,
    chunk_data: &ChunkData,
) -> Result<Response, StatusCode> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let content_length = chunk_data.files.iter().map(|f| f.length).sum();
    let permit = FILE_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;

    Ok(encrypted_response(
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
    context: &mut RefMut<'_, (String, String), DownloadContext>,
    chunk_data: &ChunkData,
) -> Option<PathBuf> {
    let guard = cache.reserve(&chunk_data.checksum)?;
    let mut file = tokio::fs::File::create(&guard.temp_path).await.ok()?;

    let expected: u64 = chunk_data.files.iter().map(|f| f.length as u64).sum();
    let mut written: u64 = 0;

    for file_entry in &chunk_data.files {
        let mut reader = context
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
            .ok()?;

        match tokio::io::copy(&mut reader, &mut file).await {
            Ok(bytes) => written += bytes,
            Err(e) => {
                warn!("chunk cache fill copy failed: {e}");
                return None;
            }
        }
    }

    if file.flush().await.is_err() {
        return None;
    }
    drop(file);

    if written != expected {
        warn!(
            "chunk cache fill size mismatch for {}: wrote {written}, expected {expected}",
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
    headers.insert("Content-Type", "application/octet-stream".parse().unwrap());
    headers.insert("Content-Length", content_length.into());

    (headers, body).into_response()
}
async fn acquire_permit<'a>() -> SemaphorePermit<'a> {
    return GLOBAL_CONTEXT_SEMAPHORE
        .acquire()
        .await
        .expect("failed to acquire semaphore");
}
/**
 * Needs to be cloned for reference reasons
 */
fn lookup_chunk(
    chunk_id: &str,
    context: &RefMut<'_, (String, String), DownloadContext>,
) -> Result<ChunkData, StatusCode> {
    context
        .manifest
        .chunks
        .get(chunk_id)
        .cloned()
        .ok_or(StatusCode::NOT_FOUND)
}
async fn get_file_reader(
    context: &mut RefMut<'_, (String, String), DownloadContext>,
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
async fn get_or_create_context<'a>(
    state: &Arc<AppState>,
    context_cache: &'a DashMap<(String, String), DownloadContext>,
    game_id: String,
    version_name: String,
) -> Result<RefMut<'a, (String, String), DownloadContext>, StatusCode> {
    let key = (game_id.clone(), version_name.clone());

    if let Some(context) = context_cache.get_mut(&key) {
        Ok(context)
    } else {
        let permit = acquire_permit().await;

        // Check if it's been done while we've been sitting here
        if let Some(already_done) = context_cache.get_mut(&key) {
            Ok(already_done)
        } else {
            info!("generating context for {game_id}...");
            let context_result =
                create_download_context(state, game_id.clone(), version_name.clone()).await?;

            state.context_cache.insert(key.clone(), context_result);

            info!("continuing download for {game_id}");

            drop(permit);

            Ok(context_cache.get_mut(&key).unwrap())
        }
    }
}
