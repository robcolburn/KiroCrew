"""App tools in a Bot's own chat: the servers an app offers, on the Bots its owner ticked.

A Bot's chat runs on the shared ``kirocrew-mate-conductor``, which mounts only the
platform servers (``mate_worker.conductor_mcp_servers``). This module is the one
exception, and a superseding entry in ``docs/decisions`` must cover it (it narrows
the conductor rules there). It adds nothing unless ALL of these hold:

* the feature preview ``bot_chat_app_tools`` is on (always off on LTS);
* the app is installed and enabled;
* the app OFFERS the server in ``contributes.botChatServers`` (each ``{agent,
  server}`` names a server one of the app's own agents declares);
* the owner approved the app's ``tools`` Bot scope (``permissions.bots``, a staged
  grant: ``apps.bot_grants.app_bot_scopes``);
* the owner ticked THIS Bot for the app (``apps.bot_grants.app_granted_bots``).

The offered server joins this Bot's chat spec per session
(:func:`conductor_session_spec`), the way a Bot's worker gets its own spec per
session (``mate_worker.worker_session_spec``); the shared conductor file is never
written. Its entry carries ``KIROCREW_SESSION_LABEL = dashboard:<the chat's slot>``,
so the app's server knows which Bot is calling. Approvals stay the Bot's own:
nothing here grants a tool call.

A chat mounts its servers when its agent process starts, and that start is recorded,
so a change reaches a live chat through :func:`after_app_change`, which compares the
chat with its record: a Bot that loses a server starts a fresh conversation, so the
old tool names leave its context too; one whose servers were added or changed reloads
(same conversation).
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
from collections.abc import Callable, Iterable
from typing import Any

logger = logging.getLogger(__name__)

#: ``dashboard.feature_previews.<this>``.
PREVIEW = "bot_chat_app_tools"
#: Characters that make a ``disabledTools`` pattern a glob, which Claude deny rules
#: cannot express (``claude_mcp_tool_name`` sanitises them, producing a wrong name).
_GLOB_CHARS: frozenset[str] = frozenset("*?{[")


def preview_on(cfg: Any = None) -> bool:
    """Whether the preview is on. Off on any read failure, and always off on LTS."""
    from kiro_crew.edition_locks import feature_previews

    try:
        if cfg is None:
            from kiro_crew.config.loader import KiroCrewConfig

            cfg = KiroCrewConfig.load()
        previews = getattr(getattr(cfg, "dashboard", None), "feature_previews", None)
    except Exception:  # noqa: BLE001 - an unread config is the preview off
        return False
    previews = feature_previews(previews)
    return isinstance(previews, dict) and previews.get(PREVIEW) is True


def _agent_stem(path: str) -> str:
    return path.rsplit("/", 1)[-1].removesuffix(".json")


def _offers(app: str) -> list[tuple[str, str]]:
    """``[(agent, server)]`` *app* offers to Bot chats, its own agents only. Blocking.

    *agent* is the name registration files the agent under: the ``name`` its spec
    declares, its file stem when it declares none (``bridges_agents._register_agents``).
    An offer names the agent by its file stem.
    """
    from kiro_crew.apps.bridges import _registration_source
    from kiro_crew.apps.manager import _owner_json

    manifest, root = _registration_source(app)
    if manifest is None:
        return []
    names: dict[str, str] = {}
    for rel in map(str, manifest.agents):
        stem = _agent_stem(rel)
        data = _owner_json(root / rel)
        name = data.get("name", stem) if data else stem
        names[stem] = name if isinstance(name, str) and name else stem
    return [
        (names[item["agent"]], item["server"])
        for item in manifest.contributes.botChatServers
        if item["agent"] in names
    ]


def _app_reaches(app: str, slug: str) -> bool:
    """Whether *app* holds the approved ``tools`` scope AND the owner ticked Bot *slug*,
    AND execution trust for *app* is not denied (re-checked at offer time so a trust
    withdrawal that stops short of deregistration cannot re-mount servers on cold start).
    """
    from kiro_crew.apps.bot_grants import BOT_SCOPE_TOOLS, app_bot_scopes, app_granted_bots
    from kiro_crew.apps.execution import app_execution_denied

    # ``app_bot_scopes`` is empty for an app that is not installed and enabled.
    if not (BOT_SCOPE_TOOLS in app_bot_scopes(app) and slug in app_granted_bots(app)):
        return False
    # Execution-admission gate: covers the trust-withdrawn-but-still-enabled case.
    return app_execution_denied(app, action="bot_chat_server_offer") is None


def _app_names() -> list[str]:
    from kiro_crew.apps.manager import list_apps

    return [str(a.get("name") or "") for a in list_apps() if isinstance(a, dict)]


def _rendered_entry(app: str, agent: str, server: str) -> dict[str, Any] | None:
    """The entry a Bot chat mounts for *server*, from the app agent's RENDERED spec.

    ``None`` when the server is switched off whole, in that spec or on the MCP page,
    under its OWN name: the mount renames it ``<app>:<server>``, which no switch-off
    names. Rebuilt from launch keys alone (``template_mcp_additions.ENTRY_KEYS``), so
    no trust key such as ``autoApprove`` reaches the Bot's chat, then given the tools
    switched off for that server, in the spec or on the page, as ``disabledTools``.
    """
    from kiro_crew.agent_sdk.agent_specs import (
        global_mcp_servers,
        switched_off_tools,
        unusable_disabled_tools,
    )
    from kiro_crew.apps.bridges import _kiro_agents_dir, _namespace, _safe_link_name
    from kiro_crew.mate_worker import globally_disabled_refs
    from kiro_crew.mcp_cleanup import mcp_entry_is_muted, mcp_server_muted_in_any_store
    from kiro_crew.mcp_utils import mcp_server_alias
    from kiro_crew.template_mcp_additions import ENTRY_KEYS

    path = _kiro_agents_dir() / f"{_safe_link_name(_namespace(app, agent))}.json"
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    servers = spec.get("mcpServers") if isinstance(spec, dict) else None
    entry = servers.get(server) if isinstance(servers, dict) else None
    if not isinstance(entry, dict) or mcp_server_muted_in_any_store(server, entry):
        return None
    canonical = mcp_server_alias(server)
    if any(
        mcp_server_alias(str(name)) == canonical and mcp_entry_is_muted(row)
        for name, row in global_mcp_servers().items()
    ):
        return None
    if unusable_disabled_tools({"mcpServers": {server: entry}}):
        # A malformed restriction would be dropped by the rebuild below and the
        # server mount whole: refuse it, as KAS refuses such a spec.
        return None
    out = {key: copy.deepcopy(entry[key]) for key in ENTRY_KEYS if key in entry}
    # By the source name, canonically (the page row and the toggle's stub use the
    # slash-free alias): the spec's and Kiro-global switch-offs, then the MCP page's,
    # whichever Crew store it saved them to.
    off = {tool for name, tool in switched_off_tools(spec) if mcp_server_alias(name) == canonical}
    for ref in globally_disabled_refs({server, canonical}):
        name, _, tool = ref[1:].partition("/")
        if tool and mcp_server_alias(name) == canonical:
            off.add(tool)
    if off:
        if any(_GLOB_CHARS & set(tool) for tool in off):
            # A glob-pattern restriction cannot be translated to a Claude deny rule
            # (``claude_mcp_tool_name`` replaces glob chars with ``_``, producing a
            # rule for a nonexistent tool). Withhold the offer instead, as the worker
            # path already refuses ``uncarried_tool_limits_of`` for the same reason.
            return None
        out["disabledTools"] = sorted(off)
    return out


def bot_servers(slug: str, cfg: Any = None) -> dict[str, dict[str, Any]]:
    """``{alias: entry}`` Bot *slug*'s chat mounts now. Empty with the preview off. Blocking."""
    from kiro_crew.mcp_utils import mcp_server_alias

    if not slug or not preview_on(cfg):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for app in _app_names():
        try:
            if not app or not _app_reaches(app, slug):
                continue
            for agent, server in _offers(app):
                entry = _rendered_entry(app, agent, server)
                if entry is not None:
                    # The server part is made slash-free first: aliasing the whole
                    # key would drop the ``<app>:`` namespace for ``vendor/inbox``.
                    out[f"{app}:{mcp_server_alias(server)}"] = entry
        except Exception:  # noqa: BLE001 - one bad app must not hide the rest
            logger.warning("bot chat tools: app %s unreadable", app, exc_info=True)
    return out


#: ``{Bot slug: {alias: entry fingerprint}}``: what each Bot chat's agent process was
#: last started with, written only by :func:`record_mounted` from the list the
#: harness was really handed. A change is judged against this record,
#: never against a reading taken under the current preview flag or grants, so a
#: revocation after the preview went off still lands. In memory: a gateway restart
#: starts every chat on a freshly built spec.
_MOUNTED: dict[str, dict[str, str]] = {}
#: ``{Bot slug: session_key}`` the session key recorded at mount time — written by
#: :func:`record_mounted` alongside :data:`_MOUNTED`.  Used by
#: :func:`stop_app_bot_chat_servers` so teardown does not rely on a live DM-binding
#: read (which may be unreadable during revocation).
_MOUNTED_SESSION_KEYS: dict[str, str] = {}
#: ``{app_name: int}`` revocation generation counter.  Incremented by
#: :func:`revoke_app_generation` on every trust-withdrawal, disable, and uninstall.
#: A cold-starting Bot projection stamps each app-server entry with the generation
#: at build time (:func:`conductor_session_spec`); the three :func:`record_mounted`
#: call-sites verify it before handing the entry to the session, so a stale
#: projection that raced a revocation is stripped before it can mount.
_APP_REVOKE_GEN: dict[str, int] = {}
#: ``{Bot slug: fingerprints}`` a reconcile has queued (a reload or a fresh start)
#: but no agent process has started with yet. Kept apart from :data:`_MOUNTED` so an
#: addition undone before it applied is never judged a loss of what the chat runs.
#: Cleared when the chat's next process gets its tools (:func:`record_mounted`).
#: shortcut: a removal undone before its fresh start applied keeps the queued
#: discard; cancelling it would need the slot's reset hook, upgrade if it bites.
_PENDING: dict[str, dict[str, str]] = {}
#: ``{Bot slug: {alias: fingerprint}}`` offered to the chat's last process but not
#: reaching it: a platform server of that name won, or the harness withheld it (a
#: codex per-tool limit, a claude array held back whole). A reconcile never counts
#: one as lost, and reloads when its entry changes, since the change may make it
#: mountable.
_UNMOUNTED: dict[str, dict[str, str]] = {}
#: ``{Bot slug: (offers, shadowed offers)}``, each ``{alias: fingerprint}``: every
#: offer the builder last made, split by whether a platform server of that name won;
#: :func:`record_mounted` splits the first by what the harness was handed.
_OFFERED: dict[str, tuple[dict[str, str], dict[str, str]]] = {}
#: Bumped by every :func:`after_app_change`, the one door each grant, app, trust and
#: preview change goes through.
_GENERATION = 0
#: ``{Bot slug: generation}`` when the oldest offer :func:`record_mounted` has not
#: settled yet was built: a projection that straddles a change is reconciled after it.
_OFFERED_AT: dict[str, int] = {}
#: ``(state, loop)`` of the last :func:`after_app_change`, to re-run it from a record
#: that straddled it. Unset until a change has run, when no record can straddle one.
_RECONCILER: tuple[Any, asyncio.AbstractEventLoop] | None = None


def record_mounted(
    session_key: str, names: Iterable[str], spelled: Callable[[str], str] = str
) -> None:
    """Settle *session_key*'s Bot chat record from the server *names* its harness was
    really handed, once the harness's projection is final. Blocking. Never raises.

    Every harness calls it at the same point, after its own withholding: the KAS
    projection, the array a mirror built (claude, codex), the mirrorless member path.
    Nothing else writes the record: a projection that only reads (a settings
    re-seed, a deny-rule pass) leaves the running chat's record as it is.

    *names* are as the harness registers them, and *spelled* is how that harness
    spells a name it is handed, so each offer is matched under it: the codex callers
    pass ``codex_name`` (codex folds whitespace); KAS and the claude array keep the
    alias as is.
    """
    from kiro_crew.members import member_identity_for_session

    try:
        ident = member_identity_for_session(session_key)
        if not ident:
            return
        slug = ident["slug"]
        record = _OFFERED.get(slug)
        if record is None:
            return
        # A shadowed offer shares its name with the platform server that won, so the
        # handed list cannot tell them apart: it stays unmounted whatever is handed.
        offered, shadow = record
        handed = {str(n) for n in names}
        # shortcut: two offers that fold to one codex name both count as mounted though
        # codex keeps only the first; the error is toward a fresh start on untick, never
        # toward a revoked server left running.
        _MOUNTED[slug] = {a: f for a, f in offered.items() if spelled(a) in handed}
        _MOUNTED_SESSION_KEYS[slug] = session_key
        _UNMOUNTED[slug] = {
            **shadow,
            **{a: f for a, f in offered.items() if spelled(a) not in handed},
        }
        _PENDING.pop(slug, None)
        if _OFFERED_AT.pop(slug, _GENERATION) != _GENERATION:
            # A change ran while this projection was building, before this record
            # existed for it to compare: compare now, against the latest grants.
            _reconcile_again()
    except Exception:  # noqa: BLE001 - the provisional record stands
        logger.warning("bot chat tools: mounted record for %s failed", session_key, exc_info=True)


def _reconcile_again() -> None:
    """Re-run :func:`after_app_change` on its loop, from any thread."""
    if _RECONCILER is None:
        return
    state, loop = _RECONCILER

    def _start() -> None:
        task = loop.create_task(after_app_change(state))
        tasks = getattr(state, "_crewmate_reload_tasks", None)
        if not isinstance(tasks, set):
            tasks = set()
            try:
                state._crewmate_reload_tasks = tasks
            except AttributeError:  # a state that holds no task set: the loop keeps it
                pass
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    try:
        loop.call_soon_threadsafe(_start)
    except RuntimeError:  # the loop closed: a restart re-reads every grant
        pass


def mounted_names(servers: Any) -> list[str]:
    """The ``name`` of each element of an ACP ``mcpServers`` array, or the keys of an
    ``mcpServers`` map: the shape :func:`record_mounted` takes from any harness."""
    if isinstance(servers, dict):
        return [str(k) for k in servers]
    if isinstance(servers, (list, tuple)):
        return [str(e.get("name")) for e in servers if isinstance(e, dict) and e.get("name")]
    return []


def _fingerprints(servers: dict[str, dict[str, Any]]) -> dict[str, str]:
    return {alias: json.dumps(e, sort_keys=True, default=str) for alias, e in servers.items()}


#: ``{session_key: {alias: gen}}`` the per-app revocation generation captured
#: by :func:`conductor_session_spec` BEFORE reading the grant table.  A revocation
#: that races the grant read cannot advance past the recorded generation.  Entries are
#: removed by :func:`check_and_filter_projection` after the delivery gate runs.
_PROJECTION_GENS: dict[str, dict[str, int]] = {}


def revoke_app_generation(app_name: str) -> None:
    """Bump the revocation generation for *app_name*.

    Call this BEFORE :func:`stop_app_bot_chat_servers` on every security path that
    removes the right for *app_name* to run in Bot chats (trust withdrawal, disable,
    uninstall).  Any cold-starting projection that captured the old generation will
    be fenced at the three delivery call-sites.
    """
    _APP_REVOKE_GEN[app_name] = _APP_REVOKE_GEN.get(app_name, 0) + 1


def check_and_filter_projection(
    session_key: str, servers: dict[str, dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Remove app-server entries whose revocation generation has advanced or whose
    admission is invalid, and clear the sidecar-table entry for *session_key*.

    Called at the three delivery points (AcpRuntime mirror, AcpClient array, KAS
    projection) before the final array is handed to the session.

    For each ``<app>:<server>`` alias:
    * If the generation recorded in :data:`_PROJECTION_GENS` for this session differs
      from the current :data:`_APP_REVOKE_GEN` value, the entry is stripped (revocation
      raced the projection).
    * If :func:`_app_reaches` says the app lacks execution admission (trust withdrawn
      but still enabled), the entry is stripped.
      still enabled), the entry is stripped.

    Entries that were not part of the projection (no sidecar entry) are left as-is so
    platform servers are never accidentally dropped.
    """
    snapshot = _PROJECTION_GENS.pop(session_key, {})
    out: dict[str, dict[str, Any]] = {}
    for alias, entry in servers.items():
        if ":" not in alias:
            out[alias] = entry
            continue
        app_name = alias.split(":")[0]
        recorded_gen = snapshot.get(alias)
        if recorded_gen is not None:
            current_gen = _APP_REVOKE_GEN.get(app_name, 0)
            if recorded_gen != current_gen:
                continue  # revocation raced the projection
        # Re-check execution admission (trust withdrawn but app still enabled).
        # _app_reaches reads slug from _OFFERED; if the alias is not in the projection
        # snapshot, it was not a Bot-app server and we skip the admission check.
        if recorded_gen is not None:
            # Find the slug from _OFFERED to re-run _app_reaches.
            slug = next(
                (s for s, (offered, _) in _OFFERED.items() if alias in offered),
                None,
            )
            if slug is not None and not _app_reaches(app_name, slug):
                continue  # execution admission denied
        out[alias] = entry
    return out


def _slot_of(session_key: str) -> str:
    for prefix in ("dashboard_", "dashboard:"):
        if session_key.startswith(prefix):
            return session_key[len(prefix) :]
    return session_key


def conductor_session_spec(spec: dict[str, Any], session_key: str) -> dict[str, Any]:
    """*spec* (the shared conductor's) plus the app servers this Bot's chat mounts.

    Never raises and never narrows: anything unreadable answers *spec* unchanged. A
    platform server of the same name wins. The session-label marker is replaced by
    the label itself, so every harness hands the server the same caller. Blocking.
    """
    from kiro_crew.agent_sdk.agent_specs import stamp_session_label
    from kiro_crew.members import member_identity_for_session

    try:
        # Snapshot the per-app revocation generations BEFORE reading grants, so a
        # revocation that races the grant-read cannot advance past this snapshot.
        # check_and_filter_projection uses it at the three delivery call-sites.
        gen_snapshot = {app: gen for app, gen in _APP_REVOKE_GEN.items()}
        generation = _GENERATION
        ident = member_identity_for_session(session_key)
        servers = bot_servers(ident["slug"]) if ident else {}
    except Exception:  # noqa: BLE001 - see the docstring
        logger.warning("bot chat tools for %s unreadable", session_key, exc_info=True)
        return spec
    out = dict(spec)
    mounted = dict(out.get("mcpServers") or {})
    shadowed = {alias for alias in servers if alias in mounted}
    if ident:
        # Staged only. The record of what the chat runs is written by record_mounted,
        # once a harness hands the session its final tool surface; a projection that
        # only reads (a settings re-seed, a deny-rule pass) must not change it.
        offered = _fingerprints(servers)
        shadow = {a: f for a, f in offered.items() if a in shadowed}
        _OFFERED[ident["slug"]] = ({a: f for a, f in offered.items() if a not in shadowed}, shadow)
        _OFFERED_AT.setdefault(ident["slug"], generation)
    if not servers:
        return spec
    tools = list(out.get("tools") or [])
    label = f"dashboard:{_slot_of(session_key)}"
    # Store the sidecar: {alias: gen-at-snapshot-time} for every app-server entry
    # offered to this session, keyed on session_key so the delivery points can find it.
    proj_gens: dict[str, int] = {}
    for alias, entry in servers.items():
        if alias in shadowed:
            continue
        app_name = alias.split(":")[0] if ":" in alias else None
        if app_name:
            proj_gens[alias] = gen_snapshot.get(app_name, 0)
        mounted[alias] = stamp_session_label(entry, label)
        if "*" not in tools and f"@{alias}" not in tools:
            tools.append(f"@{alias}")
    if proj_gens:
        _PROJECTION_GENS[session_key] = proj_gens
    out["mcpServers"] = mounted
    out["tools"] = tools
    return out


def _live_slot(state: Any, slug: str) -> Any:
    from kiro_crew.members import read_dm_binding

    binding = read_dm_binding(slug)
    return state._slots.get(binding["slot_key"]) if binding else None


#: :func:`reload_bot_chats` outcome for a chat whose queued fresh start covers it.
PENDING_FRESH = "pending_fresh"

_RELOAD_NOTICE = (
    "Session reloaded so this bot's chat picks up the app tools its owner turned on. "
    "The conversation is kept."
)

_FRESH_NOTICE = (
    "App tools were taken off this bot's chat, so its next turn starts a fresh "
    "conversation without them. The messages above stay here."
)

#: ``{chat slot key: notices}`` owed to a Bot's next prompt (:func:`take_owner_notes`).
_OWNER_NOTES: dict[str, list[str]] = {}


def _tell_bot(slot: Any, notice: str) -> None:
    """Owe *notice* to the Bot's next prompt, once per slot until it is written there.

    A Bot's chat draws no runtime notice row (the recorded decision "the crewmate
    chat draws messages only"): the row appended beside this shows on the Sessions
    page, and the Bot tells its owner.
    """
    owed = _OWNER_NOTES.setdefault(str(getattr(slot, "key", "")), [])
    if notice not in owed:
        owed.append(notice)


def take_owner_notes(slot: Any) -> str:
    """The framed notices owed to *slot*'s Bot, cleared as they are returned: the turn
    that writes them into its prompt is the one that delivers them. ``""`` when none."""
    owed = _OWNER_NOTES.pop(str(getattr(slot, "key", "")), [])
    if not owed:
        return ""
    lines = "\n".join(f"- {n}" for n in owed)
    return (
        "[One-time note from Crew for your owner -- not from them]\n"
        "Tell your owner this once, in your own words, in this reply:\n"
        f"{lines}\n[End of note]\n\n"
    )


async def reload_bot_chats(state: Any, slugs: Iterable[str]) -> dict[str, str]:
    """Reload each Bot's live chat onto its spec now (idle) or at its turn end (busy).

    So a chat picks up an app server on its next turn. Never raises.
    """
    from kiro_crew.dashboard.crewmate_worker_reload import GONE, reload_if_idle

    out: dict[str, str] = {}
    for slug in slugs:
        try:
            slot = await asyncio.to_thread(_live_slot, state, slug)
            if slot is None:
                # DM-binding read failed (e.g. a Windows sharing violation): clear the
                # pending entry so the next reconciliation retries instead of skipping.
                _PENDING.pop(slug, None)
                continue
            if getattr(slot, "_pending_discard_conversation_key", None) is not None:
                # A fresh start is already queued (an app disabled then enabled): its
                # spawn reads the new spec, and a reload beside it would start a second
                # agent process on the same chat at once.
                out[slug] = PENDING_FRESH
                continue
            out[slug] = await reload_if_idle(state, slot, notice=_RELOAD_NOTICE)
            if out[slug] != GONE:
                _tell_bot(slot, _RELOAD_NOTICE)
        except Exception:  # noqa: BLE001 - a missed reload leaves the next spawn to read it
            _PENDING.pop(slug, None)  # allow the next reconciliation to retry
            logger.warning("bot chat reload for %s failed", slug, exc_info=True)
    return out


async def fresh_bot_chats(state: Any, slugs: Iterable[str]) -> list[str]:
    """Queue a fresh conversation on each Bot's live chat; returns the Bots queued.

    For a server taken AWAY. A reload resumes the same conversation (``session/load``),
    and that history still names the removed tools, so the model keeps offering them.
    This queues the discard the ``reset_conversation`` directive queues
    (``slot._pending_discard_conversation_key``): it lands at the next idle turn
    boundary with ``replay=False``, and the next turn spawns on the narrowed spec with
    no memory of the old tools. The transcript stays in the tab. Never raises.
    """
    from kiro_crew.dashboard.chat_runner import _arm_pending_reset_retry
    from kiro_crew.dashboard.chat_utils import effective_session_key

    queued: list[str] = []
    for slug in slugs:
        try:
            slot = await asyncio.to_thread(_live_slot, state, slug)
            # shortcut: a chat with no live slot keeps its resume pointer; every opened
            # Bot chat has a slot while the gateway runs, so only a restart lands here.
            if slot is None:
                # DM-binding read failed: clear the pending entry so the next
                # reconciliation retries the revocation instead of skipping it.
                _PENDING.pop(slug, None)
                continue
            slot._pending_discard_conversation_key = effective_session_key(slot)
            slot._pending_discard_from_wake = False
            slot.append("system", _FRESH_NOTICE, "msg msg-info")
            _tell_bot(slot, _FRESH_NOTICE)
            _arm_pending_reset_retry(state, slot)
            queued.append(slug)
        except Exception:  # noqa: BLE001 - a missed discard leaves the tools uncallable
            _PENDING.pop(slug, None)  # allow the next reconciliation to retry
            logger.warning("bot chat fresh start for %s failed", slug, exc_info=True)
    return queued


_HARNESS_NOTICE = (
    "This bot's engine can't use app tools, so they're off in this chat. Switch the "
    "bot to Kiro Agent, Claude Code or Codex to use them."
)
#: Bot slugs told :data:`_HARNESS_NOTICE` in this process, so each cold start does
#: not repeat it; forgotten once the Bot starts on a harness that carries them.
_HARNESS_NOTED: set[str] = set()
#: Bot slugs whose chat just started without its app tools and is owed the notice.
_HARNESS_OWED: set[str] = set()


async def note_harness_without_app_tools(session_key: str, carried: bool) -> None:
    """At a Bot chat's cold start: on a harness that cannot carry its per-session spec,
    mark the chat owed a notice when the Bot has app tools turned on. Never raises.

    *carried* is the provider's ``mate_worker_kit_supported``: the same opt-in set
    (``ACP_BACKENDS_MATE_WORKER_KIT``) a crewmate's worker is refused on. A Bot chat on
    such a harness (Kiro CLI, which reads ``--agent`` off disk) never calls
    :func:`conductor_session_spec`, so nothing mounts. The allocation door has no
    slot in hand, so the dashboard turn that claimed the session posts it
    (:func:`deliver_harness_notice`).
    """
    from kiro_crew.members import member_identity_for_session

    try:
        ident = await asyncio.to_thread(member_identity_for_session, session_key)
        if not ident:
            return
        slug = ident["slug"]
        if carried:
            _HARNESS_NOTED.discard(slug)
            _HARNESS_OWED.discard(slug)
            return
        if slug in _HARNESS_NOTED or not await asyncio.to_thread(bot_servers, slug):
            return
        _HARNESS_OWED.add(slug)
    except Exception:  # noqa: BLE001 - the chat still starts, only the notice is lost
        logger.warning("bot chat harness notice for %s failed", session_key, exc_info=True)


async def deliver_harness_notice(slot: Any, session_key: str) -> None:
    """Post the notice :func:`note_harness_without_app_tools` left owed on this Bot chat's
    *slot*, once per process. Never raises."""
    if not _HARNESS_OWED:
        return
    from kiro_crew.members import member_identity_for_session

    try:
        ident = await asyncio.to_thread(member_identity_for_session, session_key)
        slug = ident["slug"] if ident else ""
        if slug not in _HARNESS_OWED:
            return
        slot.append("system", _HARNESS_NOTICE, "msg msg-info")
        _tell_bot(slot, _HARNESS_NOTICE)
        _HARNESS_OWED.discard(slug)
        _HARNESS_NOTED.add(slug)
    except Exception:  # noqa: BLE001 - only the notice is lost
        logger.warning("bot chat harness notice for %s failed", session_key, exc_info=True)


async def after_app_change(state: Any) -> None:
    """After a change that can move a Bot chat's app servers, bring each live chat in line.

    Each Bot chat is compared with what its agent process was started with
    (``_MOUNTED``): one that LOST a server starts a fresh conversation, one whose
    servers were added or whose entries changed (an app update) reloads. Called after
    an app is enabled, disabled, updated or uninstalled, a Bot is ticked or unticked,
    and the preview is switched. Never raises.
    """
    global _GENERATION, _RECONCILER
    if state is None:
        return
    _GENERATION += 1
    _RECONCILER = (state, asyncio.get_running_loop())
    lost: list[str] = []
    changed: list[str] = []
    for slug, was in list(_MOUNTED.items()):
        try:
            now = _fingerprints(await asyncio.to_thread(bot_servers, slug))
        except Exception:  # noqa: BLE001 - the change has committed
            logger.warning("bot chat tools for %s unreadable", slug, exc_info=True)
            continue
        # An offer the last process did not get (withheld or shadowed) counts only
        # once its entry changes, since that change may make it mountable now.
        withheld = _UNMOUNTED.get(slug, {})
        now = {a: f for a, f in now.items() if withheld.get(a) != f}
        if now == was:
            # Back to what the chat runs (an addition undone before it applied): no
            # fresh start, and an owed reload only respawns the same servers.
            _PENDING.pop(slug, None)
            continue
        if _PENDING.get(slug) == now:
            continue  # already queued for exactly this
        _PENDING[slug] = now
        (lost if was.keys() - now.keys() else changed).append(slug)
    if lost:
        await fresh_bot_chats(state, lost)
    if changed:
        schedule_reload(state, changed)


async def on_preview_change(state: Any, change: Any) -> None:
    """Config applier: a flip of this preview reconciles every Bot chat."""
    if change.touched(f"dashboard.feature_previews.{PREVIEW}"):
        await after_app_change(state)


def schedule_reload(state: Any, slugs: list[str]) -> "asyncio.Task | None":
    """:func:`reload_bot_chats` as a task, kept alive on *state*."""
    if state is None or not slugs:
        return None
    try:
        task = asyncio.get_running_loop().create_task(reload_bot_chats(state, slugs))
    except RuntimeError:
        return None
    tasks = getattr(state, "_crewmate_reload_tasks", None)
    if not isinstance(tasks, set):
        tasks = set()
        state._crewmate_reload_tasks = tasks
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return task


async def stop_app_bot_chat_servers(state: Any, app_name: str) -> tuple[list[str], list[str]]:
    """Immediately stop every Bot chat that mounts *app_name*'s servers.

    For security-critical paths (trust withdrawal, disable, uninstall) that must
    not leave app code running in Bot chats after the grant is gone.

    Unlike :func:`after_app_change`, which queues a deferred fresh-start that only
    takes effect at the next idle boundary, this function calls
    ``discard_conversation`` directly on each affected Bot chat without
    ``skip_if_busy``, so the session's provider (KAS or ACP) is told to shut down
    regardless of whether a turn is in progress.

    Session identity is resolved from :data:`_MOUNTED_SESSION_KEYS`, which is written
    at mount time, so teardown does not rely on a live DM-binding read.  If no
    session key was recorded the slug is treated as a failure (the process may still
    be running and cannot be positively confirmed stopped), unless the slot is also
    absent from the session manager (confirmed down).

    Returns ``(stopped, failed)``: the Bot slugs whose sessions were discarded, and
    those whose discard call raised. Never raises; failures are returned so callers
    can decide whether to 409.
    """
    prefix = f"{app_name}:"
    # Find every Bot slug that is currently running with one of this app's servers.
    affected = [
        slug
        for slug, mounted in _MOUNTED.items()
        if any(alias.startswith(prefix) for alias in mounted)
    ]
    if not affected:
        return [], []

    stopped: list[str] = []
    failed: list[str] = []
    sessions = getattr(state, "sessions", None)
    for slug in affected:
        try:
            session_key = _MOUNTED_SESSION_KEYS.get(slug)
            if not session_key:
                # No session key recorded at mount time: identity is unresolvable.
                # Cannot confirm the process is stopped, so this is a failure.
                # (A missing DM binding and a not-yet-started slot are
                # indistinguishable here; fail closed.)
                failed.append(slug)
                continue
            if sessions is None:
                failed.append(slug)
                continue
            # ``skip_if_busy`` omitted (defaults to False): stop NOW, not at the
            # next idle boundary.  The app's code must not keep running.
            await sessions.discard_conversation(session_key, replay=False)
            stopped.append(slug)
        except Exception:  # noqa: BLE001
            logger.warning(
                "bot chat app tools: could not stop Bot chat for %s (app %s)",
                slug,
                app_name,
                exc_info=True,
            )
            failed.append(slug)
    return stopped, failed
