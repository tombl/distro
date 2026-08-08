use std::env;
use std::fs;
use std::io::{Read, Write};
use std::mem::{align_of, size_of};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

thread_local! {
    static TLS_COUNTER: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

static ATOMIC: AtomicUsize = AtomicUsize::new(0);

fn process_child(args: &[String]) -> bool {
    match args.get(1).map(String::as_str) {
        Some("--process-child") => {
            let mut stdin = String::new();
            std::io::stdin().read_to_string(&mut stdin).unwrap();
            println!("argv={:?}", &args[2..]);
            println!("env={}", env::var("RUST_SPAWN_ENV").unwrap());
            println!("cwd={}", env::current_dir().unwrap().display());
            println!("stdin={stdin}");
            eprintln!("child stderr");
            true
        }
        Some("--process-exit") => {
            std::process::exit(37);
        }
        Some("--process-exec") => {
            let error = Command::new("/bin/busybox")
                .args(["printf", "EXEC OK"])
                .exec();
            panic!("exec failed: {error}");
        }
        _ => false,
    }
}

fn assert_unsupported(error: std::io::Error) {
    assert_eq!(error.kind(), std::io::ErrorKind::Unsupported, "{error}");
    assert!(error.to_string().contains("requires fork"), "{error}");
}

fn test_process() {
    println!("testing std::process::Command through posix_spawn...");

    let mut child = Command::new("/bin/rust-smoke")
        .args(["--process-child", "plain", "two words"])
        .env("RUST_SPAWN_ENV", "env value")
        .current_dir("/tmp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"piped input")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{:?}", output.status);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "argv=[\"plain\", \"two words\"]\nenv=env value\ncwd=/tmp\nstdin=piped input\n"
    );
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "child stderr\n"
    );

    for iteration in 0..32 {
        assert!(
            Command::new("/bin/busybox")
                .arg("true")
                .status()
                .unwrap_or_else(|error| panic!("spawn {iteration} failed: {error}"))
                .success()
        );
    }

    let missing = Command::new("/definitely/missing-rust-command")
        .spawn()
        .unwrap_err();
    assert_eq!(missing.kind(), std::io::ErrorKind::NotFound, "{missing}");

    let status = Command::new("/bin/rust-smoke")
        .arg("--process-exit")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(37));

    let spawn_threads: Vec<_> = (0..4)
        .map(|_| {
            thread::spawn(|| {
                for _ in 0..16 {
                    let status = Command::new("/bin/busybox")
                        .arg("true")
                        .status()
                        .unwrap();
                    assert!(status.success());
                }
            })
        })
        .collect();
    for handle in spawn_threads {
        handle.join().unwrap();
    }

    let uid_error = Command::new("/bin/busybox")
        .arg("true")
        .uid(unsafe { libc::getuid() })
        .spawn()
        .unwrap_err();
    assert_unsupported(uid_error);

    let pre_exec_error = unsafe {
        Command::new("/bin/busybox")
            .arg("true")
            .pre_exec(|| Ok(()))
            .spawn()
            .unwrap_err()
    };
    assert_unsupported(pre_exec_error);

    // posix_spawnp resolves the executable with the parent's PATH, so a PATH
    // supplied only to the child requires the fork/exec fallback to preserve
    // Command's established behavior.
    let child_path_error = Command::new("true")
        .env("PATH", "/bin")
        .spawn()
        .unwrap_err();
    assert_unsupported(child_path_error);

    println!("PROCESS OK");
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if process_child(&args) {
        return;
    }

    println!("hello from rust on wasm linux!");
    println!("args: {args:?}");
    assert_eq!(&args[1..], ["one", "two", "three"]);

    // core and a consumer's libc crate must agree on the port's ILP32/time64
    // ABI. SYS_futex distinguishes this port's asm-generic table from WALI's
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

    test_process();

    println!("total elapsed: {:?}", start.elapsed());
    println!("THREADS OK");
}
