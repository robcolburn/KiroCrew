"""The desktop app's on-demand optional SDK install (``kiro_crew.sdk_extras``)."""

from __future__ import annotations

import asyncio
import configparser
import re
import subprocess
import sys
from pathlib import Path

import pytest
from aiohttp.test_utils import make_mocked_request

from kiro_crew import sandbox_leaves, sandbox_precreate, sdk_extras
from kiro_crew.security import paths_lists
from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[1]


def test_the_leaf_is_sealed_in_every_fence_browser_harness_is() -> None:
    """The gateway imports what this leaf holds, so an agent write would choose
    gateway code. Same fences as ``browser-harness``, the other directory the
    gateway installs and then runs."""
    leaf = sdk_extras.EXTRAS_LEAF
    assert leaf == "extras"
    assert leaf in sandbox_leaves._CREW_READONLY_LEAVES
    assert leaf in sandbox_leaves._CREW_CHILD_WITHHELD_LEAVES
    assert leaf in sandbox_precreate._CREW_PRECREATE_READONLY_DIR_LEAVES
    assert leaf in sandbox_precreate._CREW_NOFOLLOW_READONLY_DIR_LEAVES
    assert leaf in sandbox_precreate._DELEGATED_OVERLAP_LEAF_REASONS
    assert leaf in paths_lists._CREW_SECRET_LEAVES


def _lock_pins(extra: str) -> dict[str, tuple[str, list[str]]]:
    text = sdk_extras.lock_file(extra).read_text(encoding="utf-8")
    pins: dict[str, tuple[str, list[str]]] = {}
    for block in re.split(r"\n(?=[a-z])", text):
        head = re.match(r"([a-z][a-z0-9-]*)==(\S+)", block)
        if head:
            pins[head.group(1)] = (head.group(2), re.findall(r"--hash=sha256:[0-9a-f]{64}", block))
    return pins


def test_every_installable_extra_has_a_fully_hashed_lock() -> None:
    for extra in sdk_extras.INSTALLABLE:
        pins = _lock_pins(extra)
        assert pins, extra
        for name, (_version, hashes) in pins.items():
            assert hashes, f"{extra}: {name} has no hash; --require-hashes would refuse it"


def test_the_feishu_lock_satisfies_the_extra_and_adds_only_what_core_lacks() -> None:
    """--no-deps installs exactly these, so the rest of lark-oapi's closure must be
    core's own. The lark-oapi pin must sit inside setup.cfg's [feishu] range."""
    pins = _lock_pins("feishu")
    assert set(pins) == {"lark-oapi", "pycryptodome", "requests-toolbelt"}
    cfg = configparser.ConfigParser()
    cfg.read(ROOT / "setup.cfg", encoding="utf-8")
    (spec,) = [s for s in cfg["options.extras_require"]["feishu"].splitlines() if s.strip()]
    assert Requirement(spec).specifier.contains(pins["lark-oapi"][0])


def test_the_lock_ships_in_the_wheel() -> None:
    cfg = (ROOT / "setup.cfg").read_text(encoding="utf-8")
    assert "    sdk_extras_locks/*.txt\n" in cfg


def test_install_is_offered_only_on_the_bundled_interpreter(monkeypatch) -> None:
    monkeypatch.setattr(sdk_extras.platform_compat, "is_bundled_interpreter", lambda: False)
    assert sdk_extras.install_supported("feishu") is False
    monkeypatch.setattr(sdk_extras.platform_compat, "is_bundled_interpreter", lambda: True)
    assert sdk_extras.install_supported("feishu") is True
    assert sdk_extras.install_supported("teams") is False


def test_activate_appends_only_a_finished_install(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(sys, "path", list(sys.path))
    target = sdk_extras.extra_dir("feishu", tmp_path)
    target.mkdir(parents=True)
    sdk_extras.activate(tmp_path)
    assert str(target) not in sys.path
    (target / sdk_extras.MARKER_FILE).write_text("{}", encoding="utf-8")
    sdk_extras.activate(tmp_path)
    sdk_extras.activate(tmp_path)
    assert sys.path.count(str(target)) == 1
    # Appended, never prepended: a bundled module always wins.
    assert sys.path[-1] == str(target)


def test_the_directory_is_keyed_by_interpreter_and_machine(tmp_path: Path) -> None:
    tag = sdk_extras.python_tag()
    assert tag.startswith(f"cp{sys.version_info[0]}{sys.version_info[1]}-{sys.platform}-")
    assert sdk_extras.extra_dir("feishu", tmp_path) == tmp_path / "extras" / "feishu" / tag


def _fake_pip(returncode: int, seen: list[list[str]], *, write: bool = True):
    def run(argv, **kwargs):
        seen.append(list(argv))
        assert kwargs["cwd"] == argv[argv.index("--target") + 1]
        assert "PYTHONPATH" not in kwargs["env"]
        assert kwargs["env"]["PIP_CONFIG_FILE"] == sdk_extras.os.devnull
        if write:
            pkg = Path(argv[argv.index("--target") + 1]) / "lark_oapi"
            pkg.mkdir()
            (pkg / "__init__.py").write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(argv, returncode, "", "pip said no")

    return run


def test_install_uses_the_locked_hashes_and_renames_into_place(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setenv("PYTHONPATH", "/workspace/evil")
    seen: list[list[str]] = []
    monkeypatch.setattr(sdk_extras.subprocess, "run", _fake_pip(0, seen))
    target = sdk_extras.install("feishu", tmp_path)
    (argv,) = seen
    assert argv[:4] == [sys.executable, "-I", "-m", "pip"]
    for flag in ("--no-deps", "--require-hashes", "--no-input"):
        assert flag in argv
    assert argv[argv.index("--only-binary") + 1] == ":all:"
    assert argv[argv.index("-r") + 1] == str(sdk_extras.lock_file("feishu"))
    assert (target / "lark_oapi" / "__init__.py").is_file()
    assert (target / sdk_extras.MARKER_FILE).is_file()
    assert not any(p.name.endswith(".partial") for p in target.parent.iterdir())
    assert str(target) in sys.path


def test_a_failed_install_leaves_nothing_activate_would_load(tmp_path: Path, monkeypatch) -> None:
    seen: list[list[str]] = []
    monkeypatch.setattr(sdk_extras.subprocess, "run", _fake_pip(1, seen))
    with pytest.raises(sdk_extras.InstallError, match="pip said no"):
        sdk_extras.install("feishu", tmp_path)
    target = sdk_extras.extra_dir("feishu", tmp_path)
    assert not target.exists()
    assert list(target.parent.iterdir()) == []


def test_an_unknown_extra_is_refused(tmp_path: Path) -> None:
    with pytest.raises(sdk_extras.InstallError):
        sdk_extras.install("whatsapp", tmp_path)


# --------------------------------------------------------------------------
# POST /api/feishu/sdk/install
# --------------------------------------------------------------------------


def _post():
    return make_mocked_request("POST", "/api/feishu/sdk/install")


def test_the_route_refuses_a_remote_session(monkeypatch) -> None:
    import kiro_crew.dashboard.handlers.messaging as mod

    monkeypatch.setattr(mod, "is_direct_local_request", lambda req: False)
    resp = asyncio.run(mod.api_feishu_sdk_install(_post()))
    assert resp.status == 403


def test_the_route_refuses_a_non_owner(monkeypatch) -> None:
    import kiro_crew.dashboard.handlers.messaging as mod
    import kiro_crew.dashboard.handlers.source_providers as sp

    monkeypatch.setattr(mod, "is_direct_local_request", lambda req: True)
    monkeypatch.setattr(sp, "is_owner_dashboard_request", lambda req: False)
    installs: list[str] = []
    monkeypatch.setattr(mod.sdk_extras, "install", lambda extra: installs.append(extra))
    resp = asyncio.run(mod.api_feishu_sdk_install(_post()))
    assert resp.status in (401, 403)
    assert installs == []


def _owner_local(monkeypatch, mod) -> None:
    import kiro_crew.dashboard.handlers.source_providers as sp

    monkeypatch.setattr(mod, "is_direct_local_request", lambda req: True)
    monkeypatch.setattr(sp, "is_owner_dashboard_request", lambda req: True)


def test_the_route_refuses_where_pip_is_the_answer(monkeypatch) -> None:
    import kiro_crew.dashboard.handlers.messaging as mod

    _owner_local(monkeypatch, mod)
    monkeypatch.setattr(mod.sdk_extras, "install_supported", lambda extra: False)
    resp = asyncio.run(mod.api_feishu_sdk_install(_post()))
    assert resp.status == 400


def test_the_route_installs_and_reports_a_failure(monkeypatch) -> None:
    import json

    import kiro_crew.dashboard.handlers.messaging as mod

    _owner_local(monkeypatch, mod)
    monkeypatch.setattr(mod.sdk_extras, "install_supported", lambda extra: True)
    installs: list[str] = []
    monkeypatch.setattr(mod.sdk_extras, "install", lambda extra: installs.append(extra))
    resp = asyncio.run(mod.api_feishu_sdk_install(_post()))
    assert resp.status == 200 and installs == ["feishu"]
    assert json.loads(resp.body)["restart_required"] is True

    def _fail(extra: str) -> None:
        raise mod.sdk_extras.InstallError("no network")

    monkeypatch.setattr(mod.sdk_extras, "install", _fail)
    resp = asyncio.run(mod.api_feishu_sdk_install(_post()))
    assert resp.status == 502
    assert json.loads(resp.body)["code"] == "sdk_install_failed"


def test_the_config_get_offers_the_in_app_install_only_while_missing(
    tmp_path: Path, monkeypatch
) -> None:
    import json

    import kiro_crew.config.loader as loader
    import kiro_crew.dashboard.handlers.messaging as mod

    (tmp_path / ".env").write_text("", encoding="utf-8")
    monkeypatch.setattr(loader, "env_path", lambda: tmp_path / ".env")
    monkeypatch.setattr(loader, "config_path", lambda: tmp_path / "config.json")
    monkeypatch.setattr(mod.sdk_extras, "install_supported", lambda extra: True)
    monkeypatch.setattr(mod, "_channel_sdk_status", lambda channel: (False, False, ""))

    class _State:
        feishu_connected = False
        feishu_connect_error = ""

    req = make_mocked_request("GET", "/api/feishu/config", app={"state": _State()})
    body = json.loads(asyncio.run(mod.api_feishu_config_get(req)).body)
    assert body["sdk_install_in_app"] is True
    monkeypatch.setattr(mod, "_channel_sdk_status", lambda channel: (True, True, ""))
    body = json.loads(asyncio.run(mod.api_feishu_config_get(req)).body)
    assert body["sdk_install_in_app"] is False
