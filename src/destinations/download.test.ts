import { describe, expect, it, vi } from 'vitest';
import { createDownloadDestination } from './download';
import { ClipDocument, DestinationError } from './types';
import { SaveFileOptions } from '../utils/file-utils';

const DOCUMENT: ClipDocument = Object.freeze({
	title: 'Private: page / notes',
	markdown: '# private markdown',
	sourceUrl: 'https://example.com/private',
	capturedAt: '2026-07-12T18:00:00.000Z',
});

async function expectCode(run: () => Promise<unknown>, code: string) {
	try {
		await run();
		throw new Error('expected destination to reject');
	} catch (error) {
		expect(error).toBeInstanceOf(DestinationError);
		expect((error as DestinationError).code).toBe(code);
		expect((error as Error).message).toBe(code);
		expect((error as Error).message).not.toContain(DOCUMENT.markdown);
		expect((error as Error).message).not.toContain(DOCUMENT.sourceUrl);
	}
}

describe('download destination', () => {
	it('reports delivery only after the save effect succeeds', async () => {
		const save = vi.fn(async (_options: SaveFileOptions) => undefined);
		const destination = createDownloadDestination(save);

		await expect(destination.send(DOCUMENT)).resolves.toEqual({
			destination: 'download',
			receipt: 'Private- page - notes.md',
		});
		expect(save).toHaveBeenCalledOnce();
		expect(save).toHaveBeenCalledWith({
			content: DOCUMENT.markdown,
			fileName: 'Private- page - notes.md',
			mimeType: 'text/markdown',
		});
	});

	it('uses a safe bounded fallback filename', async () => {
		const save = vi.fn(async (_options: SaveFileOptions) => undefined);
		const document = { ...DOCUMENT, title: `${'.'.repeat(20)}${'x'.repeat(400)}` };

		const result = await createDownloadDestination(save).send(document);
		expect(result.receipt).toMatch(/^x{1,240}\.md$/);
		expect(result.receipt!.length).toBeLessThanOrEqual(243);
	});

	it('bounds multibyte filenames in both UTF-8 bytes and UTF-16 units', async () => {
		const save = vi.fn(async (_options: SaveFileOptions) => undefined);
		const document = { ...DOCUMENT, title: '🔐'.repeat(400) };

		const result = await createDownloadDestination(save).send(document);
		const fileName = result.receipt!;
		expect(new TextEncoder().encode(fileName).byteLength).toBeLessThanOrEqual(243);
		expect(fileName.length).toBeLessThanOrEqual(243);
		expect(fileName).toMatch(/\.md$/);
		expect(fileName).not.toContain('�');
	});

	it('turns a rejecting save effect into a content-free destination error', async () => {
		const destination = createDownloadDestination(
			vi.fn(async () => { throw new Error(DOCUMENT.markdown); }),
		);
		await expectCode(() => destination.send(DOCUMENT), 'download-failed');
	});

	it('does not invoke the effect when the caller has already aborted', async () => {
		const save = vi.fn(async (_options: SaveFileOptions) => undefined);
		const controller = new AbortController();
		controller.abort();

		await expectCode(
			() => createDownloadDestination(save).send(DOCUMENT, controller.signal),
			'delivery-aborted',
		);
		expect(save).not.toHaveBeenCalled();
	});
});
