/* Build-time configuration for the wasm32-unknown-linux-musl port.
 *
 * The platform has no fork()/vfork() (the symbols do not exist, so any
 * reference fails to link). Every option here removes a fork(), daemon(), or
 * popen() call site that cannot link. Ordinary exec children use posix_spawn;
 * PTY session children use callback clone for their pre-exec session setup. */

/* Inetd-only. NON_INETD_MODE is the accept()-loop server that fork()s a child
 * per connection (svr-main.c) and daemon()ises; both are unlinkable here. The
 * server runs as `dropbear -i`, one connection on stdin/stdout, launched
 * per-connection by an external listener. DROPBEAR_REEXEC (fexecve self
 * re-exec, a NON_INETD privilege-separation trick) is off for the same reason. */
#define NON_INETD_MODE 0
#define INETD_MODE 1
#define DROPBEAR_REEXEC 0

/* Public-key authentication only, on both ends.
 *  - Server password auth is dropped: it would need crypt()/shadow and a real
 *    user database the guest does not have.
 *  - Client password and keyboard-interactive auth (the latter is defined in
 *    terms of the former in sysoptions.h) are dropped so that a failed pubkey
 *    auth fails cleanly and immediately instead of blocking on a tty password
 *    prompt that never arrives, and so the fork()ing SSH_ASKPASS helper in
 *    cli-authpasswd.c is never compiled. */
#define DROPBEAR_SVR_PASSWORD_AUTH 0
#define DROPBEAR_SVR_PUBKEY_AUTH 1
#define DROPBEAR_CLI_PASSWORD_AUTH 0

/* Client ProxyCommand/-J run a helper via spawn_command (posix_spawn here) but
 * are exercised through a code path (cli-main.c cli_proxy_cmd) we do not port;
 * compile them out so the only spawn_command caller is the server session. */
#define DROPBEAR_CLI_PROXYCMD 0
#define DROPBEAR_CLI_NETCAT 0

/* AF_UNIX sockets are available, so both ends of agent forwarding are built. */
#define DROPBEAR_SVR_AGENTFWD 1
#define DROPBEAR_CLI_AGENTFWD 1

/* X11 forwarding shells out to xauth via popen(); unavailable. (Already 0 by
 * default, set explicitly for the record.) */
#define DROPBEAR_X11FWD 0

/* sftp-server is OpenSSH's binary, not shipped here. scp needs a remote-side
 * binary too and is not built. */
#define DROPBEAR_SFTPSERVER 0

/* Sane guest search paths for the spawned shell/command. */
#define DEFAULT_PATH "/bin:/usr/bin:/sbin:/usr/sbin"
#define DEFAULT_ROOT_PATH "/bin:/usr/bin:/sbin:/usr/sbin"
