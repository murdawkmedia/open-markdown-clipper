import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string): string => readFileSync(resolve(__dirname, file), 'utf8');

function webAccessibleResources(file: string): string[] {
	const manifest = JSON.parse(source(file)) as {
		web_accessible_resources?: Array<{ resources?: string[] }>;
	};
	return manifest.web_accessible_resources
		?.flatMap(entry => entry.resources ?? [])
		?? [];
}

describe('hostile-page extension UI boundary', () => {
	it('does not expose the side-panel document as a web-accessible resource', () => {
		for (const manifest of ['manifest.chrome.json', 'manifest.firefox.json']) {
			expect(webAccessibleResources(manifest)).not.toContain('side-panel.html');
		}
	});

	it('does not construct or control a privileged iframe from the content script', () => {
		const content = source('content.ts');

		expect(content).not.toContain("createElement('iframe')");
		expect(content).not.toContain('side-panel.html');
		expect(content).not.toContain('toggle-iframe');
		expect(content).not.toContain('close-iframe');
	});

	it('removes every hostile-page embedded launch path', () => {
		const background = source('background.ts');
		const popup = source('core/popup.ts');
		const reader = source('utils/reader.ts');

		expect(background).not.toContain('open-embedded');
		expect(background).not.toContain('getActiveTabAndToggleIframe');
		expect(background).not.toContain('typedRequest.action === "toggleIframe"');
		expect(background).not.toContain("currentOpenBehavior === 'embedded'");
		expect(popup).not.toContain("openBehavior === 'embedded'");
		expect(source('popup.html')).not.toContain('id="embedded-mode"');
		expect(reader).not.toContain("{ action: 'toggleIframe' }");
	});

	it('offers only popup and reader as stored open behaviors', () => {
		expect(source('types/types.ts')).toMatch(/openBehavior:\s*'popup'\s*\|\s*'reader'/);
		expect(source('settings.html')).not.toContain('<option value="embedded"');
		expect(source('background.ts')).toContain("['popup', 'reader']");
	});

	it('uses Reader-panel terminology for the extension-origin nested panel', () => {
		const sidePanel = source('side-panel.html');
		const popup = source('core/popup.ts');
		const styles = [
			source('styles/popup.scss'),
			source('styles/side-panel.scss'),
			source('styles/mobile.scss'),
		].join('\n');
		const messages = JSON.parse(source('_locales/en/messages.json')) as Record<string, unknown>;

		expect(sidePanel).toContain('id="reader-panel-close"');
		expect(popup).toContain("classList.add('is-reader-panel')");
		expect(styles).toContain('is-reader-panel');
		for (const legacy of ['embedded-mode', 'is-embedded']) {
			expect(sidePanel).not.toContain(legacy);
			expect(popup).not.toContain(legacy);
			expect(styles).not.toContain(legacy);
		}
		expect(messages).not.toHaveProperty('embedded');
		expect(messages).not.toHaveProperty('openEmbedded');
		expect(messages).toHaveProperty('closeReaderPanel');
	});

	it('preserves native Chrome side panel and extension-reader embedding', () => {
		const chromeManifest = JSON.parse(source('manifest.chrome.json')) as {
			side_panel?: { default_path?: string };
		};
		const reader = source('utils/reader.ts');
		const popup = source('core/popup.ts');
		const background = source('background.ts');

		expect(chromeManifest.side_panel?.default_path).toBe('side-panel.html');
		expect(reader).toContain('Reader.toggleReaderPageIframe(doc)');
		expect(reader).toContain("browser.runtime.getURL('side-panel.html?context=iframe&readerUrl='");
		expect(popup).toContain("action: 'toggleReaderSidePanel'");
		expect(background).toContain('isTrustedReaderSidePanelSender');
		expect(background).toContain('const readerPageUrl = sender.tab?.url');
		expect(background).toContain('const articleUrl = isReaderPageUrl(readerPageUrl)');
		expect(background).toContain('encodeURIComponent(articleUrl)');
		expect(background).toContain("typedRequest.action === 'toggleReaderSidePanel'");
	});

	it('routes reader launches to reader.html and keeps injected reader DOM non-delivering', () => {
		const background = source('background.ts');
		const reader = source('utils/reader.ts');
		const settingsBarStart = reader.indexOf('private static injectSettingsBar');
		const settingsBarEnd = reader.indexOf('private static createSettingsGroup', settingsBarStart);
		const settingsBar = reader.slice(settingsBarStart, settingsBarEnd);
		const readerPageGate = settingsBar.indexOf('if (!this.isReaderPage) return');
		const destinationRuntime = settingsBar.indexOf('createDocumentDestinationRuntime');

		expect(background).toContain('toggleReaderPageForTab');
		expect(background).not.toContain('injectReaderScript');
		expect(background).not.toContain("files: ['reader-script.js']");
		expect(background).not.toMatch(/tabs\.sendMessage\([^)]*,\s*\{ action: ["']toggleReaderMode["']/);
		expect(readerPageGate).toBeGreaterThanOrEqual(0);
		expect(destinationRuntime).toBeGreaterThan(readerPageGate);
		for (const manifest of ['manifest.chrome.json', 'manifest.firefox.json']) {
			expect(webAccessibleResources(manifest)).not.toContain('reader-script.js');
		}
		const webpack = source('../webpack.config.js');
		expect(webpack).not.toContain("'reader-script':");
		expect(webpack).toMatch(/output:\s*\{[\s\S]*?clean:\s*true/);
		expect(existsSync(resolve(__dirname, 'reader-script.ts'))).toBe(false);
		expect(source('content.ts')).not.toContain('reader-script.js (a separate');
		expect(reader).not.toContain('On a live page with reader mode');
	});

	it('removes legacy page-mediated clipboard relays', () => {
		expect(source('background.ts')).not.toContain("typedRequest.action === 'copy-to-clipboard'");
		expect(source('content.ts')).not.toContain('request.action === "copy-text-to-clipboard"');
	});
});
