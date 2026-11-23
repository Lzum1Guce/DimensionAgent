#!/usr/bin/python3
"""Enter bwrap with exactly UID 1000 and GID 1002 mapped, without newuidmap."""
import ctypes
import os
import signal
import sys

CLONE_NEWUSER = 0x10000000


def write(path, value):
    with open(path, "w", encoding="ascii") as stream:
        stream.write(value)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(64)
    ready_read, ready_write = os.pipe()
    proceed_read, proceed_write = os.pipe()
    pid = os.fork()
    if pid:
        os.close(ready_write)
        os.close(proceed_read)
        descriptor = -1
        reaped = False
        try:
            if os.read(ready_read, 1) != b"r":
                raise RuntimeError("user namespace setup failed")
            is_root = (os.geteuid() == 0)
            write(f"/proc/{pid}/setgroups", "allow" if is_root else "deny")
            write(f"/proc/{pid}/uid_map", "1000 1000 1\n")
            write(f"/proc/{pid}/gid_map", "1002 1002 1\n")
            descriptor = os.open(f"/proc/{pid}/ns/user", os.O_RDONLY)
            os.set_inheritable(descriptor, True)
            os.write(proceed_write, b"p")
            os.close(proceed_write)
            proceed_write = -1
            os.close(ready_read)
            ready_read = -1
            _, status = os.waitpid(pid, 0)
            reaped = True
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                raise RuntimeError("user namespace holder failed")
            if is_root:
                os.setgroups([1002])
                os.setresgid(1002, 1002, 1002)
                os.setresuid(1000, 1000, 1000)
            arguments = ["/usr/bin/bwrap", "--userns", str(descriptor)] + sys.argv[1:]
            os.execv(arguments[0], arguments)
        except BaseException:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if proceed_write >= 0:
                try:
                    os.close(proceed_write)
                except OSError:
                    pass
            if ready_read >= 0:
                try:
                    os.close(ready_read)
                except OSError:
                    pass
            if not reaped:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    os.waitpid(pid, 0)
                except OSError:
                    pass
            raise

    os.close(ready_read)
    os.close(proceed_write)
    # The bwrap process joins as UID 1000. Create the namespace with that owner.
    if os.geteuid() == 0:
        os.setgroups([1002])
        os.setresgid(1002, 1002, 1002)
        os.setresuid(1000, 1000, 1000)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(CLONE_NEWUSER) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    os.write(ready_write, b"r")
    os.close(ready_write)
    if os.read(proceed_read, 1) != b"p":
        raise SystemExit(125)
    os.close(proceed_read)
    raise SystemExit(0)


if __name__ == "__main__":
    main()
