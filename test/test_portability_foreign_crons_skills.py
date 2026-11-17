"""An archive from another install: its crons arrive paused and reset, its skills stay out.

Every cron job of an archive is restored PAUSED, message-only jobs too, with the record
fields that widen what the job may do reset to this install's defaults. A job the user
picks (``include_crons``) is installed as written. A Replace does not install the
archive's ``skills/`` tree over a live one unless it is picked (``include_skills``); a
machine with no live skills installs it as it always did.
"""

from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

from kiro_crew import portability
from kiro_crew.portability import apply_import_zip
from kiro_crew.portability_vetting import _hold_back_foreign_skills, _sanitize_imported_crons

RESET_FIELDS = (
    "approval_mode",
    "project_path",
    "env",
    "secret_env",
    "execution_context",
    "agent_sequence",
    "channel",
    "model",
)


def _risky_job(name: str = "nightly", **extra) -> dict:
    """A message-only job that asks for every widening field."""
    return {
        "id": f"id-{name}",
        "name": name,
        "message": "check the build",
        "schedule": {"kind": "cron", "cron_expr": "0 9 * * *"},
        "enabled": True,
        "approval_mode": "auto",
        "project_path": "/srv/other-projects",
        "env": {"FLAG": "1"},
        "secret_env": {"TOKEN": "x"},
        "execution_context": "ctx",
        "agent_sequence": ["one", "two"],
        "channel": "C123",
        "model": "some-model",
        "agent_id": "ghost-agent",
        **extra,
    }


def _store(tmp_path: Path, jobs: list[dict]) -> Path:
    path = tmp_path / "crons.json"
    path.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
    return path


def _read(path: Path) -> dict[str, dict]:
    return {j["name"]: j for j in json.loads(path.read_text(encoding="utf-8"))["jobs"]}


def test_helper_pauses_a_message_only_job_and_resets_its_fields(tmp_path):
    path = _store(tmp_path, [_risky_job()])

    dropped, paused = _sanitize_imported_crons(path, hold_all=True, known_agents=frozenset())

    job = _read(path)["nightly"]
    assert dropped == [] and paused == ["nightly"]
    assert job["user_paused"] is True and job["enabled"] is False
    for field in RESET_FIELDS:
        assert not job.get(field), field
    assert not job.get("agent_id")
    assert job["message"] == "check the build"


def test_helper_keeps_an_agent_that_exists_here_and_drops_one_that_does_not(tmp_path):
    path = _store(
        tmp_path,
        [_risky_job("a", agent_id="known"), _risky_job("b", agent_id="ghost-agent")],
    )

    _sanitize_imported_crons(path, hold_all=True, known_agents=frozenset({"known"}))

    jobs = _read(path)
    assert jobs["a"]["agent_id"] == "known"
    assert not jobs["b"].get("agent_id")


def test_helper_names_a_job_that_was_already_paused_when_its_settings_are_removed(tmp_path):
    bare = {
        "id": "id-bare",
        "name": "bare",
        "message": "check the build",
        "schedule": {"kind": "cron", "cron_expr": "0 9 * * *"},
        "user_paused": True,
        "enabled": False,
    }
    path = _store(tmp_path, [_risky_job("was-paused", user_paused=True, enabled=False), bare])

    _dropped, paused = _sanitize_imported_crons(path, hold_all=True, known_agents=frozenset())

    assert paused == ["was-paused"]
    assert not _read(path)["was-paused"].get("approval_mode")


def _zip(path: Path, files: dict[str, str]) -> Path:
    with zipfile.ZipFile(str(path), "w") as zf:
        zf.writestr("snap/MANIFEST.json", json.dumps({"version": 2}))
        for name, text in files.items():
            zf.writestr(f"snap/{name}", text)
    return path


def _import(zip_path: Path, home: Path, mode: str = "replace", **kwargs) -> dict:
    with patch.object(portability, "config_dir", return_value=home):
        with patch.dict(os.environ, {"KIROCREW_HOME": str(home)}):
            return apply_import_zip(zip_path, mode=mode, **kwargs)


def _home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    return home


def test_import_restores_a_message_only_cron_paused_with_its_fields_reset(tmp_path):
    home = _home(tmp_path)
    z = _zip(tmp_path / "a.zip", {"crons.json": json.dumps({"jobs": [_risky_job()]})})

    summary = _import(z, home)

    job = _read(home / "crons.json")["nightly"]
    assert job["user_paused"] is True and job["enabled"] is False
    for field in RESET_FIELDS:
        assert not job.get(field), field
    assert summary["paused_crons"] == ["nightly"]
    assert summary["paused_crons_reset"] is True


def test_import_in_merge_mode_also_pauses_and_resets(tmp_path):
    home = _home(tmp_path)
    z = _zip(tmp_path / "a.zip", {"crons.json": json.dumps({"jobs": [_risky_job()]})})

    summary = _import(z, home, mode="merge")

    job = _read(home / "crons.json")["nightly"]
    assert job["user_paused"] is True and not job.get("approval_mode")
    assert summary["paused_crons"] == ["nightly"]


def test_merge_does_not_name_a_job_this_install_already_has(tmp_path):
    home = _home(tmp_path)
    live = _risky_job(approval_mode="")
    (home / "crons.json").write_text(json.dumps({"jobs": [live]}), encoding="utf-8")
    z = _zip(tmp_path / "a.zip", {"crons.json": json.dumps({"jobs": [_risky_job()]})})

    summary = _import(z, home, mode="merge")

    assert "paused_crons" not in summary
    assert _read(home / "crons.json")["nightly"]["enabled"] is True


def test_an_agent_the_same_import_installs_keeps_its_cron_agent_id(tmp_path):
    home = _home(tmp_path)
    z = _zip(tmp_path / "a.zip", {"crons.json": json.dumps({"jobs": [_risky_job()]})})

    _import(z, home, agent_templates=("ghost-agent",))

    assert _read(home / "crons.json")["nightly"]["agent_id"] == "ghost-agent"


def test_the_cron_pick_names_only_command_jobs_and_does_not_claim_a_reset(tmp_path):
    home = _home(tmp_path)
    jobs = [_risky_job("plain"), _risky_job("runs", command="echo hi")]
    z = _zip(tmp_path / "a.zip", {"crons.json": json.dumps({"jobs": jobs})})

    summary = _import(z, home, include_crons=True)

    assert summary["paused_crons"] == ["runs"]
    assert "paused_crons_reset" not in summary


def test_the_staged_skills_folder_is_not_deleted_through_a_redirected_root(tmp_path):
    live = tmp_path / "home" / "skills" / "mine"
    live.mkdir(parents=True)
    (live / "SKILL.md").write_text("live skill", encoding="utf-8")
    root = tmp_path / "staging-root"
    try:
        root.symlink_to(tmp_path / "home", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available here")

    with pytest.raises(OSError):
        _hold_back_foreign_skills(root, tmp_path / "home")

    assert (live / "SKILL.md").read_text(encoding="utf-8") == "live skill"


def _staged_world(tmp_path: Path) -> tuple[Path, Path, Path]:
    """A staging root holding ``skills/``, a live home with skills, and an outside
    folder with its own ``skills/`` that must never be touched."""
    home = tmp_path / "home"
    (home / "skills" / "mine").mkdir(parents=True)
    (home / "skills" / "mine" / "SKILL.md").write_text("live skill", encoding="utf-8")
    root = tmp_path / "stage" / "root"
    (root / "skills" / "foreign").mkdir(parents=True)
    (root / "skills" / "foreign" / "SKILL.md").write_text("foreign skill", encoding="utf-8")
    outside = tmp_path / "outside"
    (outside / "skills").mkdir(parents=True)
    (outside / "skills" / "keep.txt").write_text("outside", encoding="utf-8")
    return root, home, outside


def _swap_root_for_link(root: Path, outside: Path) -> None:
    root.rename(root.with_name("root-moved"))
    root.symlink_to(outside, target_is_directory=True)


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="needs descriptor-relative opens")
def test_a_root_swapped_for_a_link_after_the_check_does_not_delete_outside(tmp_path, monkeypatch):
    import shutil

    root, home, outside = _staged_world(tmp_path)
    real_rmtree = shutil.rmtree

    def swap_then_remove(path, *args, **kwargs):
        _swap_root_for_link(root, outside)
        return real_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", swap_then_remove)

    try:
        _hold_back_foreign_skills(root, home)
    except OSError:
        pass

    assert (outside / "skills" / "keep.txt").read_text(encoding="utf-8") == "outside"


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="needs descriptor-relative opens")
def test_a_root_swapped_for_a_link_before_the_walk_is_refused(tmp_path, monkeypatch):
    from kiro_crew import pinned_fs

    root, home, outside = _staged_world(tmp_path)
    real_pin = pinned_fs.pin_parent

    def swap_then_pin(path, **kwargs):
        _swap_root_for_link(root, outside)
        return real_pin(path, **kwargs)

    monkeypatch.setattr(pinned_fs, "pin_parent", swap_then_pin)

    with pytest.raises(OSError):
        _hold_back_foreign_skills(root, home)

    assert (outside / "skills" / "keep.txt").read_text(encoding="utf-8") == "outside"
    assert (home / "skills" / "mine" / "SKILL.md").read_text(encoding="utf-8") == "live skill"


def test_a_platform_that_cannot_pin_deletes_by_name_only_when_that_was_accepted(
    tmp_path, monkeypatch
):
    from kiro_crew import pinned_fs

    monkeypatch.setattr(pinned_fs, "supports_pinned_tree_walk", lambda: False)
    root, home, _outside = _staged_world(tmp_path)

    with pytest.raises(OSError):
        _hold_back_foreign_skills(root, home)
    assert (root / "skills" / "foreign" / "SKILL.md").is_file()

    assert _hold_back_foreign_skills(root, home, allow_unpinned=True) is True
    assert not (root / "skills").exists()


def _unpinned_with_swap(monkeypatch, swap) -> None:
    """Make the platform unable to pin, and run *swap* right after the pin decision,
    the moment before the by-name delete."""
    from kiro_crew import pinned_fs, portability_vetting

    monkeypatch.setattr(pinned_fs, "supports_pinned_tree_walk", lambda: False)
    real = portability_vetting._staging_is_pinned

    def decide_then_swap(**kwargs):
        answer = real(**kwargs)
        swap()
        return answer

    monkeypatch.setattr(portability_vetting, "_staging_is_pinned", decide_then_swap)


def test_the_unpinned_delete_refuses_a_root_swapped_for_a_link(tmp_path, monkeypatch):
    root, home, outside = _staged_world(tmp_path)
    _unpinned_with_swap(monkeypatch, lambda: _swap_root_for_link(root, outside))

    with pytest.raises(OSError):
        _hold_back_foreign_skills(root, home, allow_unpinned=True)

    assert (outside / "skills" / "keep.txt").read_text(encoding="utf-8") == "outside"


def test_the_unpinned_delete_refuses_a_skills_folder_swapped_for_a_link(tmp_path, monkeypatch):
    root, home, outside = _staged_world(tmp_path)

    def swap_skills() -> None:
        (root / "skills").rename(root / "skills-moved")
        (root / "skills").symlink_to(outside / "skills", target_is_directory=True)

    _unpinned_with_swap(monkeypatch, swap_skills)

    with pytest.raises(OSError):
        _hold_back_foreign_skills(root, home, allow_unpinned=True)

    assert (outside / "skills" / "keep.txt").read_text(encoding="utf-8") == "outside"


def test_the_unpinned_delete_still_removes_a_normal_staged_folder(tmp_path, monkeypatch):
    root, home, outside = _staged_world(tmp_path)
    _unpinned_with_swap(monkeypatch, lambda: None)

    assert _hold_back_foreign_skills(root, home, allow_unpinned=True) is True

    assert not (root / "skills").exists()
    assert (outside / "skills" / "keep.txt").is_file()


def test_a_picked_template_keeps_a_cron_that_names_its_declared_name(tmp_path):
    home = _home(tmp_path)
    template = {"name": "reviewer", "description": "reviews"}
    z = _zip(
        tmp_path / "a.zip",
        {
            "crons.json": json.dumps({"jobs": [_risky_job(agent_id="reviewer")]}),
            "agents/package-reviewer.json": json.dumps(template),
        },
    )

    _import(z, home, agent_templates=("package-reviewer",))

    assert _read(home / "crons.json")["nightly"]["agent_id"] == "reviewer"


def test_a_corrupt_picked_template_does_not_stop_the_import(tmp_path):
    home = _home(tmp_path)
    z = tmp_path / "a.zip"
    with zipfile.ZipFile(str(z), "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("snap/MANIFEST.json", json.dumps({"version": 2}))
        zf.writestr("snap/crons.json", json.dumps({"jobs": [_risky_job()]}))
        zf.writestr("snap/agents/bad.json", json.dumps({"name": "bad", "pad": "x" * 4000}))
    with zipfile.ZipFile(str(z)) as zf:
        info = zf.getinfo("snap/agents/bad.json")
        start = info.header_offset + 30 + len(info.filename) + len(info.extra)
    raw = bytearray(z.read_bytes())
    raw[start : start + 8] = b"\xff" * 8
    z.write_bytes(bytes(raw))

    summary = _import(z, home, agent_templates=("bad",))

    assert _read(home / "crons.json")["nightly"]["user_paused"] is True
    assert summary["paused_crons"] == ["nightly"]


def _archive_with_unreadable_template(path: Path, kind: str) -> Path:
    """An archive whose picked template ``agents/bad.json`` cannot be read: ``encrypted``
    sets the encryption flag, ``method`` names a compression method nobody implements."""
    with zipfile.ZipFile(str(path), "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("snap/MANIFEST.json", json.dumps({"version": 2}))
        zf.writestr("snap/crons.json", json.dumps({"jobs": [_risky_job()]}))
        zf.writestr("snap/agents/bad.json", json.dumps({"name": "bad"}))
    raw = bytearray(path.read_bytes())
    local = raw.index(b"snap/agents/bad.json") - 30  # the member's local header comes first
    central = raw.rindex(b"PK\x01\x02")  # it is the last member of the directory
    if kind == "encrypted":
        for at in (local + 6, central + 8):  # general purpose flags: bit 0 = encrypted
            raw[at] |= 0x1
    else:
        for at in (local + 8, central + 10):  # compression method
            raw[at : at + 2] = (99).to_bytes(2, "little")
    path.write_bytes(bytes(raw))
    return path


@pytest.mark.parametrize("kind", ["encrypted", "method"])
def test_an_unreadable_picked_template_is_skipped_not_raised(tmp_path, kind):
    home = _home(tmp_path)
    z = _archive_with_unreadable_template(tmp_path / "a.zip", kind)

    summary = _import(z, home, agent_templates=("bad",))

    assert _read(home / "crons.json")["nightly"]["user_paused"] is True
    assert summary["paused_crons"] == ["nightly"]


def test_import_with_the_cron_pick_installs_the_job_as_written(tmp_path):
    home = _home(tmp_path)
    z = _zip(tmp_path / "a.zip", {"crons.json": json.dumps({"jobs": [_risky_job()]})})

    summary = _import(z, home, include_crons=True)

    job = _read(home / "crons.json")["nightly"]
    assert job["enabled"] is True and job["approval_mode"] == "auto"
    assert job["env"] == {"FLAG": "1"}
    assert "paused_crons" not in summary


def _live_skill(home: Path) -> Path:
    mine = home / "skills" / "mine" / "SKILL.md"
    mine.parent.mkdir(parents=True)
    mine.write_text("live skill", encoding="utf-8")
    return mine


def _skills_zip(tmp_path: Path) -> Path:
    return _zip(tmp_path / "s.zip", {"skills/foreign/SKILL.md": "foreign skill"})


def test_replace_keeps_a_live_skills_tree_unless_it_is_picked(tmp_path):
    home = _home(tmp_path)
    mine = _live_skill(home)

    summary = _import(_skills_zip(tmp_path), home)

    assert mine.read_text(encoding="utf-8") == "live skill"
    assert not (home / "skills" / "foreign").exists()
    assert summary["skills_kept"] is True


def test_replace_installs_the_skills_tree_when_picked(tmp_path):
    home = _home(tmp_path)
    mine = _live_skill(home)

    summary = _import(_skills_zip(tmp_path), home, include_skills=True)

    assert (home / "skills" / "foreign" / "SKILL.md").read_text(encoding="utf-8") == "foreign skill"
    assert not mine.exists()
    assert "skills_kept" not in summary


def test_replace_installs_the_skills_tree_on_a_machine_with_no_live_skills(tmp_path):
    home = _home(tmp_path)

    summary = _import(_skills_zip(tmp_path), home)

    assert (home / "skills" / "foreign" / "SKILL.md").is_file()
    assert "skills_kept" not in summary
