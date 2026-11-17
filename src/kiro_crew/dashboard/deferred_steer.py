"""Pending steers: a steer that could not be injected yet waits for the next tool boundary.

``session_send(steer=true)`` and ``session_broadcast(mode=steer)`` ask for a message to
cut into the target's RUNNING turn. When injection is unavailable at the instant of the
send (no steer-capable client yet, no prompt in flight, a /compact turn, an identical
steer in flight, the pending cap), the gateway holds the message here instead of
queueing it behind the whole turn.

* The stream loop calls :func:`flush_at_boundary` after every tool result. Each held
  steer is retried there, every boundary, until it is delivered.
* If the turn ends first, ``_hand_off_queue`` calls :func:`requeue_all` before it drains,
  so the held steers take the ordinary end-of-turn queue path and the next turn starts in
  the same hand-off.
* A steer is identified by ``sender + target + message``. Sending the same text again
  while it is held, or shortly after it was settled, returns the same steer and delivers
  nothing a second time.

What a held steer DOES at a boundary (re-authorize, steer, check the audience) is a
closure the sender builds in ``session_messaging``, where those gates live; this module
only holds, retries, settles and reports.
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    from kiro_crew.dashboard.state import DashboardState, _ChatSlot

logger = logging.getLogger(__name__)

#: What a boundary attempt reports.
DELIVERED = "delivered"
QUEUED = "queued"
RETRY = "retry"
DROPPED = "dropped"

#: Receipt states. ``delivered`` and ``queued`` carry ``@<iso ts>`` when settled.
PENDING = "pending-steer"

#: Held steers per slot; past it a send is refused rather than quietly queued.
MAX_DEFERRED_STEERS = 8

#: Settled receipts kept per slot, and how long a settled one still counts as "the
#: same steer" for a re-send. After the window an identical message is a new one.
MAX_RECEIPTS = 32
DEDUP_WINDOW_SECS = 120.0


@dataclass
class DeferredSteer:
    steer_id: str
    sender: str
    created_ts: float
    #: One boundary attempt: returns DELIVERED, RETRY or DROPPED. May raise.
    attempt: Callable[[], Awaitable[str]] = field(repr=False)
    #: The end-of-turn path for a steer the turn outlived.
    to_queue: Callable[[], Awaitable[None]] = field(repr=False)
    attempts: int = 0


def steer_id_for(sender: str, target_key: str, message: str) -> str:
    """The dedup key: one id per (sender, target, message)."""
    raw = "\x00".join((sender, target_key, message)).encode("utf-8", "replace")
    return hashlib.sha256(raw).hexdigest()[:16]


def _stamp(state: str) -> str:
    return f"{state}@{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"


def find(slot: "_ChatSlot", steer_id: str) -> "dict[str, Any] | None":
    """The reply facts of a held steer, or of one settled within the dedup window."""
    if any(held.steer_id == steer_id for held in slot._deferred_steers):
        return {"pending": True, "state": PENDING}
    receipt = slot._deferred_steer_receipts.get(steer_id)
    if (
        receipt
        and receipt["state"].startswith((DELIVERED, QUEUED))
        and time.monotonic() - receipt["mono"] <= DEDUP_WINDOW_SECS
    ):
        return {"pending": False, "state": receipt["state"]}
    return None


def hold(
    slot: "_ChatSlot",
    *,
    steer_id: str,
    sender: str,
    attempt: Callable[[], Awaitable[str]],
    to_queue: Callable[[], Awaitable[None]],
) -> bool:
    """Hold a steer for the next boundary; False when the slot's cap is full."""
    if len(slot._deferred_steers) >= MAX_DEFERRED_STEERS:
        return False
    slot._deferred_steers.append(
        DeferredSteer(
            steer_id=steer_id,
            sender=sender,
            created_ts=time.time(),
            attempt=attempt,
            to_queue=to_queue,
        )
    )
    slot._deferred_steer_receipts.pop(steer_id, None)
    return True


def _settle(slot: "_ChatSlot", held: DeferredSteer, state: str) -> None:
    if held in slot._deferred_steers:
        slot._deferred_steers.remove(held)
    receipts = slot._deferred_steer_receipts
    receipts[held.steer_id] = {"state": _stamp(state), "mono": time.monotonic()}
    while len(receipts) > MAX_RECEIPTS:
        receipts.pop(next(iter(receipts)))


def receipts(slot: "_ChatSlot") -> list[dict[str, str]]:
    """Held and recently settled steers of *slot*, for the status row."""
    rows = [{"steer_id": held.steer_id, "state": PENDING} for held in slot._deferred_steers]
    rows += [
        {"steer_id": steer_id, "state": receipt["state"]}
        for steer_id, receipt in slot._deferred_steer_receipts.items()
    ]
    return rows


async def flush_at_boundary(state: "DashboardState", slot: "_ChatSlot") -> None:
    """Retry every held steer of *slot* now. Called at each tool-call boundary."""
    for held in list(slot._deferred_steers):
        if held not in slot._deferred_steers:
            continue
        held.attempts += 1
        try:
            outcome = await held.attempt()
        except Exception:  # noqa: BLE001 - one bad steer must not break the stream loop
            logger.warning("deferred steer %s refused at a boundary", held.steer_id, exc_info=True)
            outcome = DROPPED
        if outcome in (DELIVERED, QUEUED):
            _settle(slot, held, outcome)
        elif outcome == DROPPED:
            _settle(slot, held, "refused")


async def requeue_all(state: "DashboardState", slot: "_ChatSlot") -> None:
    """The turn ended first: hand every held steer to the end-of-turn queue.

    Called by ``_hand_off_queue`` before it drains, so the next turn starts in the
    same call. The queue entry carries the same text and provenance as a steer would.
    """
    for held in list(slot._deferred_steers):
        try:
            await held.to_queue()
        except Exception:  # noqa: BLE001 - a refused entry must not strand the others
            logger.warning("deferred steer %s could not be queued", held.steer_id, exc_info=True)
            _settle(slot, held, "refused")
        else:
            _settle(slot, held, QUEUED)
