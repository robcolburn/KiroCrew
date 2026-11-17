"""Which dashboard sessions may keep KAS "approve for me" on.

KAS asks this through :func:`kiro_crew.acp.kas_approve_for_me.register_owner_check`
when a session opens and before each of its turns, and turns the option off
whenever the answer is no. The answer is yes only while all of these hold:

* a person turned approve-for-me on for that session from this dashboard (the
  key is in :func:`approve_for_me_keys`; a gateway restart forgets it, so a
  resumed session starts off again);
* the ``approval_modes`` policy permits it (:func:`approve_for_me_permitted`);
* no slot on that session holds Trust, Reads or a reaching YOLO grant, under
  which Crew answers the calls itself;
* no Dashboard card's turn runs on it: a card turn keeps its human-approval
  floor, so its calls take Crew's permission path;
* no slot on that session is tied to a messaging channel, and no running turn
  on it came from one: other people reach a channel session, and their turns
  keep Crew's deny floor (the same lines ``deny_override`` draws).
"""

from __future__ import annotations

import functools
from typing import TYPE_CHECKING

from kiro_crew.acp import kas_approve_for_me
from kiro_crew.approval_mode_policy import APPROVE_FOR_ME_MODE, session_mode_permitted
from kiro_crew.dashboard import card_send
from kiro_crew.dashboard.chat_utils_slots import effective_session_key

if TYPE_CHECKING:
    from kiro_crew.dashboard.state import DashboardState

_KEYS_ATTR = "_approve_for_me_keys"


def approve_for_me_keys(state: DashboardState) -> set[str]:
    """The session keys a person turned approve-for-me on for, on *state*."""
    keys = getattr(state, _KEYS_ATTR, None)
    if not isinstance(keys, set):
        keys = set()
        setattr(state, _KEYS_ATTR, keys)
    return keys


def approve_for_me_permitted() -> bool:
    """Whether the ``approval_modes`` policy lets a session hold approve-for-me."""
    return session_mode_permitted(APPROVE_FOR_ME_MODE)


def channel_linked(slot: object) -> bool:
    """Whether *slot* is bound to another session (channel, cron, workflow) or mirrored to Slack."""
    return bool(
        getattr(slot, "linked_session_key", "")
        or getattr(slot, "_slack_linked", False)
        or getattr(slot, "_slack_channel", "")
        or getattr(slot, "channel_origin", False)
        or getattr(slot, "_channel_runtime_origin", False)
    )


def _channel_turn(slot: object) -> bool:
    """Whether *slot*'s running turn came from, or was narrowed by, a messaging channel."""
    return bool(
        getattr(slot, "_turn_channel_origin", False)
        or getattr(slot, "_turn_channel_narrowed", False)
    )


def owner_allows(state: DashboardState, session_key: str) -> bool:
    """Whether *session_key*'s approve-for-me may stay on. Memory reads only."""
    if not approve_for_me_permitted():
        return False
    sessions = state.sessions
    fold = sessions._fold_key if sessions is not None else (lambda key: key)
    target = fold(session_key)
    keys = approve_for_me_keys(state)
    if session_key not in keys and target not in keys:
        return False
    if card_send.card_turn_running(session_key) or card_send.card_turn_running(target):
        return False
    yolo = state.is_yolo_active()
    matched = False
    for slot in list(state._slots.values()):
        if fold(effective_session_key(slot)) != target:
            continue
        matched = True
        if channel_linked(slot) or _channel_turn(slot):
            return False
        if slot._trust or slot._trust_reads or slot._trust_scope:
            return False
        if yolo and state.yolo_reaches(slot):
            return False
    return matched


def install(state: DashboardState) -> None:
    """Answer KAS's owner check from *state* for this gateway's life."""
    kas_approve_for_me.register_owner_check(functools.partial(owner_allows, state))
