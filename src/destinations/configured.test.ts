import { describe, expect, it, vi } from 'vitest';
import { createConfiguredDestinationRegistry } from './configured';
import { ClipDocument } from './types';

const DOCUMENT: ClipDocument = Object.freeze({
	title: 'Captured page',
	markdown: '# Captured page',
	sourceUrl: 'https://example.com/article',
	capturedAt: '2026-07-12T18:00:00.000Z',
});
const ORIGINAL_TOKEN = ['original', 'fixture', 'token'].join('-');

describe('configured destination registry', () => {
	it('snapshots configuration and effects while wiring all four destinations', async () => {
		const preferences = {
			customUriTemplate: 'notes:clip?title={title}',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
		};
		let token = ORIGINAL_TOKEN;
		const copy = vi.fn(async () => true);
		const save = vi.fn(async () => undefined);
		const openUri = vi.fn(async () => undefined);
		const fetchImpl = vi.fn(async () => ({
			body: null,
			ok: true,
			redirected: false,
			status: 201,
			type: 'basic',
		} as Response)) as unknown as typeof fetch;
		const effects = { copy, save, openUri, fetchImpl };
		const registry = createConfiguredDestinationRegistry(preferences, token, effects);

		preferences.customUriTemplate = 'mutated:template';
		preferences.localHttpEndpoint = 'http://127.0.0.1:9999/mutated';
		token = 'mutated-token';
		const mutatedCopy = vi.fn(async () => false);
		const mutatedSave = vi.fn(async () => { throw new Error('mutated'); });
		const mutatedOpenUri = vi.fn(async () => { throw new Error('mutated'); });
		const mutatedFetch = vi.fn(async () => { throw new Error('mutated'); }) as unknown as typeof fetch;
		effects.copy = mutatedCopy;
		effects.save = mutatedSave;
		effects.openUri = mutatedOpenUri;
		effects.fetchImpl = mutatedFetch;

		await expect(registry.resolve('clipboard').send(DOCUMENT)).resolves.toEqual({
			destination: 'clipboard',
		});
		await expect(registry.resolve('download').send(DOCUMENT)).resolves.toEqual({
			destination: 'download',
			receipt: 'Captured page.md',
		});
		await expect(registry.resolve('custom-uri').send(DOCUMENT)).resolves.toEqual({
			destination: 'custom-uri',
		});
		await expect(registry.resolve('local-http').send(DOCUMENT)).resolves.toEqual({
			destination: 'local-http',
			receipt: 'HTTP 201',
		});

		expect(copy).toHaveBeenCalledTimes(2);
		expect(copy).toHaveBeenNthCalledWith(1, DOCUMENT.markdown);
		expect(copy).toHaveBeenNthCalledWith(2, DOCUMENT.markdown);
		expect(save).toHaveBeenCalledWith({
			content: DOCUMENT.markdown,
			fileName: 'Captured page.md',
			mimeType: 'text/markdown',
		});
		expect(openUri).toHaveBeenCalledWith('notes:clip?title=Captured%20page');
		expect(fetchImpl).toHaveBeenCalledWith(
			'http://127.0.0.1:8765/captures',
			expect.objectContaining({
				headers: {
					'Authorization': `Bearer ${ORIGINAL_TOKEN}`,
					'Content-Type': 'application/json',
				},
			}),
		);
		expect(mutatedCopy).not.toHaveBeenCalled();
		expect(mutatedSave).not.toHaveBeenCalled();
		expect(mutatedOpenUri).not.toHaveBeenCalled();
		expect(mutatedFetch).not.toHaveBeenCalled();
	});
});
