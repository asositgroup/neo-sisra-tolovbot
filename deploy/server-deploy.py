#!/usr/bin/python3 -I
"""Root-installed, narrow stdin-only release deployer; never installs packages.

Install root:root 0755 at /usr/local/sbin/neo-sisra-bot-deploy. The deployment
account must have sudo permission for this program only. The base/releases
directories and an initial releases/<40-hex-SHA> current target must already
exist and be owned by root. Existing .env and data remain at the base directory.
"""

import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid


BASE = Path("/opt/neo-sisra-pay-bot")
RELEASES = BASE / "releases"
CURRENT = BASE / "current"
LOCK = Path("/run/lock/neo-sisra-pay-bot-deploy.lock")
UNIT = "neo-sisra-pay-bot.service"
RUNTIME_USER = "neo-sisra-bot"
FILES = frozenset(("bot.js", "google-delivery.cjs", "telegram-http.cjs", "package.json"))
JS_FILES = ("bot.js", "google-delivery.cjs", "telegram-http.cjs")
STATE_NAMES = frozenset((".env", "data"))
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z", re.ASCII)
INVOCATION_PATTERN = re.compile(r"[0-9a-f]{32}\Z", re.ASCII)
MAX_ARCHIVE = 16 * 1024 * 1024
MAX_FILE = 4 * 1024 * 1024
MAX_EXPANDED = 17 * 1024 * 1024
READY_LINE = b"Neo Sisra polling ready."
RESTART_TIMEOUT = 330  # Unit's graceful stop may take up to 260 seconds.
READY_TIMEOUT = 60
COMMAND_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C.UTF-8",
    "HOME": "/nonexistent",
    "SYSTEMD_PAGER": "cat",
    "SYSTEMD_COLORS": "0",
}


class DeploymentError(Exception):
    """Only fixed, non-sensitive messages are shown to the SSH caller."""


def validate_sha(value):
    if not SHA_PATTERN.fullmatch(value):
        raise DeploymentError("expected one full, lowercase 40-character commit SHA")
    return value


def secure_directory(path):
    try:
        metadata = path.lstat()
    except OSError:
        raise DeploymentError("required root-owned deployment directory is missing") from None
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0
            or metadata.st_mode & 0o022):
        raise DeploymentError("deployment directory ownership or permissions are unsafe")


def check_state():
    # Inspect only metadata: never read, copy, or display state or credentials.
    try:
        env_metadata = (BASE / ".env").lstat()
        data_metadata = (BASE / "data").lstat()
    except OSError:
        raise DeploymentError("existing shared state is missing") from None
    if not stat.S_ISREG(env_metadata.st_mode) or not stat.S_ISDIR(data_metadata.st_mode):
        raise DeploymentError("shared state must be a regular .env file and data directory")


def check_state_links(release):
    for name in STATE_NAMES:
        link = release / name
        if not link.is_symlink() or os.readlink(link) != str(BASE / name):
            raise DeploymentError("release has an invalid shared-state link")


def previous_release():
    if not CURRENT.is_symlink():
        raise DeploymentError("a current fallback release must be installed first")
    try:
        release = CURRENT.resolve(strict=True)
    except (OSError, RuntimeError):
        raise DeploymentError("current fallback release cannot be resolved") from None
    if release.parent != RELEASES or not SHA_PATTERN.fullmatch(release.name):
        raise DeploymentError("current fallback must refer to releases/<full-commit-SHA>")
    secure_directory(release)
    check_state_links(release)
    for name in FILES:
        check_code_file(release / name)
    return release


def check_code_file(path):
    try:
        metadata = path.lstat()
    except OSError:
        raise DeploymentError("a release code file is missing") from None
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
            or metadata.st_mode & 0o022 or metadata.st_nlink != 1
            or metadata.st_size > MAX_FILE):
        raise DeploymentError("release code file ownership, type, size, or permissions are unsafe")


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DeploymentError("package.json contains duplicate keys")
        result[key] = value
    return result


def reject_json_constant(_value):
    raise DeploymentError("package.json is not valid JSON")


def validate_package(content):
    try:
        package = json.loads(content.decode("utf-8"), object_pairs_hook=reject_duplicate_keys,
                             parse_constant=reject_json_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise DeploymentError("package.json is not valid UTF-8 JSON") from None
    if not isinstance(package, dict):
        raise DeploymentError("package.json must contain an object")
    for name in ("dependencies", "optionalDependencies", "peerDependencies"):
        if name in package and (not isinstance(package[name], dict) or package[name]):
            raise DeploymentError("runtime dependencies are not supported by this deployer")
    for name in ("bundledDependencies", "bundleDependencies"):
        if name in package and (not isinstance(package[name], list) or package[name]):
            raise DeploymentError("bundled dependencies are not supported by this deployer")


class BoundedGzip:
    def __init__(self, compressed):
        self.stream = gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb")
        self.total = 0

    def read(self, size):
        # One-byte excess detects even a highly compressed expansion attack.
        data = self.stream.read(min(size, MAX_EXPANDED - self.total + 1))
        self.total += len(data)
        if self.total > MAX_EXPANDED:
            raise DeploymentError("expanded archive exceeds the permitted size")
        return data

    def exact(self, size):
        data = self.read(size)
        if len(data) != size:
            raise DeploymentError("archive is truncated")
        return data


def extract_archive(source, staging):
    compressed = source.read(MAX_ARCHIVE + 1)
    if not compressed or len(compressed) > MAX_ARCHIVE:
        raise DeploymentError("compressed archive is empty or exceeds 16 MiB")
    archive = BoundedGzip(compressed)
    found = set()
    hashes = {}
    try:
        while True:
            block = archive.exact(tarfile.BLOCKSIZE)
            if block == bytes(tarfile.BLOCKSIZE):
                if archive.exact(tarfile.BLOCKSIZE) != bytes(tarfile.BLOCKSIZE):
                    raise DeploymentError("archive has an invalid end marker")
                # Reject a concatenated tar archive and any nonzero trailing data.
                while True:
                    tail = archive.read(64 * 1024)
                    if not tail:
                        break
                    if any(tail):
                        raise DeploymentError("archive contains unexpected trailing content")
                break
            # Read each physical header ourselves: tarfile's high-level iterator
            # hides PAX/global/long-name records, which this strict format forbids.
            entry = tarfile.TarInfo.frombuf(block, "utf-8", "strict")
            if (entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
                    or entry.name not in FILES or entry.linkname):
                raise DeploymentError("archive must contain only the four allowed regular files")
            if entry.name in found:
                raise DeploymentError("archive contains a duplicate file")
            if entry.size < 0 or entry.size > MAX_FILE:
                raise DeploymentError("archive file exceeds 4 MiB")
            found.add(entry.name)
            content = archive.exact(entry.size)
            padding = (-entry.size) % tarfile.BLOCKSIZE
            if padding and any(archive.exact(padding)):
                raise DeploymentError("archive has invalid file padding")
            if entry.name == "package.json":
                validate_package(content)
            target = staging / entry.name
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fchmod(output.fileno(), 0o644)
                os.fsync(output.fileno())
            hashes[entry.name] = hashlib.sha256(content).hexdigest()
    except (tarfile.TarError, OSError, EOFError, UnicodeError, ValueError):
        raise DeploymentError("archive is malformed or could not be safely extracted") from None
    finally:
        archive.stream.close()
    if found != FILES:
        raise DeploymentError("archive is missing required files")
    return hashes


def command(arguments, timeout=15, capture=False):
    try:
        return subprocess.run(arguments, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, env=COMMAND_ENV,
                              cwd="/", timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise DeploymentError("a required deployment command failed or timed out") from None


def validate_javascript(release):
    for name in JS_FILES:
        result = command(["/usr/sbin/runuser", "-u", RUNTIME_USER, "--",
                          "/usr/bin/node", "--check", str(release / name)], timeout=30)
        if result.returncode != 0:
            raise DeploymentError("JavaScript syntax validation failed")


def same_release(release, expected_hashes):
    secure_directory(release)
    if {entry.name for entry in release.iterdir()} != FILES | STATE_NAMES:
        raise DeploymentError("existing commit release contains unexpected files")
    check_state_links(release)
    for name in FILES:
        check_code_file(release / name)
        if hashlib.sha256((release / name).read_bytes()).hexdigest() != expected_hashes[name]:
            raise DeploymentError("existing commit release does not match the uploaded files")


def switch_current(release):
    temporary = BASE / (".current-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(release, target_is_directory=True)
        os.replace(temporary, CURRENT)
        directory_fd = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def invocation_id(timeout=15):
    result = command(["/usr/bin/systemctl", "show", "--property=InvocationID", "--value", UNIT],
                     capture=True, timeout=timeout)
    if result.returncode != 0:
        raise DeploymentError("could not inspect the service invocation")
    value = result.stdout.decode("ascii", errors="replace").strip()
    if value and not INVOCATION_PATTERN.fullmatch(value):
        raise DeploymentError("service returned an invalid invocation identifier")
    return value


def restart_service():
    if command(["/usr/bin/systemctl", "restart", UNIT], timeout=RESTART_TIMEOUT).returncode != 0:
        raise DeploymentError("service restart failed")


def service_active(timeout=15):
    return command(["/usr/bin/systemctl", "is-active", "--quiet", UNIT], timeout=timeout).returncode == 0


def wait_ready(old_invocation):
    deadline = time.monotonic() + READY_TIMEOUT

    def remaining(maximum=15):
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise DeploymentError("service did not become ready within 60 seconds")
        return min(maximum, seconds)

    expected = invocation_id(timeout=remaining())
    if not expected or expected == old_invocation:
        raise DeploymentError("service did not start a fresh invocation")
    while time.monotonic() < deadline:
        if invocation_id(timeout=remaining()) != expected:
            raise DeploymentError("service invocation changed before readiness")
        ready = command([
            "/usr/bin/journalctl", "--quiet", "--no-pager", "--output=cat", "--lines=1",
            "--unit=" + UNIT, "_SYSTEMD_INVOCATION_ID=" + expected,
            "--grep=^Neo Sisra polling ready[.]$",
        ], capture=True, timeout=remaining(10))
        if (ready.returncode == 0 and ready.stdout.strip() == READY_LINE
                and service_active(timeout=remaining()) and invocation_id(timeout=remaining()) == expected):
            return
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise DeploymentError("service did not become ready within 60 seconds")


def clean_staging(staging):
    # Never recursively remove a release, state directory, or a resolved symlink.
    if staging is None:
        return
    if staging.parent != RELEASES or not staging.name.startswith(".staging-"):
        raise DeploymentError("refusing to clean an unexpected staging path")
    secure_directory(staging)
    shutil.rmtree(staging)


def deploy(sha, source):
    secure_directory(BASE)
    secure_directory(RELEASES)
    check_state()
    previous = previous_release()
    staging = Path(tempfile.mkdtemp(prefix=".staging-" + sha + "-", dir=RELEASES))
    try:
        hashes = extract_archive(source, staging)
        for name in STATE_NAMES:
            (staging / name).symlink_to(BASE / name, target_is_directory=(name == "data"))
        staging.chmod(0o755)
        validate_javascript(staging)
        release = RELEASES / sha
        if release.exists() or release.is_symlink():
            same_release(release, hashes)
        else:
            os.rename(staging, release)
            staging = None
        old_invocation = invocation_id()
        # Treat any failure during/after the atomic switch as a rollback case,
        # including a directory fsync failure after os.replace has succeeded.
        try:
            switch_current(release)
            restart_service()
            wait_ready(old_invocation)
        except BaseException:
            # Finish the bounded rollback even when the SSH client disconnects.
            for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(signum, signal.SIG_IGN)
            try:
                switch_current(previous)
                failed_invocation = invocation_id()
                restart_service()
                wait_ready(failed_invocation)
            except BaseException:
                raise DeploymentError("deployment failed and rollback could not be confirmed; operator recovery required") from None
            raise DeploymentError("deployment failed; previous release restored and service restarted") from None
    finally:
        clean_staging(staging)


def interrupted(_signum, _frame):
    raise DeploymentError("deployment interrupted")


def main():
    os.umask(0o022)
    try:
        if len(sys.argv) != 2:
            raise DeploymentError("expected one commit SHA argument and a tar.gz archive on stdin")
        sha = validate_sha(sys.argv[1])
        if os.geteuid() != 0:
            raise DeploymentError("this deployment entry point must run as root")
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, interrupted)
        # /run/lock is system-owned; reject pre-existing symlinks or unsafe files.
        descriptor = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "r+b") as lock:
            metadata = os.fstat(lock.fileno())
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                    or metadata.st_mode & 0o077 or metadata.st_nlink != 1):
                raise DeploymentError("deployment lock permissions are unsafe")
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            deploy(sha, sys.stdin.buffer)
        print("Deployment " + sha + " is ready.")
        return 0
    except DeploymentError as error:
        print("Deployment rejected: " + str(error) + ".", file=sys.stderr)
        return 1
    except Exception:
        # Do not leak command output, archive content, file content, or environment.
        print("Deployment failed; inspect deployment setup with an operator.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
