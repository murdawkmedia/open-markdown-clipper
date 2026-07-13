import { describe, expect, it, vi } from 'vitest';
import { deliverToDestination } from './destination-delivery';
import { DestinationRegistry } from '../destinations/registry';
import {
	ClipDestination,
	DestinationError,
	DestinationResult,
} from '../destinations/types';

const MARKDOWN = [
	'---',
	'title: "Exact title"',
	'tags:',
	'  - "one"',
	'---',
	'',
	'# Exact title',
	'',
	'Body with **formatting**.',
	'',
].join('\n');

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('popup destination delivery', () => {
	it('builds once and sends one frozen document before recording success', async () => {
		const events: string[] = [];
		const capturedAt = new Date('2026-07-12T18:00:00.000Z');
		const now = vi.fn(() => {
			events.push('now');
			return capturedAt;
		});
		const result: DestinationResult = {
			destination: 'download',
			receipt: 'Exact title.md',
		};
		const send = vi.fn(async (document) => {
			events.push('send');
			expect(Object.isFrozen(document)).toBe(true);
			expect(document).toEqual({
				title: 'Exact title',
				markdown: MARKDOWN,
				sourceUrl: 'https://example.com/exact',
				capturedAt: capturedAt.toISOString(),
			});
			return result;
		});
		const destination: ClipDestination = { kind: 'download', send };
		const registry: DestinationRegistry = {
			resolve: vi.fn(() => destination),
		};
		const recordSuccess = vi.fn(async (delivered: DestinationResult) => {
			events.push('record');
			expect(delivered).toBe(result);
		});

		await expect(deliverToDestination(
			'download',
			'Exact title',
			MARKDOWN,
			'https://example.com/exact',
			now,
			registry,
			recordSuccess,
		)).resolves.toBe(result);

		expect(now).toHaveBeenCalledOnce();
		expect(registry.resolve).toHaveBeenCalledOnce();
		expect(registry.resolve).toHaveBeenCalledWith('download');
		expect(send).toHaveBeenCalledOnce();
		expect(recordSuccess).toHaveBeenCalledOnce();
		expect(events).toEqual(['now', 'send', 'record']);
	});

	it('passes cancellation to the adapter and never records a result completed after abort', async () => {
		const pending = deferred<DestinationResult>();
		const result: DestinationResult = { destination: 'download' };
		const send = vi.fn((_document, _signal?: AbortSignal) => pending.promise);
		const registry: DestinationRegistry = {
			resolve: vi.fn(() => ({ kind: 'download' as const, send })),
		};
		const recordSuccess = vi.fn();
		const abortController = new AbortController();

		const delivery = deliverToDestination(
			'download',
			'Private title',
			'Private body',
			'https://example.com/private',
			() => new Date('2026-07-12T18:00:00.000Z'),
			registry,
			recordSuccess,
			abortController.signal,
		);
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		abortController.abort();
		pending.resolve(result);

		await expect(delivery).rejects.toMatchObject({
			name: 'DestinationError',
			code: 'destination-delivery-failed',
			message: 'destination-delivery-failed',
		});
		expect(send.mock.calls[0][1]).toBe(abortController.signal);
		expect(recordSuccess).not.toHaveBeenCalled();
	});

	it('does not let best-effort recording consume Quick Clip deadline ownership', async () => {
		const pendingRecord = deferred<void>();
		const result: DestinationResult = { destination: 'clipboard' };
		const registry: DestinationRegistry = {
			resolve: vi.fn(() => ({
				kind: 'clipboard' as const,
				send: vi.fn(async () => result),
			})),
		};
		const recordSuccess = vi.fn(() => pendingRecord.promise);
		const abortController = new AbortController();
		let settled: DestinationResult | undefined;

		const delivery = deliverToDestination(
			'clipboard',
			'Exact title',
			MARKDOWN,
			'https://example.com/exact',
			() => new Date('2026-07-12T18:00:00.000Z'),
			registry,
			recordSuccess,
			abortController.signal,
		).then((value) => {
			settled = value;
			return value;
		});

		try {
			await Promise.resolve();
			await Promise.resolve();
			expect(recordSuccess).toHaveBeenCalledOnce();
			expect(settled).toBe(result);
		} finally {
			pendingRecord.resolve();
		}
		await expect(delivery).resolves.toBe(result);
	});

	it('sanitizes adapter failures and never records them as successful', async () => {
		const title = 'Private title 74f1';
		const markdown = '---\nsecret: private-markdown-82aa\n---\nPrivate body';
		const sourceUrl = 'https://example.com/private-url-19c3';
		const adapterError = 'arbitrary-adapter-error-55dd';
		const send = vi.fn(async () => {
			throw new Error(`${adapterError}: ${title} ${markdown} ${sourceUrl}`);
		});
		const recordSuccess = vi.fn();
		const registry: DestinationRegistry = {
			resolve: vi.fn(() => ({ kind: 'clipboard' as const, send })),
		};

		try {
			await deliverToDestination(
				'clipboard',
				title,
				markdown,
				sourceUrl,
				() => new Date('2026-07-12T18:00:00.000Z'),
				registry,
				recordSuccess,
			);
			throw new Error('expected delivery to reject');
		} catch (error) {
			expect(error).toBeInstanceOf(DestinationError);
			expect((error as DestinationError).code).toBe('destination-delivery-failed');
			expect((error as Error).message).toBe('destination-delivery-failed');
			for (const privateValue of [title, markdown, sourceUrl, adapterError]) {
				expect((error as DestinationError).code).not.toContain(privateValue);
				expect((error as Error).message).not.toContain(privateValue);
			}
		}

		expect(send).toHaveBeenCalledOnce();
		expect(recordSuccess).not.toHaveBeenCalled();
	});

	it('preserves only the bounded Local HTTP outcome-unknown signal', async () => {
		const title = 'Private outcome title 8f61';
		const markdown = '# Private outcome markdown 4a72';
		const sourceUrl = 'https://example.com/private-outcome-3c59';
		const hiddenAdapterDetail = `${title} ${markdown} ${sourceUrl}`;
		const adapterError = new DestinationError('local-http-outcome-unknown') as (
			DestinationError & { hiddenAdapterDetail?: string }
		);
		adapterError.hiddenAdapterDetail = hiddenAdapterDetail;
		const send = vi.fn(async () => { throw adapterError; });
		const recordSuccess = vi.fn();
		const registry: DestinationRegistry = {
			resolve: vi.fn(() => ({ kind: 'local-http' as const, send })),
		};
		const consoleSpies = (
			['debug', 'error', 'info', 'log', 'warn'] as const
		).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));

		try {
			await deliverToDestination(
				'local-http',
				title,
				markdown,
				sourceUrl,
				() => new Date('2026-07-12T18:00:00.000Z'),
				registry,
				recordSuccess,
			);
			throw new Error('expected delivery to reject');
		} catch (error) {
			expect(error).toBeInstanceOf(DestinationError);
			expect(error).not.toBe(adapterError);
			expect((error as DestinationError).code).toBe('local-http-outcome-unknown');
			expect((error as Error).message).toBe('local-http-outcome-unknown');
			expect(String(error)).toBe('DestinationError: local-http-outcome-unknown');
			for (const representation of [
				(error as DestinationError).code,
				(error as Error).message,
				String(error),
				JSON.stringify(error),
				(error as Error).stack ?? '',
			]) {
				expect(representation).not.toContain(hiddenAdapterDetail);
				expect(representation).not.toContain(title);
				expect(representation).not.toContain(markdown);
				expect(representation).not.toContain(sourceUrl);
			}
		}

		expect(send).toHaveBeenCalledOnce();
		expect(recordSuccess).not.toHaveBeenCalled();
		for (const spy of consoleSpies) {
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		}
	});

	it('still collapses every other destination error to the generic code', async () => {
		const send = vi.fn(async () => {
			throw new DestinationError('local-http-timeout');
		});
		const recordSuccess = vi.fn();
		const registry: DestinationRegistry = {
			resolve: vi.fn(() => ({ kind: 'local-http' as const, send })),
		};

		await expect(deliverToDestination(
			'local-http',
			'Private title',
			'Private markdown',
			'https://example.com/private',
			() => new Date('2026-07-12T18:00:00.000Z'),
			registry,
			recordSuccess,
		)).rejects.toMatchObject({
			name: 'DestinationError',
			code: 'destination-delivery-failed',
			message: 'destination-delivery-failed',
		});
		expect(recordSuccess).not.toHaveBeenCalled();
	});

	it('sanitizes resolver failures and never records them as successful', async () => {
		const title = 'Private resolver title a23b';
		const markdown = '---\nsecret: resolver-markdown-b34c\n---\nPrivate resolver body';
		const sourceUrl = 'https://example.com/private-resolver-url-c45d';
		const resolverError = 'arbitrary-resolver-error-d56e';
		const resolve = vi.fn(() => {
			throw new Error(`${resolverError}: ${title} ${markdown} ${sourceUrl}`);
		});
		const recordSuccess = vi.fn();
		const registry: DestinationRegistry = { resolve };

		try {
			await deliverToDestination(
				'clipboard',
				title,
				markdown,
				sourceUrl,
				() => new Date('2026-07-12T18:00:00.000Z'),
				registry,
				recordSuccess,
			);
			throw new Error('expected delivery to reject');
		} catch (error) {
			expect(error).toBeInstanceOf(DestinationError);
			expect((error as DestinationError).code).toBe('destination-delivery-failed');
			expect((error as Error).message).toBe('destination-delivery-failed');
			for (const privateValue of [title, markdown, sourceUrl, resolverError]) {
				expect((error as DestinationError).code).not.toContain(privateValue);
				expect((error as Error).message).not.toContain(privateValue);
			}
		}

		expect(resolve).toHaveBeenCalledOnce();
		expect(recordSuccess).not.toHaveBeenCalled();
	});

	it('returns a completed delivery when best-effort success recording fails', async () => {
		const events: string[] = [];
		const result: DestinationResult = { destination: 'clipboard' };
		const send = vi.fn(async () => {
			events.push('send');
			return result;
		});
		const registry: DestinationRegistry = {
			resolve: vi.fn(() => ({ kind: 'clipboard' as const, send })),
		};
		const recordSuccess = vi.fn(async () => {
			events.push('record');
			throw new Error(`recorder rejected ${MARKDOWN}`);
		});
		const consoleSpies = (
			['debug', 'error', 'info', 'log', 'warn'] as const
		).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));

		try {
			await expect(deliverToDestination(
				'clipboard',
				'Exact title',
				MARKDOWN,
				'https://example.com/exact',
				() => new Date('2026-07-12T18:00:00.000Z'),
				registry,
				recordSuccess,
			)).resolves.toBe(result);

			expect(send).toHaveBeenCalledOnce();
			expect(recordSuccess).toHaveBeenCalledOnce();
			expect(events).toEqual(['send', 'record']);
			for (const spy of consoleSpies) {
				expect(spy).not.toHaveBeenCalled();
			}
		} finally {
			for (const spy of consoleSpies) {
				spy.mockRestore();
			}
		}
	});
});
