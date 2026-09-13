use std::{sync::nonpoison::Mutex, time::Duration};

use client::app_status::AppStatus;
use database::{borrow_db_checked, borrow_db_mut_checked};
use futures_lite::StreamExt;
use futures_util::SinkExt;
use log::{debug, warn};
use remote::{
    auth::{auth_initiate_logic, generate_authorization_header},
    cache::{cache_object, get_cached_object},
    error::RemoteAccessError,
    requests::generate_url,
    setup,
    utils::{DROP_CLIENT_ASYNC, DROP_CLIENT_WS_CLIENT, DropHealthcheck},
};
use reqwest_websocket::{Message, RequestBuilderExt};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use url::Url;
use utils::{app_emit, webbrowser_open::webbrowser_open};

use crate::{AppState, recieve_handshake};

#[tauri::command]
pub async fn use_remote(
    url: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), RemoteAccessError> {
    debug!("connecting to url {url}");
    let base_url = Url::parse(&url)?;

    // Test Drop url
    let test_endpoint = base_url.join("/api/v1")?;
    let client = DROP_CLIENT_ASYNC.clone();
    let response = client
        .get(test_endpoint.to_string())
        .timeout(Duration::from_secs(3))
        .send()
        .await?;

    let result: DropHealthcheck = response.json().await?;

    if result.app_name() != "Drop" {
        warn!("user entered drop endpoint that connected, but wasn't identified as Drop");
        return Err(RemoteAccessError::InvalidEndpoint);
    }

    let mut app_state = state.lock();
    app_state.status = AppStatus::SignedOut;
    drop(app_state);

    let mut db_state = borrow_db_mut_checked();
    db_state.base_url = base_url.to_string();

    Ok(())
}

#[tauri::command]
pub fn gen_drop_url(path: String) -> Result<String, RemoteAccessError> {
    let base_url = {
        let handle = borrow_db_checked();

        Url::parse(&handle.base_url).map_err(RemoteAccessError::ParsingError)?
    };

    let url = base_url.join(&path)?;

    Ok(url.to_string())
}

#[tauri::command]
pub fn fetch_drop_object(path: String) -> Result<Vec<u8>, RemoteAccessError> {
    let _drop_url = gen_drop_url(path.clone())?;
    let req = generate_url(&[&path], &[])?;
    let req = remote::utils::DROP_CLIENT_SYNC
        .get(req)
        .header("Authorization", generate_authorization_header())
        .send();

    match req {
        Ok(data) => {
            let data = data.bytes()?.to_vec();
            cache_object(&path, &data)?;
            Ok(data)
        }
        Err(e) => {
            debug!("{e}");
            get_cached_object::<Vec<u8>>(&path)
        }
    }
}
#[tauri::command]
pub fn sign_out(app: AppHandle) {
    // Clear auth from database
    {
        let mut handle = borrow_db_mut_checked();
        handle.auth = None;
    }

    // Update app state
    {
        let state = app.state::<Mutex<AppState>>();
        let mut app_state_handle = state.lock();
        app_state_handle.status = AppStatus::SignedOut;
        app_state_handle.user = None;
    }

    // Emit event for frontend
    app_emit!(&app, "auth/signedout", ());
}

#[tauri::command]
pub async fn retry_connect(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), ()> {
    let (app_status, user) = setup().await;

    let mut guard = state.lock();
    guard.status = app_status;
    guard.user = user;
    drop(guard);

    Ok(())
}

#[tauri::command]
pub fn auth_initiate() -> Result<(), RemoteAccessError> {
    let base_url = {
        let db_lock = borrow_db_checked();
        Url::parse(&db_lock.base_url.clone())?
    };

    let redir_url = auth_initiate_logic("callback".to_string())?;
    let complete_redir_url = base_url.join(&redir_url)?;

    debug!("opening web browser to continue authentication");
    webbrowser_open(complete_redir_url.as_ref());
    Ok(())
}

#[derive(Deserialize)]
struct CodeWebsocketResponse {
    #[serde(rename = "type")]
    response_type: String,
    value: String,
}

#[tauri::command]
pub fn auth_initiate_code(app: AppHandle) -> Result<String, RemoteAccessError> {
    let base_url = {
        let db_lock = borrow_db_checked();
        Url::parse(&db_lock.base_url.clone())?.clone()
    };

    let code = auth_initiate_logic("code".to_string())?;
    let header_code = code.clone();

    println!("using code: {code} to sign in");

    tauri::async_runtime::spawn(async move {
        let load = async || -> Result<(), RemoteAccessError> {
            let ws_url = base_url.join("/api/v1/client/auth/code/ws")?;
            let response = DROP_CLIENT_WS_CLIENT
                .get(ws_url)
                .header("Authorization", header_code)
                .upgrade()
                .send()
                .await?;

            let mut websocket = response.into_websocket().await?;

            while let Some(token) = websocket.try_next().await? {
                if let Message::Text(response) = token {
                    let response = serde_json::from_str::<CodeWebsocketResponse>(&response)
                        .map_err(|e| RemoteAccessError::UnparseableResponse(e.to_string()))?;
                    match response.response_type.as_str() {
                        "token" => {
                            let recieve_app = app.clone();
                            manual_recieve_handshake(recieve_app, response.value).await;
                            return Ok(());
                        }
                        _ => return Err(RemoteAccessError::HandshakeFailed(response.value)),
                    }
                }
            }
            Err(RemoteAccessError::HandshakeFailed(
                "Failed to connect to websocket".to_string(),
            ))
        };

        let result = load().await;
        if let Err(err) = result {
            warn!("{err}");
            app_emit!(&app, "auth/failed", err.to_string());
        }
    });

    Ok(code)
}

#[tauri::command]
pub async fn manual_recieve_handshake(app: AppHandle, token: String) {
    recieve_handshake(app, format!("handshake/{token}")).await;
}

#[tauri::command]
pub async fn plugin_request(
    plugin_id: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, RemoteAccessError> {
    let base_url = {
        let db_lock = borrow_db_checked();
        Url::parse(&db_lock.base_url.clone())?
    };

    let trimmed = path.trim_start_matches('/');
    let target_path = if trimmed.is_empty() {
        format!("/api/v1/plugins/{plugin_id}")
    } else {
        format!("/api/v1/plugins/{plugin_id}/{trimmed}")
    };
    let endpoint = base_url.join(&target_path)?;

    let auth_header = generate_authorization_header();
    let client = DROP_CLIENT_ASYNC.clone();

    let request_builder = match method.to_uppercase().as_str() {
        "POST" => {
            let mut req = client
                .post(endpoint.to_string())
                .header("Authorization", auth_header);
            if let Some(b) = body {
                req = req.json(&b);
            }
            req
        }
        "DELETE" => {
            let mut req = client
                .delete(endpoint.to_string())
                .header("Authorization", auth_header);
            if let Some(b) = body {
                req = req.json(&b);
            }
            req
        }
        "PATCH" => {
            let mut req = client
                .patch(endpoint.to_string())
                .header("Authorization", auth_header);
            if let Some(b) = body {
                req = req.json(&b);
            }
            req
        }
        _ => client
            .get(endpoint.to_string())
            .header("Authorization", auth_header),
    };

    let response = request_builder.send().await?;
    let status = response.status();
    if !status.is_success() {
        let err_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(RemoteAccessError::UnparseableResponse(format!(
            "Plugin API error ({status}): {err_text}"
        )));
    }

    let json_val = response.json::<serde_json::Value>().await?;
    Ok(json_val)
}

/// Subscribe to a plugin WebSocket channel and emit each event as `plugin:event`.
///
/// The Tauri webview cannot reach the Drop server directly (TLS/auth), so the
/// Rust side owns the socket and forwards decoded JSON to the frontend.
#[tauri::command]
pub fn plugin_subscribe(app: AppHandle, channel: String) -> Result<(), RemoteAccessError> {
    let ws_url = generate_url(&["/api/v1/plugins/ws"], &[])?;
    let auth_header = generate_authorization_header();

    tauri::async_runtime::spawn(async move {
        let load = async || -> Result<(), RemoteAccessError> {
            let response = DROP_CLIENT_WS_CLIENT
                .get(ws_url)
                .header("Authorization", auth_header)
                .upgrade()
                .send()
                .await?;
            let mut websocket = response.into_websocket().await?;

            let subscribe = serde_json::json!({ "type": "subscribe", "channel": channel });
            websocket
                .send(Message::Text(subscribe.to_string()))
                .await
                .map_err(|e| RemoteAccessError::HandshakeFailed(e.to_string()))?;

            while let Some(message) = websocket.try_next().await? {
                if let Message::Text(text) = message
                    && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                {
                    app_emit!(&app, "plugin:event", value);
                }
            }
            Ok(())
        };

        if let Err(err) = load().await {
            warn!("plugin websocket for {channel} closed: {err}");
        }
    });

    Ok(())
}

/// Send one message to a plugin WebSocket channel and return its reply.
///
/// Used for authenticated request/response flows (e.g. credential delivery)
/// where the sandboxed webview cannot open a server WebSocket directly.
#[tauri::command]
pub async fn plugin_request_ws(
    channel: String,
    data: serde_json::Value,
) -> Result<serde_json::Value, RemoteAccessError> {
    let ws_url = generate_url(&["/api/v1/plugins/ws"], &[])?;
    let auth_header = generate_authorization_header();

    let response = DROP_CLIENT_WS_CLIENT
        .get(ws_url)
        .header("Authorization", auth_header)
        .upgrade()
        .send()
        .await?;
    let mut websocket = response.into_websocket().await?;

    let request = serde_json::json!({
        "type": "message",
        "channel": channel,
        "data": data,
    });
    websocket
        .send(Message::Text(request.to_string()))
        .await
        .map_err(|e| RemoteAccessError::HandshakeFailed(e.to_string()))?;

    while let Some(message) = websocket.try_next().await? {
        if let Message::Text(text) = message {
            let value: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| RemoteAccessError::UnparseableResponse(e.to_string()))?;
            return Ok(value.get("data").cloned().unwrap_or(value));
        }
    }

    Err(RemoteAccessError::HandshakeFailed(
        "plugin WebSocket closed before replying".to_string(),
    ))
}

/// Download and verify an emulator release into
/// `<dataDir>/tools/gse/<flavor>/`, where the launch interceptor picks it up.
///
/// `manifest_url` points at a `release.json`; payload files are fetched from
/// the same directory and each SHA-256 is verified before writing.
#[tauri::command]
pub async fn gse_fetch_release(manifest_url: String) -> Result<(), String> {
    use gse_engine::dist::{ReleaseSpec, fetch_release, is_trusted_manifest_url, url_origin};

    // Root of trust: only HTTPS origins named in DROP_GSE_RELEASE_ALLOWLIST may
    // supply a release manifest (loopback is allowed for development). Without
    // this, a manifest and its matching payloads could both be attacker-chosen.
    let allowlist_env = std::env::var("DROP_GSE_RELEASE_ALLOWLIST").unwrap_or_default();
    let allowlist: Vec<&str> = allowlist_env
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    if !is_trusted_manifest_url(&manifest_url, &allowlist) {
        return Err(format!(
            "refusing to fetch emulator release from '{manifest_url}': set \
             DROP_GSE_RELEASE_ALLOWLIST to the trusted host(s); only HTTPS origins \
             are accepted (localhost is always allowed)"
        ));
    }

    // The payload URLs are derived from the manifest, so pin them to the
    // manifest's origin. This prevents a compromised/allow-listed manifest from
    // pointing payloads at an attacker host, and rejects cross-origin
    // redirects (reqwest follows redirects by default).
    let trusted_origin = url_origin(&manifest_url)
        .ok_or_else(|| format!("invalid release manifest URL: {manifest_url}"))?;

    let client = DROP_CLIENT_WS_CLIENT.clone();
    let manifest_response = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if url_origin(manifest_response.url().as_str()).as_ref() != Some(&trusted_origin) {
        return Err("refusing release manifest that redirected off its origin".to_string());
    }
    let manifest_bytes = manifest_response.bytes().await.map_err(|e| e.to_string())?;
    let spec: ReleaseSpec = serde_json::from_slice(&manifest_bytes).map_err(|e| e.to_string())?;

    let base = Url::parse(&manifest_url)
        .map_err(|e| e.to_string())?
        .join(".")
        .map_err(|e| e.to_string())?;

    let mut payloads = std::collections::HashMap::new();
    for name in spec.files.keys() {
        let url = base.join(name).map_err(|e| e.to_string())?;
        if url_origin(url.as_str()).as_ref() != Some(&trusted_origin) {
            return Err(format!(
                "refusing release payload '{name}' outside the trusted origin"
            ));
        }
        let response = client.get(url).send().await.map_err(|e| e.to_string())?;
        if url_origin(response.url().as_str()).as_ref() != Some(&trusted_origin) {
            return Err(format!(
                "refusing release payload '{name}' that redirected off its origin"
            ));
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
        payloads.insert(name.clone(), bytes);
    }

    let flavor = match spec.flavor {
        gse_engine::EmulatorFlavor::GbeFork => "gbe_fork",
        gse_engine::EmulatorFlavor::GseFork => "gse_fork",
    };
    let dest = database::db::DATA_ROOT_DIR.join("tools/gse").join(flavor);
    fetch_release(
        &spec,
        |name| {
            payloads.get(name).cloned().ok_or_else(|| {
                gse_engine::EngineError::ScanFailed(format!(
                    "missing downloaded release file {name}"
                ))
            })
        },
        &dest,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn gse_write_room_config(
    install_dir: String,
    peer_ips: Vec<String>,
    app_id: Option<u32>,
    flavor: Option<String>,
) -> Result<(), String> {
    let path = std::path::Path::new(&install_dir);
    if !path.is_dir() {
        return Err("Game install directory does not exist".to_string());
    }

    // All writes are symlink-confined to the install directory so a release
    // cannot ship a `steam_settings` symlink that redirects them elsewhere.
    if let Err(e) = gse_engine::path_guard::ensure_dir(path, "steam_settings") {
        return Err(format!("Failed to create steam_settings dir: {e}"));
    }

    // Pin the room's AppID so the emulator namespaces lobbies correctly.
    if let Some(app_id) = app_id {
        gse_engine::path_guard::write_file(
            path,
            "steam_settings/steam_appid.txt",
            app_id.to_string().as_bytes(),
        )
        .map_err(|e| format!("Failed to write steam_appid.txt: {e}"))?;
    }

    // Record the emulator flavor so the launch interceptor stages the matching
    // payload (`tools/gse/<flavor>`) and PatchPlan. Unknown values default to
    // gbe_fork rather than being written verbatim.
    let flavor = match flavor.as_deref() {
        Some("gse_fork") => "gse_fork",
        _ => "gbe_fork",
    };
    gse_engine::path_guard::write_file(
        path,
        "steam_settings/drop_gse_flavor.txt",
        flavor.as_bytes(),
    )
    .map_err(|e| format!("Failed to write drop_gse_flavor.txt: {e}"))?;

    let content = if peer_ips.is_empty() {
        "127.0.0.1:47584\n".to_string()
    } else {
        let mut lines: Vec<String> = peer_ips
            .iter()
            .map(|ip| {
                if ip.contains(':') {
                    ip.to_string()
                } else {
                    format!("{ip}:47584")
                }
            })
            .collect();
        lines.push(String::new());
        lines.join("\n")
    };

    gse_engine::path_guard::write_file(
        path,
        "steam_settings/custom_broadcasts.txt",
        content.as_bytes(),
    )
    .map_err(|e| format!("Failed to write custom_broadcasts.txt: {e}"))?;
    Ok(())
}
