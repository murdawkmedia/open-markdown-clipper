import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	__getMockStorage,
	__resetMockStorage,
} from './__mocks__/webextension-polyfill';
import {
	ClipRecordingError,
	createSerializedClipRecorder,
	dispatchRecordClipMessage,
	handleRecordClipMessage,
	sendClipRecordingMessage,
} from './clip-recorder';
import {
	getClipHistory,
	loadSettings,
	recordClipInStorage,
} from './storage-utils';

const PRIVATE_CONTENT = '# private clip body that must not escape';

beforeEach(() => {
	__resetMockStorage();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function expectFixedFailure(operation: Promise<unknown>): Promise<void> {
	try {
		await operation;
		throw new Error('expected clip recording to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(ClipRecordingError);
		expect((error as Error).message).toBe('clip-recording-failed');
		expect((error as ClipRecordingError).code).toBe('clip-recording-failed');
		expect(JSON.stringify(error)).not.toContain(PRIVATE_CONTENT);
	}
}

describe('exact clip recording runtime boundary', () => {
	it('accepts only an exact plain generic recording message', async () => {
		const recorder = vi.fn(async () => undefined);
		await handleRecordClipMessage({
			action: 'recordClip',
			clipAction: 'local-http',
			url: 'https://example.com/article',
			title: 'Article',
		}, recorder);

		expect(recorder).toHaveBeenCalledWith({
			clipAction: 'local-http',
			url: 'https://example.com/article',
			title: 'Article',
		});
	});

	it.each([
		null,
		[],
		Object.create({ action: 'recordClip', clipAction: 'clipboard' }),
		{ action: 'recordClip', clipAction: 'copyToClipboard' },
		{ action: 'recordClip', clipAction: 'clipboard', title: 'Missing URL' },
		{ action: 'recordClip', clipAction: 'clipboard', extra: PRIVATE_CONTENT },
		{ action: 'wrongAction', clipAction: 'clipboard' },
	])('maps malformed or non-exact messages to a fixed failure: %p', async (value) => {
		const recorder = vi.fn(async () => undefined);
		await expectFixedFailure(handleRecordClipMessage(value, recorder));
		expect(recorder).not.toHaveBeenCalled();
	});

	it('rejects hidden, symbolic, and accessor fields without exposing their values', async () => {
		const hidden = { action: 'recordClip', clipAction: 'clipboard' };
		Object.defineProperty(hidden, 'private', { value: PRIVATE_CONTENT });
		const symbolic = {
			action: 'recordClip',
			clipAction: 'clipboard',
			[Symbol('private')]: PRIVATE_CONTENT,
		};
		const accessor = { action: 'recordClip' } as Record<string, unknown>;
		const getter = vi.fn(() => {
			throw new Error(PRIVATE_CONTENT);
		});
		Object.defineProperty(accessor, 'clipAction', { enumerable: true, get: getter });

		for (const value of [hidden, symbolic, accessor]) {
			await expectFixedFailure(handleRecordClipMessage(value, vi.fn()));
		}
		expect(getter).not.toHaveBeenCalled();
	});

	it('dispatches asynchronously with only fixed success or failure responses', async () => {
		const successResponse = vi.fn();
		expect(dispatchRecordClipMessage(
			{ action: 'recordClip', clipAction: 'share' },
			vi.fn(async () => undefined),
			successResponse,
		)).toBe(true);
		await vi.waitFor(() => expect(successResponse).toHaveBeenCalledWith({ success: true }));

		const failureResponse = vi.fn();
		expect(dispatchRecordClipMessage(
			{ action: 'recordClip', clipAction: 'clipboard', extra: PRIVATE_CONTENT },
			vi.fn(async () => { throw new Error(PRIVATE_CONTENT); }),
			failureResponse,
		)).toBe(true);
		await vi.waitFor(() => expect(failureResponse).toHaveBeenCalledWith({
			success: false,
			error: 'clip-recording-failed',
		}));
		expect(JSON.stringify(failureResponse.mock.calls)).not.toContain(PRIVATE_CONTENT);

		expect(dispatchRecordClipMessage(
			{ action: 'unrelated' },
			vi.fn(),
			vi.fn(),
		)).toBeUndefined();
	});

	it('client sends the exact minimum message and maps all failures to one code', async () => {
		const send = vi.fn(async () => ({ success: true }));
		await sendClipRecordingMessage('download', undefined, undefined, send);
		expect(send).toHaveBeenCalledWith({
			action: 'recordClip',
			clipAction: 'download',
		});

		for (const failingSend of [
			async () => ({ success: false, error: 'clip-recording-failed', private: PRIVATE_CONTENT }),
			async () => ({ success: true, private: PRIVATE_CONTENT }),
			async () => { throw new Error(PRIVATE_CONTENT); },
		]) {
			await expectFixedFailure(sendClipRecordingMessage(
				'clipboard',
				'https://example.com/article',
				'Article',
				failingSend,
			));
		}
	});
});

describe('background-owned serialized clip recorder', () => {
	it('preserves every concurrent count and history entry through the runtime boundary', async () => {
		const queuedRecorder = createSerializedClipRecorder(async (record) => {
			await recordClipInStorage(record.clipAction, record.url, record.title);
		});
		const sendThroughBackground = async (message: unknown): Promise<unknown> => (
			new Promise((resolve, reject) => {
				const handled = dispatchRecordClipMessage(message, queuedRecorder, resolve);
				if (!handled) reject(new Error('message was not handled'));
			})
		);

		await Promise.all(Array.from({ length: 40 }, (_, index) => (
			sendClipRecordingMessage(
				'clipboard',
				`https://example.com/article/${index}?private=${index}#fragment`,
				`Article ${index}`,
				sendThroughBackground,
			)
		)));

		expect((await loadSettings()).stats.clipboard).toBe(40);
		const history = await getClipHistory();
		expect(history).toHaveLength(40);
		expect(new Set(history.map((entry) => entry.title)).size).toBe(40);
		expect(history.every((entry) => !entry.url.includes('?') && !entry.url.includes('#'))).toBe(true);
		expect((__getMockStorage('sync').stats as Record<string, unknown>).clipboard).toBe(40);
	});

	it('continues the queue after a fixed content-free failure', async () => {
		let calls = 0;
		const queuedRecorder = createSerializedClipRecorder(async () => {
			calls += 1;
			if (calls === 1) throw new Error(PRIVATE_CONTENT);
		});

		await expectFixedFailure(handleRecordClipMessage(
			{ action: 'recordClip', clipAction: 'clipboard' },
			queuedRecorder,
		));
		await expect(handleRecordClipMessage(
			{ action: 'recordClip', clipAction: 'download' },
			queuedRecorder,
		)).resolves.toBeUndefined();
		expect(calls).toBe(2);
	});
});
