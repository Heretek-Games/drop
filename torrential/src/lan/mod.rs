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

#[cfg(test)]
mod tests {
    use super::*;

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
