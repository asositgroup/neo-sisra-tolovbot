"""Offline updater tests; all network, systemd and deployment calls are mocked."""

import gzip
import importlib.util
import io
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location("server_poll", Path(__file__).resolve().parents[1] / "server-poll.py")
poller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(poller)
SHA = "a" * 40
OLD = "b" * 40
FILES = {name: b"offline fixture\n" for name in poller.REQUIRED}
FILES["package.json"] = b'{"name":"offline-test"}\n'


def archive(entries=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as result:
        for entry in entries if entries is not None else FILES.items():
            name, content = entry[:2]
            info = tarfile.TarInfo("neo-sisra-tolovbot-" + SHA + "/" + name)
            info.size = len(content)
            if len(entry) > 2:
                info.type = entry[2]
            if len(entry) > 3:
                info.linkname = entry[3]
            result.addfile(info, io.BytesIO(content))
    return gzip.compress(output.getvalue())


class ArchiveTests(unittest.TestCase):
    def test_only_fixed_code_and_node_tests_are_selected(self):
        entries = list(FILES.items()) + [("README.md", b"ignored"), (".env", b"never copied"),
                                        ("tests/additional.test.cjs", b"more tests")]
        selected = poller.snapshot_files(archive(entries), SHA)
        self.assertEqual(set(selected), set(FILES) | {"tests/additional.test.cjs"})
        self.assertEqual(selected["bot.js"], FILES["bot.js"])

    def test_missing_files_rejected(self):
        with self.assertRaises(poller.PollError):
            poller.snapshot_files(archive(list(FILES.items())[1:]), SHA)

    def test_snapshot_requires_every_scalable_runtime_module(self):
        for name in ("state-store.cjs", "work-queue.cjs", "telegram-queue.cjs"):
            with self.subTest(name=name), self.assertRaises(poller.PollError):
                entries = [(path, content) for path, content in FILES.items() if path != name]
                poller.snapshot_files(archive(entries), SHA)

    def test_new_offline_test_files_are_included_without_adding_to_allowlist(self):
        new_tests = {
            "tests/state-store.test.cjs": b"SQLite tests",
            "tests/work-queue.test.cjs": b"ordering tests",
            "tests/telegram-queue.test.cjs": b"rate limit tests",
        }
        selected = poller.snapshot_files(archive(list(FILES.items()) + list(new_tests.items())), SHA)
        for name, content in new_tests.items():
            self.assertEqual(selected[name], content)

    def test_operator_exporter_is_not_shipped_in_runtime_archive(self):
        encoded = poller.release_archive(FILES)
        with tarfile.open(fileobj=io.BytesIO(encoded), mode="r:gz") as result:
            names = set(result.getnames())
        self.assertNotIn("deploy/export-state.cjs", names)
        self.assertTrue({"state-store.cjs", "work-queue.cjs", "telegram-queue.cjs"}.issubset(names))

    def test_unsafe_paths_and_duplicate_entries_rejected(self):
        for name in ("../bot.js", "tests/../../escape", "tests//bad", "tests/./bad", "back\\slash", "bot.js"):
            with self.subTest(name=name), self.assertRaises(poller.PollError):
                poller.snapshot_files(archive(list(FILES.items()) + [(name, b"bad")]), SHA)

    def test_links_and_special_entries_rejected_even_when_not_selected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            with self.subTest(kind=kind), self.assertRaises(poller.PollError):
                poller.snapshot_files(archive(list(FILES.items()) + [("ignored", b"", kind, "target")]), SHA)

    def test_wrong_commit_prefix_rejected(self):
        with self.assertRaises(poller.PollError):
            poller.snapshot_files(archive(), OLD)

    def test_size_and_entry_limits(self):
        for setting, value in (("MAX_COMPRESSED", 8), ("MAX_EXPANDED", 1024), ("MAX_FILE", 2), ("MAX_ENTRIES", 2)):
            with self.subTest(setting=setting), patch.object(poller, setting, value), self.assertRaises(poller.PollError):
                poller.snapshot_files(archive(), SHA)

    def test_malformed_archive_rejected(self):
        for content in (b"", b"not gzip", gzip.compress(b"not tar")):
            with self.subTest(content=content), self.assertRaises(poller.PollError):
                poller.snapshot_files(content, SHA)

    def test_runtime_archive_contains_only_exact_runtime_bytes(self):
        encoded = poller.release_archive(FILES)
        with tarfile.open(fileobj=io.BytesIO(encoded), mode="r:gz") as result:
            self.assertEqual({member.name for member in result}, poller.RUNTIME_FILES)
            for name in poller.RUNTIME_FILES:
                self.assertEqual(result.extractfile(name).read(), FILES[name])


class CommandTests(unittest.TestCase):
    def test_main_sha_is_exact_and_git_config_is_not_inherited(self):
        result = Mock(returncode=0, stdout=(SHA + "\trefs/heads/main\n").encode())
        with patch.object(poller.subprocess, "run", return_value=result) as run:
            self.assertEqual(poller.remote_sha(), SHA)
        args, kwargs = run.call_args
        self.assertEqual(args[0][-2:], [poller.REPOSITORY, "refs/heads/main"])
        self.assertEqual(kwargs["cwd"], "/")
        self.assertEqual(kwargs["env"]["GIT_CONFIG_GLOBAL"], "/dev/null")
        self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertNotIn("BOT_TOKEN", kwargs["env"])

    def test_invalid_branch_results_are_rejected(self):
        for output in (b"", (SHA + "\trefs/heads/other\n").encode(), (SHA + "\trefs/heads/main\nextra\n").encode()):
            with self.subTest(output=output), patch.object(poller, "command", return_value=Mock(returncode=0, stdout=output)):
                with self.assertRaises(poller.PollError):
                    poller.remote_sha()

    def test_command_failure_never_echoes_subprocess_secrets(self):
        with patch.object(poller.subprocess, "run", side_effect=subprocess.TimeoutExpired("SECRET", 1)):
            with self.assertRaises(poller.PollError) as error:
                poller.command(["SECRET"], 1)
        self.assertNotIn("SECRET", str(error.exception))

    def test_download_refuses_invalid_sha_without_network(self):
        with patch.object(poller.urllib.request, "build_opener") as opener:
            with self.assertRaises(poller.PollError):
                poller.download("../../secret")
        opener.assert_not_called()


class SnapshotTests(unittest.TestCase):
    def test_snapshot_replaced_with_read_only_regular_files_and_no_extras(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot"
            snapshot.mkdir()
            (snapshot / "old.txt").write_text("old")
            with patch.multiple(poller, ROOT=root, SNAPSHOT=snapshot), patch.object(poller, "secure_directory"):
                poller.install_snapshot(FILES)
            self.assertFalse((snapshot / "old.txt").exists())
            for name, content in FILES.items():
                path = snapshot / name
                self.assertEqual(path.read_bytes(), content)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertFalse((root / ".previous-snapshot").exists())

    def test_unexpected_snapshot_path_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            root.mkdir()
            with patch.object(poller, "ROOT", root), patch.object(poller, "secure_directory"):
                with self.assertRaises(poller.PollError):
                    poller.install_snapshot({"../escape": b"bad"})
            self.assertFalse((root.parent / "escape").exists())

    def test_attempt_marker_is_private_and_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / ".last-failed-sha"
            with patch.multiple(poller, ROOT=root, FAILED=target):
                poller.mark_attempt(SHA)
                self.assertEqual(target.read_text(), SHA + "\n")
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                self.assertEqual(list(root.iterdir()), [target])


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.patches = []
        self.mocks = {}
        for name in ("secure_directory", "remote_sha", "active_sha", "failed_sha", "download",
                     "snapshot_files", "install_snapshot", "mark_attempt", "command"):
            started = patch.object(poller, name)
            self.patches.append(started)
            self.mocks[name] = started.start()
        self.mocks["remote_sha"].return_value = SHA
        self.mocks["active_sha"].return_value = OLD
        self.mocks["failed_sha"].return_value = None
        self.mocks["snapshot_files"].return_value = FILES
        self.mocks["command"].return_value = Mock(returncode=0)

    def tearDown(self):
        for started in reversed(self.patches):
            started.stop()

    def test_unchanged_main_never_tests_or_restarts(self):
        self.mocks["active_sha"].return_value = SHA
        poller.poll()
        self.mocks["download"].assert_not_called()
        self.mocks["command"].assert_not_called()

    def test_failed_commit_is_not_repeated(self):
        self.mocks["failed_sha"].return_value = SHA
        poller.poll()
        self.mocks["download"].assert_not_called()
        self.mocks["command"].assert_not_called()

    def test_failed_tests_never_call_deployer(self):
        self.mocks["command"].side_effect = [Mock(returncode=0), Mock(returncode=1)]
        with self.assertRaises(poller.PollError):
            poller.poll()
        self.mocks["mark_attempt"].assert_called_once_with(SHA)
        self.assertEqual(self.mocks["command"].call_count, 2)
        self.assertTrue(all(call.args[0][0] == "/usr/bin/systemctl" for call in self.mocks["command"].call_args_list))

    def test_test_timeout_stops_test_unit_and_preserves_attempt_marker(self):
        self.mocks["command"].side_effect = [Mock(returncode=0), poller.PollError("timeout"), Mock(returncode=0)]
        with self.assertRaises(poller.PollError):
            poller.poll()
        self.assertEqual(self.mocks["command"].call_args.args[0], ["/usr/bin/systemctl", "stop", poller.TEST_UNIT])
        self.mocks["mark_attempt"].assert_called_once_with(SHA)

    def test_success_deploys_same_immutable_bytes_and_clears_marker(self):
        self.mocks["active_sha"].side_effect = [OLD, SHA]
        with patch.object(poller, "FAILED") as failed:
            poller.poll()
            failed.unlink.assert_called_once_with()
        final = self.mocks["command"].call_args
        self.assertEqual(final.args[0], [poller.DEPLOYER, SHA])
        with tarfile.open(fileobj=io.BytesIO(final.kwargs["payload"]), mode="r:gz") as archive_result:
            self.assertEqual(archive_result.extractfile("bot.js").read(), FILES["bot.js"])

    def test_failed_deploy_preserves_marker_for_manual_retry(self):
        self.mocks["command"].side_effect = [Mock(returncode=0), Mock(returncode=0), Mock(returncode=1)]
        with patch.object(poller, "FAILED") as failed, self.assertRaises(poller.PollError):
            poller.poll()
        failed.unlink.assert_not_called()


if __name__ == "__main__":
    unittest.main()
