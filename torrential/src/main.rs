use std::{
    env::set_current_dir,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use dashmap::DashMap;
use log::{info, warn};
use simple_logger::SimpleLogger;
use tokio::{runtime::Handle, spawn, time};
use torrential::{
    downloads::{cache::ChunkCache, handlers, serve},
    server::create_drop_server,
    state::AppState,
};

const CONTEXT_TTL: u64 = 10 * 60;

/// Default cache budget when `CHUNK_CACHE_DIR` is set but
/// `CHUNK_CACHE_MAX_BYTES` is not (20 GiB).
const DEFAULT_CACHE_MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    initialise_logger()?;

    if let Ok(working_directory) = std::env::var("WORKING_DIRECTORY") {
        info!("moving to working directory {working_directory}");
        set_current_dir(&working_directory)?;
    }

    let metrics = Handle::current().metrics();
    info!("using {} threads", metrics.num_workers());

    let server = create_drop_server().await?;

    let chunk_cache = build_chunk_cache();

    let shared_state = Arc::new(AppState {
        context_cache: DashMap::new(),
        server,
        chunk_cache,
    });

    let interval_shared_state = shared_state.clone();

    spawn(async move {
        let shared_state = interval_shared_state;
        let mut interval = time::interval(Duration::from_mins(1));

        loop {
            interval.tick().await;
            let keys = shared_state
                .context_cache
                .iter()
                .map(|v| v.key().clone())
                .collect::<Vec<(String, String)>>();
            for key in keys {
                let last_access = if let Some(context) = shared_state.context_cache.get(&key) {
                    context.last_access()
                } else {
                    Instant::now()
                };
                if last_access.elapsed().as_secs() >= CONTEXT_TTL {
                    shared_state.context_cache.remove(&key);
                    info!("cleaned context: {key:?}");
                }
            }
        }
    });

    let app = setup_app(shared_state);

    serve(app).await?;

    Ok(())
}

/// Gate the catalog and cache-invalidation routes behind a shared token.
///
/// When `TORRENTIAL_HTTP_TOKEN` is unset the routes remain open (backwards
/// compatible for single-tenant deployments); setting it requires callers to
/// present it as `Authorization: Bearer <token>` or `x-torrential-token`.
async fn require_depot_token(request: Request, next: Next) -> Result<Response, StatusCode> {
    let Ok(expected) = std::env::var("TORRENTIAL_HTTP_TOKEN") else {
        return Ok(next.run(request).await);
    };
    let expected = expected.trim();
    if expected.is_empty() {
        return Ok(next.run(request).await);
    }

    let presented = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            request
                .headers()
                .get("x-torrential-token")
                .and_then(|value| value.to_str().ok())
        });

    if presented.is_some_and(|token| token == expected) {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn setup_app(shared_state: Arc<AppState>) -> Router {
    // The manifest catalog and cache invalidation are not needed by anonymous
    // depot downloads, so they can require a token.
    let protected = Router::new()
        .route("/api/v1/depot/manifest.json", get(handlers::manifest))
        .route("/invalidate", post(handlers::invalidate))
        .route_layer(middleware::from_fn(require_depot_token));

    Router::new()
        .route(
            "/api/v1/depot/content/{game_id}/{version_name}/{chunk_id}",
            get(serve::serve_file),
        )
        .route("/api/v1/depot/speedtest", get(handlers::speedtest))
        .route("/healthcheck", get(handlers::healthcheck))
        .merge(protected)
        .with_state(shared_state)
}

async fn serve(app: Router) -> Result<(), std::io::Error> {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:5000").await?;
    info!("started depot server");
    axum::serve(listener, app).await
}

fn initialise_logger() -> Result<(), log::SetLoggerError> {
    SimpleLogger::new()
        .with_level(log::LevelFilter::Info)
        .init()
}

/// Builds the optional chunk cache from environment configuration. Caching is
/// opt-in: when `CHUNK_CACHE_DIR` is unset (or empty) the cache is disabled and
/// the depot serves directly from source storage.
fn build_chunk_cache() -> ChunkCache {
    let dir = std::env::var("CHUNK_CACHE_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    if dir.is_none() {
        info!("chunk cache disabled (CHUNK_CACHE_DIR not set)");
        return ChunkCache::new(None, 0);
    }

    let max_bytes = match std::env::var("CHUNK_CACHE_MAX_BYTES") {
        Ok(value) => match value.parse::<u64>() {
            Ok(0) => {
                warn!(
                    "CHUNK_CACHE_MAX_BYTES=0 would leave the cache unbounded; using {DEFAULT_CACHE_MAX_BYTES} bytes"
                );
                DEFAULT_CACHE_MAX_BYTES
            }
            Ok(parsed) => parsed,
            Err(err) => {
                warn!(
                    "invalid CHUNK_CACHE_MAX_BYTES '{value}' ({err}); using {DEFAULT_CACHE_MAX_BYTES} bytes"
                );
                DEFAULT_CACHE_MAX_BYTES
            }
        },
        Err(_) => DEFAULT_CACHE_MAX_BYTES,
    };

    ChunkCache::new(dir, max_bytes)
}
