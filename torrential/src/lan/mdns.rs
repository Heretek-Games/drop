//! mDNS discovery backend for LAN depot peers.
//!
//! Companion to [`super::ssdp`]. Drop depot servers advertise
//! `_drop-depot._tcp.local`; a client sends a multicast DNS query and resolves
//! SRV + A/AAAA answers into [`LanPeer`]s. Message construction and parsing are
//! pure so they can be exercised with crafted packets; the socket loop is
//! tested against a loopback responder.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use super::LanPeer;

/// Standard mDNS multicast group.
pub const MDNS_MULTICAST: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(224, 0, 0, 251)), 5353);

/// Default service advertised by depot servers.
pub const DEPOT_SERVICE: &str = "_drop-depot._tcp.local";

const TYPE_A: u16 = 1;
const TYPE_PTR: u16 = 12;
const TYPE_TXT: u16 = 16;
const TYPE_AAAA: u16 = 28;
const TYPE_SRV: u16 = 33;
const CLASS_IN: u16 = 1;
const MAX_POINTER_HOPS: usize = 128;

/// A parsed resource record from an mDNS response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MdnsRecord {
    Ptr {
        name: String,
        target: String,
    },
    Srv {
        name: String,
        port: u16,
        target: String,
    },
    A {
        name: String,
        address: Ipv4Addr,
    },
    Aaaa {
        name: String,
        address: Ipv6Addr,
    },
    Txt {
        name: String,
        values: Vec<String>,
    },
    Other {
        name: String,
        record_type: u16,
    },
}

/// DNS names are case-insensitive; normalize by lowercasing and dropping the
/// trailing root dot.
#[must_use]
pub fn normalize_name(name: &str) -> String {
    name.trim_end_matches('.').to_ascii_lowercase()
}

/// Encode a dotted DNS name as length-prefixed labels terminated by a root dot.
#[must_use]
pub fn encode_name(name: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for label in name.split('.').filter(|label| !label.is_empty()) {
        let bytes = label.as_bytes();
        let len = bytes.len().min(63);
        out.push(u8::try_from(len).unwrap_or(63));
        out.extend_from_slice(&bytes[..len]);
    }
    out.push(0);
    out
}

/// Build a standard mDNS query for a service (PTR record).
#[must_use]
pub fn build_query(service: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_be_bytes()); // id 0
    out.extend_from_slice(&0u16.to_be_bytes()); // flags: standard query
    out.extend_from_slice(&1u16.to_be_bytes()); // qdcount
    out.extend_from_slice(&0u16.to_be_bytes()); // ancount
    out.extend_from_slice(&0u16.to_be_bytes()); // nscount
    out.extend_from_slice(&0u16.to_be_bytes()); // arcount
    out.extend_from_slice(&encode_name(service));
    out.extend_from_slice(&TYPE_PTR.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    out
}

/// Decode a (possibly compressed) DNS name starting at `start`.
///
/// Returns the decoded name and the offset to resume parsing at in the
/// original record (after the name at the original level).
fn read_name(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let mut labels: Vec<&str> = Vec::new();
    let mut pos = start;
    let mut resume = None;
    let mut hops = 0;

    loop {
        let len = *bytes.get(pos)?;
        if len == 0 {
            pos += 1;
            if resume.is_none() {
                resume = Some(pos);
            }
            break;
        }
        if len & 0xC0 == 0xC0 {
            let low = *bytes.get(pos + 1)?;
            let pointer = (((len as usize) & 0x3F) << 8) | low as usize;
            if resume.is_none() {
                resume = Some(pos + 2);
            }
            hops += 1;
            if hops > MAX_POINTER_HOPS {
                return None;
            }
            pos = pointer;
            continue;
        }
        let len = len as usize;
        let label = bytes.get(pos + 1..pos + 1 + len)?;
        labels.push(std::str::from_utf8(label).ok()?);
        pos += 1 + len;
    }

    Some((labels.join("."), resume.unwrap_or(pos)))
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

/// Parse an mDNS response packet into records. Malformed packets yield the
/// records parsed so far rather than an error, matching the tolerant SSDP path.
#[must_use]
pub fn parse_response(bytes: &[u8]) -> Vec<MdnsRecord> {
    if bytes.len() < 12 {
        return Vec::new();
    }
    let question_count = read_u16(bytes, 4).unwrap_or(0) as usize;
    let answer_count = read_u16(bytes, 6).unwrap_or(0) as usize;
    let authority_count = read_u16(bytes, 8).unwrap_or(0) as usize;
    let additional_count = read_u16(bytes, 10).unwrap_or(0) as usize;

    let mut pos = 12;
    for _ in 0..question_count {
        let Some((_, next)) = read_name(bytes, pos) else {
            return Vec::new();
        };
        pos = next + 4;
        if pos > bytes.len() {
            return Vec::new();
        }
    }

    let mut records = Vec::new();
    for _ in 0..(answer_count + authority_count + additional_count) {
        let Some((name, next)) = read_name(bytes, pos) else {
            break;
        };
        pos = next;
        let (Some(record_type), Some(_class), Some(rdlength)) = (
            read_u16(bytes, pos),
            read_u16(bytes, pos + 2),
            read_u16(bytes, pos + 8),
        ) else {
            break;
        };
        pos += 10;
        let rdlength = rdlength as usize;
        let Some(rdata) = bytes.get(pos..pos + rdlength) else {
            break;
        };
        let name = normalize_name(&name);

        let entry = match (record_type, rdata.len()) {
            (TYPE_A, 4) => MdnsRecord::A {
                name,
                address: Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]),
            },
            (TYPE_AAAA, 16) => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(rdata);
                MdnsRecord::Aaaa {
                    name,
                    address: Ipv6Addr::from(octets),
                }
            }
            (TYPE_PTR, _) => match read_name(bytes, pos) {
                Some((target, _)) => MdnsRecord::Ptr {
                    name,
                    target: normalize_name(&target),
                },
                None => MdnsRecord::Other { name, record_type },
            },
            (TYPE_SRV, len) if len >= 6 => {
                let port = read_u16(bytes, pos + 4).unwrap_or(0);
                let target = read_name(bytes, pos + 6)
                    .map(|(target, _)| normalize_name(&target))
                    .unwrap_or_default();
                MdnsRecord::Srv { name, port, target }
            }
            (TYPE_TXT, _) => {
                let mut values = Vec::new();
                let mut index = 0;
                while index < rdata.len() {
                    let len = rdata[index] as usize;
                    index += 1;
                    let Some(value) = rdata.get(index..index + len) else {
                        break;
                    };
                    if let Ok(value) = std::str::from_utf8(value) {
                        values.push(value.to_string());
                    }
                    index += len;
                }
                MdnsRecord::Txt { name, values }
            }
            _ => MdnsRecord::Other { name, record_type },
        };

        records.push(entry);
        pos += rdlength;
    }

    records
}

/// Resolve the first complete SRV+A/AAAA peer from a response.
#[must_use]
pub fn peer_from_records(records: &[MdnsRecord]) -> Option<LanPeer> {
    let mut addresses: HashMap<&str, IpAddr> = HashMap::new();
    for record in records {
        match record {
            MdnsRecord::A { name, address } => {
                addresses.insert(name.as_str(), IpAddr::V4(*address));
            }
            MdnsRecord::Aaaa { name, address } => {
                addresses.insert(name.as_str(), IpAddr::V6(*address));
            }
            _ => {}
        }
    }

    for record in records {
        if let MdnsRecord::Srv { name, port, target } = record
            && let Some(address) = addresses.get(target.as_str())
        {
            return Some(LanPeer {
                peer_id: name.clone(),
                address: SocketAddr::new(*address, *port),
                rtt_ms: 0,
                throughput_kibps: 0,
            });
        }
    }
    None
}

/// Blocking mDNS searcher. `bind` is normally `0.0.0.0:0`; tests point `target`
/// at a loopback responder.
pub struct MdnsDiscovery {
    bind: SocketAddr,
    target: SocketAddr,
    service: String,
    timeout: Duration,
}

impl MdnsDiscovery {
    #[must_use]
    pub fn new(bind: SocketAddr, target: SocketAddr, service: &str, timeout: Duration) -> Self {
        Self {
            bind,
            target,
            service: service.to_string(),
            timeout,
        }
    }

    /// Sends an mDNS query and collects response packets until the timeout.
    ///
    /// # Errors
    /// Returns an I/O error if the socket cannot be bound or read.
    pub fn search(&self) -> io::Result<Vec<Vec<MdnsRecord>>> {
        let socket = UdpSocket::bind(self.bind)?;
        socket.set_read_timeout(Some(self.timeout))?;
        socket.send_to(&build_query(&self.service), self.target)?;

        let mut responses = Vec::new();
        let deadline = Instant::now() + self.timeout;
        let mut buffer = [0u8; 4096];
        while Instant::now() < deadline {
            match socket.recv_from(&mut buffer) {
                Ok((size, _)) => {
                    let records = parse_response(&buffer[..size]);
                    if !records.is_empty() {
                        responses.push(records);
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
        Ok(responses)
    }

    /// Discovered peers, ready for the LAN registry.
    ///
    /// # Errors
    /// Returns an I/O error if the underlying mDNS search fails.
    pub fn discover_peers(&self) -> io::Result<Vec<LanPeer>> {
        Ok(self
            .search()?
            .iter()
            .filter_map(|records| peer_from_records(records))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_u16(out: &mut Vec<u8>, value: u16) {
        out.extend_from_slice(&value.to_be_bytes());
    }

    fn build_srv_a_response() -> Vec<u8> {
        let mut out = Vec::new();
        push_u16(&mut out, 0); // id
        push_u16(&mut out, 0x8400); // response, authoritative
        push_u16(&mut out, 0); // qdcount
        push_u16(&mut out, 2); // ancount
        push_u16(&mut out, 0); // nscount
        push_u16(&mut out, 0); // arcount

        let service_name = encode_name("drop-peer-1._drop-depot._tcp.local");
        let target_name = encode_name("peer-1.local");

        // SRV record
        out.extend_from_slice(&service_name);
        push_u16(&mut out, TYPE_SRV);
        push_u16(&mut out, CLASS_IN);
        out.extend_from_slice(&120u32.to_be_bytes());
        let srv_len = 6 + u16::try_from(target_name.len()).unwrap_or(0);
        push_u16(&mut out, srv_len);
        push_u16(&mut out, 0); // priority
        push_u16(&mut out, 0); // weight
        push_u16(&mut out, 8080); // port
        out.extend_from_slice(&target_name);

        // A record
        out.extend_from_slice(&target_name);
        push_u16(&mut out, TYPE_A);
        push_u16(&mut out, CLASS_IN);
        out.extend_from_slice(&120u32.to_be_bytes());
        push_u16(&mut out, 4);
        out.extend_from_slice(&[192, 168, 1, 50]);

        out
    }

    #[test]
    fn builds_a_ptr_query() {
        let query = build_query(DEPOT_SERVICE);
        assert!(query.len() > 12);
        // QDCOUNT is 1 and the question round-trips through the parser.
        assert_eq!(u16::from_be_bytes([query[4], query[5]]), 1);
        let Some((name, _)) = read_name(&query, 12) else {
            panic!("query name should parse");
        };
        assert_eq!(name, DEPOT_SERVICE.trim_end_matches('.'));
    }

    #[test]
    fn resolves_a_peer_from_srv_and_a_records() {
        let records = parse_response(&build_srv_a_response());
        assert_eq!(records.len(), 2);
        let Some(peer) = peer_from_records(&records) else {
            panic!("peer should resolve");
        };
        assert_eq!(peer.address, SocketAddr::from(([192, 168, 1, 50], 8080)));
        assert_eq!(peer.peer_id, "drop-peer-1._drop-depot._tcp.local");
    }

    #[test]
    fn follows_compression_pointers_in_ptr_records() {
        // PTR whose rdata is a pointer back to the question-style name.
        let mut out = Vec::new();
        push_u16(&mut out, 0);
        push_u16(&mut out, 0x8400);
        push_u16(&mut out, 0);
        push_u16(&mut out, 1); // ancount
        push_u16(&mut out, 0);
        push_u16(&mut out, 0);

        let name_offset = out.len();
        let service = encode_name("_drop-depot._tcp.local");
        out.extend_from_slice(&service);
        push_u16(&mut out, TYPE_PTR);
        push_u16(&mut out, CLASS_IN);
        out.extend_from_slice(&120u32.to_be_bytes());
        push_u16(&mut out, 2); // rdlength: one pointer
        // Pointer to the name we just wrote.
        let pointer = 0xC000u16 | u16::try_from(name_offset).unwrap_or(0);
        push_u16(&mut out, pointer);

        let records = parse_response(&out);
        assert_eq!(
            records,
            vec![MdnsRecord::Ptr {
                name: "_drop-depot._tcp.local".to_string(),
                target: "_drop-depot._tcp.local".to_string(),
            }]
        );
    }

    #[test]
    fn tolerates_truncated_packets() {
        let full = build_srv_a_response();
        assert_eq!(parse_response(&full[..10]).len(), 0);
        assert!(parse_response(&full[..full.len() - 3]).len() <= 2);
    }

    #[test]
    fn discovers_a_loopback_responder() {
        let Ok(responder) = UdpSocket::bind("127.0.0.1:0") else {
            panic!("bind responder");
        };
        let Ok(responder_addr) = responder.local_addr() else {
            panic!("responder address");
        };
        let response = build_srv_a_response();

        let handle = std::thread::spawn(move || {
            let mut buffer = [0u8; 1024];
            if let Ok((_, from)) = responder.recv_from(&mut buffer) {
                let _ = responder.send_to(&response, from);
            }
        });

        let discovery = MdnsDiscovery::new(
            SocketAddr::from(([127, 0, 0, 1], 0)),
            responder_addr,
            DEPOT_SERVICE,
            Duration::from_millis(500),
        );

        let Ok(peers) = discovery.discover_peers() else {
            panic!("search should succeed");
        };
        handle.join().ok();

        assert_eq!(peers.len(), 1);
        assert_eq!(
            peers[0].address,
            SocketAddr::from(([192, 168, 1, 50], 8080))
        );
    }
}
