"""KAS "approve for me": the session option, its spawn switch, and the audit row.

With approve-for-me on, KAS decides on its own which tool calls to run. A call it
approves raises no ``session/request_permission``, so Crew's own permission path
(the deny floor, the governance ceiling, the approval mode) never sees it; a call
it is unsure about still arrives as a permission request and takes that path as
any other does. Crew therefore owns three things here:

* **The engine switch.** ``KIRO_TRUST_CLASSIFIER_MODE`` decides whether the
  engine offers the feature at all, and the engine reads it once at start. Every
  child Crew spawns gets ``off`` (:func:`force_off`), whatever the gateway
  inherited. Only a session a person opted in starts with ``enforce``: the
  session's own ``extra_env`` carries it (:func:`session_env`), which also keys
  the session onto a process of its own, and the runtime spawn keeps it only from
  there (:func:`apply_runtime_env`). Every other KAS session runs with the switch
  off, as it would without this module.
* **The session value.** Crew holds the ``approveForMe`` option at ``on`` or
  ``off`` and never leaves it at any other value the engine offers:
  :func:`settle` writes ``off`` unless the session already reads ``on`` and its
  owner allows that (:func:`register_owner_check`; with no owner check every
  session is held ``off``). It runs when a session opens and before each
  turn, so a trust or YOLO grant, or a policy that denies the mode, takes the
  option off before the next prompt is sent. Inside a running turn, the first
  engine-approved call seen after the owner withdrew its leave cancels that turn
  (:func:`audit_classifier_approved`), so the engine approves nothing more under it.
* **The audit row.** A tool call the engine approved carries
  ``_meta.kiro.trustClassifierApproved``; :func:`audit_classifier_approved` writes
  one security-event row for it, since no Crew consumer decided it.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, MutableMapping
from typing import Any

logger = logging.getLogger(__name__)

#: The session config option's id.
APPROVE_FOR_ME_CONFIG_ID = "approveForMe"

#: The engine's switch for the feature, read once when the engine starts.
CLASSIFIER_MODE_ENV = "KIRO_TRUST_CLASSIFIER_MODE"
CLASSIFIER_MODE_ON = "enforce"
CLASSIFIER_MODE_OFF = "off"

#: The ``_meta.kiro`` key on a tool call the engine approved on its own.
CLASSIFIER_APPROVED_META_KEY = "trustClassifierApproved"


#: SEL ``source`` of the row written for an engine-approved call.
SEL_SOURCE = "kas_approve_for_me"

#: Tool-call ids kept per session for the one-row-per-call rule; the oldest half
#: is dropped past this.
_AUDITED_MAX = 4096
#: Longest engine-written tool-call id kept or written to the audit row; a longer
#: one is cut, so the kept set is bounded in bytes as well as in entries.
CALL_ID_MAX_CHARS = 256

_ON = "on"
_OFF = "off"


def _deny_all(_session_key: str) -> bool:
    return False


_owner_check: Callable[[str], bool] = _deny_all


def register_owner_check(check: Callable[[str], bool]) -> None:
    """Install the answer to "may this session's approve-for-me stay on?".

    *check* gets the session key and runs on the event loop, so it must only read
    memory. Until one is installed, and whenever it raises, the answer is no.
    """
    global _owner_check
    _owner_check = check


def reset_owner_check() -> None:
    """Back to holding every session ``off``. For tests."""
    register_owner_check(_deny_all)


def may_stay_on(session_key: str) -> bool:
    """Whether the owner lets *session_key* keep approve-for-me on (fail closed)."""
    try:
        return bool(_owner_check(session_key))
    except Exception:
        logger.warning("approve-for-me owner check raised; holding the session off", exc_info=True)
        return False


def option_value(config_options: object) -> str | None:
    """The session's ``approveForMe`` value; ``None`` when it offers no such option."""
    if not isinstance(config_options, list):
        return None
    for opt in config_options:
        if isinstance(opt, dict) and opt.get("id") == APPROVE_FOR_ME_CONFIG_ID:
            value = opt.get("currentValue")
            return value if isinstance(value, str) else ""
    return None


def settle_target(current: str | None, *, allowed: bool) -> str | None:
    """The value to write for a session that reads *current*, or ``None`` for none.

    ``on`` while *allowed*, else ``off``; nothing to write when it already reads so,
    or when the session offers no option.
    """
    if current is None:
        return None
    target = _ON if allowed else _OFF
    return None if current == target else target


class ApproveForMeNotOff(RuntimeError):
    """The session reads ``on``, may not, and the engine refused to turn it off."""


async def settle(handle: Any) -> None:
    """Hold *handle*'s ``approveForMe`` at ``on`` or ``off``, never another value.

    A no-op for a session that offers no option (every non-KAS backend, or an
    engine started with the feature off). A failed write is logged; when the
    session still reads ``on`` without its owner's leave, :class:`ApproveForMeNotOff`
    is raised so the caller sends no prompt under it.
    """
    # A new turn: a cancel an earlier one made for a withdrawn leave is spent.
    handle._kas_afm_cancel_sent = False
    current = option_value(getattr(handle, "config_options", None))
    target = settle_target(current, allowed=current is not None and may_stay_on(_key_of(handle)))
    if target is None:
        return
    try:
        await handle.set_config_option(APPROVE_FOR_ME_CONFIG_ID, target)
    except Exception as exc:
        logger.warning(
            "could not set approve-for-me to %s: %s: %s", target, type(exc).__name__, exc
        )
        if current == _ON:
            raise ApproveForMeNotOff(
                "approve-for-me is on for this session and could not be turned off"
            ) from exc
        return
    logger.info("approve-for-me set to %s for session %s", target, _key_of(handle) or "?")


def _key_of(handle: Any) -> str:
    key = getattr(handle, "_session_key", "")
    return key if isinstance(key, str) else ""


def force_off(env: MutableMapping[str, str]) -> None:
    """Turn the engine switch off in a child's *env*, overriding an inherited value."""
    env[CLASSIFIER_MODE_ENV] = CLASSIFIER_MODE_OFF


def enable(env: MutableMapping[str, str]) -> None:
    """Turn the engine switch on in *env*."""
    env[CLASSIFIER_MODE_ENV] = CLASSIFIER_MODE_ON


def session_env(session_key: str, extra_env: dict[str, str] | None) -> dict[str, str] | None:
    """*extra_env* for a session about to start: with ``enforce`` only when opted in.

    The value is part of the session's process key, so an opted-in session never
    shares a process with one that is not. Any inherited switch value in
    *extra_env* is dropped first, so only the owner's leave can put it there.
    """
    env = {k: v for k, v in (extra_env or {}).items() if k != CLASSIFIER_MODE_ENV}
    if session_key and may_stay_on(session_key):
        enable(env)
    if env == (extra_env or {}):
        return extra_env
    return env or None


def apply_runtime_env(env: MutableMapping[str, str], backend: str, own_env: object) -> None:
    """Settle the engine switch in a runtime child's *env*, after every other source.

    ``enforce`` only for a backend in ``ACP_BACKENDS_APPROVE_FOR_ME`` whose runtime's
    own ``extra_env`` (*own_env*, set by :func:`session_env`) asks for it; ``off``
    for every other child, whatever the gateway or ``agent.env`` carried.
    """
    from kiro_crew.acp.types import ACP_BACKENDS_APPROVE_FOR_ME

    wants = isinstance(own_env, dict) and own_env.get(CLASSIFIER_MODE_ENV) == CLASSIFIER_MODE_ON
    if wants and backend in ACP_BACKENDS_APPROVE_FOR_ME:
        enable(env)
    else:
        force_off(env)


def classifier_approved(update: object) -> bool:
    """Whether a ``tool_call`` / ``tool_call_update`` says the engine approved it."""
    if not isinstance(update, dict):
        return False
    meta = update.get("_meta")
    kiro = meta.get("kiro") if isinstance(meta, dict) else None
    return isinstance(kiro, dict) and kiro.get(CLASSIFIER_APPROVED_META_KEY) is True


def audit_classifier_approved(handle: Any, update: dict[str, Any]) -> None:
    """Write one SEL row for a tool call the engine approved on its own.

    Once per tool-call id per session: the engine stamps the mark on the call's
    first frame and its updates alike. The write is offloaded and tracked on the
    handle's ``_audit_tasks`` like its other audit rows; a failure is logged and
    never breaks the frame.

    When the owner does not allow approve-for-me on this session any more (a mode pick,
    a grant or a policy deny during the turn), the running turn is cancelled once,
    so the engine approves no further call under a leave that was withdrawn.
    """
    if not classifier_approved(update):
        return
    raw_id = update.get("toolCallId")
    if not isinstance(raw_id, str) or not raw_id:
        return
    call_id = raw_id[:CALL_ID_MAX_CHARS]
    seen: dict[str, None] | None = getattr(handle, "_kas_classifier_audited", None)
    if seen is None:
        seen = {}
        handle._kas_classifier_audited = seen
    if call_id in seen:
        return
    seen[call_id] = None
    if len(seen) > _AUDITED_MAX:
        for old in list(seen)[: _AUDITED_MAX // 2]:
            del seen[old]
    from kiro_crew.acp._dispatch import redact_text

    title = update.get("title")
    tool_name = (
        redact_text(str(title)[:4096])[:120] if isinstance(title, str) and title else "unknown"
    )
    kind = update.get("kind")
    tool_kind = kind if isinstance(kind, str) else ""
    session_key = _key_of(handle) or f"acp:{getattr(handle, '_session_id', '')}"
    agent = getattr(handle, "active_agent", "") or "kirocrew"

    def _audit() -> None:
        try:
            from kiro_crew.sel import sel

            sel().log_tool_invocation(
                session_key=session_key,
                agent=agent,
                source=SEL_SOURCE,
                tool_name=tool_name,
                tool_kind=tool_kind,
                outcome="auto_approved",
                request_id=call_id,
                metadata={
                    "reason": "approve_for_me",
                    "decided_by": "kas",
                    "crew_gate": "skipped",
                },
            )
        except Exception:
            logger.warning("SEL audit of a KAS-approved tool call failed", exc_info=True)

    tasks = getattr(handle, "_audit_tasks", None)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running loop (a synchronous caller): write in place.
        _audit()
        return
    task = loop.create_task(asyncio.to_thread(_audit))
    if isinstance(tasks, set):
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    if not may_stay_on(_key_of(handle)) and not getattr(handle, "_kas_afm_cancel_sent", False):
        handle._kas_afm_cancel_sent = True
        logger.warning(
            "approve-for-me leave withdrawn mid-turn for session %s; cancelling the turn",
            session_key,
        )
        cancel = loop.create_task(handle.cancel())
        if isinstance(tasks, set):
            tasks.add(cancel)
            cancel.add_done_callback(tasks.discard)
