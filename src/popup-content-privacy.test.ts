import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('popup content privacy', () => {
	it('does not write extracted page or template data to the extension console', () => {
		const source = readFileSync(resolve(__dirname, 'core/popup.ts'), 'utf8');

		expect(source).not.toMatch(/console\.(?:log|debug|info)\s*\(/);
	});

	it('primes one browser consent controller before wiring destination actions', () => {
		const source = readFileSync(resolve(__dirname, 'core/popup.ts'), 'utf8');

		expect(source).toMatch(/const popupDataConsentController = createDataConsentController\(/);
		expect(source).toMatch(/const popupDataConsentPrime = popupDataConsentController\.prime\(\)/);
		expect(source).toMatch(/await popupDataConsentPrime;[\s\S]*createPopupDestinationDelivery\(\{[\s\S]*dataConsent:\s*popupDataConsentController/);
	});

	it('does not retain bundled provider icon masks', () => {
		const source = readFileSync(resolve(__dirname, 'styles/icons.scss'), 'utf8');

		expect(source).not.toContain('mask-image');
		expect(source).not.toMatch(/span\[?\.?class|span\.icon-/);
	});

	it('does not log imported templates, schema values, or property defaults', () => {
		for (const relativePath of [
			'utils/import-export.ts',
			'managers/property-types-manager.ts',
			'utils/variables/schema.ts',
		]) {
			const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
			expect(source, relativePath).not.toMatch(/console\.(?:log|debug|info|warn|error)\s*\(/);
		}
	});

	it('does not pass page, DOM, or template values to production diagnostics', () => {
		const forbiddenNeedles: Record<string, string[]> = {
			'content.ts': [
				'URL:`, value);',
				"'Could not find element to highlight. Info:', request.targetElementInfo",
			],
			'core/highlights.ts': ["'Failed to fetch page:', url, error"],
			'utils/highlighter.ts': ["'Error creating text highlight for block:', blockElement, e", "'Highlights cleared for:', url"],
			'utils/string-utils.ts': ['${attributeValue}', "'Invalid URL:', url"],
			'utils/filters/calc.ts': ["'Input is not a number:', str", "'Invalid calculation value:', operation"],
			'utils/filters/date.ts': ["'Invalid date for date filter:', str"],
			'utils/filters/date_modify.ts': ["'Invalid date for date_modify filter:', str", "'Invalid format for date_modify filter:', param"],
			'utils/triggers.ts': ["'Schema match found:', template"],
			'managers/template-manager.ts': ["'Templates reloaded:', templates"],
		};

		for (const [relativePath, needles] of Object.entries(forbiddenNeedles)) {
			const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
			for (const needle of needles) expect(source, relativePath).not.toContain(needle);
		}
	});

	it('never relays clipboard payloads through a web page or active tab', () => {
		const clipboardSource = readFileSync(resolve(__dirname, 'utils/clipboard-utils.ts'), 'utf8');
		const backgroundSource = readFileSync(resolve(__dirname, 'background.ts'), 'utf8');
		const contentSource = readFileSync(resolve(__dirname, 'content.ts'), 'utf8');
		const documentRuntimeSource = readFileSync(
			resolve(__dirname, 'utils/document-destination-runtime.ts'),
			'utf8',
		);

		expect(clipboardSource).not.toContain('browser.runtime.sendMessage');
		expect(backgroundSource).not.toContain("typedRequest.action === 'copy-to-clipboard'");
		expect(contentSource).not.toContain('request.action === "copy-text-to-clipboard"');
		expect(documentRuntimeSource).not.toContain('parent.appendChild(textArea)');
	});
});
