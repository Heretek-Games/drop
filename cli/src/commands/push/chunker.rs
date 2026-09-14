//! Content-defined chunking for the `downpour push` publisher.
//!
//! Uses a rolling buzhash so chunk boundaries follow file content rather than
//! fixed offsets: inserting bytes near the start of a file only re-chunks the
//! region around the edit, which keeps depot deltas small.

/// Smallest chunk emitted (except the final chunk of a file).
pub const DEFAULT_MIN_CHUNK: usize = 64 * 1024;
/// Largest chunk emitted; forces a boundary to bound memory and blob size.
pub const DEFAULT_MAX_CHUNK: usize = 1024 * 1024;
/// Boundary mask size: average chunk target is `2^DEFAULT_AVG_BITS`.
pub const DEFAULT_AVG_BITS: u32 = 20;

/// Rolling content-defined chunker.
pub struct Chunker {
    min: usize,
    max: usize,
    mask: u64,
    table: [u64; 256],
}

impl Default for Chunker {
    fn default() -> Self {
        Self::new(DEFAULT_MIN_CHUNK, DEFAULT_MAX_CHUNK, DEFAULT_AVG_BITS)
    }
}

impl Chunker {
    pub fn new(min: usize, max: usize, avg_bits: u32) -> Self {
        assert!(min > 0 && min <= max, "invalid chunk bounds");
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut table = [0u64; 256];
        for entry in table.iter_mut() {
            // Deterministic xorshift64 so boundaries are reproducible everywhere.
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *entry = state;
        }
        Self {
            min,
            max,
            mask: (1u64 << avg_bits) - 1,
            table,
        }
    }

    /// Splits `data` into content-defined chunks, returned as `(start, end)`.
    pub fn split<'a>(&self, data: &'a [u8]) -> Vec<&'a [u8]> {
        let mut chunks = Vec::new();
        let mut start = 0usize;
        while start < data.len() {
            let end = self.next_boundary(&data[start..]);
            chunks.push(&data[start..start + end]);
            start += end;
        }
        if chunks.is_empty() {
            chunks.push(&data[0..0]);
        }
        chunks
    }

    fn next_boundary(&self, data: &[u8]) -> usize {
        if data.len() <= self.min {
            return data.len();
        }

        let limit = data.len().min(self.max);
        let mut hash: u64 = 0;
        for (index, byte) in data[..limit].iter().enumerate() {
            hash = hash.rotate_left(1) ^ self.table[*byte as usize];
            if index + 1 >= self.min && (hash & self.mask) == 0 {
                return index + 1;
            }
        }
        limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_reassemble_to_the_input() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let chunker = Chunker::new(1024, 8192, 10);
        let chunks = chunker.split(&data);
        let rejoined: Vec<u8> = chunks.iter().flat_map(|c| c.iter().copied()).collect();
        assert_eq!(rejoined, data);
        assert!(chunks.len() > 1, "expected multiple chunks");
    }

    #[test]
    fn respects_min_and_max_bounds() {
        let data: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 256) as u8).collect();
        let chunker = Chunker::new(2048, 4096, 9);
        let chunks = chunker.split(&data);
        for chunk in &chunks[..chunks.len().saturating_sub(1)] {
            assert!(chunk.len() >= 2048, "chunk below minimum: {}", chunk.len());
            assert!(chunk.len() <= 4096, "chunk above maximum: {}", chunk.len());
        }
    }

    #[test]
    fn is_deterministic_for_the_same_input() {
        let data: Vec<u8> = (0..50_000u32).map(|i| (i % 97) as u8).collect();
        let a = Chunker::default().split(&data);
        let b = Chunker::default().split(&data);
        assert_eq!(a.len(), b.len());
        assert!(a.iter().zip(&b).all(|(x, y)| x == y));
    }

    #[test]
    fn empty_input_still_yields_one_empty_chunk() {
        let chunks = Chunker::default().split(&[]);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].is_empty());
    }
}
