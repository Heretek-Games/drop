use std::{
    cmp,
    fs::File,
    io::{BufWriter, Write},
};

use criterion::{Criterion, criterion_group, criterion_main};
use rand::{Rng, rng};
use tempfile::tempfile;
use tokio::runtime::Runtime;
use torrential::downloads::cache::ChunkCache;

async fn torrential() {}

fn generate_file() -> File {
    let total_bytes = 312 * 1024 * 1024;
    let tempfile = tempfile().unwrap();
    let mut writer = BufWriter::new(tempfile);

    let mut rng = rng();
    let mut buffer = [0; 1024];
    let mut remaining_size = total_bytes;

    while remaining_size > 0 {
        let to_write = cmp::min(remaining_size, buffer.len());
        let buffer = &mut buffer[..to_write];
        rng.fill(buffer);
        writer.write(buffer).unwrap();

        remaining_size -= to_write;
    }
    writer.into_inner().unwrap()
}
// The benchmark function setup
fn benchmark(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let file = generate_file();

    c.bench_function("torrential download", |b| {
        b.to_async(&rt).iter(|| torrential())
    });
}

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

// Grouping your benchmarks
criterion_group!(benches, benchmark, cache_bench);
criterion_main!(benches);
