import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (file: string): string => readFileSync(resolve(__dirname, file), 'utf8');

function commandBlock(backgroundSource: string): string {
	const start = backgroundSource.indexOf('browser.commands.onCommand.addListener');
	const end = backgroundSource.indexOf('const debouncedUpdateContextMenu', start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return backgroundSource.slice(start, end);
}

describe('production background Quick Clip wiring', () => {
	it('uses the background popup owner with raw action APIs and a fresh random UUID', () => {
		const background = src('background.ts');
		const controller = src('utils/background-quick-clip.ts');

		expect(background).toContain("from './utils/background-quick-clip'");
		expect(background).toMatch(/setPopup:\s*\(details\)\s*=>\s*browser\.action\.setPopup\(details\)/);
		expect(background).toMatch(/openPopup:\s*\(details\)\s*=>\s*browser\.action\.openPopup\(details\)/);
		expect(background).toMatch(/createNonce:\s*\(\)\s*=>\s*(?:globalThis\.)?crypto\.randomUUID\(\)/);
		expect(background).toMatch(/sendMessage:\s*\(message\)\s*=>\s*browser\.runtime\.sendMessage\(message\)/);
		expect(controller).toContain("import { runQuickClipCommand } from './quick-clip-command'");
		expect(controller).toMatch(/runQuickClipCommand\s*\(/);
	});

	it('replaces the timer broadcast path and accepts tab id zero', () => {
		const block = commandBlock(src('background.ts'));

		expect(block).toContain("command === 'quick_clip'");
		expect(block).toMatch(/quickClipController\.run\(tab\.id,\s*tab\.windowId\)/);
		expect(block).toMatch(/Number\.isSafeInteger\(tab\.id\)/);
		expect(block).toContain('tab.id >= 0');
		expect(block).toMatch(/Number\.isSafeInteger\(tab\.windowId\)/);
		expect(block).toContain('tab.windowId >= 0');
		expect(block).not.toContain('setTimeout');
		expect(block).not.toContain('triggerQuickClip');
		expect(block).not.toMatch(/\bopenPopup\s*\(/);
		expect(block).not.toContain('copy_to_clipboard');
		expect(block).not.toContain('tabs.remove');
		expect(block).not.toContain('tabs.update');
	});

	it('routes every normal popup mutation through the controller', () => {
		const background = src('background.ts');
		const controller = src('utils/background-quick-clip.ts');
		const directWrites = background.match(/browser\.action\.setPopup/g) ?? [];

		expect(directWrites).toHaveLength(1);
		expect(background).toMatch(/quickClipController\.setNormalPopup\(/);
		expect(background).toMatch(/tabs\.onRemoved\.addListener\(\(tabId\)[\s\S]*quickClipController\.releaseTab\(tabId\)/);
		expect(background).not.toMatch(/tabs\.onUpdated\.addListener\(\(tabId,\s*changeInfo\)[\s\S]*quickClipController\.releaseTab\(tabId\)/);
		expect(background).toMatch(/browser\.tabs\.query\(\{\}\)[\s\S]*quickClipController\.trackTabs\(/);
		expect(controller).not.toMatch(/popup:\s*null/);
		expect(controller).not.toMatch(/while\s*\(popupCurrent/);
		expect(controller).toMatch(/restorationPasses\s*<\s*MAX_BACKGROUND_POPUP_RESTORE_WRITES/);
	});

	it('revision-gates the asynchronous startup setting read against newer storage changes', () => {
		const background = src('background.ts');
		const updateStart = background.indexOf('async function updateActionPopup');
		const updateEnd = background.indexOf('let currentOpenBehavior', updateStart);
		const updateBlock = background.slice(updateStart, updateEnd);

		expect(background).toMatch(/let actionPopupUpdateRevision\s*=\s*0/);
		expect(updateBlock).toMatch(/const revision\s*=\s*\+\+actionPopupUpdateRevision/);
		expect(updateBlock).toMatch(/await browser\.storage\.sync\.get\('general_settings'\)[\s\S]*revision\s*!==\s*actionPopupUpdateRevision[\s\S]*return/);
		expect(updateBlock.match(/revision\s*!==\s*actionPopupUpdateRevision/g)).toHaveLength(2);
	});

	it('removes the active legacy URI handler and uses the neutral context label', () => {
		const background = src('background.ts');
		const legacyOpenAction = ['open', 'Ob', 'sidian', 'Url'].join('');

		expect(background).not.toContain(legacyOpenAction);
		expect(background).toContain('title: "Open Markdown Clipper"');
	});

	it('declares the same Quick Clip command in Firefox and Chromium', () => {
		const firefox = JSON.parse(src('manifest.firefox.json')) as {
			commands: Record<string, unknown>;
		};
		const chrome = JSON.parse(src('manifest.chrome.json')) as {
			commands: Record<string, unknown>;
		};

		expect(firefox.commands.quick_clip).toEqual(chrome.commands.quick_clip);
		expect(firefox.commands.quick_clip).toEqual({
			suggested_key: {
				default: 'Alt+Shift+O',
				mac: 'Alt+Shift+O',
			},
			description: '__MSG_commandQuickClip__',
		});
		expect(firefox.commands._execute_action).toEqual(chrome.commands._execute_action);
		expect(firefox.commands._execute_action).toEqual({
			suggested_key: {
				default: 'Alt+Shift+M',
				mac: 'Alt+Shift+M',
			},
			description: '__MSG_commandOpenClipper__',
		});
	});

	it('declares the Chromium version where action.openPopup is generally available', () => {
		const chrome = JSON.parse(src('manifest.chrome.json')) as {
			minimum_chrome_version?: string;
		};

		expect(chrome.minimum_chrome_version).toBe('127');
	});

	it('requires the Firefox version where openPopup survives awaited setup', () => {
		const firefox = JSON.parse(src('manifest.firefox.json')) as {
			browser_specific_settings?: {
				gecko?: { strict_min_version?: string };
				gecko_android?: { strict_min_version?: string };
			};
		};

		expect(firefox.browser_specific_settings?.gecko?.strict_min_version).toBe('149.0');
		expect(firefox.browser_specific_settings?.gecko_android?.strict_min_version).toBe('149.0');
		expect(src('../README.md')).toContain('Firefox 149 or newer');
	});

	it('exposes the live reader icon asset in both browser manifests', () => {
		for (const manifest of ['manifest.chrome.json', 'manifest.firefox.json']) {
			const parsed = JSON.parse(src(manifest)) as {
				web_accessible_resources: Array<{ resources: string[] }>;
			};
			const exposed = parsed.web_accessible_resources
				.flatMap(({ resources }) => resources);

			expect(exposed, manifest).toContain('icons/icon16.png');
		}
	});
});
