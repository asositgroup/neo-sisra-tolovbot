#!/usr/bin/python3 -I
"""Root-installed public-repository updater; repository code runs only in a test unit.

Install this reviewed file outside the checkout. It never imports downloaded
Python, runs package scripts, installs dependencies, or reads bot credentials.
The fixed test unit must use a separate sandboxed user, no network or sudo, and
kill its entire cgroup on completion. All snapshot files remain root-owned.
"""

import fcntl
import gzip
import io
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request


REPOSITORY = "https://github.com/asositgroup/neo-sisra-tolovbot.git"
CODELOAD = "https://codeload.github.com/asositgroup/neo-sisra-tolovbot/tar.gz/"
ROOT = Path("/var/lib/neo-sisra-ci-test")
SNAPSHOT = ROOT / "snapshot"
FAILED = ROOT / ".last-failed-sha"
LOCK = Path("/run/lock/neo-sisra-bot-poll.lock")
BOT_BASE = Path("/opt/neo-sisra-pay-bot")
CURRENT = BOT_BASE / "current"
TEST_UNIT = "neo-sisra-bot-tests.service"
DEPLOYER = "/usr/local/sbin/neo-sisra-bot-deploy"
RUNTIME_FILES = frozenset(("bot.js", "google-delivery.cjs", "telegram-http.cjs", "package.json"))
REQUIRED = RUNTIME_FILES | frozenset((
    "deploy/server-deploy.py", "deploy/ssh-entry.sh", "deploy/tests/test_server_deploy.py",
    "deploy/server-poll.py", "deploy/tests/test_server_poll.py",
    "tests/bot-flow.test.cjs", "tests/google-delivery.test.cjs",
    "tests/shutdown.test.cjs", "tests/telegram-http.test.cjs",
))
SHA_RE = re.compile(r"[0-9a-f]{40}\Z", re.ASCII)
NODE_TEST_RE = re.compile(r"tests/[A-Za-z0-9_-]+[.]test[.]cjs\Z", re.ASCII)
MAX_COMPRESSED = 16 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_FILE = 4 * 1024 * 1024
MAX_ENTRIES = 1024
COMMAND_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/nonexistent",
    "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0",
    "SYSTEMD_PAGER": "cat", "SYSTEMD_COLORS": "0",
}


class PollError(Exception):
    """Messages are fixed and safe for the journal."""


def validate_sha(value):
    if not SHA_RE.fullmatch(value):
        raise PollError("invalid commit identifier")
    return value


def secure_directory(path):
    metadata = path.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0
            or metadata.st_mode & 0o022):
        raise PollError("updater directory ownership or permissions are unsafe")


def command(arguments, timeout, capture=False, payload=None):
    try:
        return subprocess.run(arguments, input=payload, cwd="/", env=COMMAND_ENV,
                              stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise PollError("an updater command failed or exceeded its deadline") from None


def remote_sha():
    result = command([
        "/usr/bin/git", "-c", "core.hooksPath=/dev/null",
        "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
        "ls-remote", "--exit-code", REPOSITORY, "refs/heads/main",
    ], timeout=45, capture=True)
    if result.returncode != 0:
        raise PollError("could not read the repository main branch")
    match = re.fullmatch(rb"([0-9a-f]{40})\trefs/heads/main\n?", result.stdout)
    if not match:
        raise PollError("repository returned an unexpected branch response")
    return match.group(1).decode("ascii")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PollError("archive endpoint unexpectedly redirected")


def download(sha):
    validate_sha(sha)
    request = urllib.request.Request(CODELOAD + sha, headers={"User-Agent": "Neo-Sisra-Server-Updater"})
    # Ignore inherited proxy settings; only the fixed public HTTPS endpoint is used.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + 60
    chunks = []
    total = 0
    try:
        with opener.open(request, timeout=20) as response:
            if response.status != 200 or response.geturl() != CODELOAD + sha:
                raise PollError("archive endpoint returned an unexpected response")
            while True:
                if time.monotonic() >= deadline:
                    raise PollError("archive download exceeded its deadline")
                chunk = response.read(min(65536, MAX_COMPRESSED - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_COMPRESSED:
                    raise PollError("repository archive exceeds the size limit")
                chunks.append(chunk)
    except (OSError, urllib.error.URLError, ValueError):
        raise PollError("repository archive could not be downloaded") from None
    if not total:
        raise PollError("repository archive is empty")
    return b"".join(chunks)


def snapshot_files(compressed, sha):
    validate_sha(sha)
    if not compressed or len(compressed) > MAX_COMPRESSED:
        raise PollError("repository archive exceeds the size limit")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as source:
            expanded = source.read(MAX_EXPANDED + 1)
        if len(expanded) > MAX_EXPANDED:
            raise PollError("expanded repository exceeds the size limit")
        selected = {}
        seen = set()
        prefix = "neo-sisra-tolovbot-" + sha
        with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
            for count, member in enumerate(archive, 1):
                if count > MAX_ENTRIES:
                    raise PollError("repository has too many archive entries")
                name = member.name.rstrip("/") if member.isdir() else member.name
                parts = name.split("/")
                if (not parts or parts[0] != prefix or any(part in ("", ".", "..") for part in parts)
                        or PurePosixPath(name).is_absolute() or "\\" in name or name in seen):
                    raise PollError("repository archive contains an unsafe or duplicate path")
                seen.add(name)
                if member.linkname or not (member.isdir() or member.isreg()):
                    raise PollError("repository archive contains unsupported file types")
                if member.isdir():
                    if member.size:
                        raise PollError("repository archive has an invalid directory")
                    continue
                if member.size < 0 or member.size > MAX_FILE:
                    raise PollError("repository file exceeds the size limit")
                relative = "/".join(parts[1:])
                if relative in REQUIRED or NODE_TEST_RE.fullmatch(relative):
                    source = archive.extractfile(member)
                    if source is None:
                        raise PollError("repository file could not be read")
                    content = source.read(MAX_FILE + 1)
                    if len(content) != member.size:
                        raise PollError("repository file is truncated")
                    selected[relative] = content
        if not REQUIRED.issubset(selected):
            raise PollError("repository is missing required code or tests")
        return selected
    except (OSError, EOFError, tarfile.TarError, ValueError):
        raise PollError("repository archive is malformed") from None


def install_snapshot(files):
    secure_directory(ROOT)
    staging = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=ROOT))
    previous = ROOT / ".previous-snapshot"
    try:
        for name, content in files.items():
            if name not in REQUIRED and not NODE_TEST_RE.fullmatch(name):
                raise PollError("unexpected snapshot file")
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with target.open("xb") as output:
                output.write(content)
            target.chmod(0o644)
        staging.chmod(0o755)
        if previous.exists() or previous.is_symlink():
            secure_directory(previous)
            shutil.rmtree(previous)
        if SNAPSHOT.exists() or SNAPSHOT.is_symlink():
            secure_directory(SNAPSHOT)
            os.rename(SNAPSHOT, previous)
        os.rename(staging, SNAPSHOT)
        staging = None
        if previous.exists():
            secure_directory(previous)
            shutil.rmtree(previous)
    finally:
        if staging is not None:
            secure_directory(staging)
            shutil.rmtree(staging)


def failed_sha():
    try:
        descriptor = os.open(FAILED, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_mode & 0o077 or metadata.st_nlink != 1):
            raise PollError("updater state permissions are unsafe")
        value = source.read(42).decode("ascii")
    return validate_sha(value.strip())


def mark_attempt(sha):
    descriptor, temporary = tempfile.mkstemp(prefix=".attempt-", dir=ROOT)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write((validate_sha(sha) + "\n").encode("ascii"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, FAILED)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def release_archive(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(RUNTIME_FILES):
            content = files[name]
            info = tarfile.TarInfo(name)
            info.mode = 0o644
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return gzip.compress(output.getvalue(), mtime=0)


def active_sha():
    secure_directory(BOT_BASE)
    if not CURRENT.is_symlink():
        raise PollError("active release pointer is missing")
    release = CURRENT.resolve(strict=True)
    if release.parent != BOT_BASE / "releases":
        raise PollError("active release pointer is outside the release directory")
    secure_directory(release)
    return validate_sha(release.name)


def poll():
    secure_directory(ROOT)
    sha = remote_sha()
    if sha == active_sha():
        print("Repository main already matches the active bot release.")
        return
    if sha == failed_sha():
        print("This commit requires operator retry after a previous failed or interrupted update.")
        return
    files = snapshot_files(download(sha), sha)
    # Stop any previous/manual test invocation before replacing its read-only snapshot.
    if command(["/usr/bin/systemctl", "stop", TEST_UNIT], timeout=45).returncode:
        raise PollError("previous test invocation could not be stopped")
    install_snapshot(files)
    # A crash or ambiguous deployment must not trigger a repeating restart loop.
    mark_attempt(sha)
    try:
        tested = command(["/usr/bin/systemctl", "start", TEST_UNIT], timeout=330)
    except PollError:
        command(["/usr/bin/systemctl", "stop", TEST_UNIT], timeout=45)
        raise
    if tested.returncode:
        raise PollError("offline tests failed; active bot release was preserved")
    # Bytes are retained in trusted orchestrator memory, not reread from test output.
    # Never SIGKILL the deployer at a Python timeout: it may be restoring the
    # previous release. The trusted poll unit bounds the total run and sends
    # SIGTERM with enough stop grace for the deployer's rollback handler.
    result = command([DEPLOYER, sha], timeout=None, payload=release_archive(files))
    if result.returncode:
        raise PollError("deployment did not confirm readiness; inspect deployment service state")
    if active_sha() != sha:
        raise PollError("deployment returned without selecting the expected release")
    FAILED.unlink()
    print("Repository commit " + sha + " passed tests and is deployed.")


def main():
    os.umask(0o022)
    try:
        if len(sys.argv) != 1 or os.geteuid() != 0:
            raise PollError("updater requires root and accepts no arguments")
        descriptor = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "r+b") as lock:
            metadata = os.fstat(lock.fileno())
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                    or metadata.st_mode & 0o077 or metadata.st_nlink != 1):
                raise PollError("updater lock permissions are unsafe")
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("Another update is already running.")
                return 0
            poll()
        return 0
    except PollError as error:
        print("Automatic update stopped: " + str(error) + ".", file=sys.stderr)
        return 1
    except Exception:
        print("Automatic update failed; operator inspection is required.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
