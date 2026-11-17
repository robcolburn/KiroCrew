"""The dashboard's owner-only locks are pinned to the backend's teammate boundary.

The website draws a lock for a Shared Crew teammate on the surfaces that stay the
machine owner's (``website/src/components/OwnerOnlyNotice.tsx``, one ``kind`` per
lock). That list is a frontend copy of a backend fact, so this test ties each kind
to the routes its surface writes and asserts the backend refuses every one of them
to a teammate, by the same rule the gateway enforces:

* a route rule: ``teammate_access.is_owner_only_for_teammates`` (the Terminal, the
  relay's remote route limits, channel connection writes, cron secret grants);
* an admission config key: ``teammate_access.is_admission_config_key``;
* a handler gate that admits only the machine owner: the handler's refusal calls
  ``is_host_owner_dashboard_request`` or the invite routes' ``_owner_refusal``.

It also pins the refusal codes the website renders as the lock
(``OWNER_ONLY_REFUSAL_CODES`` in ``website/src/api/apiError.ts``) to the codes the
backend answers, and fails when a lock kind is used in the website without a pin
here, or a pin names a kind the website does not use.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from kiro_crew.dashboard.kiro_relay import limits
from kiro_crew.shared_crew import teammate_access

ROOT = Path(__file__).resolve().parent.parent
NOTICE = ROOT / "website/src/components/OwnerOnlyNotice.tsx"
API_ERROR = ROOT / "website/src/api/apiError.ts"
WEBSITE_SRC = ROOT / "website/src"

#: Lock kind -> the (method, path) routes its surface writes. Each must be refused
#: to a teammate by ``teammate_access.is_owner_only_for_teammates``.
ROUTE_PINS: dict[str, list[tuple[str, str]]] = {
    "terminal": [("GET", "/api/ws/terminal/abc"), ("POST", "/api/terminal/sessions")],
    "secrets": [("GET", "/api/secrets"), ("POST", "/api/secrets"), ("DELETE", "/api/secrets/NAME")],
    "remote": [("GET", "/api/instances"), ("POST", "/api/instances/abc/connect")],
    "phone": [("POST", "/api/tailnet/mobile/qr"), ("POST", "/api/auth/mobile-link")],
    "sign_in_link": [("POST", "/api/auth/mobile-link")],
    "webhooks": [("POST", "/api/webhooks/tokens"), ("DELETE", "/api/webhooks/tokens/abc")],
    "channels": [
        ("POST", "/api/slack/config"),
        ("POST", "/api/telegram/config"),
        ("POST", "/api/channels"),
        ("DELETE", "/api/channels/abc"),
        ("POST", "/api/channels/whatsapp/link"),
        ("POST", "/api/messaging/teams"),
    ],
    "cron_secrets": [("PUT", "/api/crons/abc/secrets")],
}

#: Lock kind -> config keys its surface writes through ``PATCH /api/config/kirocrew``.
ADMISSION_PINS: dict[str, list[str]] = {
    "admission": [
        "dashboard.tailscale.enabled",
        "dashboard.shared_crew.admission_enabled",
        "dashboard.shared_crew.tailnet_direct",
        "dashboard.shared_crew.ssm",
        "dashboard.shared_crew.principal_concurrency",
    ],
}


def _handler_gates() -> dict[str, list[tuple[object, str]]]:
    """Lock kind -> (handler, the owner predicate its refusal calls)."""
    from kiro_crew.dashboard.handlers import credential_redaction, redacted_reveal, tailnet_mobile
    from kiro_crew.shared_crew import routes_invites, routes_preview

    return {
        "invites": [
            (routes_invites.api_create, "_owner_refusal"),
            (routes_invites.api_revoke, "_owner_refusal"),
            (routes_invites._owner_refusal_decision, "PROVIDER_TAILSCALE"),
        ],
        "preview": [(routes_preview._refusal, "_owner_refusal")],
        "redaction": [(credential_redaction._deny_non_owner, "is_host_owner_dashboard_request")],
        "reveal": [(redacted_reveal._refusal, "is_host_owner_dashboard_request")],
        "phone": [(tailnet_mobile.api_tailnet_mobile_status, "is_host_owner_dashboard_request")],
    }


#: Kinds that name no surface of their own: the generic line any owner-only
#: refusal falls back to, and the channel list's per-row form of ``channels``.
UNPINNED_KINDS = {"generic", "channel_row"}


def _kinds_declared() -> set[str]:
    text = NOTICE.read_text(encoding="utf-8")
    block = text[text.index("const OWNER_ONLY_KEYS = {") : text.index("} as const")]
    return set(re.findall(r"^\s+(\w+): \[", block, re.M))


def _kinds_used() -> set[str]:
    used: set[str] = set()
    for path in WEBSITE_SRC.rglob("*.tsx"):
        if ".test." in path.name:
            continue
        used |= set(
            re.findall(
                r'<OwnerOnly(?:Notice|Gate|OrError)\b[^>]*\bkind="(\w+)"',
                path.read_text(encoding="utf-8"),
            )
        )
        used |= set(re.findall(r"ownerOnlyText\('(\w+)'", path.read_text(encoding="utf-8")))
    return used


def _pinned() -> set[str]:
    return set(ROUTE_PINS) | set(ADMISSION_PINS) | set(_handler_gates())


def test_every_lock_kind_the_website_declares_is_pinned_and_every_pin_is_declared() -> None:
    declared = _kinds_declared() - UNPINNED_KINDS
    assert declared, "no lock kinds found in OwnerOnlyNotice.tsx"
    assert declared - _pinned() == set(), "a lock kind has no backend pin here"
    assert _pinned() - declared == set(), "a pin names a kind OwnerOnlyNotice.tsx no longer has"


def test_every_lock_kind_the_website_uses_is_declared() -> None:
    assert _kinds_used() - _kinds_declared() == set()


@pytest.mark.parametrize(
    ("kind", "method", "path"),
    [(kind, method, path) for kind, routes in ROUTE_PINS.items() for method, path in routes],
)
def test_route_pins_are_refused_to_a_teammate(kind: str, method: str, path: str) -> None:
    request = SimpleNamespace(path=path, method=method)
    assert teammate_access.is_owner_only_for_teammates(request), (kind, method, path)


@pytest.mark.parametrize(
    ("kind", "key"),
    [(kind, key) for kind, keys in ADMISSION_PINS.items() for key in keys],
)
def test_admission_pins_are_refused_to_a_teammate(kind: str, key: str) -> None:
    assert teammate_access.is_admission_config_key(key), (kind, key)


def test_handler_gates_admit_only_the_machine_owner() -> None:
    for kind, gates in _handler_gates().items():
        for handler, predicate in gates:
            assert predicate in inspect.getsource(handler), (kind, handler)


def test_the_codes_the_website_renders_as_the_lock_are_the_backends() -> None:
    text = API_ERROR.read_text(encoding="utf-8")
    line = re.search(r"OWNER_ONLY_REFUSAL_CODES[^=]*= new Set\(\[([^\]]*)\]\)", text)
    assert line, "OWNER_ONLY_REFUSAL_CODES not found in apiError.ts"
    codes = set(re.findall(r"'([a-z_]+)'", line.group(1)))
    # The owner gates' code, and the relay route limits a teammate is held to that
    # mean "the owner's" for every caller (instances_disabled also means "off" to
    # the owner, so it is not one; the Remote Crew panel is locked up front).
    assert codes == {"owner_only", limits.LOCAL_CREDENTIAL.code, limits.SHUTDOWN.code}
