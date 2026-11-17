"""The ``app-browser-sites`` row of ``hooks.GATE_TIERS``: an app's own agent, its own sites.

An app that declares ``permissions.browserSites`` and whose owner approved them
(``apps/browser_sites.py``) has its OWN agent sessions' ``browser`` calls approved
here instead of on a card per step. Every condition fails toward the card:

* the caller is the app's own dashboard slot: ``facts.app`` is the slot's ``_app``,
  which only a request with an authenticated app scope sets, and the session key is a
  ``dashboard:`` slot key, the kind the op route resolves and confines. A person's
  chat, a cron, another app, and a subagent the app spawned (which carries the app
  but not a slot the route can find) keep their card;
* the call is the ``browser`` tool of the ``kirocrew-core`` server by its VERIFIED
  identity, never by title, so a shell call titled like it gets nothing;
* the app holds approved sites right now (read fresh, so a disable, an uninstall,
  a withdrawn trust grant or a dropped site ends the grant at the next call);
* a call that names a URL (``navigate``, ``tabs`` ``new``) names one of those pages;
  any other URL falls through to the card, and the op route refuses it anyway;
* an operator ``confirm_tools`` pattern naming the call still asks.

The row sits after every deny tier and governance, so ``capabilities.browse``, the
deny rules and the ceiling still judge the call first. The op route is where the
site list is held: it refuses an op whose page is off the list and moves the tab to
``about:blank`` (``dashboard/handlers/browser_ops.py``). This row only spares the
owner a card for a call the route will confine.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kiro_crew.hooks import (
        GateFacts,
        GateTier,
        ToolHookResult,
        _operator_confirms,
        mcp_identity_ref,
    )


def tier_app_browser_sites(facts: GateFacts, tier: GateTier) -> ToolHookResult | None:
    """Approve the app's own ``browser`` call on its approved sites; else let the card ask."""
    del tier
    call = facts.call
    # Only the app's own DASHBOARD slot: the op route confines a session it finds
    # among the dashboard's slots, so a subagent, cron or channel session the app
    # started (``subagent:<id>``, ...) keeps its card instead of an unconfined grant.
    if facts.classifier_only or not facts.app or not facts.session_key.startswith("dashboard:"):
        return None
    # Call time, by module: ``compose`` runs this body on ``kiro_crew.hooks``' globals.
    from kiro_crew.apps import browser_sites  # noqa: PLC0415

    if not (
        call.identity_trusted
        and call.mcp_server == browser_sites.BROWSER_SERVER
        and call.mcp_tool == browser_sites.BROWSER_TOOL
        and facts.canonical_mcp_name
    ):
        return None
    readable, url = browser_sites.browser_call_url(call.raw_params)
    if not readable:
        return None

    ref = mcp_identity_ref(call.mcp_server, call.mcp_tool)
    if _operator_confirms(facts, (f"Running: {ref}", ref)):
        return None
    sites = browser_sites.app_browser_sites(facts.app)
    if not sites:
        return None
    if url is not None and not browser_sites.url_matches(sites, url):
        return None
    # Before the approval leaves the gate: the op route then holds this slot to its
    # sites even if they are revoked before the call reaches it.
    browser_sites.note_granted_session(facts.session_key[len("dashboard:") :])
    return ToolHookResult.auto_approve(identity_grant=True)
