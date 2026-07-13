# Open Markdown Clipper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` only when the user explicitly asked for delegated workers; otherwise use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a trademark-clean Firefox/Chromium Markdown clipper with Clipboard, Download, Custom URI, and authenticated loopback HTTP destinations.

**Architecture:** Preserve upstream extraction, templates, highlights, and reader mode while replacing the Obsidian-specific save function with typed destination adapters. Keep destination secrets outside synchronized/exported settings, permit network delivery only to literal loopback addresses, and make Download the safe default. Preserve upstream history and license while replacing excluded branding and assets.

**Tech Stack:** TypeScript, WebExtensions Manifest V3, webextension-polyfill, Vitest/jsdom, Webpack, SCSS, GitHub Actions.

---

## File structure

- `src/destinations/types.ts`: immutable clip artifact, destination settings, result, and error contracts.
- `src/destinations/registry.ts`: resolves one destination adapter without reading UI state.
- `src/destinations/clipboard.ts`: clipboard delivery.
- `src/destinations/download.ts`: browser download delivery.
- `src/destinations/custom-uri.ts`: clipboard-first custom URI delivery and scheme validation.
- `src/destinations/local-http.ts`: literal-loopback validation and bounded authenticated POST.
- `src/destinations/*.test.ts`: adapter behavior and security tests.
- `src/utils/clip-artifact.ts`: assembles the rendered frontmatter and Markdown once for every surface.
- `src/utils/destination-secrets.ts`: extension-local access-token storage, excluded from exports/debugging.
- `src/utils/destination-secrets.test.ts`: secret isolation tests.
- `src/utils/storage-utils.ts`: public destination preferences and migration from upstream save behavior.
- `src/core/popup.ts`: dispatches the primary and secondary actions through the registry.
- `src/managers/general-settings.ts` and `src/settings.html`: destination settings UI.
- `src/background.ts`, `src/content.ts`, and `src/utils/reader.ts`: generic URI and quick/reader destination actions.
- `scripts/generate-icons.mjs` and `assets/source/icon.svg`: original icon generation.
- `.github/workflows/ci.yml`: test, typecheck, build, audit, brand, and privacy gates.

### Task 1: Repair the inherited cross-platform baseline

**Files:**
- Modify: `src/utils/template-integration.test.ts`
- Modify: `vitest.config.ts`
- Test: `src/utils/template-integration.test.ts`

- [ ] **Step 1: Reproduce and record the inherited failures**

Run:

```powershell
npm test -- src/utils/template-integration.test.ts
```

Expected: six failures; CRLF differs from LF in all six and the YouTube fixture differs by local timezone when the host is not America/Los_Angeles.

- [ ] **Step 2: Make the fixture comparison content-oriented**

Add this helper and use it on both values at the final assertion:

```ts
function normalizeFixture(value: string): string {
	return value.replace(/\r\n/g, '\n').trim();
}

expect(normalizeFixture(result)).toEqual(normalizeFixture(expected));
```

- [ ] **Step 3: Fix the test timezone at process setup**

At the top of `vitest.config.ts`, before exporting configuration, add:

```ts
process.env.TZ = 'America/Los_Angeles';
```

This preserves the upstream fixture's explicit `-08:00` winter offset on every host.

- [ ] **Step 4: Verify the focused and full baseline**

Run:

```powershell
npm test -- src/utils/template-integration.test.ts
npm test
npm run build:chrome
npm run build:firefox
```

Expected: 7 focused tests pass, all tests pass, and both builds exit zero. Record Defuddle/jsdom diagnostics separately if they remain despite passing outputs.

- [ ] **Step 5: Commit the baseline repair**

```powershell
git add src/utils/template-integration.test.ts vitest.config.ts
git commit -m "test: make fixture baselines cross-platform"
```

### Task 2: Establish independent public identity and provenance

**Files:**
- Create: `NOTICE.md`
- Create: `assets/source/icon.svg`
- Create: `scripts/generate-icons.mjs`
- Create: `scripts/public-release-scan.mjs`
- Modify: `README.md`
- Modify: `LICENSE`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `webpack.config.js`
- Modify: `src/manifest.chrome.json`
- Modify: `src/manifest.firefox.json`
- Modify: `src/_locales/en/messages.json`
- Delete: `src/manifest.safari.json`
- Delete: `xcode/Obsidian Web Clipper/**`
- Delete: `assets/chrome/**`
- Delete: `assets/edge/**`
- Delete: `assets/safari/**`
- Delete: non-English `src/_locales/*/messages.json`
- Replace: `src/icons/icon16.png`
- Replace: `src/icons/icon48.png`
- Replace: `src/icons/icon128.png`
- Test: `scripts/public-release-scan.mjs`

- [ ] **Step 1: Write the failing public-identity scan**

Create a scan with two modes. `--identity` walks tracked paths and text files,
ignores `LICENSE`, `NOTICE.md`, the attribution section of `README.md`, and
historical Git metadata, then fails on private product names/paths, old
extension IDs/homepages, `clipper@obsidian.md`, Safari bundle IDs, excluded asset
paths, or missing required provenance files. The default final mode adds
`obsidian://` and remaining legacy transport/source identifiers; it is expected
to remain red until Task 6 removes that transport.

Core deny list:

```js
const forbidden = [
	/new RegExp(['Mur', 'phy', 'OS'].join(''), 'i'),
	/[A-Z]:\\Users\\/i,
	/clipper@obsidian\.md/i,
	/md\.obsidian\./i,
];
```

Run `node scripts/public-release-scan.mjs` and confirm it fails on the upstream checkout.

- [ ] **Step 2: Replace package and manifest identity**

Use:

```json
{
	"name": "open-markdown-clipper",
	"description": "Capture web pages as durable Markdown and deliver them to local destinations."
}
```

Set both manifests to `Open Markdown Clipper`, homepage
`https://github.com/murdawkmedia/open-markdown-clipper`, version `0.1.0`, and neutral copy. Set the Firefox ID to `open-markdown-clipper@murdawk.media`. Remove Safari scripts/build targets and rename ZIP output to `open-markdown-clipper-<browser>-<version>.zip`.

- [ ] **Step 3: Remove excluded assets and add an original icon pipeline**

Remove store screenshots, Safari/Xcode material, and upstream icons. Add an original SVG consisting of a rounded dark document tile and teal downward arrow, with no upstream geometry or trademarks. Add `sharp` as a dev dependency and generate the three committed PNG sizes:

```js
import sharp from 'sharp';
for (const size of [16, 48, 128]) {
	await sharp('assets/source/icon.svg').resize(size, size).png().toFile(`src/icons/icon${size}.png`);
}
```

- [ ] **Step 4: Replace public copy and restrict the first release to English**

Rewrite `README.md`, all nine `docs/*.md` files, issue templates, package/CLI
identity, and manifest copy. Remove non-English locale directories for the first
release rather than shipping inaccurate mechanically translated destination
terminology. Keep `default_locale: "en"`. Leave destination-specific popup,
settings, reader, and English locale strings for Tasks 5 and 6 so the interim
branch never claims the legacy transport has already been replaced.

- [ ] **Step 5: Preserve license and add fork notice**

Keep the upstream MIT copyright/license text. Add `NOTICE.md` containing the upstream repository URL, the fork date, retained MIT-covered source, material changes, and a plain statement that the project is independent and not affiliated with or endorsed by Obsidian.

- [ ] **Step 6: Verify identity and builds**

Run:

```powershell
npm test
npm run build:chrome
npm run build:firefox
node scripts/public-release-scan.mjs --identity
git diff --check
```

Expected: all commands exit zero; built manifests contain the new identity and
no excluded IDs/assets. Running the scan without `--identity` remains red on the
legacy transport until Task 6.

- [ ] **Step 7: Commit the public identity**

```powershell
git add -A
git commit -m "chore: establish Open Markdown Clipper identity"
```

### Task 3: Add the destination domain and safe local adapters

**Files:**
- Create: `src/destinations/types.ts`
- Create: `src/destinations/clipboard.ts`
- Create: `src/destinations/download.ts`
- Create: `src/destinations/custom-uri.ts`
- Create: `src/destinations/local-http.ts`
- Create: `src/destinations/registry.ts`
- Create: `src/destinations/clipboard.test.ts`
- Create: `src/destinations/download.test.ts`
- Create: `src/destinations/custom-uri.test.ts`
- Create: `src/destinations/local-http.test.ts`
- Create: `src/destinations/registry.test.ts`
- Create: `src/utils/clip-artifact.ts`
- Create: `src/utils/clip-artifact.test.ts`

- [ ] **Step 1: Write failing contract and artifact tests**

Tests must require exact immutable output:

```ts
expect(buildClipDocument({ title: 'Page', markdown: '# Page', sourceUrl: 'https://example.com', now }))
	.toEqual({
		title: 'Page',
		markdown: '# Page',
		sourceUrl: 'https://example.com',
		capturedAt: '2026-07-12T18:00:00.000Z',
	});
```

Also fail on empty/oversized Markdown, control characters in titles, non-HTTP(S) source URLs, and invalid timestamps.

- [ ] **Step 2: Implement the shared types and builder**

Define:

```ts
export type DestinationKind = 'clipboard' | 'download' | 'custom-uri' | 'local-http';
export interface ClipDocument { readonly title: string; readonly markdown: string; readonly sourceUrl: string; readonly capturedAt: string; }
export interface DestinationResult { readonly destination: DestinationKind; readonly receipt?: string; }
export interface ClipDestination { readonly kind: DestinationKind; send(document: ClipDocument, signal?: AbortSignal): Promise<DestinationResult>; }
export class DestinationError extends Error { constructor(readonly code: string) { super(code); } }
```

- [ ] **Step 3: Write failing Clipboard and Download tests**

Inject the existing clipboard/file functions. Require successful effects before a delivered result and require `DestinationError` when the effect rejects. Prove no Markdown appears in error messages.

- [ ] **Step 4: Implement Clipboard and Download adapters**

Wrap `copyToClipboard()` and `saveFile()` without reading DOM state. Change `saveFile()` to reject after invoking `onError`, so callers cannot record a false success.

- [ ] **Step 5: Write failing Custom URI security tests**

Require clipboard-first delivery and template expansion for encoded `{title}` and `{sourceUrl}` only. Reject `http`, `https`, `javascript`, `data`, `file`, browser-internal schemes, missing custom schemes, control characters, URI output over 2,048 characters, and templates containing `{markdown}` or `{content}`.

- [ ] **Step 6: Implement Custom URI delivery**

Validate with a strict custom-scheme regex, copy Markdown, expand only the two safe placeholders, and invoke an injected `openUri(uri)` effect. Never place Markdown in the URI or a log.

- [ ] **Step 7: Write failing Local HTTP tests**

Tests must cover:

```ts
expect(fetch).toHaveBeenCalledWith(
	'http://127.0.0.1:8765/captures',
	expect.objectContaining({
		method: 'POST',
		credentials: 'omit',
		cache: 'no-store',
		redirect: 'error',
		headers: {
			'Authorization': 'Bearer test-token',
			'Content-Type': 'application/json',
		},
	})
);
```

Reject localhost hostnames, IPv4 variants, credentials in URLs, fragments, non-loopback addresses, redirects, timeouts, aborts, non-2xx responses, empty tokens, and response/error content echo.

- [ ] **Step 8: Implement Local HTTP and registry**

Use `new URL()`, require protocol `http:`, hostname exactly `127.0.0.1` (add `[::1]` only after a passing browser contract test), explicit port 1-65535, and a non-root path. Serialize exactly `title`, `markdown`, `sourceUrl`, and `capturedAt`. Use an `AbortController` timeout of 10 seconds and return only `HTTP <status>` as the receipt.

- [ ] **Step 9: Verify and commit adapters**

```powershell
npm test -- src/destinations src/utils/clip-artifact.test.ts
npm test
git add src/destinations src/utils/clip-artifact.ts src/utils/clip-artifact.test.ts src/utils/file-utils.ts
git commit -m "feat: add secure clip destinations"
```

### Task 4: Store public preferences and isolate destination secrets

**Files:**
- Modify: `src/types/types.ts`
- Modify: `src/utils/storage-utils.ts`
- Modify: `src/utils/import-export.ts`
- Modify: `src/utils/__mocks__/webextension-polyfill.ts`
- Create: `src/utils/storage-utils.test.ts`
- Create: `src/utils/destination-secrets.ts`
- Create: `src/utils/destination-secrets.test.ts`

- [ ] **Step 1: Write failing default and migration tests**

Require defaults:

```ts
{
	defaultDestination: 'download',
	customUriTemplate: '',
	localHttpEndpoint: '',
}
```

Require upstream `addToObsidian` to migrate to `download`; preserve existing `saveFile` as `download` and `copyToClipboard` as `clipboard`. Invalid destination values also become `download`.

- [ ] **Step 2: Implement destination preferences**

Replace `SaveBehavior` with `DestinationKind`, remove vault/silent/legacy settings from active UI state, bump the migration version, and sanitize every loaded string with explicit maximum lengths.

- [ ] **Step 3: Write failing secret-isolation tests**

Tests must show the access token is stored under `browser.storage.local` key `destinationSecrets`, never under sync storage, never returned by `exportAllSettings()`, never accepted through import, and rendered by debug/repr helpers only as `<configured>` or `<unset>`.

- [ ] **Step 4: Implement secret storage**

Expose only:

```ts
export async function setLocalHttpToken(token: string): Promise<void>;
export async function getLocalHttpToken(): Promise<string>;
export async function clearLocalHttpToken(): Promise<void>;
export async function hasLocalHttpToken(): Promise<boolean>;
```

Validate 16-512 printable ASCII characters, trim neither end, and return no storage object to callers.

- [ ] **Step 5: Remove sensitive full-store logging/export**

Delete `window.debugStorage()` and exported-object logging. Make settings export construct an allowlisted object containing templates and public settings only; exclude destination secrets and upstream model-provider credentials.

- [ ] **Step 6: Verify and commit settings**

```powershell
npm test -- src/utils/storage-utils.test.ts src/utils/destination-secrets.test.ts
npm test
git add src/types/types.ts src/utils/storage-utils.ts src/utils/storage-utils.test.ts src/utils/destination-secrets.ts src/utils/destination-secrets.test.ts src/utils/import-export.ts src/utils/__mocks__/webextension-polyfill.ts
git commit -m "feat: add private destination settings"
```

### Task 5: Add the destination settings experience

**Files:**
- Modify: `src/settings.html`
- Modify: `src/managers/general-settings.ts`
- Modify: `src/style.scss`
- Modify: `src/_locales/en/messages.json`
- Create: `src/managers/general-settings.test.ts`

- [ ] **Step 1: Write failing settings DOM tests**

Require a Destination select with four values, conditional Custom URI and Local HTTP panels, masked token input, Save/Clear token controls, and a Test connection button. Assert there are no vault, legacy mode, silent-open, or Obsidian controls.

- [ ] **Step 2: Replace the upstream destination controls**

Use these IDs so tests and code share one contract:

```html
<select id="default-destination"></select>
<input id="custom-uri-template" type="text" maxlength="2048">
<input id="local-http-endpoint" type="url" maxlength="2048">
<input id="local-http-token" type="password" autocomplete="off" maxlength="512">
<button id="save-local-http-token" type="button"></button>
<button id="clear-local-http-token" type="button"></button>
<button id="test-local-http" type="button"></button>
```

- [ ] **Step 3: Implement UI persistence and content-free connection test**

The connection test sends a `ClipDocument` with title `Open Markdown Clipper connection test`, Markdown `Connection test`, source URL `https://example.invalid/connection-test`, and the current UTC timestamp. It must never reuse the active page content.

- [ ] **Step 4: Verify accessibility and tests**

Ensure every control has a visible label, keyboard focus, descriptive error text, and a status region with `aria-live="polite"`. Run:

```powershell
npm test -- src/managers/general-settings.test.ts
npm test
```

- [ ] **Step 5: Commit the settings UI**

```powershell
git add src/settings.html src/managers/general-settings.ts src/managers/general-settings.test.ts src/style.scss src/_locales/en/messages.json
git commit -m "feat: add destination preferences UI"
```

### Task 6: Route popup, reader, and quick actions through destinations

**Files:**
- Modify: `src/core/popup.ts`
- Modify: `src/background.ts`
- Modify: `src/content.ts`
- Modify: `src/utils/reader.ts`
- Modify: `src/utils/clipboard-utils.ts`
- Delete: `src/utils/obsidian-note-creator.ts`
- Create: `src/core/popup-destinations.test.ts`
- Create: `src/utils/reader-destinations.test.ts`
- Create: `src/background-destinations.test.ts`

- [ ] **Step 1: Write failing popup dispatch tests**

Characterize one assembly of frontmatter + rendered Markdown and require the selected adapter to receive that exact immutable document. Require stats/history only after delivery succeeds. On Local HTTP failure, require the document to remain visible and Copy/Download fallbacks to stay enabled.

- [ ] **Step 2: Replace popup action branching**

Remove `handleClipObsidian()` and `saveToObsidian()`. Implement one `deliverTo(kind)` function that obtains the rendered document once, resolves the adapter, sends it, updates the bounded status, and then records the successful action.

- [ ] **Step 3: Write failing generic URI background tests**

Require message action `openCustomUri`, a previously validated custom scheme, no content/authorization fields, and rejection of HTTP(S), browser-internal, or control-character values. Assert nothing is logged.

- [ ] **Step 4: Replace the background URI path**

Delete `openObsidianUrl`; add the narrow `openCustomUri` handler. Remove the unrestricted save-specific fallback and retain only the injected generic URI open operation.

- [ ] **Step 5: Write and implement reader/quick-action tests**

Replace the inline branded reader SVG and labels with the original icon and generic actions. Route reader and content-script Copy/Download through the same adapter contracts. Quick Clip uses the configured default destination and fails without closing the source tab when delivery fails.

- [ ] **Step 6: Verify every surface and commit**

```powershell
npm test -- src/core/popup-destinations.test.ts src/utils/reader-destinations.test.ts src/background-destinations.test.ts
npm test
npm run build:chrome
npm run build:firefox
git add -A
git commit -m "feat: deliver clips through configurable destinations"
```

### Task 7: Add public CI, documentation, and release gates

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`
- Modify: `README.md`
- Modify: `docs/Clip web pages.md`
- Modify: `docs/Filters.md`
- Modify: `docs/Highlight web pages.md`
- Modify: `docs/Interpret web pages.md`
- Modify: `docs/Introduction to Obsidian Web Clipper.md` (rename to `docs/Introduction to Open Markdown Clipper.md`)
- Modify: `docs/Logic.md`
- Modify: `docs/Templates.md`
- Modify: `docs/Troubleshoot Web Clipper.md` (rename to `docs/Troubleshoot Open Markdown Clipper.md`)
- Modify: `docs/Variables.md`
- Modify: `package.json`

- [ ] **Step 1: Add complete local verification scripts**

Add:

```json
{
	"scripts": {
		"typecheck": "tsc --noEmit",
		"scan:public": "node scripts/public-release-scan.mjs",
		"verify": "npm test && npm run typecheck && npm run build:chrome && npm run build:firefox && npm run scan:public"
	}
}
```

- [ ] **Step 2: Add GitHub Actions**

On pushes and pull requests to `main`, use Node 22, `npm ci`, `npm run verify`, and `npm audit --audit-level=high`. Upload Firefox and Chromium ZIPs only after all checks pass. Do not publish stores or GitHub Releases automatically in the initial workflow.

- [ ] **Step 3: Document the four destinations and privacy behavior**

README must include Firefox/Chromium local installation, configuration examples using `127.0.0.1:8765`, exact HTTP JSON schema, bearer-header behavior, credential/export policy, no-telemetry statement, upstream attribution, contribution flow, and limitations. `SECURITY.md` must request private vulnerability reports and state that non-loopback HTTP is rejected.

- [ ] **Step 4: Run the full public-release gate**

```powershell
npm ci
npm run verify
npm audit --audit-level=high
git diff --check
git status --short
```

Expected: tests, typecheck, both builds, public scan, high-severity audit, and diff checks pass. Only intentional tracked changes appear.

- [ ] **Step 5: Run the public privacy review**

Scan tracked content and commit history for private names, local absolute paths, tokens, emails, internal endpoints, personal notes, credentials, and excluded upstream assets. Review every match manually. Do not create the public GitHub repository until the result is clean.

- [ ] **Step 6: Commit the release infrastructure**

```powershell
git add .github SECURITY.md CONTRIBUTING.md README.md docs package.json package-lock.json
git commit -m "docs: prepare public extension release"
```

- [ ] **Step 7: Create and publish the public repository**

After privacy approval:

```powershell
gh repo create murdawkmedia/open-markdown-clipper --public --source . --remote origin --description "Capture web pages as durable Markdown and deliver them to local destinations."
git push -u origin feature/initial-public-release:main
gh repo edit murdawkmedia/open-markdown-clipper --enable-issues=true --enable-wiki=false
```

Verify GitHub reports visibility `PUBLIC`, default branch `main`, and the remote commit equals local HEAD. Configure protected-main rules when supported by the account; otherwise retain pull requests as the documented contribution policy.

## Plan self-review

- Spec coverage: provenance, four adapters, Firefox/Chromium, secret isolation, fallback behavior, no Obsidian dependency, CI, privacy scan, and public publication all have tasks.
- Baseline failures are repaired before feature code.
- Types consistently use `DestinationKind`, `ClipDocument`, `DestinationResult`, and `ClipDestination`.
- The plan intentionally excludes Safari, hosted sync, RAG, chat, and consumer-specific configuration.
