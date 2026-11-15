#!/usr/bin/env python3
"""Build the public download page from Mozilla-signed releases in updates.json.

This script only writes docs/index.html. It never changes the Firefox extension,
the signed release assets, or updates.json.
"""
import argparse
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "site" / "download-template.html"
OUTPUT = ROOT / "docs" / "index.html"
FEED = ROOT / "updates.json"
ADDON_ID = "richland-goodreads@local"
SIGNED_XPI = re.compile(
    r"https://github\.com/adelechase/richland-goodreads-firefox/releases/download/"
    r"v(?P<version>\d+\.\d+\.\d+)/"
    r"richland-goodreads-firefox-v(?P=version)-signed\.xpi"
)
MARKERS = ("{{DOWNLOAD_URL}}", "{{VERSION}}", "{{FALLBACK_HTML}}")


def signed_releases(feed):
    """Return signed releases sorted by numeric version, newest first."""
    try:
        entries = feed["addons"][ADDON_ID]["updates"]
    except (KeyError, TypeError) as exc:
        raise ValueError("Missing Firefox update entries for this extension.") from exc

    if not isinstance(entries, list) or not entries:
        raise ValueError("No signed releases in updates.json; keeping the existing page.")

    seen = set()
    releases = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("An update entry is not an object.")
        version, url = entry.get("version"), entry.get("update_link")
        if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError(f"Invalid signed release version: {version!r}")
        if not isinstance(url, str) or not SIGNED_XPI.fullmatch(url):
            raise ValueError(f"Unexpected signed XPI URL for version {version}.")
        if SIGNED_XPI.fullmatch(url).group("version") != version:
            raise ValueError(f"Version and XPI URL disagree for {version}.")
        numeric = tuple(int(n) for n in version.split("."))
        if numeric in seen:
            raise ValueError(f"Duplicate signed release version: {version}")
        seen.add(numeric)
        releases.append((numeric, version, url))

    releases.sort(reverse=True)
    return releases


def render_page(template, releases):
    """Keep every instruction and style reference while changing only release links."""
    for marker in MARKERS:
        if template.count(marker) != 1:
            raise ValueError(f"Expected exactly one {marker} in {TEMPLATE}.")

    _, version, url = releases[0]
    fallback = ""
    if len(releases) > 1:
        _, prior_version, prior_url = releases[1]
        fallback = (
            '<p class="fallback">Fallback: <a href="'
            + html.escape(prior_url, quote=True)
            + '">signed version '
            + html.escape(prior_version)
            + "</a></p>"
        )

    return (template
            .replace("{{DOWNLOAD_URL}}", html.escape(url, quote=True))
            .replace("{{VERSION}}", html.escape(version))
            .replace("{{FALLBACK_HTML}}", fallback))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build-page", "check-page"))
    args = parser.parse_args()

    try:
        feed = json.loads(FEED.read_text(encoding="utf-8"))
        releases = signed_releases(feed)
        output = render_page(TEMPLATE.read_text(encoding="utf-8"), releases)
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else None
        if args.command == "check-page":
            if current != output:
                print("Website is out of sync with signed Firefox releases.", file=sys.stderr)
                return 1
        elif current != output:
            OUTPUT.parent.mkdir(parents=True, exist_ok=True)
            OUTPUT.write_text(output, encoding="utf-8")
            print("Updated docs/index.html for signed release " + releases[0][1])
        else:
            print("Website already matches signed release " + releases[0][1])
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Download page not generated: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
