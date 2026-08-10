use std::fs;
use std::mem::{align_of, size_of};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

thread_local! {
    static TLS_COUNTER: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

static ATOMIC: AtomicUsize = AtomicUsize::new(0);

fn main() {
    println!("hello from rust on wasm linux!");
    let args: Vec<String> = std::env::args().collect();
    println!("args: {args:?}");
    assert_eq!(&args[1..], ["one", "two", "three"]);

    // core and a consumer's libc crate must agree on the port's ILP32/time64
    // ABI. SYS_futex distinguishes the fork's asm-generic table from WALI's
    // x86_64-like syscall table, so this also proves Cargo used the path
    // override rather than the registry source from Cargo.lock.
    assert_eq!(size_of::<std::ffi::c_long>(), 4);
    assert_eq!(size_of::<libc::c_long>(), 4);
    assert_eq!(size_of::<libc::time_t>(), 8);
    assert_eq!(size_of::<libc::timespec>(), 16);
    assert_eq!(size_of::<libc::max_align_t>(), 32);
    assert_eq!(align_of::<libc::max_align_t>(), 16);
    assert_eq!(libc::SYS_futex, 422);

    // Exercise std's libc::stat layout rather than only proving that the
    // executable links. A bad layout can return plausible but corrupt fields.
    let path = "/rust-smoke-file";
    fs::write(path, b"rust stat ok").unwrap();
    assert_eq!(fs::read(path).unwrap(), b"rust stat ok");
    assert_eq!(fs::metadata(path).unwrap().len(), 12);
    fs::remove_file(path).unwrap();

    let n_threads = 4;
    let iters = 10_000;
    println!("spawning {n_threads} threads x {iters} mutex increments...");

    let counter = Arc::new(Mutex::new(0u64));
    let (tx, rx) = mpsc::channel::<(String, u32)>();
    let start = Instant::now();

    let handles: Vec<_> = (0..n_threads)
        .map(|i| {
            let counter = Arc::clone(&counter);
            let tx = tx.clone();
            thread::Builder::new()
                .name(format!("worker-{i}"))
                .spawn(move || {
                    for _ in 0..iters {
                        *counter.lock().unwrap() += 1;
                        ATOMIC.fetch_add(1, Ordering::Relaxed);
                        TLS_COUNTER.with(|c| c.set(c.get() + 1));
                    }
                    let tls = TLS_COUNTER.with(|c| c.get());
                    tx.send((thread::current().name().unwrap().to_owned(), tls))
                        .unwrap();
                    i as u64
                })
                .unwrap()
        })
        .collect();
    drop(tx);

    for (name, tls) in rx {
        println!("recv: {name} finished, tls={tls}");
        assert_eq!(tls, iters as u32, "worker TLS count wrong");
    }

    let mut sum = 0;
    for h in handles {
        sum += h.join().unwrap();
    }
    let total = *counter.lock().unwrap();
    let atomic = ATOMIC.load(Ordering::Relaxed);
    println!("joined all: sum={sum} mutex_count={total} atomic_count={atomic}");
    assert_eq!(total, (n_threads * iters) as u64, "mutex count wrong");
    assert_eq!(atomic, n_threads * iters, "atomic count wrong");
    let main_tls = TLS_COUNTER.with(|c| c.get());
    assert_eq!(main_tls, 0, "main thread TLS should be untouched");

    // timed futex waits: sleep and park_timeout must actually take ~their duration
    let t0 = Instant::now();
    thread::sleep(Duration::from_millis(100));
    let slept = t0.elapsed();
    println!("sleep(100ms) took {slept:?}");
    assert!(slept >= Duration::from_millis(90), "sleep returned early: {slept:?}");

    let t0 = Instant::now();
    thread::park_timeout(Duration::from_millis(100));
    let parked = t0.elapsed();
    println!("park_timeout(100ms) took {parked:?}");
    assert!(
        parked >= Duration::from_millis(90),
        "park_timeout returned early: {parked:?} (time64 futex ABI bug?)"
    );

    // scoped threads borrow from the stack
    let data = vec![1u64, 2, 3, 4];
    let scoped_sum: u64 = thread::scope(|s| {
        let handles: Vec<_> = data
            .chunks(2)
            .map(|chunk| s.spawn(move || chunk.iter().sum::<u64>()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).sum()
    });
    assert_eq!(scoped_sum, 10);
    println!("scoped threads: sum={scoped_sum}");

    println!("total elapsed: {:?}", start.elapsed());
    println!("THREADS OK");
}
