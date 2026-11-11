# Richland Library on Goodreads — v2.5.1

Firefox extension that shows Richland Library physical holdings, live Libby availability, and Hoopla eBook/eAudiobook availability on Goodreads.

## Baseline and v2.5 behavior

**v2.3 remains the known-good rollback baseline.** v2.5 was rebuilt directly from v2.3 with one functional change: Hoopla eBook and eAudiobook lookups are fully independent jobs. Each format gets its own hidden Firefox tab, polling loop, retry state, timeout, and queue, and one format cannot stop or shorten the other format's search.

## v2.5.1 release-preparation changes

v2.5.1 does not change matching or availability behavior. It adds the distribution and privacy metadata needed for self-hosting:

- Minimum Firefox version: 140
- Firefox data-collection declaration: `websiteContent`
- Self-hosted update URL: `https://raw.githubusercontent.com/adelechase/richland-goodreads-firefox/main/updates.json`
- Privacy policy: [`PRIVACY.md`](PRIVACY.md)

## Privacy

The extension reads the title, author, and, when available, ISBN from Goodreads and sends book-identifying search information to Richland Library's Polaris catalog, OverDrive/Libby, and Hoopla to retrieve availability. It does not operate a developer server, use analytics, or intentionally retain a reading/search history. See [`PRIVACY.md`](PRIVACY.md) for details.

## Self-hosted Firefox updates

The extension ID is `richland-goodreads@local`. Firefox checks `updates.json` for newer versions.

`updates.json` intentionally starts with an empty `updates` array. Do not advertise a version until Mozilla has signed that exact XPI and the signed XPI has been uploaded to a stable HTTPS URL.

For a future signed release, add an entry like:

```json
{
  "addons": {
    "richland-goodreads@local": {
      "updates": [
        {
          "version": "2.5.2",
          "update_link": "https://github.com/adelechase/richland-goodreads-firefox/releases/download/v2.5.2/richland-goodreads-firefox-v2.5.2-signed.xpi"
        }
      ]
    }
  }
}
```

Keep older update entries if you want Firefox to choose among versions based on compatibility. The `update_link` must point to a Mozilla-signed XPI, not the unsigned source ZIP submitted for signing.

## Mozilla self-distribution workflow

1. Package the extension with `manifest.json` at the root of the ZIP.
2. Submit the ZIP to addons.mozilla.org using the self-distribution/unlisted workflow.
3. Download the Mozilla-signed XPI.
4. Create a GitHub Release for the same version and upload the signed XPI with the filename used by `updates.json`.
5. Add that version and its GitHub Release URL to `updates.json` and commit the change.
6. Users who already have the extension installed will receive later versions automatically when Firefox checks the update manifest.

## Temporary development install

1. Open `about:debugging` in Firefox.
2. Choose **This Firefox** → **Load Temporary Add-on**.
3. Select `manifest.json` from the extension source folder.
4. Refresh Goodreads.

## Important Hoopla note

Hoopla's official library-specific Partner API requires credentials issued to library/vendor integrations. This extension does not embed those credentials or read your library card number. For library-specific Hoopla results, sign in to Hoopla in Firefox with the Richland Library account you normally use.
