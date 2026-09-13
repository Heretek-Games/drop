use std::{sync::Arc, time::Duration};

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
    sync::Mutex,
    time,
};
use waitmap::WaitMap;

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
    waitmap: WaitMap<String, TorrentialBound>,
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
                myself.waitmap.insert(message.message_id.clone(), message);
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
                    match myself.server.accept().await {
                        Ok((drop_stream, _)) => break drop_stream.into_split(),
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
        let message = time::timeout(RPC_RESPONSE_TIMEOUT, self.waitmap.wait(message_id))
            .await
            .map_err(|_| anyhow!("timed out waiting for RPC response"))?
            .ok_or(anyhow!("no response returned for value"))?;

        let message = message.value();

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
    let server = TcpListener::bind("127.0.0.1:33148").await?;

    let (drop_stream, _) = server.accept().await?;

    let (read, write) = drop_stream.into_split();

    let client = Arc::new(DropServer {
        server,
        write_stream: Mutex::new(write),
        waitmap: WaitMap::new(),
    });

    spawn(DropServer::recieve_subroutine(client.clone(), read));

    info!("created client subroutine");

    Ok(client)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn frame_length_validation() {
        assert!(validate_frame_length(0).is_err());
        assert!(validate_frame_length(MAX_FRAME_BYTES + 1).is_err());
        assert_eq!(validate_frame_length(8).unwrap(), 8);
    }
}
