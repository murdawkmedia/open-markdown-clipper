---
permalink: web-clipper/troubleshoot
---
If you encounter issues with [[Introduction to Open Markdown Clipper|Web Clipper]], report them in the [public GitHub repository](https://github.com/murdawkmedia/open-markdown-clipper/issues).

## General

### Some content is missing

By default, Web Clipper tries to intelligently capture content from the page. However it may not be successful in doing so across all websites.

Web Clipper uses [Defuddle](https://github.com/kepano/defuddle) to capture only the main content of the page. This excludes header, footer, and other elements, but sometimes it can be overly conservative and remove content that you want to keep. You can [report bugs](https://github.com/kepano/defuddle) to Defuddle.

To bypass Defuddle in Web Clipper use the following methods:

- Select text, or use `Cmd/Ctrl+A` to select all text.
- [[Highlight web pages|Highlight content]] to choose exactly what you want to capture.
- Use a [[Templates|custom template]] for the site.

### A capture is empty or delivery fails

- Confirm that the Markdown preview contains the expected content before delivery.
- Try selecting the relevant text or using a site-specific template.
- Try **Copy to clipboard** or **Save file** (download) so the rendered Markdown is not lost.
- Check the browser extension's developer console for an error code. Before sharing a report, remove captured content, page URLs, credentials, and other private data from the logs.

## Linux

#### Clipboard delivery fails

Your browser or Wayland configuration may prevent the extension from writing to the clipboard. For example, in Hyprland:

```ini
# hyprland.conf
misc {
    focus_on_activate = true
}
```

- If the clipboard remains unavailable, use **Save file** and move the downloaded `.md` file to your preferred notes folder.
