# POSIX named semaphores and Python multiprocessing on wasm Linux

Date: 2026-07-20

**Status update (2026-07-20, later same day):** the kernel-backed named
semaphore recommended in section 2 has landed (`platform: kernel-backed
POSIX named semaphores`), including the musl `sem_open` dispatch. The
Python multiprocessing enablement in section 6 (phases 1 and 4) is the
remaining open work; the sections below are the original research and
recommendation as written before the implementation round.

Research basis:

- distro base: `08b42dfea2761bd66e962d7b85e8201904c2bbbd`
- musl base: `2c0e019c745dc3ca416904204c8e80f6063e460f`
- kernel reference: `4b81de2fb5613d50a5ff92ba6359dd619113beb0`
- experimental musl commit: `29193e0083b53f11ab5dfed460a9f097037423a7`
- distro prototype commit: `ad11338b21fb93cc9ae405b76491410208a10e83`

## Executive recommendation

Do not expose a process-local registry as POSIX `sem_open()`. It is small and it
works for threads, but it violates the defining cross-process property of a
named semaphore. The failure is not merely a missing feature: two processes can
both successfully create the same supposedly exclusive name and then enter the
same critical section. That is silent data-corruption territory.

Tom's hypothesis is half right:

- `CLONE_VM` makes the existing unnamed, `pshared=0` musl semaphore and futex
  machinery usable across threads. This works today.
- Turning `multiprocessing.Process` into such a thread does not preserve
  multiprocessing semantics. In one interpreter it is essentially the existing
  `multiprocessing.dummy`: shared failure domain and one GIL, so no Python CPU
  parallelism. Per-interpreter GILs could provide parallelism, but that is a
  separate interpreter-pool design with object-transfer and extension-module
  constraints, not a cheap start method.

The recommended architecture is therefore:

1. Make CPython honestly spawn-only on this platform and enable the useful
   semaphore-free subset: real `Process`, `Pipe`/`Connection`, and probably
   managers. Keep fork and forkserver unavailable.
2. Keep named POSIX semaphores unavailable until they are kernel-backed. Fix
   CPython's `_multiprocessing` link/configure bug so absence is loud.
3. If `Queue`, `Pool`, `ProcessPoolExecutor`, and process synchronizers justify
   the cost, add a small kernel named-semaphore object and a musl fd-backed
   wrapper. A syscall per operation is the correct trade here.
4. Continue to report `sharedctypes`, `Value`/`Array`, and
   `multiprocessing.shared_memory` as unsupported for real processes. Named
   semaphores do not create cross-process user memory.
5. Direct callers wanting shared-state concurrency to `threading`,
   `concurrent.futures.ThreadPoolExecutor`, or `multiprocessing.dummy`. Do not
   add a misleading `wasmthread` multiprocessing start method.

## 1. musl `sem_open()` audit

### What normal musl does

The normal implementation in `src/thread/sem_open.c` depends on every part of
the conventional Linux shared-memory model:

1. `__shm_mapname()` canonicalizes the semaphore name to `/dev/shm/<name>`.
2. `open()` supplies a system-wide namespace, mode/uid/gid checks, and
   persistence independently of any one process.
3. Creation initializes a `sem_t` with `pshared=1`, writes it to a temporary
   file, and atomically links that file to the final name. Competing
   `O_CREAT|O_EXCL` calls are serialized by the filesystem operation.
4. `mmap(PROT_READ|PROT_WRITE, MAP_SHARED)` maps the same semaphore words into
   every opener. The atomic counter and futex key therefore refer to one shared
   object.
5. A process-local inode table deduplicates repeated mappings and refcounts
   them. `sem_close()` unmaps the last local reference.
6. `sem_unlink()` removes the name while existing mappings continue to keep the
   old object alive.

On wasm Linux, steps 3 and 4 are impossible. There is no `mmap()` or
`MAP_SHARED`, each process has a private `WebAssembly.Memory`, and a copy-clone
only copies the initial bytes. A file can store a snapshot of `sem_t`; it cannot
make subsequent atomics or futex waits observe the same word. The normal
implementation is therefore not one missing syscall away from working.

### Process-local prototype

The experimental musl commit adds a fixed, locked table of
`name -> {sem_t, refcount, linked}` and initializes each entry with
`sem_init(..., pshared=0, ...)`. It implements useful same-process behavior:

- repeated opens find the same live object;
- local `O_CREAT|O_EXCL`, `ENOENT`, and `SEM_VALUE_MAX` checks work;
- unlink removes the name but existing handles remain usable;
- a replacement name denotes a new object while old unlinked handles live.

The patch is only 128 changed lines, which confirms that this route is cheap.
It also confirms that implementation size is not the relevant decision.

POSIX.1-2024 explicitly requires processes opening the same leading-slash name
to refer to the same object, permits other processes to connect after creation,
and makes `O_CREAT|O_EXCL` existence-and-creation atomic across processes. See
the [POSIX `sem_open()` specification](https://pubs.opengroup.org/onlinepubs/9799919799/functions/sem_open.html).

| POSIX property | Process-local registry | Consequence |
|---|---|---|
| Same leading-slash name denotes one object across processes | Violated | Mutual exclusion and wakeups do not cross the process boundary. |
| Other processes can open an existing object | Violated | `sem_open(name, 0)` returns `ENOENT` in a fresh process. |
| `O_CREAT|O_EXCL` is atomic across processes | Violated | Multiple processes can all report exclusive creation success. |
| Semaphore value is shared | Violated | Each process has an independent counter and waiter set. |
| Name, mode, uid/gid, and access checks are system-wide | Violated | Mode is ignored and visibility is local. |
| Unlink removes the global name while open references retain the old object | Only local | Other processes do not observe unlink; no object survives its owning process. |
| Leaked named objects can be cleaned by a resource-tracker process | Violated | The tracker has a different registry and cannot unlink the creator's entry. |
| Same-process open/close/unlink lifetime | Approximated | Useful only as a private thread convenience. |

Silent wrongness is unacceptable. A named semaphore is commonly guarding state
whose corruption is worse than a clean startup failure.

There is no reliable cross-process detection using only process-local memory. A
PID file or advisory lock could detect some concurrent second openers, but it
cannot provide the counter, preserve unlink lifetime, handle crashes and PID
reuse, or support a later process opening a persistent name. Once a shared
broker or kernel registry is introduced to solve those cases, it should hold
the actual semaphore too. The honest loud behavior is to omit `sem_open()` (or
fail it consistently as unsupported), so feature detection cannot mistake a
thread-only object for POSIX IPC. If a local named registry is ever wanted, it
needs a non-POSIX API and name; unnamed semaphores already cover the practical
thread use case.

## 2. Kernel-backed named semaphores

The kernel is the only memory and lifetime domain common to all wasm processes.
It is therefore the natural location for the counter, wait queue, namespace,
and unlink state.

### Why bare eventfd is not enough

The referenced kernel already has `eventfd`, and `EFD_SEMAPHORE` reads one and
decrements the counter by one (`fs/eventfd.c`, `eventfd_ctx_do_read()`). An fd
can also be passed with `SCM_RIGHTS`. This is a good proof that the blocking
counter operation is already cheap and kernel-representable.

An eventfd cannot be placed in a filesystem file: a pathname can store an fd
number, but that number is meaningful only in one process's descriptor table.
Some agent must turn a name into a reference to the same kernel object. Options
are a kernel registry, a `/dev` control node, or a userspace broker that sends
fds over AF_UNIX.

Even after naming is solved, raw eventfd is not quite a POSIX semaphore:

- it has no uid/gid/mode namespace;
- it has no unlink-while-open lifecycle;
- its 64-bit overflow rule does not enforce musl's configured
  `SEM_VALUE_MAX`;
- it has no supported atomic `sem_getvalue()` interface (`/proc/*/fdinfo` is
  not an ABI to build libc on);
- timed waits require a nonblocking read/poll/retry loop and careful
  cancellation handling.

A broker can own the name-to-eventfd map and pass descriptors, but then daemon
lifecycle, credentials, crash recovery, cleanup, and the missing operations
become part of libc correctness. Brokering every operation fixes those gaps but
is more moving parts than the small kernel object it replaces.

### Recommended kernel/libc shape

Use a wasm-specific control device (for example `/dev/wasm-sem`) or a compact
arch syscall family. An open operation should return an `O_CLOEXEC` anon-inode
fd referring to a kernel object with:

- canonical name, uid, gid, mode, and a linked/unlinked flag;
- counter and implementation maximum;
- wait queue and lock;
- open-reference count distinct from the name's link;
- persistence while linked even when no process currently has it open.

The ABI needs open/create, unlink, wait/trywait/timedwait, post, and getvalue.
The kernel must enforce atomic `O_CREAT|O_EXCL`, permissions, overflow, signal
interruption, and unlink lifetime. An ioctl on the object fd is reasonable for
the operations; a control ioctl can allocate and return a new fd for open.

musl's `sem_open()` can allocate a tagged opaque handle containing that fd.
`sem_wait()`/`sem_post()`/`sem_getvalue()` dispatch tagged named handles to the
kernel and retain today's atomic/futex implementation for user-allocated
unnamed semaphores. `sem_close()` closes/frees the named handle; `sem_unlink()`
uses the control interface. POSIX.1-2024 permits repeated opens in one process
to return either the same handle or distinct handles, so libc does not need the
old inode-dedup table for conformance.

Every named operation being a syscall is acceptable. There is no possible
userspace-atomic fast path for unrelated wasm memories, and Python's process
startup, pickle, and pipe costs dominate this syscall.

This is not a 100-line production patch. A realistic first implementation is
roughly 500-900 kernel/UAPI lines plus 200-350 musl lines and cross-process
tests. Namespace limits, credentials, cancellation, timeouts, cleanup, and
races around unlink/recreate are the work, not the counter decrement. The
benefit is substantial but bounded: it unlocks process synchronizers, queues,
pools, and `ProcessPoolExecutor`; it does not unlock shared memory.

## 3. What CPython multiprocessing actually needs

The package is CPython 3.13.14, statically linked with all extension modules
built in; see [`packages/python/package.nix`](../packages/python/package.nix).

### Start methods

- **fork:** `popen_fork.py` calls `os.fork()`. A return-twice fork is
  impossible here.
- **forkserver:** the server is launched separately but ultimately calls
  `os.fork()` for each worker. It is also impossible.
- **spawn:** `popen_spawn_posix.py` pickles preparation data and the process
  object, creates control pipes, and calls `util.spawnv_passfds()` to start a
  fresh interpreter. This model fits `posix_spawn()` and works in the
  prototype. CPython normally routes this helper through `_posixsubprocess`'s
  `fork_exec`, so the distro needs the small `os.posix_spawn()` file-actions
  fallback in the prototype patch.

This matches Python's documented model: spawn starts a fresh interpreter and
passes only necessary resources, while fork and forkserver depend on
`os.fork()`. See the [Python 3.13 multiprocessing start-method documentation](https://docs.python.org/3.13/library/multiprocessing.html#contexts-and-start-methods).

### Synchronization and IPC

On Unix, `_multiprocessing.SemLock` creates named semaphores with
`sem_open(O_CREAT|O_EXCL)`. Under spawn it retains the name. Pickling a lock
serializes that name, and the child rebuild path calls `sem_open(name, 0)`.
This is exactly where the local registry fails.

There are two CPython build couplings worth fixing independently:

- Configure currently selects `_multiprocessing` from `sem_unlink` availability
  even when `sem_open` is absent. The module exposes `sem_unlink`, but
  `_PyMp_sem_unlink` is compiled only under `HAVE_MP_SEMAPHORE`, which requires
  `sem_open`; the static link then has an unresolved reference.
- `multiprocessing.resource_tracker` imports `_posixshmem` unconditionally on
  POSIX even when it only needs semaphore cleanup. The port must keep
  `_posixshmem` disabled because shared-memory mapping cannot work. The
  prototype makes this backend optional.

The semaphore-free transport is healthier than the package defaults suggest:

- `Pipe`/`Connection` uses pipes or sockets and pickle. It works in the VM,
  including passing a connection to a spawned process.
- FD reduction/resource sharing uses AF_UNIX plus `SCM_RIGHTS`, already present.
- `Queue` adds locks, a bounded semaphore, and a feeder thread around a pipe.
  `SimpleQueue` still adds reader/writer locks. Both therefore need true
  cross-process semaphores despite the pipe transport working.
- `Pool` constructs `SimpleQueue` instances, so it also stops at SemLock.
- Managers use a real server process and connection/proxy RPC. Their server-side
  synchronization uses threads, making them plausible with spawn without
  shared memory; this path was audited but not prototyped.
- `Barrier` directly allocates a `multiprocessing.heap.BufferWrapper`, so it is
  a shared-memory exception even if the other synchronizers work.

`multiprocessing.heap` imports `mmap`; `sharedctypes`, `Value`, and `Array` use
that heap, and this distro also disables `_ctypes`. `multiprocessing.shared_memory`
requires both `mmap` and `_posixshmem`. These APIs cannot be made cross-process
on this memory model.

### Feature matrix

Legend: **yes** means the architecture supports the documented semantics;
**partial** is useful but narrower; **no** is a fundamental or demonstrated
failure. “Thread-backed” means today's single-interpreter thread model, not a
future subinterpreter pool.

| Feature | Spawn + kernel named sems | Spawn + local named registry | Thread-backed / `multiprocessing.dummy` |
|---|---:|---:|---:|
| `Process` with pickled target/args | **Yes**; prototype proves launcher | **Yes** when args contain no SemLock | Thread task only; not process semantics |
| Distinct PID, isolation, exit status, signal/terminate | **Yes** | **Yes** for spawnable workloads | **No** |
| `Pipe` / `Connection` / pickled messages | **Yes**; prototype proves it | **Yes**; prototype proves it | **Yes**, but ordinary queues are simpler |
| `Lock`, `RLock`, `Semaphore`, `BoundedSemaphore`, `Condition`, `Event` across workers | **Yes** | **No**; child cannot rebuild the name | **Yes** across threads |
| `Barrier` | **No**; also needs shared mmap heap | **No** | **Yes** with thread primitive |
| `Queue`, `JoinableQueue`, `SimpleQueue` | **Yes** | **No**; demonstrated at SemLock rebuild | **Yes** with in-process queues |
| `Pool` / `ProcessPoolExecutor` | **Yes** | **No**; pool queues need SemLock | **Partial**: ThreadPool, still one GIL for Python code |
| `Manager` and proxy objects | **Likely yes**; needs spawn/connections | **Likely yes**; does not require client SemLock | Possible, usually unnecessary |
| Semaphore resource-tracker cleanup after a crash | **Yes**; global name | **No**; tracker has another registry | Not applicable |
| `Value`, `Array`, `sharedctypes` | **No**; mmap absent, ctypes disabled | **No** | In-process substitutes work; not the real sharedctypes implementation |
| `multiprocessing.shared_memory` | **No**; no shared user mapping | **No** | Only via a new local-only API; ordinary objects already share |
| CPU parallelism for Python code | **Yes** on an SMP guest | Only for the narrow spawnable subset | **No** with one interpreter GIL |
| `fork` / `forkserver` | **No** | **No** | Not meaningful |

When a production kernel semaphore exists, the cross-build must also set or
correctly probe `ac_cv_broken_sem_getvalue=no`; CPython pessimistically marks
`sem_getvalue` broken when it cannot run the configure test. The musl function
works, and CPython uses it for value inspection and full bounded-semaphore
checks.

## 4. Thread-backed multiprocessing assessment

A `CLONE_VM` task executing in the same CPython interpreter shares the heap and
the GIL. If it uses pthread-equivalent clone flags it also shares the surrounding
process runtime expected of a thread. It cannot honestly supply process
isolation, independent PIDs, `kill()`/`terminate()` semantics, or protection
from another worker corrupting or exiting the runtime. CPU-bound Python workers
serialize on the GIL. This is the existing `multiprocessing.dummy` design, whose
[documentation describes it as a threading wrapper](https://docs.python.org/3.13/library/multiprocessing.html#the-multiprocessing-dummy-module).

A platform `wasmthread` start method would duplicate that implementation behind
a name that implies stronger semantics. It would also push thread-specific
exceptions into the process API: cwd/environment/signal handling, descriptor
ownership, abrupt termination, global state, and module imports all need new
answers. The honest interface is the thread interface.

Per-interpreter GILs change the parallelism result but not the cost assessment.
[PEP 684](https://peps.python.org/pep-0684/) added an own-GIL interpreter
configuration in Python 3.12, with strict isolation and explicit restrictions
for incompatible extension modules. Physically shared `WebAssembly.Memory`
does not make Python objects safe to use from another interpreter. A practical
pool still needs serialization or interpreter channels, per-interpreter module
state, allocator/runtime auditing, and an audit of every statically built C
extension and its dependent libraries. Process API concepts such as PID,
signals, termination, and independent failure remain false.

That may be a worthwhile future `InterpreterPool` project for CPU parallelism,
but it should be designed and named as such. It is not a prerequisite or a
substitute for the useful spawn-based process subset.

## 5. Prototype results

### C/musl tests

[`semaphore-thread.c`](../packages/basic-init/tests/semaphore-thread.c) performs
both directions of an unnamed `sem_init(pshared=0)` thread handshake and a
direct cross-thread `FUTEX_WAIT_PRIVATE`/`FUTEX_WAKE_PRIVATE` handshake. It
passes in the VM.

[`named-semaphore-local.c`](../packages/basic-init/tests/named-semaphore-local.c)
checks local open/exclusive/unlink/recreate lifetime, then uses `posix_spawn()`
to prove the child sees `ENOENT` and can independently create the same name
with `O_CREAT|O_EXCL`. The test passes; its success is the conformance failure
made executable.

Validation command (both checks pass):

```sh
nix build --override-input musl-src path:checkouts/musl \
  'path:.#legacyPackages.x86_64-linux.basic-init.checks.semaphore-thread' \
  'path:.#legacyPackages.x86_64-linux.basic-init.checks.named-semaphore-local'
```

### CPython VM test

The distro prototype:

- enables the now-linkable built-in `_multiprocessing`;
- makes spawn the only advertised/default context;
- launches multiprocessing helpers with `os.posix_spawn()` file actions when
  `_posixsubprocess` is absent;
- makes `_posixshmem` cleanup optional in the resource tracker;
- creates and uses a same-process `multiprocessing.Lock`;
- starts a real child, observes a different PID and zero exit status;
- passes a pickled value over `multiprocessing.Pipe` from the spawned child;
- attempts a Queue producer and asserts that the child exits nonzero with
  `FileNotFoundError` in `SemLock._rebuild`.

Validation command (passes):

```sh
nix build --override-input musl-src path:checkouts/musl \
  'path:.#legacyPackages.x86_64-linux.python.checks.interpreter'
```

The result establishes three separate facts: `_multiprocessing` links when
`sem_open` exists; real spawn and pipe transport are viable now; and a local
named semaphore cannot carry CPython's synchronization graph into the fresh
interpreter. A Pool would fail for the same reason because it constructs
SemLock-backed queues.

These commits are research artifacts, not a merge recommendation for the local
`sem_open` implementation.

## 6. Phased implementation plan

Estimates assume one engineer familiar with this port and exclude review queue
time.

### Phase 1: ship the honest spawn-only subset (2-4 days)

- Land the `spawnv_passfds()` `posix_spawn` fallback and spawn-only context
  selection.
- Fix `_multiprocessing` feature selection/unconditional `_PyMp_sem_unlink`
  reference, and make resource-tracker shared-memory cleanup optional.
- Keep `_multiprocessing.SemLock` unavailable until a conforming semaphore
  backend exists; verify `Process`, `Pipe`, fd transfer, exit codes, and Manager.
- Document unsupported synchronization, Queue/Pool, shared memory, fork, and
  forkserver clearly.

This phase provides useful real processes without waiting for a kernel ABI.

### Phase 2: kernel named-semaphore prototype (4-7 days)

- Specify the wasm-only UAPI and lifetime/permission rules.
- Implement the registry, anon-inode handle, counter/wait queue, open/unlink,
  wait variants, post, and getvalue.
- Add C tests with unrelated `posix_spawn` processes for exclusion, wakeup,
  exclusive-create races, unlink/recreate, crash/close, timeout, interruption,
  permissions, and overflow.

Do not start with a generic driver framework or a userspace daemon; keep one
kernel object aligned to the required semantics.

### Phase 3: production musl integration (3-5 days)

- Add the tagged fd-backed named handle and dispatch in semaphore operations.
- Preserve the current futex fast path for unnamed thread semaphores.
- Run musl semaphore tests plus the distro VM cross-process suite.
- Verify cancellation points and ABI compatibility carefully.

### Phase 4: full semaphore-backed multiprocessing subset (3-5 days)

- Enable `_multiprocessing`, provide the correct `sem_getvalue` configure cache,
  and exercise all SemLock kinds and resource-tracker crash cleanup.
- Add Queue/SimpleQueue/JoinableQueue producer-consumer tests, Pool map, and
  `ProcessPoolExecutor` tests under spawn.
- Test Manager separately and retain explicit failures for Barrier,
  sharedctypes, `Value`/`Array`, and shared memory.

### Phase 5: hardening and review (1-2 weeks)

- Stress name races, unlink/recreate ABA cases, limits, signals/cancellation,
  process death, and descriptor exhaustion.
- Document the supported Python matrix and kernel ABI stability.

A usable kernel-backed multiprocessing subset is about 2-3 engineer-weeks; a
production-confidence implementation is more honestly 3-5 weeks. A
per-interpreter-GIL worker system is a separate multi-week project with a much
larger compatibility surface and should be prioritized only for workloads that
cannot use real spawn plus message passing.
