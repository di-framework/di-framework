#!/usr/bin/env python3
"""Replace Writerside favicon output with our site icons.

This builder's <custom-favicons> emits the value as a literal text node
(local path or URL) instead of <link rel="icon">. With the variable
absent, it injects JetBrains.com favicon links. Either way, post-process
the unzipped WebHelp HTML so the tab icon is ours.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

OUR_LINKS = (
    '<link rel="icon" href="favicon.png" type="image/png">'
    '<link rel="shortcut icon" href="favicon.ico" type="image/x-icon">'
)

# Dump from broken <custom-favicons> (filename or hosted URL).
DUMPED = re.compile(
    r'(rel="stylesheet">)\s*'
    r"(?:favicon\.png|https://docs\.di-framework\.dev/favicon\.png)\s*",
    re.IGNORECASE,
)

# Default JetBrains favicon suite inserted when custom-favicons is unset.
JETBRAINS = re.compile(
    r'<link rel="apple-touch-icon"[^>]*>'
    r'(?:<link rel="(?:icon|manifest|mask-icon)"[^>]*>)*'
    r'(?:<meta name="msapplication-[^"]*"[^>]*/?>)*',
    re.IGNORECASE,
)

ALREADY_OURS = 'href="favicon.png"'


def patch_html(text: str) -> str:
    text = DUMPED.sub(r"\1", text)
    if ALREADY_OURS in text and "jetbrains.com/favicon" not in text:
        return text
    if JETBRAINS.search(text):
        return JETBRAINS.sub(OUR_LINKS, text, count=1)
    if ALREADY_OURS in text:
        return text
    return re.sub(
        r'(href="[^"]*app\.css"[^>]*>)',
        r"\1" + OUR_LINKS,
        text,
        count=1,
    )


def main(root: Path) -> int:
    n = 0
    for path in root.rglob("*.html"):
        original = path.read_text(encoding="utf-8")
        updated = patch_html(original)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            n += 1
    print(f"patched favicon links in {n} html file(s) under {root}")
    return 0


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "dir")
    raise SystemExit(main(target))
