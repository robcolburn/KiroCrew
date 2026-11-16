"""The gate a command or a canvas comment asks right before its route.

Split out of :mod:`.routing` (the file-line cap); :mod:`.routing` keeps both
names as the import path callers use.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from kiro_crew.slack.code_channels.store import Binding

logger = logging.getLogger("kiro_crew.slack.code_channels.routing")

#: Asked right before a bind or a route with the binding it acts on (None: no
#: binding yet): ``""`` admits it,
#: else why not (:func:`.surface.act_refusal`).
Admit = Callable[[Binding | None], Awaitable[str]]


async def admitted(binding: Binding, admit: Admit) -> bool:
    """Whether a route to *binding*'s session may start NOW (fails closed).

    The linked slot's window is loaded first: a sidebar row restored after a
    restart reads its transcript off the loop inside the route, an await that
    would otherwise fall between *admit* and the turn. Then *admit* is asked, so
    the caller routes right after it with no await between.
    """
    try:
        from kiro_crew.dashboard.state import load_window_off_loop
        from kiro_crew.slack.code_channels import routing

        state = routing._dashboard_state()
        get_linked = getattr(state, "get_linked_slot", None)
        slot = get_linked(binding.anchor_ts) if callable(get_linked) else None
        if slot is not None:
            await load_window_off_loop(slot)
        return not await admit(binding)
    except Exception:
        logger.debug("code channel %s: route gate failed", binding.channel_id, exc_info=True)
        return False
