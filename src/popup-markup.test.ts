// @vitest-environment jsdom

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function loadDocument(fileName: string): Document {
	const parser = new DOMParser();
	return parser.parseFromString(
		readFileSync(join(process.cwd(), 'src', fileName), 'utf8'),
		'text/html',
	);
}

describe.each(['popup.html', 'side-panel.html'])('%s destination markup', fileName => {
	it('has a polite nonblocking delivery status and no legacy vault or path controls', () => {
		const popup = loadDocument(fileName);
		const status = popup.getElementById('delivery-status');
		expect(status?.getAttribute('role')).toBe('status');
		expect(status?.getAttribute('aria-live')).toBe('polite');
		expect(status?.closest('.clipper')).not.toBeNull();
		for (const id of ['clip-btn', 'more-btn']) {
			const button = popup.getElementById(id) as HTMLButtonElement | null;
			expect(button).not.toBeNull();
			expect(button!.disabled).toBe(true);
		}
		for (const selector of [
			'#vault-container',
			'#vault-select',
			'#path-name-field',
			'.vault-path-container',
		]) {
			expect(popup.querySelector(selector)).toBeNull();
		}
		expect(popup.body.textContent).not.toMatch(
			new RegExp(['Ob', 'sidian'].join(''), 'i'),
		);
	});

	it('does not expose the retired model-processing controls', () => {
		const popup = loadDocument(fileName);
		for (const id of [
			['inter', 'preter'].join(''),
			['prompt', 'context'].join('-'),
			['model', 'select'].join('-'),
			['interpret', 'btn'].join('-'),
		]) {
			expect(popup.getElementById(id)).toBeNull();
		}
	});
});

describe('settings markup release boundary', () => {
	it('does not expose retired model, provider, credential, or prompt-context controls', () => {
		const settings = loadDocument('settings.html');
		for (const id of [
			['inter', 'preter-section'].join(''),
			['inter', 'preter-toggle'].join(''),
			['default', 'prompt', 'context'].join('-'),
			['prompt', 'context'].join('-'),
			['model', 'modal'].join('-'),
			['provider', 'modal'].join('-'),
			['provider', 'api', 'key'].join('-'),
		]) {
			expect(settings.getElementById(id)).toBeNull();
		}
	});
});
