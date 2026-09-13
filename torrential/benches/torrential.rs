use criterion::{Criterion, criterion_group, criterion_main};
use torrential::downloads::cache::ChunkCache;

// Exercises the content-addressed chunk cache hot path (index lookup + LRU
// touch) without touching source storage.
fn cache_bench(c: &mut Criterion) {
    let dir = tempfile::tempdir().unwrap();
    let cache = ChunkCache::new(Some(dir.path().to_path_buf()), 1024 * 1024 * 1024);

    let guard = cache.reserve("aa00bb11cc22dd33").unwrap();
    std::fs::write(&guard.temp_path, vec![0u8; 64 * 1024]).unwrap();
    assert!(guard.commit(64 * 1024));

    c.bench_function("chunk cache hit", |b| {
        b.iter(|| cache.hit("aa00bb11cc22dd33"))
    });
}

criterion_group!(benches, cache_bench);
criterion_main!(benches);
