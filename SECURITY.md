# Security policy

Open Markdown Clipper is a local-first browser extension in pre-release
development. Security fixes are supported on the latest `main` revision until
the first tagged release establishes a longer support window.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/murdawkmedia/open-markdown-clipper/security/advisories/new>

If private reporting is unavailable, open a minimal public issue asking the
maintainers to establish a private contact channel. Do not include an exploit,
credential, captured page content, local path, browser profile detail, or other
sensitive material in a public issue.

Include the affected revision and browser, the smallest safe reproduction, the
security impact, and whether the issue requires a particular destination or
setting. Replace real content and secrets with synthetic canaries.

## Security boundaries

- The extension has no telemetry or hosted account.
- Copy and Download act only when the user invokes them. Clipboard content and
  downloaded files then follow the operating system's own retention and access
  rules.
- Custom URI copies Markdown to the clipboard and sends only the configured,
  encoded metadata fields to an external protocol handler. The receiving
  application is outside the extension's trust boundary. The template is
  synchronized and exported; never embed credentials or secrets in it.
- Local HTTP accepts only a literal
  `http://127.0.0.1:<explicit-port>/<non-root-path>` endpoint without a query
  string or fragment. The endpoint preference is synchronized and exported, so
  never embed credentials or secrets in it. Redirects are
  rejected, cookies and browser credentials are omitted, and responses are not
  cached.
- The Local HTTP bearer authenticates the extension to the receiver; it does
  not authenticate the receiver to the extension. Any local process that owns
  the configured port can receive the probe token and captured Markdown. Use
  this destination only on a trusted machine with a receiver you control.
- A valid bearer authenticates the sender, not the captured page. Receiver
  implementations must treat title, Markdown, source URL, timestamp, and
  frontmatter as attacker-controlled data: validate schema and size, sanitize
  rendered output, and never execute or interpolate captures into commands.
- The Local HTTP token is kept in browser local extension storage. It is not
  synchronized, exported with settings, or intentionally logged. Browser local
  storage is not a hardware-backed secret store; software running with access
  to the browser profile may still be able to read it.
- Network destinations receive the current page title, rendered Markdown,
  source URL, and capture timestamp only after explicit configuration and
  delivery. Treat captures as potentially sensitive.
- Privileged delivery controls are never embedded in an arbitrary web page.
  They run in the browser popup, Chrome's native side panel, or the
  extension-origin Reader page so page scripts cannot frame or restyle a send
  control.
- Reader custom CSS is trusted active configuration: CSS can request remote
  resources and restyle or overlay Reader controls. Use only CSS you wrote or
  reviewed, and import full settings files only from a trusted source.
- Firefox treats Custom URI and Local HTTP as optional data-collection
  capabilities. Custom URI requests browsing activity, website content, and
  website activity; Local HTTP requests those categories plus authentication
  information for its bearer token. The extension requests grants from a popup
  or Settings user gesture, then checks the current grant again before capture
  and delivery. Copy and Download do not require these grants. Reader controls
  and Quick Clip never prompt; they fail closed until the grant already exists.
  Chromium builds feature-detect this Firefox-only capability.
- Once a Local HTTP POST has been dispatched, a timeout, abort, or connection
  failure cannot prove that the receiver did not save the document. The
  extension reports this as an unknown outcome without page or response
  content. Check the receiver before retrying to avoid a duplicate.
- The v0.1 release does not include an in-browser model provider or transmit
  page content to an AI service.

These controls reduce accidental disclosure and web-origin abuse. They do not
claim to defend a compromised browser, operating system, extension profile, or
privileged local process.

## Credentials and diagnostics

Never paste a real token, API key, private page, personal path, or browser
profile into an issue, test, build log, screenshot, or sample configuration.
Use generated placeholder values. Rotate a credential if it may have been
exposed.

Release checks scan the intended repository tree for credential-like literals,
private paths and endpoints, active legacy transports, and private product
names. A clean scan is a release gate, not a substitute for review.
