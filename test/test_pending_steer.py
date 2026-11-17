"""A steer that cannot be injected at send time waits for the next tool boundary.

``session_send(steer=True)`` and ``session_broadcast(mode=steer)`` used to fall back to
the end-of-turn queue when the target was mid-turn and injection was unavailable at
that instant, so an urgent message waited for the whole turn. The contract here: the
gateway holds it as a PENDING STEER, retries at every tool-call boundary of the same
turn, and only when the turn ends first hands it to the end-of-turn path, which starts
the next turn at once.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from chat_test_helpers import _make_state
from session_control_helpers import (  # noqa: F401 -- the autouse fixtures register by import
    _enabled_fixture,
    _fresh_create_budget,
    _fresh_stop_windows,
    _key,
    _peer_target,
    _slot,
    _steerable,
)

from kiro_crew.crew_log import emit
from kiro_crew.crew_log import session_tree_projection as stp
from kiro_crew.crew_log.session_tree import OpenedRecord
from kiro_crew.dashboard import chat_runner
from kiro_crew.dashboard import session_control as sc

TEXT = "stop, the base moved; rebase before you push"


def _running(slot):
    """A slot whose turn is in flight, ended by cancelling ``slot.task``."""
    slot.task = asyncio.get_running_loop().create_future()
    return slot


@pytest.fixture(name="_tree")
def _tree_fixture(tmp_path, monkeypatch):
    """The crew-log fold ``created_session_status`` reads, in memory only."""
    monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "crewhome"))
    monkeypatch.setenv(emit.CREW_LOG_ENV, "1")
    monkeypatch.setattr(
        "kiro_crew.executors.maintenance_executor",
        lambda: type("_NoPool", (), {"submit": staticmethod(lambda *a, **k: None)}),
    )
    stp.reset_for_tests()
    stp.projection().ensure_seeded()
    yield
    stp.reset_for_tests()


async def _send(state, caller, target="chat-2", message=TEXT):
    return await sc.send_to_target(
        state, caller_session_key=_key(caller), target=target, message=message, steer=True
    )


@pytest.mark.asyncio
async def test_an_unavailable_steer_is_injected_at_the_next_tool_boundary(tmp_path):
    """(a) No client at send time: held, not queued; the boundary injects it, once."""
    state = _make_state(tmp_path)
    caller = _slot(state, "chat-1")
    target = _running(_peer_target(state, "chat-2", caller))

    out = await _send(state, caller)

    assert out.get("pending_steer") is True, "the send must report a pending steer"
    from kiro_crew.dashboard import deferred_steer

    assert out["steered"] is False
    assert not target._queue, "a steer must never be a plain end-of-turn queue entry"

    # The first boundary still has no client: it stays pending and nothing is queued.
    await deferred_steer.flush_at_boundary(state, target)
    assert not target._queue

    # The turn now has a steer-capable client: the NEXT boundary delivers it.
    target._acp_client = _steerable(accepted=True)
    await deferred_steer.flush_at_boundary(state, target)

    target._acp_client.steer.assert_awaited_once()
    injected = target._acp_client.steer.await_args.args[0]
    assert TEXT in injected and injected.startswith("[sent by session ")
    assert not target._queue


@pytest.mark.asyncio
async def test_a_steer_whose_turn_ends_first_is_queued_and_the_next_turn_starts_at_once(tmp_path):
    """(b) The turn ends before any boundary delivered it: end-of-turn path, no idle wait."""
    state = _make_state(tmp_path)
    caller = _slot(state, "chat-1")
    target = _running(_peer_target(state, "chat-2", caller))

    out = await _send(state, caller)
    assert out.get("pending_steer") is True

    run_chat = MagicMock(return_value=MagicMock())
    try:
        with (
            patch.object(chat_runner, "spawn_guarded_turn", return_value=MagicMock()) as spawn,
            patch.object(chat_runner, "_run_chat", new=run_chat),
        ):
            await chat_runner._hand_off_queue(
                state, target, drain=True, allow_automatic_successor=False
            )
    finally:
        target.task.cancel()

    assert spawn.call_count == 1, "the next turn must start in the same hand-off"
    assert any(TEXT in str(call) for call in run_chat.call_args_list), "and it runs the steer text"
    assert not target._queue, "the entry was consumed by the started turn, not left waiting"


@pytest.mark.asyncio
async def test_a_resent_steer_is_delivered_exactly_once(tmp_path):
    """(c) A re-send (or retry) of the same steer adds nothing and delivers once."""
    state = _make_state(tmp_path)
    caller = _slot(state, "chat-1")
    target = _running(_peer_target(state, "chat-2", caller))

    first = await _send(state, caller)
    second = await _send(state, caller)

    assert first.get("pending_steer") is True
    assert second.get("pending_steer") is True
    from kiro_crew.dashboard import deferred_steer

    assert second["steer_id"] == first["steer_id"], "the duplicate must map to the same steer"
    assert not target._queue

    target._acp_client = _steerable(accepted=True)
    await deferred_steer.flush_at_boundary(state, target)
    await deferred_steer.flush_at_boundary(state, target)
    third = await _send(state, caller)

    assert target._acp_client.steer.await_count == 1, "delivered exactly once"
    assert third["steer_id"] == first["steer_id"], "a late retry is recognised as the same steer"
    assert target._acp_client.steer.await_count == 1


@pytest.mark.asyncio
async def test_the_reply_says_pending_steer_and_the_status_later_says_delivered(tmp_path, _tree):
    """(d) Reply text first, then ``delivered@<ts>`` on the target's status row."""
    state = _make_state(tmp_path)
    caller = _slot(state, "chat-1")
    target = _running(_peer_target(state, "chat-2", caller))
    target._created_by = caller.key
    proj = stp.projection()
    proj.apply(OpenedRecord(sid="sid-chat-1", slot="chat-1", created_at=1))
    proj.apply(OpenedRecord(sid="sid-chat-2", slot="chat-2", created_at=2, parent_slot="chat-1"))

    out = await _send(state, caller)
    assert out.get("steer_state") == "pending-steer"
    from kiro_crew.dashboard import deferred_steer

    status = await sc.created_session_status(state, caller_session_key=_key(caller))
    row = {r["target"]: r for r in status["sessions"]}[target.key]
    assert row["steer_receipts"] == [{"steer_id": out["steer_id"], "state": "pending-steer"}]

    target._acp_client = _steerable(accepted=True)
    await deferred_steer.flush_at_boundary(state, target)

    status = await sc.created_session_status(state, caller_session_key=_key(caller))
    row = {r["target"]: r for r in status["sessions"]}[target.key]
    receipt = row["steer_receipts"][0]
    assert receipt["steer_id"] == out["steer_id"]
    assert receipt["state"].startswith("delivered@")


@pytest.mark.asyncio
async def test_a_loss_recovery_backend_gets_the_peer_steer_at_the_boundary(tmp_path):
    """(e) A claude/codex-type client refuses a peer steer at send time by default.

    ``steer_needs_loss_recovery`` plus ``peer_steer_loss_recovery`` off means the
    send-time attempt answers unavailable. The held steer must still be injected at
    the next boundary, registered pending so a turn that drops it requeues it.
    """
    state = _make_state(tmp_path)
    caller = _slot(state, "chat-1")
    target = _running(_peer_target(state, "chat-2", caller))
    client = _steerable(accepted=True)
    client.steer_needs_loss_recovery = True
    target._acp_client = client

    out = await _send(state, caller)

    assert out.get("pending_steer") is True, "refused at send time, so held rather than queued"
    from kiro_crew.dashboard import deferred_steer

    client.steer.assert_not_awaited()
    assert not target._queue

    await deferred_steer.flush_at_boundary(state, target)

    client.steer.assert_awaited_once()
    assert any(TEXT in text for text in target._pending_steers), "registered, so it is tracked"
    assert not target._queue


def _loss_recovery_target(state):
    caller = _slot(state, "chat-1")
    target = _running(_peer_target(state, "chat-2", caller))
    client = _steerable(accepted=True)
    client.steer_needs_loss_recovery = True
    target._acp_client = client
    return caller, target, client


async def _hand_off(state, target):
    """End the target's turn the way ``_hand_off_queue`` does; return the spawn mock."""
    with (
        patch.object(chat_runner, "spawn_guarded_turn", return_value=MagicMock()) as spawn,
        patch.object(chat_runner, "_run_chat", new=MagicMock(return_value=MagicMock())),
    ):
        try:
            await chat_runner._hand_off_queue(
                state, target, drain=True, allow_automatic_successor=False
            )
        finally:
            if target.task is not None:
                target.task.cancel()
    return spawn


@pytest.mark.asyncio
async def test_an_injected_peer_steer_does_not_run_again_from_the_queue(tmp_path, monkeypatch):
    """(f) NO DOUBLE RUN: injected at the boundary, then the turn ends unconsumed.

    A loss-recovery harness may have acted on the steer before it dropped it, so the
    teardown must not queue it back: marked delivered before the injection, the
    requeue skips it and no next turn starts for it.
    """
    state = _make_state(tmp_path)
    caller, target, client = _loss_recovery_target(state)

    out = await _send(state, caller)
    assert out.get("pending_steer") is True
    from kiro_crew.dashboard import deferred_steer

    await deferred_steer.flush_at_boundary(state, target)
    client.steer.assert_awaited_once()
    assert target._deferred_steer_delivered, "marked delivered when it was injected"

    spawn = await _hand_off(state, target)

    assert spawn.call_count == 0, "no second run from the queue"
    assert not target._queue
    assert not target._pending_steers


@pytest.mark.asyncio
async def test_a_steer_whose_injection_fails_stays_pending_and_is_not_lost(tmp_path):
    """(g) No silent loss before delivery: a refused injection clears the mark.

    The client answers "not accepted", so the steer stays held with no delivered
    mark, and the turn ending then hands it to the queue and starts the next turn.
    """
    state = _make_state(tmp_path)
    caller, target, client = _loss_recovery_target(state)
    client.steer.return_value = False

    out = await _send(state, caller)
    assert out.get("pending_steer") is True
    from kiro_crew.dashboard import deferred_steer

    await deferred_steer.flush_at_boundary(state, target)

    assert not target._deferred_steer_delivered, "the mark is cleared when injection fails"
    assert len(target._deferred_steers) == 1

    spawn = await _hand_off(state, target)

    assert spawn.call_count == 1, "the held steer runs as the next turn"
