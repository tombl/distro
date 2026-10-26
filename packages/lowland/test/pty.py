# SPDX-License-Identifier: MIT
"""Runs a command on a new pseudoterminal for the lowland run tests.

Usage: pty.py ROWS COLUMNS COMMAND...

The command leads a new session with the terminal as its controlling
terminal, as it would in a terminal emulator. Requests arrive on stdin and
events leave on stdout, one JSON object per line:

  {"write": text}            types text on the terminal
  {"resize": [rows, columns]} resizes the terminal, which signals SIGWINCH
  {"signal": name}           sends a signal to the command
  {"termios": true}          replies {"termios": {"icanon", "echo", "isig",
                             "opost"}}

  {"output": text}           what the terminal displayed
  {"exit": code, "restored": bool}
                             the command's exit code, as a shell reports it,
                             and whether it left the terminal's modes as
                             they were before it started

The end of stdin SIGKILLs the command's process group and ends the
harness, and so does the harness exiting, so a test that gives up on the
command leaves nothing behind.
"""

import codecs
import fcntl
import json
import os
import selectors
import signal
import struct
import sys
import termios


def window(fd, rows, columns):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def kill_group(pid):
    # The child stays unreaped until the harness ends, so its pid and group
    # cannot belong to another process yet. It is killed itself too, in case
    # it has not created its session.
    for kill in (os.killpg, os.kill):
        try:
            kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main():
    rows, columns, *command = sys.argv[1:]
    master, slave = os.openpty()
    window(slave, int(rows), int(columns))
    before = termios.tcgetattr(slave)
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        os.close(slave)
        os.execvp(command[0], command)

    # The harness keeps the terminal's slave side open, so reading the
    # master never fails before the command is reaped and its modes stay
    # readable afterwards.
    try:
        run(master, slave, pid, before)
    finally:
        kill_group(pid)
        os.waitpid(pid, 0)


def run(master, slave, pid, before):
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ, "output")
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "request")
    pending = b""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    status = None
    quiet = 0
    closing = False
    while True:
        if status is None:
            # Observe the exit without reaping, which kill_group relies on.
            exited = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if exited:
                # A command killed by a signal exits 128 plus the signal, as
                # in a shell.
                killed = exited.si_code in (os.CLD_KILLED, os.CLD_DUMPED)
                status = 128 + exited.si_status if killed else exited.si_status
        events = selector.select(0.1)
        if status is not None and closing:
            break
        if status is not None and not any(key.data == "output" for key, _ in events):
            # Output the command wrote just before it exited is still
            # delivered, until the terminal stays quiet.
            quiet += 1
            if quiet >= 3:
                break
        for key, _ in events:
            if key.data == "output":
                quiet = 0
                send({"output": decoder.decode(os.read(master, 65536))})
                continue
            data = os.read(key.fd, 65536)
            if not data:
                selector.unregister(key.fd)
                # The leader may be gone while its descendants still run.
                kill_group(pid)
                closing = True
                continue
            pending += data
            *lines, pending = pending.split(b"\n")
            for line in lines:
                request = json.loads(line)
                if "write" in request:
                    os.write(master, request["write"].encode())
                elif "resize" in request:
                    window(master, *request["resize"])
                elif "signal" in request:
                    os.kill(pid, getattr(signal, request["signal"]))
                elif "termios" in request:
                    modes = termios.tcgetattr(slave)
                    send(
                        {
                            "termios": {
                                "icanon": bool(modes[3] & termios.ICANON),
                                "echo": bool(modes[3] & termios.ECHO),
                                "isig": bool(modes[3] & termios.ISIG),
                                "opost": bool(modes[1] & termios.OPOST),
                            }
                        }
                    )
    send({"exit": status, "restored": termios.tcgetattr(slave) == before})


main()
