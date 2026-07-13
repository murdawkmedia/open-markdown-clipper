# Open Markdown Clipper

Open Markdown Clipper captures web pages, selections, and highlights as durable
Markdown. It is an independent, local-first Firefox and Chromium extension
derived from the open-source Obsidian Web Clipper codebase.

## Development status

The public fork is in pre-release verification. Page extraction, templates,
highlights, and reader view are retained, while the legacy application transport
has been removed. Copy, Download, Custom URI, and authenticated loopback HTTP are
the supported destination contracts.

No browser-store package has been published. Build and load the extension
locally while version `0.1.0` is in development.

## Principles

- Markdown remains durable and portable.
- Copy and Download work without a desktop note application.
- No telemetry or hosted account.
- Network delivery is explicit and user-configured.
- The raw Local HTTP access token is never synchronized, exported, or intentionally logged.
- Firefox and Chromium are first-class targets; Safari is not packaged.

## Choose a destination

Download is the default and needs no setup. The extension also supports Copy,
a user-defined Custom URI, and an authenticated Local HTTP receiver. Configure
the default and any receiver details under **Settings > Destination**. Custom
URI templates and Local HTTP endpoints are synchronized and included in
settings exports, so never put credentials or other secrets in either field.
The raw Local HTTP access token stays in extension-local storage and is
deliberately excluded from settings export and synchronization.

Firefox asks for optional consent to transmit browsing activity, website
content, and website activity when Custom URI would send data outside the
extension. Local HTTP asks for those categories plus authentication information
because it transmits the bearer token. Copy and Download do not request that
consent. A popup or Settings action can show the Firefox prompt;
Reader controls and Quick Clip never interrupt with a permission prompt, so
grant consent from the popup or Settings before using either with a
transmitting destination. Removing the grant makes subsequent sends fail
closed.

Local HTTP accepts only an explicit
`http://127.0.0.1:<port>/<non-root-path>` endpoint with no query string or
fragment. Its bearer token proves the
sender to the receiver, but it does not prove the receiver to the extension:
another local process that owns the configured port could receive the token and
capture. Use a receiver you control. If a POST times out or loses its connection
after dispatch, the result is reported as unknown because the receiver may
already have saved it; check the receiver before retrying.

### Local HTTP receiver contract

The **Test connection** action sends an authenticated `HEAD` request with no
body. A capture sends an authenticated `POST` with `Content-Type:
application/json` and exactly these fields:

```json
{
  "title": "Page title",
  "markdown": "# Rendered capture",
  "sourceUrl": "https://example.com/page",
  "capturedAt": "2026-07-12T18:00:00.000Z"
}
```

Both requests carry the configured access token as a Bearer authorization
header. The receiver should return any 2xx status. Redirects and all other
statuses are failures; response bodies are cancelled without being read. The
extension applies a ten-second request timeout. Because a failed or timed-out
POST may still have been committed, receivers should make duplicate handling
safe and users should check the receiver before retrying.

Treat every request field as attacker-controlled web content even when the
Bearer token is valid. A receiver should enforce schema and size limits, store
captures as data, sanitize any rendered Markdown, HTML, or links, and never
execute frontmatter or interpolate capture fields into shell commands.

The v0.1 extension never places a privileged delivery interface inside an
arbitrary web page. Delivery runs in browser-owned extension UI: the popup,
Chrome's native side panel, or an extension-origin Reader page.

See [SECURITY.md](SECURITY.md) for the complete trust boundaries.

## Build locally

Requirements: Node.js 22 or newer and npm. The browser packages target
Chromium 127 or newer (the first general release with `action.openPopup`) and
Firefox 149 or newer (where `action.openPopup` remains callable after awaited
Quick Clip setup).

```sh
npm ci
npm run verify
npm audit --audit-level=high
```

Build outputs:

- `dist/` for Chromium browsers.
- `dist_firefox/` for Firefox.
- `builds/open-markdown-clipper-0.1.0-chrome.zip`.
- `builds/open-markdown-clipper-0.1.0-firefox.zip`.

For Chromium, open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and select `dist/`.

For Firefox development, open `about:debugging#/runtime/this-firefox`, choose
**Load Temporary Add-on**, and select `dist_firefox/manifest.json`.

## Verify public-release boundaries

```sh
node scripts/public-release-scan.mjs --identity
npm run scan:public
```

The complete `verify` command runs tests, TypeScript checking, scanner tests,
the final public scan, API/CLI builds, and both browser builds. Both identity
and final public scans must pass before the repository is released.

## Documentation

- [Introduction](docs/Introduction%20to%20Open%20Markdown%20Clipper.md)
- [Clip web pages](docs/Clip%20web%20pages.md)
- [Highlight web pages](docs/Highlight%20web%20pages.md)
- [Templates](docs/Templates.md)
- [Variables](docs/Variables.md)
- [Filters](docs/Filters.md)
- [Template logic](docs/Logic.md)
- [Troubleshooting](docs/Troubleshoot%20Open%20Markdown%20Clipper.md)

## Upstream provenance

This project began as a fork of
[`obsidianmd/obsidian-clipper`](https://github.com/obsidianmd/obsidian-clipper).
The upstream MIT-covered source history and copyright notice are preserved.
Upstream trademarks, icons, store imagery, and marketing assets are not part of
this project. Open Markdown Clipper is not affiliated with or endorsed by
Obsidian.

See [NOTICE.md](NOTICE.md) for provenance and material changes.

## Contributing

Use a feature branch and open a pull request. `main` is the release branch, and
tests, both browser builds, identity checks, dependency audit policy, and the
public privacy scan must pass before merge.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
