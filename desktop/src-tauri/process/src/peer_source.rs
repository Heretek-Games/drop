//! Frozen Track A <-> Track B contract.
//!
//! Track A (GSE for games) patches the emulator and writes peer addresses into
//! `custom_broadcasts.txt`. Track B (LAN emulation) is the mesh that produces
//! those addresses. An empty `peers` list is valid and means LAN/offline
//! emulator mode with no mesh.

/// Mesh backends a room can be provisioned on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshBackend {
    Tailscale,
    ZeroTier,
    /// Bring-your-own / persistent network.
    Byo,
}

/// A room currently joined by this client.
#[derive(Debug, Clone)]
pub struct ActiveRoom {
    pub room_id: String,
    pub backend: MeshBackend,
    /// Mesh peer addresses, written into `custom_broadcasts.txt`.
    pub peers: Vec<String>,
    /// This node's address inside the room mesh, when known.
    pub self_address: Option<String>,
    pub credential_expires_at: u64,
}

/// Supplies the active room (if any) to the launch engine.
pub trait PeerSource: Send + Sync {
    fn get_active_room(&self) -> Option<ActiveRoom>;
}
