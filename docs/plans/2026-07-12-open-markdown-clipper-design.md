# Open Markdown Clipper design

Date: 2026-07-12
Status: approved
Repository: `murdawkmedia/open-markdown-clipper` (public)

## Purpose

Open Markdown Clipper is a browser extension that turns a web page into durable
Markdown and sends it to a user-selected destination. It is a generic,
local-first fork of Obsidian Web Clipper for Firefox and Chromium browsers. It
must work without Obsidian, must not contain consumer-specific configuration,
and must remain useful to people running other local knowledge systems.

## Upstream and licensing

The fork preserves the upstream Git history and the MIT license/copyright
notice. The README and `NOTICE.md` credit `obsidianmd/obsidian-clipper` and list
material changes. Obsidian trademarks, icons, marketing copy, store imagery,
Safari application assets, extension IDs, URLs, and user-facing branding are
not reused. The initial release supports Firefox and Chromium only.

## Product boundary

The fork retains the mature extraction, Markdown conversion, templates,
highlights, reader view, clipboard, and file-download capabilities. The
application-specific URI path is replaced by a destination abstraction. The
upstream AI interpreter and provider configuration are removed from the first
release; the extension contains no browser-based AI interpretation workflow.

The extension has no telemetry. Existing local usage counters may remain local,
but no data is transmitted unless the user explicitly activates Custom URI or
Local HTTP. Custom URI templates and Local HTTP endpoints are non-secret
preferences that are synchronized and included in settings exports. The raw
Local HTTP access token remains extension-local and is never intentionally
logged, synchronized, exported, included in clip payloads, or stored in
repository fixtures.

## Destination model

Every destination implements one narrow interface:

```ts
export interface ClipDocument {
	title: string;
	markdown: string;
	sourceUrl: string;
	capturedAt: string;
}

export interface DestinationResult {
	destination: DestinationKind;
	receipt?: string;
}

export interface ClipDestination {
	send(document: ClipDocument): Promise<DestinationResult>;
}
```

The first release provides four destination kinds:

1. `clipboard`: copy the generated Markdown.
2. `download`: save a `.md` file through the browser download flow.
3. `custom-uri`: open a user-configured URI template after strict scheme and
   length validation.
4. `local-http`: POST the generic JSON document to a configured endpoint.

The local HTTP adapter accepts only literal loopback HTTP URLs using
`127.0.0.1`, an explicit port, a non-root path, and no query string or fragment.
Hostnames are not resolved, so a name cannot be rebound to another
machine. A configured bearer token is sent only in the `Authorization` header.
Requests use `application/json`, `credentials: "omit"`, a bounded timeout, no
redirects, and a fixed four-field request shape. Response bodies are cancelled
without being read or rendered; the bounded receipt records only the validated
HTTP status.
After POST dispatch, a timeout, abort, fetch rejection, invalid response, or
response-read failure is reported as an unknown outcome because the receiver
may already have persisted the document. The user is told to check the receiver
before retrying.

## Settings

Non-secret destination preferences use synchronized extension settings:

```ts
export interface DestinationSettings {
	defaultDestination: DestinationKind;
	customUriTemplate: string;
	localHttpEndpoint: string;
}
```

The raw HTTP token uses a dedicated local-only storage key and is masked in the
settings page. Settings export/import omits this key. The UI includes an explicit
connection test that sends no page content. The default destination is
`download`, so the extension is useful before any local service is configured.

## User experience

The popup keeps the extracted Markdown preview and template controls. The main
button names the selected destination. Secondary actions expose the other safe
destinations. A successful HTTP save confirms delivery without displaying the
receiver response; a failure leaves the Markdown in the popup and offers Copy
and Download without discarding work.

Settings use the plain terms Destination, Endpoint, Access token, Custom URI,
Copy, and Download. No interface assumes vaults or an installed desktop note
application.

Privileged delivery controls live only in browser-owned extension UI: the
popup, Chromium's native side panel, or an extension-origin Reader page. The
v0.1 public release does not inject a delivery iframe into arbitrary page DOM.

## Browser and network security

- Firefox and Chromium Manifest V3 builds remain separate.
- Page extraction permissions remain explicit in the manifests.
- Endpoint validation happens before every request, not only when settings save.
- Redirects are rejected so a trusted loopback endpoint cannot redirect private
  content to another host.
- `javascript:`, `data:`, `file:`, browser-internal, and malformed custom URI
  schemes are rejected.
- HTTP failures expose stable, content-free messages.
- Destination adapters and fixed delivery errors never log Markdown, page URLs,
  tokens, authorization headers, or raw response bodies.
- Content is sent only after a direct destination action or the configured
  Quick Clip keyboard command.
- Firefox declares authentication information, browsing activity, website
  content, and website activity as optional data-collection categories. Custom
  URI requires browsing activity, website content, and website activity; Local
  HTTP additionally requires authentication information for its bearer token.
  Both require the applicable current grant before capture and delivery;
  popup and Settings gestures can request it, Reader controls and Quick Clip
  never prompt, and revocation fails closed. Copy and Download never request it.
  Chromium builds feature-detect the Firefox-only API.

## Public repository policy

`main` is the release branch. Feature branches and pull requests are the normal
contribution path. CI must run tests, TypeScript compilation, Firefox/Chromium
builds, dependency audit policy, forbidden-brand scans, and a public privacy
scan before merge. Repository examples use placeholders such as
`http://127.0.0.1:8765/captures`; they never name or expose a consumer's internals.

## Baseline portability repair

The fork normalizes fixture line endings at the test boundary and pins the test
timezone so the extraction suite is repeatable on Windows and Linux. Defuddle
diagnostics remain visible when they represent a real extraction failure.

## Non-goals for the first release

- No consumer-specific destination or branding.
- No direct filesystem access outside the browser download API.
- No synchronization service.
- No hosted account, analytics, or telemetry.
- No Safari package.
- No RAG, chat, summarization, or model orchestration inside the extension.

## Acceptance criteria

- Firefox and Chromium packages build from the public repository.
- Copy, Download, Custom URI, and Local HTTP destinations have behavior tests.
- The extension can operate without Obsidian installed.
- All excluded upstream branding/assets are removed or replaced.
- The public repository passes its privacy and forbidden-content scans.
- A private local console can use the same generic HTTP contract without
  appearing in this repository.
