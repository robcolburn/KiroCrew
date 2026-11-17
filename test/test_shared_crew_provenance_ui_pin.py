"""The website's provenance-to-path map is pinned to the backend's.

People rows carry a ``provenance`` only, so the website maps it to the path a person
came in on (``pathOfProvenance`` in ``website/src/api/sharedCrewUi.ts``). That switch
is a frontend copy of ``shared_crew.crew_mode._VIA_BY_PROVENANCE``, the map behind
the mode body's ``viewer_via``. This test parses the switch and fails when the two
disagree on any provenance, or the switch names one the backend does not have.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

from kiro_crew.shared_crew import crew_mode
from kiro_crew.shared_crew.contracts import Provenance

ROOT = Path(__file__).resolve().parent.parent
SHARED_CREW_UI = ROOT / "website/src/api/sharedCrewUi.ts"


def _website_map() -> tuple[dict[str, str], str]:
    """The switch's ``case`` -> returned path, and its ``default`` path."""
    source = SHARED_CREW_UI.read_text(encoding="utf-8")
    start = source.index("export function pathOfProvenance(")
    body = source[start : source.index("\n}\n", start)]
    mapping: dict[str, str] = {}
    for cases, via in re.findall(r"((?:case '[a-z_]+':\s*)+)return '([a-z_]+)'", body):
        for provenance in re.findall(r"case '([a-z_]+)':", cases):
            assert provenance not in mapping, f"{provenance!r} is cased twice"
            mapping[provenance] = via
    default = re.search(r"default:\s*return '([a-z_]+)'", body)
    assert mapping and default, "pathOfProvenance's switch could not be parsed"
    return mapping, default.group(1)


def test_the_website_maps_every_provenance_to_the_backends_path() -> None:
    website, default = _website_map()
    assert set(website) <= {p.value for p in Provenance}, "a case names no backend provenance"
    assert set(website) == {p.value for p in crew_mode._VIA_BY_PROVENANCE}
    for provenance in Provenance:
        backend = crew_mode.viewer_via(SimpleNamespace(provenance=provenance))  # type: ignore[arg-type]
        assert website.get(provenance.value, default) == backend, provenance
    # A provenance neither side names: both answer the same fallback.
    assert crew_mode.viewer_via(SimpleNamespace(provenance=None)) == default  # type: ignore[arg-type]
