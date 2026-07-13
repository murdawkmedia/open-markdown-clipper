---
permalink: web-clipper/capture
aliases:
  - Open Markdown Clipper/Capture web pages
---
Once you install the [[Introduction to Open Markdown Clipper|Web Clipper]] browser extension, you can access it in several ways, depending on your browser:

1. The Open Markdown Clipper icon in your browser toolbar.
2. Hotkeys, to activate the extension from your keyboard.
3. Context menu, by right-clicking the web page you are visiting.

Use the primary action in the extension footer to deliver the rendered Markdown by Copy, Download, Custom URI, or Local HTTP.

## Capture a page

When you open the extension, Web Clipper extracts data from the current web page following the settings in your [[Templates|template]]. You can create your own templates, and customize the output using [[variables]] and [[filters]].

By default Web Clipper attempts to intelligently extract only the main article content, excluding other elements on the page. However, you can override this behavior in the following ways:

- If a custom template is present it uses your template.
- If a selection is present, it uses the selection. You can use `Ctrl/Cmd+A` to select the entire page.
- If any [[Highlight web pages|highlights]] are present, it uses the highlights.

## Download images

Images are not automatically downloaded when you use Web Clipper. Instead, captured Markdown links to each image's web URL. This keeps captures small, but the images will not be available offline and may disappear if the source URL changes.

## Hotkeys

Web Clipper includes keyboard shortcuts you can use to speed up your workflow. To change key mappings, go to **Web Clipper Settings** → **General** and follow the instructions for Firefox or your Chromium browser.

| Action                  | macOS         | Windows/Linux  |
| ----------------------- | ------------- | -------------- |
| Open clipper            | `Opt+Shift+M` | `Alt+Shift+M`  |
| Quick clip              | `Opt+Shift+O` | `Alt+Shift+O`  |
| Toggle highlighter mode | `Opt+Shift+H` | `Alt+Shift+H`  |

## Interface functionality

The Web Clipper interface is divided into four sections:

1. **Header** where you can switch templates, turn on [[Highlight web pages|highlighting]], and access settings.
2. **Properties** shows the metadata extracted from the page and rendered as Markdown frontmatter.
3. **Note content** previews the Markdown body.
4. **Footer** contains delivery controls for the rendered capture.

Header functionality includes:

- **Template** dropdown to switch between your saved [[Templates|templates]] added in Web Clipper settings.
- **More (...)** button to display page variables you can use in templates.
- **Highlighter** button to turn on [[Highlight web pages|highlighting]].
- **Cog** button to open Web Clipper settings.

Footer functionality includes the current primary delivery action, a menu for the other configured destinations, and Share when supported by the browser.

