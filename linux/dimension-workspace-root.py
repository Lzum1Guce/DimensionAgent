#!/usr/bin/python3
"""Provision one fixed-size, per-Bot ext4 workspace with kernel block and inode quotas."""
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

VOLUME_BYTES = 512 * 1024**2
QUOTA_BYTES = 448 * 1024**2
MAX_INODES = 16384
UID = 1000
GID = 1002
BASE = Path("/var/lib/dimension/managed")
IMAGES = Path("/var/lib/dimension/managed-volumes")


def run(arguments):
    subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=True)


class Dqblk(ctypes.Structure):
    _fields_ = [
        ("bhard", ctypes.c_uint64), ("bsoft", ctypes.c_uint64),
        ("curspace", ctypes.c_uint64), ("ihard", ctypes.c_uint64),
        ("isoft", ctypes.c_uint64), ("curinodes", ctypes.c_uint64),
        ("btime", ctypes.c_uint64), ("itime", ctypes.c_uint64),
        ("valid", ctypes.c_uint32), ("id", ctypes.c_uint32),
        ("padding", ctypes.c_uint32 * 4),
    ]


def set_quota(device, include_user=True):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.quotactl.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
    libc.quotactl.restype = ctypes.c_int
    targets = [(1, GID, True)]
    if include_user:
        targets.insert(0, (0, UID, False))
    for qtype, qid, required in targets:
        value = Dqblk()
        # Linux quota block limits use 1024-byte units, not bytes.
        value.bhard = QUOTA_BYTES // 1024
        value.bsoft = QUOTA_BYTES // 1024
        value.ihard = MAX_INODES
        value.isoft = MAX_INODES
        value.valid = 3  # QIF_BLIMITS | QIF_ILIMITS
        command = (0x800008 << 8) | qtype
        if libc.quotactl(command, os.fsencode(device), qid, ctypes.byref(value)) != 0:
            error = ctypes.get_errno()
            if not required and error in (errno.ESRCH, errno.EINVAL, errno.ENOSYS):
                continue
            raise OSError(error, os.strerror(error))


def ensure(key):
    if not re.fullmatch(r"bot-[0-9a-f]{32}", key):
        raise ValueError("invalid managed workspace key")
    BASE.mkdir(parents=True, exist_ok=True)
    IMAGES.mkdir(parents=True, exist_ok=True)
    if BASE.is_symlink() or IMAGES.is_symlink():
        raise RuntimeError("managed workspace root must not be a symbolic link")
    lock_path = Path("/var/lib/dimension/.dimension-managed.lock")
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        image = IMAGES / (key + ".img")
        mountpoint = BASE / key
        if image.is_symlink() or mountpoint.is_symlink():
            raise RuntimeError("managed workspace target must not be a symbolic link")
        mountpoint.mkdir(exist_ok=True)
        created = False
        mounted_here = False
        user_quota_mounted = False
        try:
            if not image.exists():
                descriptor = os.open(image, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    os.ftruncate(descriptor, VOLUME_BYTES)
                finally:
                    os.close(descriptor)
                created = True
                run(["/usr/sbin/mkfs.ext4", "-q", "-F", "-O", "quota", str(image)])
            stat_info = image.lstat()
            if stat_info.st_size != VOLUME_BYTES or not image.is_file():
                raise RuntimeError("invalid managed workspace image")
            if not os.path.ismount(mountpoint):
                try:
                    run(["/usr/bin/mount", "-o", "loop,nosuid,nodev,usrquota,grpquota", str(image), str(mountpoint)])
                    user_quota_mounted = True
                except subprocess.CalledProcessError:
                    run(["/usr/bin/mount", "-o", "loop,nosuid,nodev,grpquota", str(image), str(mountpoint)])
                mounted_here = True
            os.chmod(mountpoint, 0o775)
            os.chown(mountpoint, UID, GID)
            listing = subprocess.check_output(["/usr/sbin/losetup", "-j", str(image)], text=True)
            device = listing.split(":", 1)[0].strip()
            if not device.startswith("/dev/loop"):
                raise RuntimeError("managed workspace has no loop device")
            set_quota(device, include_user=user_quota_mounted)
            return {"ok": True, "key": key, "linuxPath": str(mountpoint),
                    "volumeBytes": VOLUME_BYTES, "writeQuotaBytes": QUOTA_BYTES,
                    "uid": UID, "gid": GID, "filesystem": "ext4", "quotaKind": "kernel-group"}
        except BaseException:
            if mounted_here:
                subprocess.run(["/usr/bin/umount", "-l", str(mountpoint)],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if created:
                image.unlink(missing_ok=True)
            raise


def main():
    try:
        raw_line = sys.stdin.readline(4096)
        if len(raw_line) >= 4096 and not raw_line.endswith("\n"):
            raise ValueError("managed workspace request exceeds maximum size")
        request = json.loads(raw_line)
        if not isinstance(request, dict) or set(request) != {"operation", "key"} or request["operation"] != "ensure":
            raise ValueError("invalid managed workspace request")
        result = ensure(request["key"])
    except Exception as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
