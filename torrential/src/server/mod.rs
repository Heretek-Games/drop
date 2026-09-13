use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::anyhow;
use log::{info, warn};
use protobuf::{EnumOrUnknown, Message};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt as _, BufReader},
    net::{
        TcpListener,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
    },
    spawn,
    sync::{Mutex, oneshot},
    time,
};

use crate::{
    droplet::{
        backend::{has_backend_rpc, list_files_rpc, peek_file_rpc},
        call_rpc,
        cert::{generate_client_cert_rpc, generate_root_ca_rpc},
        manifest::generate_manifest_rpc,
    },
    proto::core::{DropBound, DropBoundType, TorrentialBound, TorrentialBoundType},
};

pub mod download;

/// Maximum size of a single length-prefixed RPC frame. Guards against a
/// desynchronized or hostile peer driving an unbounded allocation.
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// How long to wait for the Drop server to answer a query before giving up.
const RPC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Delay before retrying to accept a new connection after the RPC link drops.
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// Maximum time a peer has to present the shared secret before being dropped.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Length of the spawn-time RPC shared secret in bytes (64 hex characters).
const RPC_SECRET_BYTES: usize = 32;

/// Maximum number of buffered responses retained when no waiter has registered
/// yet. Bounds memory if a peer floods frames that are never consumed.
const MAX_PENDING_RESPONSES: usize = 1024;

/// Error type used by the RPC listener.
type RpcResult<T> = Result<T, anyhow::Error>;

/// Decodes a lowercase/uppercase hex string into bytes.
fn hex_decode(input: &str) -> Option<Vec<u8>> {
    if input.is_empty() || !input.len().is_multiple_of(2) {
        return None;
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        let high = (bytes[index] as char).to_digit(16)?;
        let low = (bytes[index + 1] as char).to_digit(16)?;
        out.push(u8::try_from(high * 16 + low).ok()?);
        index += 2;
    }
    Some(out)
}

/// Reads the spawn-time shared secret. The listener fails closed without it:
/// an unauthenticated local process could otherwise answer `VERSION_QUERY` and
/// make torrential serve arbitrary files.
fn read_rpc_secret() -> RpcResult<[u8; RPC_SECRET_BYTES]> {
    let raw = std::env::var("TORRENTIAL_RPC_SECRET").map_err(|_| {
        anyhow!("TORRENTIAL_RPC_SECRET is required; refusing unauthenticated RPC peers")
    })?;
    let decoded = hex_decode(raw.trim())
        .ok_or_else(|| anyhow!("TORRENTIAL_RPC_SECRET must be a hex string"))?;
    if decoded.len() != RPC_SECRET_BYTES {
        return Err(anyhow!(
            "TORRENTIAL_RPC_SECRET must be {RPC_SECRET_BYTES} bytes ({} hex characters)",
            RPC_SECRET_BYTES * 2
        ));
    }
    let mut secret = [0u8; RPC_SECRET_BYTES];
    secret.copy_from_slice(&decoded);
    Ok(secret)
}

/// Constant-time-ish comparison of two secrets (no early return on mismatch).
fn secrets_match(presented: &[u8], expected: &[u8]) -> bool {
    if presented.len() != expected.len() {
        return false;
    }
    presented
        .iter()
        .zip(expected)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Accepts the next connection that proves knowledge of the shared secret,
/// dropping unauthenticated peers.
async fn accept_authenticated(
    server: &TcpListener,
    secret: &[u8; RPC_SECRET_BYTES],
) -> RpcResult<(OwnedReadHalf, OwnedWriteHalf)> {
    loop {
        let (mut stream, _) = server.accept().await?;
        let mut presented = [0u8; RPC_SECRET_BYTES];
        match time::timeout(HANDSHAKE_TIMEOUT, stream.read_exact(&mut presented)).await {
            Ok(Ok(_)) if secrets_match(&presented, secret) => {
                return Ok(stream.into_split());
            }
            Ok(Ok(_)) => warn!("rejecting torrential RPC peer: bad shared secret"),
            Ok(Err(err)) => warn!("rejecting torrential RPC peer: handshake failed: {err}"),
            Err(_) => warn!("rejecting torrential RPC peer: handshake timed out"),
        }
    }
}

/// Removable response map.
///
/// Entries are removed when a waiter consumes them and when a waiter times out,
/// so a long-lived process cannot leak one entry per RPC round trip the way a
/// write-once map does.
#[derive(Default)]
struct PendingResponses {
    entries: Mutex<HashMap<String, PendingEntry>>,
}

enum PendingEntry {
    Waiting(oneshot::Sender<TorrentialBound>),
    Ready(TorrentialBound),
}

impl PendingResponses {
    async fn wait(&self, message_id: &str) -> Option<TorrentialBound> {
        let receiver = {
            let mut entries = self.entries.lock().await;
            if let Some(PendingEntry::Ready(message)) = entries.remove(message_id) {
                return Some(message);
            }
            let (sender, receiver) = oneshot::channel();
            entries.insert(message_id.to_string(), PendingEntry::Waiting(sender));
            receiver
        };

        if let Ok(Ok(message)) = time::timeout(RPC_RESPONSE_TIMEOUT, receiver).await {
            Some(message)
        } else {
            // Timed out or the sender was dropped: evict the stale waiter.
            self.entries.lock().await.remove(message_id);
            None
        }
    }

    async fn dispatch(&self, message_id: String, message: TorrentialBound) {
        let mut entries = self.entries.lock().await;
        match entries.remove(&message_id) {
            Some(PendingEntry::Waiting(sender)) => {
                let _ = sender.send(message);
            }
            _ => {
                if entries.len() < MAX_PENDING_RESPONSES {
                    entries.insert(message_id, PendingEntry::Ready(message));
                } else {
                    warn!("dropping RPC response: pending response map is full");
                }
            }
        }
    }
}

/// Validates the declared payload length of an RPC frame.
///
/// # Errors
///
/// Returns an error for empty or oversized frames, which indicate a
/// desynchronized or hostile peer.
fn validate_frame_length(length: usize) -> Result<usize, anyhow::Error> {
    if length == 0 || length > MAX_FRAME_BYTES {
        Err(anyhow!(
            "invalid RPC frame length {length} (maximum {MAX_FRAME_BYTES})"
        ))
    } else {
        Ok(length)
    }
}

macro_rules! spawn_rpc {
    ($myself:ident, $message:ident, $func_name:ident) => {
        spawn(async move { call_rpc($myself.clone(), $message, $func_name).await });
    };
}

pub struct DropServer {
    server: TcpListener,
    write_stream: Mutex<OwnedWriteHalf>,
    pending: PendingResponses,
    rpc_secret: [u8; RPC_SECRET_BYTES],
}

impl DropServer {
    /**
    Reads from the socket, and tries to parse it into a message,
    and then updates the waitmap with the corresponding message ID
    and content
    */
    async fn recieve_loop(
        myself: Arc<DropServer>,
        buffered_reader: &mut BufReader<OwnedReadHalf>,
    ) -> Result<(), anyhow::Error> {
        let mut length_buffer: [u8; 8] = [0; 8];
        buffered_reader.read_exact(&mut length_buffer).await?;

        let length = validate_frame_length(usize::from_le_bytes(length_buffer))?;
        let mut buffer = vec![0; length];

        buffered_reader.read_exact(&mut buffer).await?;

        let message = match TorrentialBound::parse_from_bytes(&buffer) {
            Ok(message) => message,
            Err(err) => {
                warn!("dropping malformed RPC frame: {err}");
                return Ok(());
            }
        };

        let Ok(message_type) = message.type_.enum_value() else {
            warn!("dropping RPC frame with an unknown message type");
            return Ok(());
        };

        match message_type {
            TorrentialBoundType::GENERATE_MANIFEST => {
                spawn_rpc!(myself, message, generate_manifest_rpc);
            }
            TorrentialBoundType::GENERATE_ROOT_CA => {
                spawn_rpc!(myself, message, generate_root_ca_rpc);
            }
            TorrentialBoundType::GENERATE_CLIENT_CERT => {
                spawn_rpc!(myself, message, generate_client_cert_rpc);
            }
            TorrentialBoundType::LIST_FILES_QUERY => {
                spawn_rpc!(myself, message, list_files_rpc);
            }
            TorrentialBoundType::HAS_BACKEND_QUERY => {
                spawn_rpc!(myself, message, has_backend_rpc);
            }
            TorrentialBoundType::PEEK_FILE_QUERY => {
                spawn_rpc!(myself, message, peek_file_rpc);
            }
            _ => {
                myself
                    .pending
                    .dispatch(message.message_id.clone(), message)
                    .await;
            }
        }

        Ok(())
    }

    /**
    Long-lived subroutine that never returns, runs the `recieve_loop` and reconnects
    as necessary
    */
    async fn recieve_subroutine(myself: Arc<DropServer>, read_stream: OwnedReadHalf) -> ! {
        let mut buffered_reader = BufReader::new(read_stream);

        loop {
            if let Err(err) = Self::recieve_loop(myself.clone(), &mut buffered_reader).await {
                warn!("RPC connection error: {err:?}");

                let (read, write) = loop {
                    match accept_authenticated(&myself.server, &myself.rpc_secret).await {
                        Ok(streams) => break streams,
                        Err(err) => {
                            warn!("failed to accept reconnection: {err}");
                            time::sleep(RECONNECT_DELAY).await;
                        }
                    }
                };

                info!("reconnected to drop server");

                let mut lock = myself.write_stream.lock().await;
                *lock = write;

                buffered_reader = BufReader::new(read);
            }
        }
    }

    /**
    Uses the waitmap to wait for a response from a query

    # Errors

    Returns an error when the response does not arrive within
    [`RPC_RESPONSE_TIMEOUT`], the server reports an error, or the payload cannot
    be parsed.
    */
    pub async fn wait_for_message_id<T>(&self, message_id: &str) -> Result<T, anyhow::Error>
    where
        T: protobuf::Message,
    {
        let message = self
            .pending
            .wait(message_id)
            .await
            .ok_or_else(|| anyhow!("timed out waiting for RPC response"))?;

        if message.type_.enum_value() == Ok(TorrentialBoundType::ERROR) {
            Err(anyhow!(String::from_utf8_lossy(&message.data).into_owned()))
        } else {
            let response = T::parse_from_bytes(&message.data)?;
            Ok(response)
        }
    }

    /**
    Sends a message, returning the message ID

    # Errors

    Returns an error when the message cannot be serialized or written to the
    socket.
    */
    pub async fn send_message<T>(
        &self,
        message_type: DropBoundType,
        message: T,
        message_id: Option<String>,
    ) -> Result<String, anyhow::Error>
    where
        T: protobuf::Message,
    {
        let mut query = DropBound::new();
        query.message_id = message_id.unwrap_or(uuid::Uuid::new_v4().to_string());
        query.type_ = EnumOrUnknown::new(message_type);
        query.data = Vec::new();
        message.write_to_vec(&mut query.data)?;

        let mut buf = Vec::new();
        query.write_to_vec(&mut buf)?;

        {
            let mut mutex_lock = self.write_stream.lock().await;
            mutex_lock.write_all(&buf.len().to_le_bytes()).await?;
            mutex_lock.write_all(&buf).await?;
        };

        Ok(query.message_id)
    }
}

/**
Spins up the TCP listener, and waits for the first client to connect
Also starts the recieve subroutine

# Errors

Returns an error when the listener cannot be bound or the first client cannot
be accepted.
*/
pub async fn create_drop_server() -> Result<Arc<DropServer>, anyhow::Error> {
    let rpc_secret = read_rpc_secret()?;
    let server = TcpListener::bind("127.0.0.1:33148").await?;

    let (read, write) = accept_authenticated(&server, &rpc_secret).await?;

    let client = Arc::new(DropServer {
        server,
        write_stream: Mutex::new(write),
        pending: PendingResponses::default(),
        rpc_secret,
    });

    spawn(DropServer::recieve_subroutine(client.clone(), read));

    info!("created client subroutine");

    Ok(client)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn frame_length_validation() {
        assert!(validate_frame_length(0).is_err());
        assert!(validate_frame_length(MAX_FRAME_BYTES + 1).is_err());
        assert_eq!(validate_frame_length(8).unwrap(), 8);
    }

    #[test]
    fn hex_secret_decoding_is_strict() {
        assert_eq!(hex_decode("00ff"), Some(vec![0, 255]));
        assert_eq!(hex_decode("abc"), None);
        assert_eq!(hex_decode("zz"), None);
        assert_eq!(hex_decode(""), None);
    }

    #[test]
    fn secrets_match_requires_exact_equality() {
        let secret = [7u8; RPC_SECRET_BYTES];
        assert!(secrets_match(&secret, &secret));
        let mut other = secret;
        other[0] ^= 1;
        assert!(!secrets_match(&other, &secret));
        assert!(!secrets_match(&secret[..RPC_SECRET_BYTES - 1], &secret));
    }

    #[tokio::test]
    async fn pending_responses_are_evicted_on_consume() {
        let pending = PendingResponses::default();
        let (sender, receiver) = oneshot::channel();
        pending
            .entries
            .lock()
            .await
            .insert("r1".to_string(), PendingEntry::Waiting(sender));

        let mut message = TorrentialBound::new();
        message.message_id = "r1".to_string();
        pending.dispatch("r1".to_string(), message).await;

        let delivered = receiver.await.expect("response delivered");
        assert_eq!(delivered.message_id, "r1");
        assert!(pending.entries.lock().await.is_empty());
    }

    #[tokio::test]
    async fn pending_responses_buffer_until_a_waiter_arrives() {
        let pending = PendingResponses::default();
        let mut message = TorrentialBound::new();
        message.message_id = "r2".to_string();
        pending.dispatch("r2".to_string(), message).await;

        let delivered = pending.wait("r2").await.expect("buffered response");
        assert_eq!(delivered.message_id, "r2");
        assert!(pending.entries.lock().await.is_empty());
    }
}
