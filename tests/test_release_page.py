"""Regression checks for the signed-release download-page generator."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release


class ReleasePageTests(unittest.TestCase):
    def test_current_page_tracks_signed_update_feed(self):
        feed = json.loads(release.FEED.read_text(encoding="utf-8"))
        releases = release.signed_releases(feed)
        actual = release.OUTPUT.read_text(encoding="utf-8")
        expected = release.render_page(release.TEMPLATE.read_text(encoding="utf-8"), releases)
        self.assertEqual(actual, expected)

    def test_newer_signed_release_becomes_primary_and_old_one_fallback(self):
        old = {
            "version": "2.5.1",
            "update_link": "https://github.com/adelechase/richland-goodreads-firefox/releases/download/v2.5.1/richland-goodreads-firefox-v2.5.1-signed.xpi",
        }
        new = {
            "version": "2.5.10",
            "update_link": "https://github.com/adelechase/richland-goodreads-firefox/releases/download/v2.5.10/richland-goodreads-firefox-v2.5.10-signed.xpi",
        }
        feed = {"addons": {release.ADDON_ID: {"updates": [old, new]}}}
        output = release.render_page(release.TEMPLATE.read_text(encoding="utf-8"),
                                     release.signed_releases(feed))
        self.assertIn("Install version 2.5.10 for Firefox", output)
        self.assertIn('">signed version 2.5.1</a>', output)
        self.assertNotIn("{{DOWNLOAD_URL}}", output)
        self.assertIn("<h3>AI Disclosure</h3>", output)
        self.assertIn('<link rel="stylesheet" href="styles.css">', output)

    def test_invalid_or_unreleased_download_links_are_rejected(self):
        for link in (
            "https://example.com/v2.5.2/new.xpi",
            "https://github.com/adelechase/richland-goodreads-firefox/releases/download/v2.5.2/unsigned.zip",
            "https://github.com/adelechase/richland-goodreads-firefox/releases/download/v9.0.0/richland-goodreads-firefox-v9.0.0-signed.xpi",
        ):
            with self.subTest(link=link):
                feed = {"addons": {release.ADDON_ID: {"updates": [
                    {"version": "2.5.2", "update_link": link}
                ]}}}
                with self.assertRaises(ValueError):
                    release.signed_releases(feed)

    def test_empty_update_feed_does_not_erase_install_link(self):
        feed = {"addons": {release.ADDON_ID: {"updates": []}}}
        with self.assertRaises(ValueError):
            release.signed_releases(feed)


if __name__ == "__main__":
    unittest.main()
