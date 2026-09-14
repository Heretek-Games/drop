//! SSDP discovery backend for LAN depot peers.
//!
//! Drop depot servers announce themselves over SSDP; a downloading client
//! sends an `M-SEARCH` and collects `HTTP/1.1 200 OK` responses. The parsing
//! and message construction are pure and unit-tested; the socket loop is
//! exercised against a loopback responder in tests.

use std::io;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use super::LanPeer;

/// A parsed SSDP response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsdpAnnouncement {
    pub location: String,
    pub usn: String,
    pub server: Option<String>,
}

/// Builds an `M-SEARCH` datagram for a search target (e.g. `urn:drop:depot`).
#[must_use]
pub fn build_m_search(search_target: &str, mx: u8) -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\n\
         HOST: 239.255.255.250:1900\r\n\
         MAN: \"ssdp:discover\"\r\n\
         MX: {mx}\r\n\
         ST: {search_target}\r\n\
         \r\n"
    )
}

/// Parses an SSDP response datagram, returning `None` for non-response lines or
/// announcements without a `LOCATION`.
#[must_use]
pub fn parse_ssdp_response(message: &str) -> Option<SsdpAnnouncement> {
    let mut is_response = false;
    let mut location = None;
    let mut usn = None;
    let mut server = None;

    for (index, raw_line) in message.lines().enumerate() {
        let line = raw_line.trim();
        if index == 0 {
            is_response = line.to_ascii_uppercase().starts_with("HTTP/1.1 200");
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_string();
        match name.trim().to_ascii_uppercase().as_str() {
            "LOCATION" => location = Some(value),
            "USN" => usn = Some(value),
            "SERVER" => server = Some(value),
            _ => {}
        }
    }

    if !is_response {
        return None;
    }

    Some(SsdpAnnouncement {
        location: location?,
        usn: usn.unwrap_or_default(),
        server,
    })
}

/// Extracts a `host:port` peer address from an SSDP `LOCATION` URL.
#[must_use]
pub fn peer_address_from_location(location: &str) -> Option<SocketAddr> {
    let without_scheme = location
        .strip_prefix("http://")
        .or_else(|| location.strip_prefix("https://"))
        .unwrap_or(location);
    let authority = without_scheme.split('/').next()?;
    let authority = authority.rsplit('@').next()?;
    authority.parse().ok()
}

/// Converts an announcement into a [`LanPeer`], using the location host/port.
#[must_use]
pub fn announcement_to_peer(announcement: &SsdpAnnouncement) -> Option<LanPeer> {
    Some(LanPeer {
        peer_id: announcement.usn.clone(),
        address: peer_address_from_location(&announcement.location)?,
        rtt_ms: 0,
        throughput_kibps: 0,
    })
}

/// Blocking SSDP searcher. `bind` is normally `0.0.0.0:0`; tests point `target`
/// at a loopback responder.
pub struct SsdpDiscovery {
    bind: SocketAddr,
    target: SocketAddr,
    search_target: String,
    timeout: Duration,
}

impl SsdpDiscovery {
    #[must_use]
    pub fn new(
        bind: SocketAddr,
        target: SocketAddr,
        search_target: &str,
        timeout: Duration,
    ) -> Self {
        Self {
            bind,
            target,
            search_target: search_target.to_string(),
            timeout,
        }
    }

    /// Sends an `M-SEARCH` and collects responses until the timeout elapses.
    ///
    /// # Errors
    /// Returns an I/O error if the socket cannot be bound or read.
    pub fn search(&self) -> io::Result<Vec<SsdpAnnouncement>> {
        let socket = UdpSocket::bind(self.bind)?;
        socket.set_read_timeout(Some(self.timeout))?;
        socket.send_to(
            build_m_search(&self.search_target, 2).as_bytes(),
            self.target,
        )?;

        let mut announcements = Vec::new();
        let deadline = Instant::now() + self.timeout;
        let mut buffer = [0u8; 2048];
        while Instant::now() < deadline {
            match socket.recv_from(&mut buffer) {
                Ok((size, _)) => {
                    let text = String::from_utf8_lossy(&buffer[..size]);
                    if let Some(announcement) = parse_ssdp_response(&text) {
                        announcements.push(announcement);
                    }
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::TimedOut =>
                {
                    break;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(announcements)
    }

    /// Discovered peers, ready for the LAN registry.
    ///
    /// # Errors
    /// Returns an I/O error if the underlying SSDP search fails.
    pub fn discover_peers(&self) -> io::Result<Vec<LanPeer>> {
        Ok(self
            .search()?
            .iter()
            .filter_map(announcement_to_peer)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESPONSE: &str = "HTTP/1.1 200 OK\r\n\
        CACHE-CONTROL: max-age=1800\r\n\
        LOCATION: http://192.168.1.50:8080/depot\r\n\
        SERVER: Drop/0.4 UPnP/1.0\r\n\
        ST: urn:drop:depot\r\n\
        USN: uuid:drop-abc::urn:drop:depot\r\n\r\n";

    #[test]
    fn parses_an_ssdp_response() {
        let Some(announcement) = parse_ssdp_response(RESPONSE) else {
            panic!("response should parse");
        };
        assert_eq!(announcement.location, "http://192.168.1.50:8080/depot");
        assert_eq!(announcement.usn, "uuid:drop-abc::urn:drop:depot");
        assert_eq!(announcement.server.as_deref(), Some("Drop/0.4 UPnP/1.0"));
    }

    #[test]
    fn rejects_non_responses_and_missing_location() {
        assert!(parse_ssdp_response("NOTIFY * HTTP/1.1\r\nLOCATION: x\r\n").is_none());
        assert!(parse_ssdp_response("HTTP/1.1 200 OK\r\nUSN: x\r\n").is_none());
    }

    #[test]
    fn builds_an_m_search_datagram() {
        let datagram = build_m_search("urn:drop:depot", 2);
        assert!(datagram.starts_with("M-SEARCH * HTTP/1.1"));
        assert!(datagram.contains("ST: urn:drop:depot"));
        assert!(datagram.contains("MAN: \"ssdp:discover\""));
    }

    #[test]
    fn extracts_peer_addresses_from_locations() {
        assert_eq!(
            peer_address_from_location("http://192.168.1.50:8080/depot"),
            Some(SocketAddr::from(([192, 168, 1, 50], 8080)))
        );
        assert_eq!(
            peer_address_from_location("http://user@10.0.0.2:9000/x"),
            Some(SocketAddr::from(([10, 0, 0, 2], 9000)))
        );
        assert!(peer_address_from_location("not a url").is_none());
    }

    #[test]
    fn discovers_a_loopback_responder() {
        let Ok(responder) = UdpSocket::bind("127.0.0.1:0") else {
            panic!("bind responder");
        };
        let Ok(responder_addr) = responder.local_addr() else {
            panic!("responder address");
        };

        let handle = std::thread::spawn(move || {
            let mut buffer = [0u8; 1024];
            if let Ok((_, from)) = responder.recv_from(&mut buffer) {
                let _ = responder.send_to(RESPONSE.as_bytes(), from);
            }
        });

        let discovery = SsdpDiscovery::new(
            SocketAddr::from(([127, 0, 0, 1], 0)),
            responder_addr,
            "urn:drop:depot",
            Duration::from_millis(500),
        );

        let Ok(announcements) = discovery.search() else {
            panic!("search should succeed");
        };
        handle.join().ok();

        assert_eq!(announcements.len(), 1);
        assert_eq!(
            announcement_to_peer(&announcements[0]).map(|peer| peer.address),
            Some(SocketAddr::from(([192, 168, 1, 50], 8080)))
        );
    }
}
