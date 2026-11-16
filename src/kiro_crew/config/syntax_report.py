"""Name a JSON syntax error in ``config.json`` / ``config.local.json`` for a person.

The loader treats a file that does not parse as absent: it logs one WARNING per
load, marks the file degraded and runs on defaults, which leaves the file itself
untouched. That is the right recovery, but nothing told the person who saved the
broken file: the terminal and the dashboard both read "all systems running" while
every setting they had made was ignored. :func:`find_config_syntax_errors` reads
the two hand-edited files as the person sees them on disk and returns one
:class:`ConfigSyntaxError` per file that does not parse, carrying the path, the
line and column, and one concrete fix. The gateway prints it at start and posts it
as a bell note (``notifications/config_syntax_note.py``).

Read-only: the broken copy is never repaired or moved here. No text from the file is
quoted: the report reaches the terminal, the log and the bell, and the line that
fails to parse is the one most likely to hold a value in a shape no masking
recognises (unquoted, or half-quoted).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from kiro_crew.config import loosening_provenance
from kiro_crew.config.loader_locations import config_local_path, config_path
from kiro_crew.user_json import strip_utf8_bom


def _read_regular_config_text(path: Path) -> str:
    """The text of *path*, BOM dropped, refusing a *path* that is not a regular file.

    A name pointed at a FIFO or ``/dev/zero`` raises ``OSError`` here, as the
    loader's own read does, instead of blocking or never ending. An absent file
    raises ``FileNotFoundError``.
    """
    return strip_utf8_bom(loosening_provenance.read_regular_with_retry(path).decode("utf-8"))


@dataclass(frozen=True)
class ConfigSyntaxError:
    """One config file that does not parse as JSON, and where."""

    path: Path
    line: int
    column: int
    message: str
    fix: str
    #: ``<path>.bak`` when one exists: the copy the last settings migration took,
    #: which can be older than the edit that broke the file.
    backup: Path | None = None
    #: True for ``config.local.json``: the loader keeps ``config.json`` and drops
    #: only the overlay, so its settings are not on defaults.
    overlay: bool = False

    def summary(self) -> str:
        """One line: the file, the position and the parser's reason."""
        return f"{self.path} has a JSON syntax error on line {self.line}, column {self.column}: {self.message}."

    def explain(self) -> str:
        """The summary and the fix, for a terminal or a note body."""
        lines = [self.summary()]
        # Every config writer refuses a file that does not parse (``save`` and
        # ``read_config_for_update`` raise ConfigReadError), so this holds until it is fixed.
        ignored = (
            "Kiro Crew is ignoring the overrides in this file and running on config.json alone"
            if self.overlay
            else "Kiro Crew is ignoring this file and running on default settings"
        )
        lines.append(f"{ignored}; it will not save over the file until it parses again.")
        lines.append(f"To fix it: {self.fix}, save the file, then restart Kiro Crew.")
        if self.backup is not None:
            lines.append(
                f"An earlier copy from a settings migration is at {self.backup}; "
                "it may be older than your last edit."
            )
        return "\n".join(lines)


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _column_of(text: str, pos: int) -> int:
    return pos - (text.rfind("\n", 0, pos) + 1) + 1


def _ends_its_line(text: str, pos: int) -> bool:
    """True when only whitespace follows *pos* up to the end of its line."""
    newline = text.find("\n", pos + 1)
    return not text[pos + 1 : newline if newline >= 0 else len(text)].strip()


def _previous_token(text: str, pos: int) -> int:
    """The index of the last non-whitespace character before *pos*, or -1."""
    i = min(pos, len(text)) - 1
    while i >= 0 and text[i].isspace():
        i -= 1
    return i


def _fix_for(text: str, err: json.JSONDecodeError) -> str:
    """One concrete edit for the commonest hand-edit mistakes, else a generic one.

    "At the end of line N" is said only when the token it is about ends that line;
    on a line that goes on (a one-line file), the edit is placed by its column.
    """
    prev = _previous_token(text, err.pos)
    if err.msg.startswith("Expecting ',' delimiter") and prev >= 0:
        if _ends_its_line(text, prev):
            return f"add a comma at the end of line {_line_of(text, prev)}"
        return f"add a comma on line {err.lineno} just before column {err.colno}"
    trailing = err.msg.startswith(("Expecting property name", "Expecting value"))
    if trailing and prev >= 0 and text[prev] == ",":
        if _ends_its_line(text, prev):
            return f"remove the comma at the end of line {_line_of(text, prev)}"
        return f"remove the comma on line {_line_of(text, prev)} at column {_column_of(text, prev)}"
    return f"correct the JSON on line {err.lineno} at column {err.colno}"


def syntax_error_in(path: Path, *, overlay: bool = False) -> ConfigSyntaxError | None:
    """The syntax error in the config file at *path*, or None when it parses or is absent.

    Read as the person sees it on disk, BOM dropped: the report is about the bytes
    they edited. Read through :func:`_read_regular_config_text`, so a name pointed at
    a FIFO or a device is refused instead of blocking or never ending. An absent or
    unreadable file is the loader's warning to give, not a syntax error, so it reads
    as None here.
    """
    try:
        text = _read_regular_config_text(path)
    except (OSError, UnicodeDecodeError):
        return None
    try:
        json.loads(text)
    except json.JSONDecodeError as err:
        backup = Path(str(path) + ".bak")
        return ConfigSyntaxError(
            path=path,
            line=err.lineno,
            column=err.colno,
            message=err.msg,
            fix=_fix_for(text, err),
            backup=backup if backup.is_file() else None,
            overlay=overlay,
        )
    except RecursionError:
        return None
    return None


def find_config_syntax_errors() -> list[ConfigSyntaxError]:
    """The syntax errors in ``config.json`` then ``config.local.json``. BLOCKING: reads files."""
    found = [
        syntax_error_in(config_path()),
        syntax_error_in(config_local_path(), overlay=True),
    ]
    return [err for err in found if err is not None]
