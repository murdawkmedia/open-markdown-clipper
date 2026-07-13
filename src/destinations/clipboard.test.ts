import { describe, expect, it, vi } from 'vitest';
import { createClipboardDestination } from './clipboard';
import { ClipDocument, DestinationError } from './types';

const DOCUMENT: ClipDocument = Object.freeze({
	title: 'Private page',
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

describe('clipboard destination', () => {
	it('reports delivery only after the clipboard effect succeeds', async () => {
		const copy = vi.fn(async () => true);
		const destination = createClipboardDestination(copy);

		await expect(destination.send(DOCUMENT)).resolves.toEqual({
			destination: 'clipboard',
		});
		expect(copy).toHaveBeenCalledOnce();
		expect(copy).toHaveBeenCalledWith(DOCUMENT.markdown);
	});

	it('turns a false clipboard result into a content-free destination error', async () => {
		const destination = createClipboardDestination(vi.fn(async () => false));
		await expectCode(() => destination.send(DOCUMENT), 'clipboard-failed');
	});

	it('turns a rejecting clipboard effect into a content-free destination error', async () => {
		const destination = createClipboardDestination(
			vi.fn(async () => { throw new Error(DOCUMENT.markdown); }),
		);
		await expectCode(() => destination.send(DOCUMENT), 'clipboard-failed');
	});

	it('does not invoke the effect when the caller has already aborted', async () => {
		const copy = vi.fn(async () => true);
		const controller = new AbortController();
		controller.abort();

		await expectCode(
			() => createClipboardDestination(copy).send(DOCUMENT, controller.signal),
			'delivery-aborted',
		);
		expect(copy).not.toHaveBeenCalled();
	});

	it('threads cancellation into an active effect and does not report late success', async () => {
		let resolveCopy!: (copied: boolean) => void;
		const copying = new Promise<boolean>((resolve) => {
			resolveCopy = resolve;
		});
		const copy = vi.fn((_markdown: string, _signal?: AbortSignal) => copying);
		const controller = new AbortController();
		const delivery = createClipboardDestination(copy).send(DOCUMENT, controller.signal);
		await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());

		controller.abort();
		resolveCopy(true);

		await expectCode(() => delivery, 'delivery-aborted');
		expect(copy).toHaveBeenCalledWith(DOCUMENT.markdown, controller.signal);
	});
});
