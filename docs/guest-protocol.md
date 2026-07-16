# Guest protocol

`@tombl/linux-guest` ships both endpoints of a private protocol between its
host `Machine` and the init process in its root filesystem. The endpoints are
always versioned and released together. There is one protocol version, no
negotiation, and no compatibility path.

## Transport

The agent listens on virtio-vsock port 1024. Every logical resource owns a
separate `SOCK_STREAM` connection. A connection starts with this little-endian
prelude:

| Field | Type |
| --- | --- |
| magic (`TLNX`) | `u32` |
| version | `u16` |
| connection kind | `u16` |
| metadata length | `u32` |

The prelude is followed by the operation-specific metadata. Metadata is at
most 64 KiB. Strings are UTF-8 bytes prefixed by a `u32` length and must not
contain NUL. Counts and lengths are checked before parsing.

Subsequent messages use one frame shape:

| Field | Type |
| --- | --- |
| payload length | `u32` |
| message type | `u16` |
| flags | `u16` |

Frames are at most 64 KiB including their header. A stream may contain any
number of frames. Successful streams end with an explicit `END` frame;
transport EOF before `END` is an error. An `ERROR` frame contains a positive
Linux errno. The host already knows the operation and paths and adds them to
the public `SystemError`.

There are no checksums, request identifiers, authentication, encryption, or
application-level flow control. Vsock is reliable and ordered, a connection
identifies its request, and virtio-vsock credit provides stream backpressure.

## Connection kinds

Short operations (`stat`, `lstat`, `mkdir`, `remove`, `rename`, and related
metadata calls) send one request in the prelude and receive one result frame.

`readFile` and `readDir` receive a sequence of data or entry frames followed by
`END`. `writeFile` sends data frames followed by `END`; its writable stream
closes only after the agent replies with `END`, so late write errors are not
lost.

An open file owns one connection and one guest file descriptor. Its commands
are serialized by the host. Closing the connection closes the descriptor.

## Processes

Each process owns four connections: control, stdin, stdout, and stderr. The
control prelude contains argv, cwd, and environment and creates a bounded
process slot. The guest returns an opaque session token but does not start the
child. The host attaches the three stream connections with that token, then
sends `START` on control. This makes partially connected children
unrepresentable.

Signals and final status use the control connection. stdin carries data and an
explicit `END`. stdout and stderr carry data and `END` independently. The
control and each stdio channel are serviced independently, so backpressure on
one channel does not stop signals or either of the other channels.

Process slots have these states:

```text
attaching -> running -> exited -> closed
          \-> cancelled ------/
```

An attachment failure discards the slot. Losing control kills and reaps the
child. Losing stdin delivers EOF. Losing an output connection makes the agent
drain and discard that pipe so the child does not receive `SIGPIPE`. Status is
reported only after the child has exited and both output pipes have reached
EOF.

## Ownership and bounds

The agent has twelve request workers, a bounded queue of 32 connections, and
two process slots. Request metadata is allocated only after its length has
been validated and is owned by its queued request. A process occupies four
workers while it is running: one for control and one for each stdio channel.
Exhaustion returns `EAGAIN`; the agent never creates an unbounded thread,
allocation, process, or queue.

Closing a request connection releases the associated directory or file.
Closing process control kills and reaps the process. Closing the machine closes
every vsock connection, terminates every worker, and rejects every pending host
operation.

An incompatible wire change increments the protocol version and updates both
endpoints in the same package release.
