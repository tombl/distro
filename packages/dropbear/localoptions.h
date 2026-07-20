/* Build-time configuration for the wasm32-unknown-linux-musl port.
 *
 * The platform has no fork()/vfork() (the symbols do not exist, so any
 * reference fails to link), no AF_UNIX, and the guest kernel does not deliver
 * SIGALRM. Every option here either removes a fork()/daemon()/popen() call site
 * that cannot link, or drops a feature that depends on an unavailable facility.
 * The fork()+exec() site that DOES survive (running the user's command) is
 * rewritten to posix_spawn in wasm-posix-spawn.patch. */

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

/* Agent forwarding uses AF_UNIX sockets, which the guest kernel rejects. */
#define DROPBEAR_SVR_AGENTFWD 0
#define DROPBEAR_CLI_AGENTFWD 0

/* X11 forwarding shells out to xauth via popen(); unavailable. (Already 0 by
 * default, set explicitly for the record.) */
#define DROPBEAR_X11FWD 0

/* sftp-server is OpenSSH's binary, not shipped here. scp needs a remote-side
 * binary too and is not built. */
#define DROPBEAR_SFTPSERVER 0

/* Sane guest search paths for the spawned shell/command. */
#define DEFAULT_PATH "/bin:/usr/bin:/sbin:/usr/sbin"
#define DEFAULT_ROOT_PATH "/bin:/usr/bin:/sbin:/usr/sbin"
