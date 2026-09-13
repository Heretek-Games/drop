//! Content-addressed read-through cache for depot chunks.
//!
//! Chunks are addressed by the SHA-256 checksum of their plaintext bytes
//! (`ChunkData::checksum`), which is stable across versions and libraries.
//! Cached bytes are the **plaintext** (pre-AES) stream, so a hit can be
//! re-encrypted with the current manifest key/IV and served byte-for-byte
//! identically to a miss.
//!
//! The cache is entirely best-effort: any I/O failure disables the cache for
//! that request and the caller falls back to serving directly from the source
//! backend. When `CHUNK_CACHE_DIR` is unset the cache is disabled and the
//! depot behaves exactly as before.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};

use log::{info, warn};

const PARTIAL_EXTENSION: &str = "partial";

/// Creates a directory tree readable only by the current user. The cache stores
/// decrypted game data, so it must not be world-readable.
fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

struct Entry {
    size: u64,
    last_access: Instant,
}

#[derive(Default)]
struct Inner {
    total: u64,
    entries: HashMap<String, Entry>,
}

pub struct ChunkCache {
    dir: Option<PathBuf>,
    max_bytes: u64,
    inner: Mutex<Inner>,
    inflight: Mutex<HashSet<String>>,
}

/// A reserved cache fill. Dropping the guard without committing removes the
/// temporary file and releases the single-flight slot.
pub struct FillGuard<'a> {
    cache: &'a ChunkCache,
    checksum: String,
    pub temp_path: PathBuf,
    pub final_path: PathBuf,
    committed: bool,
}

impl ChunkCache {
    /// Creates a cache rooted at `dir`. Pass `None` to disable caching.
    ///
    /// A `max_bytes` of `0` disables eviction, so the cache can grow without
    /// bound; callers should pass a positive budget.
    #[must_use]
    pub fn new(dir: Option<PathBuf>, max_bytes: u64) -> Self {
        let cache = Self {
            dir,
            max_bytes,
            inner: Mutex::new(Inner::default()),
            inflight: Mutex::new(HashSet::new()),
        };
        cache.initialize();
        cache
    }

    #[must_use]
    pub fn enabled(&self) -> bool {
        self.dir.is_some()
    }

    #[must_use]
    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }

    /// Removes orphaned partial fills and rebuilds the size index.
    fn initialize(&self) {
        let Some(dir) = &self.dir else {
            return;
        };
        if let Err(e) = create_private_dir_all(dir) {
            warn!(
                "chunk cache disabled: failed to create {}: {e}",
                dir.display()
            );
            return;
        }

        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };

        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for entry in read.flatten() {
            let path = entry.path();

            // Shard directories are walked below; only files carry checksums.
            if path.is_dir() {
                if let Ok(shard) = std::fs::read_dir(&path) {
                    for file in shard.flatten() {
                        Self::index_file(&file.path(), &mut inner);
                    }
                }
                continue;
            }
            Self::index_file(&path, &mut inner);
        }

        info!(
            "chunk cache ready at {} ({} chunks, {} bytes, limit {} bytes)",
            dir.display(),
            inner.entries.len(),
            inner.total,
            self.max_bytes
        );
    }

    fn index_file(path: &Path, inner: &mut Inner) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if name.ends_with(PARTIAL_EXTENSION) {
            let _ = std::fs::remove_file(path);
            return;
        }

        if let Ok(meta) = path.metadata()
            && meta.is_file()
        {
            inner.total += meta.len();
            inner.entries.insert(
                name,
                Entry {
                    size: meta.len(),
                    last_access: Instant::now(),
                },
            );
        }
    }

    fn path_for(&self, checksum: &str) -> Option<PathBuf> {
        let dir = self.dir.as_ref()?;
        let shard = checksum.get(0..2).unwrap_or("00");
        Some(dir.join(shard).join(checksum))
    }

    /// Returns the path to a cached chunk, refreshing its LRU position.
    #[must_use]
    pub fn hit(&self, checksum: &str) -> Option<PathBuf> {
        let path = self.path_for(checksum)?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = inner.entries.get_mut(checksum)?;
        if !path.is_file() {
            inner.entries.remove(checksum);
            return None;
        }
        entry.last_access = Instant::now();
        Some(path)
    }

    /// Reserves a single-flight fill slot for `checksum`. Returns `None` when
    /// the chunk is already cached or another request is filling it.
    #[must_use]
    pub fn reserve(&self, checksum: &str) -> Option<FillGuard<'_>> {
        let final_path = self.path_for(checksum)?;

        {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if inner.entries.contains_key(checksum) {
                return None;
            }
        }

        {
            let mut inflight = self
                .inflight
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !inflight.insert(checksum.to_string()) {
                return None;
            }
        }

        if let Some(parent) = final_path.parent()
            && let Err(e) = create_private_dir_all(parent)
        {
            warn!("chunk cache reserve failed to create shard: {e}");
            self.inflight
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(checksum);
            return None;
        }

        let temp_path = final_path.with_extension(PARTIAL_EXTENSION);
        Some(FillGuard {
            cache: self,
            checksum: checksum.to_string(),
            temp_path,
            final_path,
            committed: false,
        })
    }

    /// Inserts a committed fill into the index and evicts if over budget.
    fn insert(&self, checksum: String, size: u64) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(previous) = inner.entries.insert(
            checksum,
            Entry {
                size,
                last_access: Instant::now(),
            },
        ) {
            inner.total = inner.total.saturating_sub(previous.size);
        }
        inner.total += size;
        self.evict(&mut inner);
    }

    fn evict(&self, inner: &mut Inner) {
        if self.max_bytes == 0 {
            return;
        }
        while inner.total > self.max_bytes && !inner.entries.is_empty() {
            let Some(oldest) = inner
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone())
            else {
                break;
            };

            if let Some(entry) = inner.entries.remove(&oldest) {
                inner.total = inner.total.saturating_sub(entry.size);
                if let Some(path) = self.path_for(&oldest) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
}

impl FillGuard<'_> {
    /// Atomically publishes the filled temp file. Returns `false` on failure
    /// (the temp file is cleaned up on drop).
    #[must_use]
    pub fn commit(mut self, size: u64) -> bool {
        if std::fs::rename(&self.temp_path, &self.final_path).is_err() {
            warn!("chunk cache commit failed to rename temp file");
            return false;
        }
        self.committed = true;
        self.cache.insert(self.checksum.clone(), size);
        true
    }
}

impl Drop for FillGuard<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.temp_path);
        }
        self.cache
            .inflight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.checksum);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn cache(dir: &Path, max: u64) -> ChunkCache {
        ChunkCache::new(Some(dir.to_path_buf()), max)
    }

    #[test]
    fn reserve_commit_and_hit() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(temp.path(), 1024 * 1024);

        let guard = cache.reserve("aabbccdd").unwrap();
        std::fs::write(&guard.temp_path, b"hello world").unwrap();
        assert!(guard.commit(11));

        let path = cache.hit("aabbccdd").unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"hello world");
        assert_eq!(cache.inner.lock().unwrap().total, 11);
    }

    #[test]
    fn dropping_guard_removes_temp_and_unblocks() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(temp.path(), 1024 * 1024);

        {
            let guard = cache.reserve("deadbeef").unwrap();
            std::fs::write(&guard.temp_path, b"partial").unwrap();
            // No commit: drop should clean up.
        }

        assert!(cache.hit("deadbeef").is_none());
        assert!(!cache.temp_path_exists("deadbeef"));
        // The single-flight slot must be free again.
        assert!(cache.reserve("deadbeef").is_some());
    }

    #[test]
    fn single_flight_rejects_second_reserve() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(temp.path(), 1024 * 1024);

        let first = cache.reserve("00112233").unwrap();
        assert!(cache.reserve("00112233").is_none());
        drop(first);
        assert!(cache.reserve("00112233").is_some());
    }

    #[test]
    fn evicts_least_recently_used_when_over_budget() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(temp.path(), 10);

        for (i, checksum) in ["aa11", "bb22", "cc33"].iter().enumerate() {
            let guard = cache.reserve(checksum).unwrap();
            std::fs::write(&guard.temp_path, vec![0u8; 6]).unwrap();
            assert!(guard.commit(6));
            // Touch the earlier entries so they are newer than the oldest.
            if i == 0 {
                let _ = cache.hit("aa11");
            }
        }

        // Budget is 10 bytes; committing three 6-byte chunks must evict two.
        let inner = cache.inner.lock().unwrap();
        assert!(inner.total <= 10);
    }

    #[test]
    fn reinserting_same_checksum_does_not_double_count() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(temp.path(), 1024 * 1024);

        cache.insert("aa11bb22".to_string(), 6);
        cache.insert("aa11bb22".to_string(), 6);

        assert_eq!(cache.inner.lock().unwrap().total, 6);
    }

    #[test]
    fn hit_drops_stale_entry_when_file_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(temp.path(), 1024 * 1024);

        let guard = cache.reserve("c0ffee00").unwrap();
        std::fs::write(&guard.temp_path, b"data").unwrap();
        assert!(guard.commit(4));

        let path = cache.hit("c0ffee00").unwrap();
        std::fs::remove_file(&path).unwrap();

        assert!(cache.hit("c0ffee00").is_none());
        assert!(!cache.inner.lock().unwrap().entries.contains_key("c0ffee00"));
    }

    impl ChunkCache {
        fn temp_path_exists(&self, checksum: &str) -> bool {
            self.path_for(checksum)
                .is_some_and(|p| p.with_extension(PARTIAL_EXTENSION).exists())
        }
    }
}
