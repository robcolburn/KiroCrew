"""The dependency-install spawns of an app backend cannot read the gateway's secret files.

``npm install`` (lifecycle scripts such as ``postinstall``) and ``pip install -r`` (source
builds run setup code) execute third-party code, exactly like the backend itself. Each
spawn must pass the gateway's internal-API secret files to ``wrap_argv`` as
``extra_hidden_dirs``, the same way the backend spawn does. So does the interpreter probe,
which runs an app-planted ``.venv`` interpreter.

Only the arguments handed to ``wrap_argv`` are checked; no sandbox and no process runs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from apps_backend_coverage_helpers import _isolated_module_state  # noqa: F401
from apps_backend_coverage_helpers import spawn_root_fixture  # noqa: F401
from apps_backend_coverage_helpers import _capture_popen, _manifest, _record_runs, _StopSpawn

import kiro_crew.apps.backend as bmod
from kiro_crew.config.paths import config_dir


def _seed_secret_files() -> tuple[str, ...]:
    home = Path(config_dir())
    (home / "run").mkdir(parents=True, exist_ok=True)
    names = (".local_secret", "run/gateway-8765.secret")
    for name in names:
        (home / name).write_text("x", encoding="utf-8")
    return tuple(str(home / name) for name in names)


def _spy_wrap_argv(monkeypatch: pytest.MonkeyPatch) -> list[tuple[list[str], tuple[str, ...]]]:
    calls: list[tuple[list[str], tuple[str, ...]]] = []

    def _wrap(argv: Any, **kwargs: Any) -> Any:
        calls.append((list(argv), tuple(kwargs.get("extra_hidden_dirs") or ())))
        return (list(argv), None)

    monkeypatch.setattr(bmod, "wrap_argv", _wrap)
    return calls


class TestTheInstallSpawnsHideTheSecretFiles:
    def test_the_npm_install_spawn_hides_every_secret_file(
        self, spawn_root: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        secrets = _seed_secret_files()
        (spawn_root / "server.js").write_text("// noop\n")
        (spawn_root / "package.json").write_text(json.dumps({"name": "x"}))
        monkeypatch.setattr(bmod, "_find_node_binary", lambda: "/usr/bin/node")
        monkeypatch.setattr(bmod, "_find_npm_binary", lambda: "/usr/bin/npm")
        calls = _spy_wrap_argv(monkeypatch)
        _record_runs(monkeypatch)
        _capture_popen(monkeypatch)

        with pytest.raises(_StopSpawn):
            bmod._start_app_backend_body("nodeapp", _manifest("server.js"))

        npm = [hidden for argv, hidden in calls if argv[:2] == ["/usr/bin/npm", "install"]]
        assert len(npm) == 1, calls
        for path in secrets:
            assert path in npm[0], f"{path} is readable by npm install"

    def test_the_pip_install_spawn_hides_every_secret_file(
        self, spawn_root: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        secrets = _seed_secret_files()
        (spawn_root / "server.py").write_text("x = 1\n")
        (spawn_root / "requirements.txt").write_bytes(b"requests\n")
        calls = _spy_wrap_argv(monkeypatch)
        _record_runs(monkeypatch)
        _capture_popen(monkeypatch)

        with pytest.raises(_StopSpawn):
            bmod._start_app_backend_body("deps", _manifest("server.py"))

        pip = [hidden for argv, hidden in calls if "pip" in argv and "install" in argv]
        assert len(pip) == 1, calls
        for path in secrets:
            assert path in pip[0], f"{path} is readable by pip install"

    def test_the_interpreter_probe_spawn_hides_every_secret_file(
        self, tmp_path: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from kiro_crew.apps import interpreter as imod

        secrets = _seed_secret_files()
        py = imod.venv_python_path(tmp_path)
        py.parent.mkdir(parents=True)
        py.write_text("#!/bin/sh\n")
        py.chmod(0o755)
        seen: list[tuple[str, ...]] = []

        def _wrap(argv: Any, **kwargs: Any) -> Any:
            seen.append(tuple(kwargs.get("extra_hidden_dirs") or ()))
            raise OSError("stop before anything runs")

        monkeypatch.setattr(imod.sandbox, "wrap_argv", _wrap)

        assert imod._venv_is_usable(tmp_path) is False

        assert len(seen) == 1, "the probe never reached the sandbox wrap"
        for path in secrets:
            assert path in seen[0], f"{path} is readable by the interpreter probe"
