//! LAN peer-to-peer chunk streaming contract (Phase 1, #17).
//!
//! Discovery and transport are pluggable: the depot server keeps a registry of
//! recently-seen LAN peers and the download manager can prefer a nearby peer
//! over the origin for chunk fetches. The mDNS/SSDP discovery backend and the
//! QUIC/HTTP transport are separate integrations; this module fixes the
//! selection + expiry behaviour both must agree on.

pub mod ssdp;

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// A peer that advertises the same depot content on the local network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanPeer {
    pub peer_id: String,
    pub address: SocketAddr,
    /// Round-trip estimate in milliseconds; lower is better.
    pub rtt_ms: u32,
    /// Observed throughput in KiB/s; higher is better.
    pub throughput_kibps: u32,
}

/// Discovers LAN peers that host the requested content.
pub trait PeerDiscovery: Send + Sync {
    fn discover(&self, content_id: &str) -> Vec<LanPeer>;
}

#[derive(Debug, Clone)]
struct TrackedPeer {
    peer: LanPeer,
    last_seen: Instant,
}

/// Keeps LAN peers fresh and evicts ones that stopped announcing.
#[derive(Debug)]
pub struct LanPeerRegistry {
    ttl: Duration,
    peers: Vec<TrackedPeer>,
}

impl LanPeerRegistry {
    #[must_use]
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            peers: Vec::new(),
        }
    }

    pub fn observe(&mut self, peer: LanPeer, now: Instant) {
        if let Some(existing) = self
            .peers
            .iter_mut()
            .find(|tracked| tracked.peer.peer_id == peer.peer_id)
        {
            existing.peer = peer;
            existing.last_seen = now;
        } else {
            self.peers.push(TrackedPeer {
                peer,
                last_seen: now,
            });
        }
    }

    pub fn evict_expired(&mut self, now: Instant) {
        self.peers
            .retain(|tracked| now.duration_since(tracked.last_seen) <= self.ttl);
    }

    #[must_use]
    pub fn live(&self, now: Instant) -> Vec<LanPeer> {
        self.peers
            .iter()
            .filter(|tracked| now.duration_since(tracked.last_seen) <= self.ttl)
            .map(|tracked| tracked.peer.clone())
            .collect()
    }

    /// Best peer by a weighted score of low latency and high throughput.
    #[must_use]
    pub fn best(&self, now: Instant) -> Option<LanPeer> {
        self.live(now).into_iter().max_by_key(peer_score)
    }
}

/// Scores a peer; higher is better. Latency dominates, throughput breaks ties.
#[must_use]
pub fn peer_score(peer: &LanPeer) -> u64 {
    let latency = u64::from(10_000u32.saturating_sub(peer.rtt_ms.min(10_000)));
    let throughput = u64::from(peer.throughput_kibps).min(999_999);
    latency * 1_000_000 + throughput
}

/// Fetches a chunk from a LAN peer (HTTP/QUIC transport is injected).
pub trait ChunkFetcher: Send + Sync {
    /// Returns the raw chunk bytes, or an error string on failure.
    ///
    /// # Errors
    /// Transport-specific failure described as a string.
    fn fetch(&self, peer: &LanPeer, content_id: &str, chunk_index: u64) -> Result<Vec<u8>, String>;
}

/// Selects the best live peer and fetches a chunk through `fetcher`. Returns
/// `None` when no live peer is available.
pub fn fetch_from_best_peer<F: ChunkFetcher>(
    registry: &LanPeerRegistry,
    now: Instant,
    fetcher: &F,
    content_id: &str,
    chunk_index: u64,
) -> Option<Result<Vec<u8>, String>> {
    let peer = registry.best(now)?;
    Some(fetcher.fetch(&peer, content_id, chunk_index))
}

/// Verify that `bytes` hash to `expected_hex` (a lowercase/uppercase 64-char
/// SHA-256 digest).
///
/// This is the integrity check a client must run **before committing** a
/// peer-fetched chunk to disk: LAN peers are untrusted, so bytes are only ever
/// trusted after they match the checksum from the local droplet manifest.
///
/// # Errors
/// Returns an error string when the expected digest is malformed or the bytes
/// do not match it.
pub fn verify_chunk_sha256(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    let expected = expected_hex.trim();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("invalid expected checksum '{expected_hex}'"));
    }
    let digest = to_hex(Sha256::digest(bytes).as_slice());
    if digest.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "chunk checksum mismatch: expected {expected}, got {digest}"
        ))
    }
}

/// Fetch a chunk from the best live peer and only return it once its SHA-256
/// matches the manifest checksum. Returns `None` when no live peer exists.
pub fn fetch_verified_from_best_peer<F: ChunkFetcher>(
    registry: &LanPeerRegistry,
    now: Instant,
    fetcher: &F,
    content_id: &str,
    chunk_index: u64,
    expected_sha256_hex: &str,
) -> Option<Result<Vec<u8>, String>> {
    Some(
        fetch_from_best_peer(registry, now, fetcher, content_id, chunk_index)?
            .and_then(|bytes| verify_chunk_sha256(&bytes, expected_sha256_hex).map(|()| bytes)),
    )
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// The client-to-client HTTP URL for a chunk on a LAN peer.
#[must_use]
pub fn chunk_url(peer: &LanPeer, content_id: &str, chunk_index: u64) -> String {
    format!(
        "http://{}/depot/{}/chunks/{}",
        peer.address, content_id, chunk_index
    )
}

/// HTTP client-to-client chunk fetcher. QUIC can be added as another
/// `ChunkFetcher` without changing the registry or selection logic.
#[derive(Debug, Default, Clone)]
pub struct HttpChunkFetcher;

impl ChunkFetcher for HttpChunkFetcher {
    fn fetch(&self, peer: &LanPeer, content_id: &str, chunk_index: u64) -> Result<Vec<u8>, String> {
        let response = reqwest::blocking::Client::new()
            .get(chunk_url(peer, content_id, chunk_index))
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("peer returned {}", response.status()));
        }
        response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_client_to_client_chunk_url() {
        let peer = LanPeer {
            peer_id: "p".to_string(),
            address: SocketAddr::from(([192, 168, 1, 5], 8080)),
            rtt_ms: 1,
            throughput_kibps: 1,
        };
        assert_eq!(
            chunk_url(&peer, "depot-abc", 7),
            "http://192.168.1.5:8080/depot/depot-abc/chunks/7"
        );
    }

    #[test]
    fn fetches_a_chunk_from_the_best_peer() {
        struct RecordingFetcher {
            seen: std::sync::Mutex<Vec<String>>,
        }
        impl ChunkFetcher for RecordingFetcher {
            fn fetch(
                &self,
                peer: &LanPeer,
                content_id: &str,
                chunk_index: u64,
            ) -> Result<Vec<u8>, String> {
                if let Ok(mut seen) = self.seen.lock() {
                    seen.push(peer.peer_id.clone());
                }
                Ok(format!("{content_id}:{chunk_index}").into_bytes())
            }
        }

        let mut registry = LanPeerRegistry::new(Duration::from_secs(30));
        let now = Instant::now();
        registry.observe(peer("slow", 50, 100), now);
        registry.observe(peer("fast", 2, 100), now);

        let fetcher = RecordingFetcher {
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let result = fetch_from_best_peer(&registry, now, &fetcher, "depot", 3);
        let Some(Ok(bytes)) = result else {
            panic!("expected a successful fetch");
        };
        assert_eq!(bytes, b"depot:3");
        assert_eq!(
            fetcher.seen.lock().map(|seen| seen.clone()).ok(),
            Some(vec!["fast".to_string()])
        );
    }

    #[test]
    fn no_live_peer_yields_none() {
        struct NeverFetcher;
        impl ChunkFetcher for NeverFetcher {
            fn fetch(
                &self,
                _peer: &LanPeer,
                _content_id: &str,
                _chunk_index: u64,
            ) -> Result<Vec<u8>, String> {
                Err("should not be called".to_string())
            }
        }
        let registry = LanPeerRegistry::new(Duration::from_secs(1));
        assert!(
            fetch_from_best_peer(&registry, Instant::now(), &NeverFetcher, "depot", 0).is_none()
        );
    }

    #[test]
    fn verifies_matching_chunk_checksums() {
        let digest = to_hex(Sha256::digest(b"hello").as_slice());
        assert!(verify_chunk_sha256(b"hello", &digest).is_ok());
        assert!(verify_chunk_sha256(b"hello", &digest.to_uppercase()).is_ok());
        assert!(verify_chunk_sha256(b"hello", "not-a-valid-checksum").is_err());
        assert!(verify_chunk_sha256(b"world", &digest).is_err());
    }

    #[test]
    fn rejects_a_chunk_that_does_not_match_the_manifest_checksum() {
        struct FixedFetcher(Vec<u8>);
        impl ChunkFetcher for FixedFetcher {
            fn fetch(
                &self,
                _peer: &LanPeer,
                _content_id: &str,
                _chunk_index: u64,
            ) -> Result<Vec<u8>, String> {
                Ok(self.0.clone())
            }
        }

        let mut registry = LanPeerRegistry::new(Duration::from_secs(30));
        let now = Instant::now();
        registry.observe(peer("fast", 1, 100), now);

        let good = b"trusted-bytes".to_vec();
        let digest = to_hex(Sha256::digest(&good).as_slice());

        let accepted = fetch_verified_from_best_peer(
            &registry,
            now,
            &FixedFetcher(good.clone()),
            "depot",
            0,
            &digest,
        );
        assert_eq!(accepted, Some(Ok(good)));

        let tampered = fetch_verified_from_best_peer(
            &registry,
            now,
            &FixedFetcher(b"evil-bytes".to_vec()),
            "depot",
            0,
            &digest,
        );
        assert!(matches!(tampered, Some(Err(_))));
    }

    fn peer(id: &str, rtt: u32, kibps: u32) -> LanPeer {
        LanPeer {
            peer_id: id.to_string(),
            address: SocketAddr::from(([127, 0, 0, 1], 9000)),
            rtt_ms: rtt,
            throughput_kibps: kibps,
        }
    }

    #[test]
    fn prefers_lower_latency() {
        let fast = peer("fast", 2, 100);
        let slow = peer("slow", 40, 100_000);
        assert!(peer_score(&fast) > peer_score(&slow));
    }

    #[test]
    fn evicts_peers_past_ttl() {
        let ttl = Duration::from_secs(5);
        let mut registry = LanPeerRegistry::new(ttl);
        let start = Instant::now();
        registry.observe(peer("a", 5, 100), start);

        let later = start + Duration::from_secs(6);
        assert_eq!(registry.live(later).len(), 0);
        registry.evict_expired(later);
        assert!(registry.best(later).is_none());
    }

    #[test]
    fn picks_the_best_peer_and_deduplicates_by_id() {
        let mut registry = LanPeerRegistry::new(Duration::from_secs(10));
        let now = Instant::now();
        registry.observe(peer("a", 30, 500), now);
        registry.observe(peer("b", 4, 500), now);
        registry.observe(peer("a", 3, 500), now);

        assert_eq!(registry.live(now).len(), 2);
        assert_eq!(
            registry.best(now).map(|best| best.peer_id),
            Some("a".to_string())
        );
    }
}
