"""KAS approve-for-me: the engine switch, the per-session value, the audit row and the owner check."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from kiro_crew.acp import kas_approve_for_me as afm


@pytest.fixture(autouse=True)
def _reset_owner_check():
    afm.reset_owner_check()
    yield
    afm.reset_owner_check()


def _option(value: str) -> list[dict[str, Any]]:
    return [{"id": "model", "currentValue": "auto"}, {"id": "approveForMe", "currentValue": value}]


class _Handle:
    def __init__(self, value: str | None, *, fail: bool = False, key: str = "dashboard:1"):
        self.config_options = [] if value is None else _option(value)
        self.writes: list[tuple[str, str]] = []
        self._fail = fail
        self._session_key = key

    async def set_config_option(self, config_id: str, value: str) -> None:
        if self._fail:
            raise RuntimeError("refused")
        self.writes.append((config_id, value))
        self.config_options = _option(value)


@pytest.mark.parametrize(
    ("current", "allowed", "target"),
    [
        (None, False, None),
        (None, True, None),
        ("off", False, None),
        ("off", True, "on"),
        ("on", True, None),
        ("on", False, "off"),
        ("files", True, "on"),
        ("files", False, "off"),
        ("", False, "off"),
    ],
)
def test_a_session_is_held_on_or_off_never_files(current, allowed, target):
    assert afm.settle_target(current, allowed=allowed) == target


def test_settle_writes_off_over_files_and_sends_nothing_without_the_option():
    files = _Handle("files")
    asyncio.run(afm.settle(files))
    assert files.writes == [("approveForMe", "off")]
    none = _Handle(None)
    asyncio.run(afm.settle(none))
    assert none.writes == []


def test_settle_writes_on_only_while_the_owner_allows_it():
    afm.register_owner_check(lambda key: key == "dashboard:1")
    opted = _Handle("files")
    asyncio.run(afm.settle(opted))
    assert opted.writes == [("approveForMe", "on")]
    other = _Handle("on", key="slack:1")
    asyncio.run(afm.settle(other))
    assert other.writes == [("approveForMe", "off")]


def test_an_owner_check_that_raises_holds_the_session_off():
    def boom(_key: str) -> bool:
        raise ValueError("x")

    afm.register_owner_check(boom)
    handle = _Handle("on")
    asyncio.run(afm.settle(handle))
    assert handle.writes == [("approveForMe", "off")]


def test_an_on_session_that_cannot_be_turned_off_refuses_the_turn():
    with pytest.raises(afm.ApproveForMeNotOff):
        asyncio.run(afm.settle(_Handle("on", fail=True)))
    # A failed write over ``files`` is logged, not raised.
    asyncio.run(afm.settle(_Handle("files", fail=True)))


def test_the_engine_switch_overrides_an_inherited_value():
    env = {afm.CLASSIFIER_MODE_ENV: "enforce"}
    afm.force_off(env)
    assert env[afm.CLASSIFIER_MODE_ENV] == "off"
    afm.enable(env)
    assert env[afm.CLASSIFIER_MODE_ENV] == "enforce"


def test_no_harness_inherits_the_engine_switch(monkeypatch):
    from kiro_crew.acp.client import _resolve_spawn_env
    from kiro_crew.acp.harness import harness_for
    from kiro_crew.acp.types import ACP_BACKEND_KAS, ACP_BACKEND_KIRO

    inherited = {afm.CLASSIFIER_MODE_ENV: "enforce"}
    kas_env = dict(inherited)
    harness_for(ACP_BACKEND_KAS).apply_spawn_env(kas_env)
    assert kas_env[afm.CLASSIFIER_MODE_ENV] == "off"
    kiro_env = dict(inherited)
    harness_for(ACP_BACKEND_KIRO).apply_spawn_env(kiro_env)
    assert kiro_env[afm.CLASSIFIER_MODE_ENV] == "off"
    client_env = _resolve_spawn_env(dict(inherited))
    assert client_env[afm.CLASSIFIER_MODE_ENV] == "off"


def test_only_an_opted_in_session_carries_enforce_in_its_own_env():
    afm.register_owner_check(lambda key: key == "dashboard:1")
    assert afm.session_env("dashboard:1", None) == {afm.CLASSIFIER_MODE_ENV: "enforce"}
    assert afm.session_env("dashboard:1", {"A": "1"}) == {
        "A": "1",
        afm.CLASSIFIER_MODE_ENV: "enforce",
    }
    # Not opted in: the env is left as the caller gave it, and a smuggled value is dropped.
    plain = {"A": "1"}
    assert afm.session_env("dashboard:2", plain) is plain
    assert afm.session_env("dashboard:2", None) is None
    assert afm.session_env("dashboard:2", {afm.CLASSIFIER_MODE_ENV: "enforce"}) is None


@pytest.mark.parametrize(
    ("backend", "own", "want"),
    [
        ("kas", {afm.CLASSIFIER_MODE_ENV: "enforce"}, "enforce"),
        ("kas", {}, "off"),
        ("kas", None, "off"),
        ("", {afm.CLASSIFIER_MODE_ENV: "enforce"}, "off"),
        ("claude", {afm.CLASSIFIER_MODE_ENV: "enforce"}, "off"),
    ],
)
def test_the_runtime_spawn_keeps_enforce_only_from_its_own_env(backend, own, want):
    # The gateway's or ``agent.env``'s value is already in *env*; it never decides.
    env = {afm.CLASSIFIER_MODE_ENV: "enforce"}
    afm.apply_runtime_env(env, backend, own)
    assert env[afm.CLASSIFIER_MODE_ENV] == want


def test_kas_is_asked_to_list_the_option():
    from kiro_crew.acp.types import KAS_CLIENT_CAPABILITIES

    assert KAS_CLIENT_CAPABILITIES["_meta"]["kiro"]["approveForMeOption"] is True


class _Sel:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def log_tool_invocation(self, **kw: Any) -> None:
        self.rows.append(kw)


def _frame(call_id: str, approved: bool) -> dict[str, Any]:
    meta = {"kiro": {"trustClassifierApproved": True}} if approved else {"kiro": {}}
    return {
        "sessionUpdate": "tool_call",
        "toolCallId": call_id,
        "title": "Run: ls",
        "kind": "execute",
        "_meta": meta,
    }


def test_a_kas_approved_call_gets_one_audit_row(monkeypatch):
    sink = _Sel()
    monkeypatch.setattr("kiro_crew.sel.sel", lambda: sink)
    handle = SimpleNamespace(_session_key="dashboard:1", _session_id="s1", active_agent="kirocrew")
    afm.audit_classifier_approved(handle, _frame("t1", True))
    afm.audit_classifier_approved(
        handle, {**_frame("t1", True), "sessionUpdate": "tool_call_update"}
    )
    afm.audit_classifier_approved(handle, _frame("t2", False))
    assert len(sink.rows) == 1
    row = sink.rows[0]
    assert row["outcome"] == "auto_approved"
    assert row["source"] == afm.SEL_SOURCE
    assert row["request_id"] == "t1"
    assert row["session_key"] == "dashboard:1"
    assert row["metadata"]["crew_gate"] == "skipped"


def test_an_approved_call_after_leave_is_withdrawn_cancels_the_turn_once(monkeypatch):
    sink = _Sel()
    monkeypatch.setattr("kiro_crew.sel.sel", lambda: sink)
    cancels: list[int] = []

    class _Live:
        _session_key = "dashboard:1"
        _session_id = "s1"
        active_agent = "kirocrew"

        def __init__(self) -> None:
            self._audit_tasks: set[Any] = set()

        async def cancel(self) -> None:
            cancels.append(1)

    async def run(allowed: bool) -> None:
        afm.register_owner_check(lambda _key: allowed)
        handle = _Live()
        afm.audit_classifier_approved(handle, _frame("t1", True))
        afm.audit_classifier_approved(handle, _frame("t2", True))
        while handle._audit_tasks:
            await asyncio.gather(*list(handle._audit_tasks))

    asyncio.run(run(True))
    assert cancels == []
    asyncio.run(run(False))
    assert cancels == [1]
    assert len(sink.rows) == 4


def test_the_policy_denies_approve_for_me_unless_a_rule_lists_it(monkeypatch):
    from types import SimpleNamespace as NS

    from kiro_crew import approval_mode_policy as amp

    def verdict(control) -> bool:
        monkeypatch.setattr(amp, "_ceiling_control", lambda: control)
        monkeypatch.setattr(
            "kiro_crew.platform.governance_parts.evaluator._query_level",
            lambda c, _scope, item: NS(permitted=item in c.allow),
        )
        amp.reset_state()
        monkeypatch.setattr(amp, "_bootstrap", amp._resolve_now)
        return amp.session_mode_permitted("approve_for_me")

    # No rule, a rule allowing Trust, a deny-mode rule: refused, and hidden.
    assert verdict(None) is False
    assert verdict(NS(mode="allow", allow=("normal", "trust", "trust_reads"))) is False
    assert "approve_for_me" in amp.disabled_session_modes()
    assert verdict(NS(mode="deny", allow=(), deny=("yolo",))) is False
    # Listed by name: permitted, and Trust is unaffected either way.
    assert verdict(NS(mode="allow", allow=("normal", "trust", "approve_for_me"))) is True
    assert "approve_for_me" not in amp.disabled_session_modes()
    assert amp.clamp_session_mode("trust") == "trust"
    amp.reset_state()


def _state(slots: list[Any], *, yolo: bool = False, keys: set[str] | None = None) -> Any:
    state = SimpleNamespace(
        sessions=SimpleNamespace(_fold_key=lambda key: key),
        _slots={s.key: s for s in slots},
        is_yolo_active=lambda: yolo,
        yolo_reaches=lambda _slot: True,
    )
    if keys is not None:
        state._approve_for_me_keys = keys
    return state


def _slot(key: str, **flags: Any) -> Any:
    return SimpleNamespace(
        key=key,
        linked_session_key="",
        _trust=flags.get("trust", False),
        _trust_reads=flags.get("reads", False),
        _trust_scope="",
    )


@pytest.fixture
def _permitted(monkeypatch):
    from kiro_crew.dashboard import approve_for_me as dafm

    monkeypatch.setattr(dafm, "approve_for_me_permitted", lambda: True)
    monkeypatch.setattr(dafm, "effective_session_key", lambda slot: slot.key)
    return dafm


def test_the_owner_allows_only_a_session_a_person_turned_on(_permitted):
    dafm = _permitted
    slot = _slot("dashboard:1")
    assert dafm.owner_allows(_state([slot], keys={"dashboard:1"}), "dashboard:1") is True
    assert dafm.owner_allows(_state([slot]), "dashboard:1") is False
    # A key no live slot addresses is held off.
    assert dafm.owner_allows(_state([], keys={"dashboard:1"}), "dashboard:1") is False


@pytest.mark.parametrize("flags", [{"trust": True}, {"reads": True}])
def test_trust_or_reads_on_the_session_holds_it_off(_permitted, flags):
    state = _state([_slot("dashboard:1", **flags)], keys={"dashboard:1"})
    assert _permitted.owner_allows(state, "dashboard:1") is False


def test_a_reaching_yolo_grant_holds_it_off(_permitted):
    state = _state([_slot("dashboard:1")], yolo=True, keys={"dashboard:1"})
    assert _permitted.owner_allows(state, "dashboard:1") is False


def test_a_policy_deny_holds_it_off(_permitted, monkeypatch):
    monkeypatch.setattr(_permitted, "approve_for_me_permitted", lambda: False)
    state = _state([_slot("dashboard:1")], keys={"dashboard:1"})
    assert _permitted.owner_allows(state, "dashboard:1") is False


def test_a_dashboard_card_turn_keeps_its_human_approval_floor(_permitted, monkeypatch):
    from kiro_crew.dashboard import card_send

    state = _state([_slot("dashboard:1")], keys={"dashboard:1"})
    assert _permitted.owner_allows(state, "dashboard:1") is True
    with card_send.card_turn("dashboard:1"):
        assert card_send.card_turn_running("dashboard:1")
        assert _permitted.owner_allows(state, "dashboard:1") is False
    assert _permitted.owner_allows(state, "dashboard:1") is True


def test_a_long_tool_call_id_is_cut_before_it_is_kept(monkeypatch):
    sink = _Sel()
    monkeypatch.setattr("kiro_crew.sel.sel", lambda: sink)
    handle = SimpleNamespace(_session_key="dashboard:1", _session_id="s1", active_agent="kirocrew")
    afm.audit_classifier_approved(handle, _frame("x" * 10_000, True))
    assert len(sink.rows[0]["request_id"]) == afm.CALL_ID_MAX_CHARS
    assert all(len(k) <= afm.CALL_ID_MAX_CHARS for k in handle._kas_classifier_audited)


@pytest.mark.parametrize("mode", ["normal", "trust", "trust_reads"])
def test_any_mode_set_through_the_shared_mutation_ends_approve_for_me(tmp_path, monkeypatch, mode):
    """``apply_approval_mode`` is the one mutation every entry point calls."""
    from unittest.mock import AsyncMock, MagicMock

    from kiro_crew.dashboard import chat_handlers
    from kiro_crew.dashboard.approve_for_me import approve_for_me_keys
    from kiro_crew.dashboard.state import DashboardState
    from kiro_crew.history import ConversationLog

    monkeypatch.setattr(chat_handlers, "session_mode_permitted", lambda _m: True)
    sessions = MagicMock(count=0)
    sessions.get_pid = MagicMock(return_value=None)
    sessions.get_provider = MagicMock(return_value=None)
    sessions.remove = AsyncMock()
    state = DashboardState(
        sessions=sessions,
        crons=MagicMock(list_jobs=MagicMock(return_value=[]), status=MagicMock(return_value={})),
        lessons=MagicMock(load_all=MagicMock(return_value=[])),
        start_time=0.0,
        conversation_log=ConversationLog(base_dir=tmp_path),
    )
    slot = state.get_or_create_slot("s1")
    key = chat_handlers.effective_session_key(slot)
    approve_for_me_keys(state).add(key)
    answer = asyncio.run(
        chat_handlers.apply_approval_mode(
            state,
            mode=mode,
            slot=slot,
            slot_key=slot.key,
            request_app="",
            cron_creator="",
            audit_caller=lambda label: label,
        )
    )
    assert answer.status == 200
    assert key not in approve_for_me_keys(state)


@pytest.mark.parametrize(
    "module",
    [
        "src/kiro_crew/dashboard/chat_api/slot_approval.py",  # dashboard picker (api_chat_mode)
        "src/kiro_crew/slack/code_channels/approval_picker.py",  # Slack code channel
        "src/kiro_crew/dashboard/crewmate_approval.py",  # crewmate live DM slot
        "src/kiro_crew/dashboard/agent_admin/crew_update.py",  # crewmate profile write
        "src/kiro_crew/dashboard/workflow_session_port.py",  # workflow session
    ],
)
def test_every_entry_point_sets_a_mode_through_the_shared_mutation(module):
    """Each one reaches the cleanup because each calls ``apply_approval_mode``."""
    import ast
    from pathlib import Path

    tree = ast.parse(Path(module).read_text(encoding="utf-8"))
    calls = [
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id == "apply_approval_mode"
    ]
    assert calls, f"{module} sets an approval mode without apply_approval_mode"
