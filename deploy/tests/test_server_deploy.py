"""Offline Linux tests: python3 -m unittest discover -s deploy/tests -v.

All service commands and privileged ownership checks in transaction tests are
mocked. The suite needs no root, live credentials, systemd, network, or Node.
"""

import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).resolve().parents[1] / "server-deploy.py"
SPEC = importlib.util.spec_from_file_location("server_deploy", SCRIPT)
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)
LEGACY_PAYLOAD = {
    "bot.js": b"console.log('test');\n",
    "google-delivery.cjs": b"module.exports = {};\n",
    "telegram-http.cjs": b"module.exports = {};\n",
    "package.json": b'{"name":"offline-fixture","private":true}\n',
}
PAYLOAD = dict(LEGACY_PAYLOAD, **{
    "state-store.cjs": b"module.exports = {};\n",
    "work-queue.cjs": b"module.exports = {};\n",
    "telegram-queue.cjs": b"module.exports = {};\n",
})


def raw_tar(entries=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for entry in entries if entries is not None else PAYLOAD.items():
            name, content = entry[:2]
            info = tarfile.TarInfo(name)
            info.size = len(content)
            if len(entry) > 2:
                info.type = entry[2]
            if len(entry) > 3:
                info.linkname = entry[3]
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def archive(entries=None):
    return io.BytesIO(gzip.compress(raw_tar(entries)))


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.staging = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def reject(self, entries=None, source=None):
        with self.assertRaises(deploy.DeploymentError):
            deploy.extract_archive(source if source is not None else archive(entries), self.staging)

    def test_exact_files_extracted_with_fixed_permissions(self):
        result = deploy.extract_archive(archive(), self.staging)
        self.assertEqual(set(result), deploy.FILES)
        for name, content in PAYLOAD.items():
            self.assertEqual((self.staging / name).read_bytes(), content)
            self.assertEqual(result[name], hashlib.sha256(content).hexdigest())
            self.assertEqual(stat.S_IMODE((self.staging / name).stat().st_mode), 0o644)

    def test_complete_legacy_archive_remains_supported(self):
        result = deploy.extract_archive(archive(LEGACY_PAYLOAD.items()), self.staging)
        self.assertEqual(set(result), deploy.LEGACY_FILES)

    def test_partial_new_runtime_is_rejected(self):
        for extras in (("state-store.cjs",), ("state-store.cjs", "work-queue.cjs")):
            with self.subTest(extras=extras), tempfile.TemporaryDirectory() as directory:
                entries = list(LEGACY_PAYLOAD.items()) + [(name, PAYLOAD[name]) for name in extras]
                with self.assertRaises(deploy.DeploymentError):
                    deploy.extract_archive(archive(entries), Path(directory))

    def test_new_modules_cannot_replace_a_required_legacy_file(self):
        self.reject([(name, content) for name, content in PAYLOAD.items() if name != "bot.js"])

    def test_unsafe_names_and_extra_entries(self):
        for name in ("../bot.js", "/bot.js", "./bot.js", "nested/bot.js", ".env", "data", "unit.service"):
            with self.subTest(name=name):
                self.reject([(name, b"x")])

    def test_nonregular_entries(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE,
                     tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE,
                     tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME):
            with self.subTest(kind=kind):
                self.reject([("bot.js", b"", kind, "/tmp/other")])

    def test_regular_entry_with_link_target(self):
        self.reject([("bot.js", b"x", tarfile.REGTYPE, "/tmp/other")])

    def test_duplicate_entry(self):
        self.reject([("bot.js", b"a"), ("bot.js", b"b")])

    def test_missing_entry(self):
        self.reject(list(PAYLOAD.items())[:-1])

    def test_file_size_limit(self):
        with patch.object(deploy, "MAX_FILE", 10):
            self.reject([("bot.js", b"x" * 11)])

    def test_compressed_size_limit(self):
        with patch.object(deploy, "MAX_ARCHIVE", 32):
            self.reject(source=io.BytesIO(b"x" * 33))

    def test_expansion_limit(self):
        with patch.object(deploy, "MAX_EXPANDED", 600):
            self.reject(source=archive())

    def test_empty_and_not_gzip(self):
        for content in (b"", b"plain text"):
            with self.subTest(content=content):
                self.reject(source=io.BytesIO(content))

    def test_truncated_gzip(self):
        self.reject(source=io.BytesIO(archive().getvalue()[:-8]))

    def test_truncated_tar(self):
        self.reject(source=io.BytesIO(gzip.compress(raw_tar()[:600])))

    def test_bad_checksum(self):
        corrupted = bytearray(raw_tar())
        corrupted[0] ^= 1
        self.reject(source=io.BytesIO(gzip.compress(corrupted)))

    def test_nonzero_file_padding(self):
        corrupted = bytearray(raw_tar())
        corrupted[512 + len(PAYLOAD["bot.js"])] = 1
        self.reject(source=io.BytesIO(gzip.compress(corrupted)))

    def test_nonzero_trailing_content(self):
        self.reject(source=io.BytesIO(gzip.compress(raw_tar() + b"extra")))

    def test_concatenated_tar(self):
        self.reject(source=io.BytesIO(gzip.compress(raw_tar() + raw_tar())))

    def test_concatenated_gzip_tar(self):
        self.reject(source=io.BytesIO(archive().getvalue() + archive().getvalue()))


class PackageAndCommandTests(unittest.TestCase):
    def test_valid_sha(self):
        self.assertEqual(deploy.validate_sha("a1" * 20), "a1" * 20)

    def test_invalid_sha(self):
        for value in ("main", "a" * 39, "a" * 41, "A" * 40, "a" * 40 + "\n", "$(id)"):
            with self.subTest(value=value), self.assertRaises(deploy.DeploymentError):
                deploy.validate_sha(value)

    def test_empty_runtime_dependency_fields_are_allowed(self):
        deploy.validate_package(b'{"dependencies":{},"optionalDependencies":{},"peerDependencies":{},"bundledDependencies":[]}')

    def test_runtime_dependency_fields_are_rejected(self):
        for key in ("dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"):
            with self.subTest(key=key), self.assertRaises(deploy.DeploymentError):
                deploy.validate_package(json.dumps({key: {"bad": "1"}}).encode())

    def test_invalid_package_json(self):
        for content in (b"[]", b"null", b"{", b"\xff", b'{"x":NaN}', b'{"dependencies":{},"dependencies":{}}'):
            with self.subTest(content=content), self.assertRaises(deploy.DeploymentError):
                deploy.validate_package(content)

    def test_syntax_checks_run_as_runtime_user(self):
        with patch.object(deploy, "command", return_value=Mock(returncode=0)) as command:
            deploy.validate_javascript(Path("/fixture"), deploy.FILES)
        self.assertEqual(command.call_count, 6)
        for call in command.call_args_list:
            self.assertEqual(call.args[0][:6], ["/usr/sbin/runuser", "-u", "neo-sisra-bot", "--", "/usr/bin/node", "--check"])

    def test_legacy_syntax_checks_do_not_require_new_modules(self):
        with patch.object(deploy, "command", return_value=Mock(returncode=0)) as command:
            deploy.validate_javascript(Path("/fixture"), deploy.LEGACY_FILES)
        self.assertEqual(command.call_count, 3)

    def test_syntax_failure_rejected(self):
        with patch.object(deploy, "command", return_value=Mock(returncode=1)):
            with self.assertRaises(deploy.DeploymentError):
                deploy.validate_javascript(Path("/fixture"), deploy.FILES)

    def test_stop_requires_confirmed_inactive_service(self):
        with patch.object(deploy, "command", side_effect=[Mock(returncode=0), Mock(returncode=0, stdout=b"inactive\n")]) as command:
            deploy.stop_service()
        self.assertEqual(command.call_args_list[0].args[0], ["/usr/bin/systemctl", "stop", deploy.UNIT])
        self.assertIn("--property=ActiveState", command.call_args_list[1].args[0])

    def test_stop_command_failure_is_closed(self):
        with patch.object(deploy, "command", return_value=Mock(returncode=1)) as command:
            with self.assertRaises(deploy.DeploymentError):
                deploy.stop_service()
        self.assertEqual(command.call_count, 1)

    def test_stop_does_not_accept_still_running_or_unknown_state(self):
        for state in (b"active\n", b"activating\n", b"deactivating\n", b"", b"failed\ninactive\n"):
            with self.subTest(state=state), patch.object(deploy, "command", side_effect=[Mock(returncode=0), Mock(returncode=0, stdout=state)]):
                with self.assertRaises(deploy.DeploymentError):
                    deploy.stop_service()

    def test_subprocess_has_fixed_environment_no_inherited_node_options(self):
        with patch.object(deploy.subprocess, "run", return_value=Mock(returncode=0)) as run:
            deploy.command(["/example"])
        kwargs = run.call_args.kwargs
        self.assertIs(kwargs["env"], deploy.COMMAND_ENV)
        self.assertNotIn("NODE_OPTIONS", kwargs["env"])
        self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["cwd"], "/")

    def test_command_timeout_does_not_leak_output(self):
        with patch.object(deploy.subprocess, "run", side_effect=subprocess.TimeoutExpired("test", 1, output=b"DO_NOT_LEAK")):
            with self.assertRaises(deploy.DeploymentError) as raised:
                deploy.command(["/example"])
        self.assertNotIn("DO_NOT_LEAK", str(raised.exception))


class ReadyTests(unittest.TestCase):
    def test_requires_new_invocation(self):
        with patch.object(deploy, "invocation_id", return_value="a" * 32):
            with self.assertRaises(deploy.DeploymentError):
                deploy.wait_ready("a" * 32)

    def test_changed_invocation_rejected(self):
        with patch.object(deploy, "invocation_id", side_effect=["b" * 32, "c" * 32]):
            with self.assertRaises(deploy.DeploymentError):
                deploy.wait_ready("a" * 32)

    def test_ready_log_is_scoped_to_fresh_invocation(self):
        with patch.object(deploy, "invocation_id", return_value="b" * 32), \
                patch.object(deploy, "service_active", return_value=True), \
                patch.object(deploy, "command", return_value=Mock(returncode=0, stdout=deploy.READY_LINE + b"\n")) as command:
            deploy.wait_ready("a" * 32)
        args = command.call_args.args[0]
        self.assertIn("_SYSTEMD_INVOCATION_ID=" + "b" * 32, args)
        self.assertIn("--grep=^Neo Sisra polling ready[.]$", args)

    def test_missing_readiness_times_out(self):
        now = [0.0]
        def advance(seconds):
            now[0] += seconds
        with patch.object(deploy, "READY_TIMEOUT", 2), \
                patch.object(deploy.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(deploy.time, "sleep", side_effect=advance), \
                patch.object(deploy, "invocation_id", return_value="b" * 32), \
                patch.object(deploy, "command", return_value=Mock(returncode=0, stdout=b"")):
            with self.assertRaises(deploy.DeploymentError):
                deploy.wait_ready("a" * 32)
        self.assertEqual(now[0], 2)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.releases = self.base / "releases"
        self.releases.mkdir()
        self.previous = self.releases / ("a" * 40)
        self.previous.mkdir()
        for name, content in PAYLOAD.items():
            (self.previous / name).write_bytes(content)
        (self.base / ".env").write_bytes(b"OFFLINE_TEST_ONLY=1\n")
        (self.base / "data").mkdir()
        (self.base / "data" / "state.json").write_bytes(b'{"preserve":true}\n')
        for name in deploy.STATE_NAMES:
            (self.previous / name).symlink_to(self.base / name, target_is_directory=name == "data")
        self.current = self.base / "current"
        self.current.symlink_to(self.previous, target_is_directory=True)
        self.target = self.releases / ("b" * 40)
        self.patches = [
            patch.multiple(deploy, BASE=self.base, RELEASES=self.releases, CURRENT=self.current),
            patch.object(deploy, "secure_directory"),
            patch.object(deploy, "check_code_file"),
            patch.object(deploy, "validate_javascript"),
            patch.object(deploy, "invocation_id", return_value="a" * 32),
            patch.object(deploy, "restart_service"),
            patch.object(deploy, "wait_ready"),
            patch.object(deploy, "service_active", return_value=True),
            patch.object(deploy.signal, "signal"),
            patch.object(deploy, "stop_service"),
        ]
        self.mocks = [item.start() for item in self.patches]
        self.restart = self.mocks[5]
        self.ready = self.mocks[6]
        self.stop = self.mocks[-1]

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def assert_state_preserved(self):
        self.assertEqual((self.base / ".env").read_bytes(), b"OFFLINE_TEST_ONLY=1\n")
        self.assertEqual((self.base / "data" / "state.json").read_bytes(), b'{"preserve":true}\n')
        self.assertTrue(self.previous.is_dir())
        self.assertFalse(list(self.releases.glob(".staging-*")))

    def test_success_switches_current_and_keeps_old_release_and_state(self):
        deploy.deploy("b" * 40, archive())
        self.assertEqual(self.current.resolve(), self.target)
        self.restart.assert_called_once()
        self.ready.assert_called_once_with("a" * 32)
        for name in deploy.STATE_NAMES:
            self.assertEqual(os.readlink(self.target / name), str(self.base / name))
        self.assert_state_preserved()

    def make_previous_legacy(self):
        for name in deploy.FILES - deploy.LEGACY_FILES:
            (self.previous / name).unlink()

    def create_sqlite_marker(self):
        (self.base / "data" / deploy.SQLITE_NAME).write_bytes(b"offline SQLite marker")

    def test_new_runtime_can_deploy_with_legacy_fallback(self):
        self.make_previous_legacy()
        deploy.deploy("b" * 40, archive())
        self.assertEqual(self.current.resolve(), self.target)
        self.stop.assert_not_called()
        self.assert_state_preserved()

    def test_partial_existing_release_is_rejected_before_restart(self):
        (self.previous / "work-queue.cjs").unlink()
        with self.assertRaisesRegex(deploy.DeploymentError, "incomplete runtime"):
            deploy.deploy("b" * 40, archive())
        self.restart.assert_not_called()

    def test_same_sha_cannot_change_legacy_to_new_runtime(self):
        self.make_previous_legacy()
        with self.assertRaisesRegex(deploy.DeploymentError, "does not match"):
            deploy.deploy("a" * 40, archive())
        self.restart.assert_not_called()
        self.assertEqual(self.current.resolve(), self.previous)

    def test_legacy_rollback_stops_then_exports_before_switch_and_restart(self):
        self.make_previous_legacy()
        self.create_sqlite_marker()
        events = []
        self.stop.side_effect = lambda: events.append("stop")
        self.restart.side_effect = lambda: events.append("restart")
        self.ready.side_effect = [deploy.DeploymentError("fixture failure"), None]
        original_switch = deploy.switch_current

        def switch(release):
            events.append("switch-legacy" if release == self.previous else "switch-new")
            original_switch(release)

        def export(arguments, **_kwargs):
            self.assertEqual(self.current.resolve(), self.target)
            self.assertEqual(arguments, ["/usr/sbin/runuser", "-u", deploy.RUNTIME_USER, "--", "/usr/bin/node", str(deploy.EXPORT_WRAPPER)])
            events.append("export")
            return Mock(returncode=0)

        with patch.object(deploy, "command", side_effect=export), patch.object(deploy, "switch_current", side_effect=switch):
            with self.assertRaisesRegex(deploy.DeploymentError, "previous release restored"):
                deploy.deploy("b" * 40, archive())
        self.assertEqual(events, ["switch-new", "restart", "stop", "export", "switch-legacy", "restart"])
        self.assertEqual(self.current.resolve(), self.previous)
        self.assert_state_preserved()

    def test_failed_export_never_selects_or_starts_stale_legacy_fallback(self):
        self.make_previous_legacy()
        self.create_sqlite_marker()
        self.ready.side_effect = deploy.DeploymentError("fixture failure")
        with patch.object(deploy, "command", return_value=Mock(returncode=1)):
            with self.assertRaisesRegex(deploy.DeploymentError, "operator recovery required"):
                deploy.deploy("b" * 40, archive())
        self.stop.assert_called_once()
        self.restart.assert_called_once()
        self.assertEqual(self.current.resolve(), self.target)
        self.assert_state_preserved()

    def test_rollback_without_sqlite_still_stops_before_legacy_activation(self):
        self.make_previous_legacy()
        self.ready.side_effect = [deploy.DeploymentError("fixture failure"), None]
        with patch.object(deploy, "command") as command:
            with self.assertRaisesRegex(deploy.DeploymentError, "previous release restored"):
                deploy.deploy("b" * 40, archive())
        self.stop.assert_called_once()
        command.assert_not_called()
        self.assertEqual(self.current.resolve(), self.previous)

    def test_manual_legacy_deploy_exports_current_sqlite_before_start(self):
        self.create_sqlite_marker()
        with patch.object(deploy, "command", return_value=Mock(returncode=0)) as command:
            deploy.deploy("b" * 40, archive(LEGACY_PAYLOAD.items()))
        self.stop.assert_called_once()
        command.assert_called_once()
        self.assertEqual(self.current.resolve(), self.target)
        self.assertEqual(deploy.release_files(self.target), deploy.LEGACY_FILES)

    def test_sqlite_created_during_stop_is_also_exported(self):
        self.stop.side_effect = self.create_sqlite_marker
        with patch.object(deploy, "command", return_value=Mock(returncode=0)) as command:
            deploy.deploy("b" * 40, archive(LEGACY_PAYLOAD.items()))
        command.assert_called_once()

    def test_legacy_export_rejects_symlink_sqlite(self):
        self.make_previous_legacy()
        (self.base / "data" / deploy.SQLITE_NAME).symlink_to(self.base / "data" / "state.json")
        with patch.object(deploy, "command") as command:
            with self.assertRaisesRegex(deploy.DeploymentError, "regular file"):
                deploy.prepare_activation(self.previous)
        command.assert_not_called()
        self.stop.assert_called_once()

    def test_export_requires_both_operator_installed_files(self):
        self.make_previous_legacy()
        self.create_sqlite_marker()
        with patch.object(deploy, "check_code_file") as checked, patch.object(deploy, "command", return_value=Mock(returncode=0)):
            deploy.prepare_activation(self.previous)
        self.assertEqual([call.args[0] for call in checked.call_args_list], [deploy.EXPORT_WRAPPER, deploy.EXPORT_MODULE])

    def test_unsafe_operator_exporter_is_rejected_without_execution(self):
        self.make_previous_legacy()
        self.create_sqlite_marker()
        with patch.object(deploy, "check_code_file", side_effect=deploy.DeploymentError("unsafe exporter")), patch.object(deploy, "command") as command:
            with self.assertRaisesRegex(deploy.DeploymentError, "unsafe exporter"):
                deploy.prepare_activation(self.previous)
        command.assert_not_called()

    def test_failed_stop_never_exports_or_starts_legacy_fallback(self):
        self.make_previous_legacy()
        self.create_sqlite_marker()
        self.ready.side_effect = deploy.DeploymentError("fixture failure")
        self.stop.side_effect = deploy.DeploymentError("could not stop")
        with patch.object(deploy, "command") as command:
            with self.assertRaisesRegex(deploy.DeploymentError, "operator recovery required"):
                deploy.deploy("b" * 40, archive())
        command.assert_not_called()
        self.restart.assert_called_once()
        self.assertEqual(self.current.resolve(), self.target)

    def test_invalid_archive_never_restarts_or_changes_current(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.deploy("b" * 40, archive([("../bad", b"x")]))
        self.assertEqual(self.current.resolve(), self.previous)
        self.restart.assert_not_called()
        self.assert_state_preserved()

    def test_failed_readiness_restores_previous_and_reports_failure(self):
        self.ready.side_effect = [deploy.DeploymentError("fixture failure"), None]
        with self.assertRaisesRegex(deploy.DeploymentError, "previous release restored"):
            deploy.deploy("b" * 40, archive())
        self.assertEqual(self.current.resolve(), self.previous)
        self.assertEqual(self.restart.call_count, 2)
        self.assertEqual(self.ready.call_count, 2)
        self.assertTrue(self.target.exists())
        self.assert_state_preserved()

    def test_failed_restart_rolls_back(self):
        self.restart.side_effect = [deploy.DeploymentError("fixture failure"), None]
        with self.assertRaisesRegex(deploy.DeploymentError, "previous release restored"):
            deploy.deploy("b" * 40, archive())
        self.assertEqual(self.current.resolve(), self.previous)
        self.assertEqual(self.restart.call_count, 2)
        self.assert_state_preserved()

    def test_rollback_failure_is_reported(self):
        self.restart.side_effect = deploy.DeploymentError("fixture failure")
        with self.assertRaisesRegex(deploy.DeploymentError, "rollback could not be confirmed"):
            deploy.deploy("b" * 40, archive())
        self.assertEqual(self.current.resolve(), self.previous)
        self.assert_state_preserved()

    def test_redeploy_same_sha_with_matching_content(self):
        deploy.deploy("b" * 40, archive())
        deploy.deploy("b" * 40, archive())
        self.assertEqual(self.current.resolve(), self.target)
        self.assertEqual(self.restart.call_count, 2)
        self.assert_state_preserved()

    def test_existing_sha_with_different_content_is_rejected(self):
        deploy.deploy("b" * 40, archive())
        self.restart.reset_mock()
        changed = dict(PAYLOAD, **{"bot.js": b"different\n"})
        with self.assertRaisesRegex(deploy.DeploymentError, "does not match"):
            deploy.deploy("b" * 40, archive(changed.items()))
        self.restart.assert_not_called()
        self.assertEqual((self.target / "bot.js").read_bytes(), PAYLOAD["bot.js"])
        self.assert_state_preserved()

    def test_existing_sha_with_extra_files_is_rejected(self):
        deploy.deploy("b" * 40, archive())
        (self.target / "extra").write_bytes(b"x")
        self.restart.reset_mock()
        with self.assertRaisesRegex(deploy.DeploymentError, "unexpected files"):
            deploy.deploy("b" * 40, archive())
        self.restart.assert_not_called()
        self.assert_state_preserved()

    def test_missing_fallback_is_rejected_before_extracting(self):
        self.current.unlink()
        with self.assertRaisesRegex(deploy.DeploymentError, "fallback"):
            deploy.deploy("b" * 40, archive())
        self.restart.assert_not_called()
        self.assertFalse(self.target.exists())
        self.assert_state_preserved()

    def test_cleanup_refuses_historical_release(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.clean_staging(self.previous)
        self.assertTrue(self.previous.exists())


class SSHWrapperTests(unittest.TestCase):
    def test_rejects_arbitrary_and_malformed_commands(self):
        wrapper = SCRIPT.parent / "ssh-entry.sh"
        for original in ("", "id", "deploy main", "deploy " + "A" * 40,
                         "deploy " + "a" * 39, "deploy " + "a" * 41,
                         "deploy " + "a" * 40 + "\n", "deploy " + "a" * 40 + "; id",
                         " deploy " + "a" * 40, "deploy  " + "a" * 40):
            with self.subTest(original=original):
                result = subprocess.run(["/bin/sh", str(wrapper)], capture_output=True,
                                        env={"SSH_ORIGINAL_COMMAND": original, "PATH": "/usr/bin:/bin"})
                self.assertEqual(result.returncode, 64)


if __name__ == "__main__":
    unittest.main()
