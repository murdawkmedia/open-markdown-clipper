import { describe, expect, it, vi } from 'vitest';
import { DestinationError, DestinationKind, DestinationResult } from '../destinations/types';
import {
	deliverReaderDestination,
	ReaderDestinationOptions,
} from './reader-destinations';

const TITLE = 'Private reader title 7d31';
const MARKDOWN = '---\nsource: exact\n---\n\n# Exact rendered Markdown\n';
const SOURCE_URL = 'https://example.com/private-reader?token=8a42';
const CAPTURED_AT = new Date('2026-07-13T06:30:00.000Z');
const TOKEN = 'test-local-token-9f53';

function response(status = 204): Response {
	return {
		body: null,
		ok: status >= 200 && status < 300,
		redirected: false,
		status,
		type: 'basic',
	} as Response;
}

function setup(defaultDestination: DestinationKind = 'download') {
	const events: string[] = [];
	const capture = vi.fn(() => {
		events.push('capture');
		return { title: TITLE, markdown: MARKDOWN, sourceUrl: SOURCE_URL };
	});
	const now = vi.fn(() => {
		events.push('now');
		return CAPTURED_AT;
	});
	const getLocalHttpToken = vi.fn(async () => {
		events.push('token');
		return TOKEN;
	});
	const hasTransmissionConsent = vi.fn(async () => {
		events.push('consent');
		return true;
	});
	const copy = vi.fn(async () => {
		events.push('copy');
		return true;
	});
	const save = vi.fn(async () => {
		events.push('save');
	});
	const openUri = vi.fn(async () => {
		events.push('open');
	});
	const fetchImpl = vi.fn(async () => {
		events.push('fetch');
		return response();
	}) as unknown as typeof fetch;
	const recordSuccess = vi.fn(async (_result: DestinationResult) => {
		events.push('record');
	});

	const options: ReaderDestinationOptions = {
		preferences: {
			defaultDestination,
			customUriTemplate: 'notes:clip?title={title}&source={sourceUrl}',
			localHttpEndpoint: 'http://127.0.0.1:8765/captures',
		},
		capture,
		now,
		getLocalHttpToken,
		hasTransmissionConsent,
		effects: { copy, save, openUri, fetchImpl },
		recordSuccess,
	};

	return {
		capture,
		copy,
		events,
		fetchImpl,
		getLocalHttpToken,
		hasTransmissionConsent,
		now,
		openUri,
		options,
		recordSuccess,
		save,
	};
}

describe('reader/content-surface destination delivery', () => {
	it.each(['clipboard', 'download'] as const)(
		'uses the shared adapter contract for an explicit %s delivery',
		async (destination) => {
			const context = setup('local-http');

			await expect(deliverReaderDestination({
				...context.options,
				destination,
			})).resolves.toEqual(expect.objectContaining({ destination }));

			expect(context.capture).toHaveBeenCalledOnce();
			expect(context.now).toHaveBeenCalledOnce();
			expect(context.getLocalHttpToken).not.toHaveBeenCalled();
			expect(context.recordSuccess).toHaveBeenCalledOnce();
			if (destination === 'clipboard') {
				expect(context.copy).toHaveBeenCalledWith(MARKDOWN);
				expect(context.events).toEqual(['capture', 'now', 'copy', 'record']);
			} else {
				expect(context.save).toHaveBeenCalledWith({
					content: MARKDOWN,
					fileName: `${TITLE}.md`,
					mimeType: 'text/markdown',
				});
				expect(context.events).toEqual(['capture', 'now', 'save', 'record']);
			}
			expect(context.hasTransmissionConsent).not.toHaveBeenCalled();
		},
	);

	it('uses the configured default and the injected custom-URI opener when destination is omitted', async () => {
		const context = setup('custom-uri');

		await expect(deliverReaderDestination(context.options)).resolves.toEqual({
			destination: 'custom-uri',
		});

		expect(context.capture).toHaveBeenCalledOnce();
		expect(context.getLocalHttpToken).not.toHaveBeenCalled();
		expect(context.copy).toHaveBeenCalledWith(MARKDOWN);
		expect(context.openUri).toHaveBeenCalledWith(
			'notes:clip?title=Private%20reader%20title%207d31&source=https%3A%2F%2Fexample.com%2Fprivate-reader%3Ftoken%3D8a42',
		);
		expect(context.events).toEqual([
			'consent', 'capture', 'consent', 'now', 'copy', 'open', 'record',
		]);
	});

	it('loads the token only for Local HTTP and sends the exact one-time snapshot', async () => {
		const context = setup('clipboard');

		await expect(deliverReaderDestination({
			...context.options,
			destination: 'local-http',
		})).resolves.toEqual({
			destination: 'local-http',
			receipt: 'HTTP 204',
		});

		expect(context.capture).toHaveBeenCalledOnce();
		expect(context.now).toHaveBeenCalledOnce();
		expect(context.getLocalHttpToken).toHaveBeenCalledOnce();
		expect(context.fetchImpl).toHaveBeenCalledOnce();
		const [endpoint, request] = vi.mocked(context.fetchImpl).mock.calls[0] as [string, RequestInit];
		expect(endpoint).toBe('http://127.0.0.1:8765/captures');
		expect(request.headers).toEqual({
			'Authorization': `Bearer ${TOKEN}`,
			'Content-Type': 'application/json',
		});
		expect(JSON.parse(request.body as string)).toEqual({
			title: TITLE,
			markdown: MARKDOWN,
			sourceUrl: SOURCE_URL,
			capturedAt: CAPTURED_AT.toISOString(),
		});
		expect(context.events).toEqual([
			'consent', 'capture', 'consent', 'token', 'consent', 'now', 'fetch', 'record',
		]);
	});

	it('preserves a bounded Local HTTP outcome-unknown signal without leaking or logging', async () => {
		const context = setup('local-http');
		const hiddenReceiverDetail = [TITLE, MARKDOWN, SOURCE_URL, TOKEN].join(' ');
		vi.mocked(context.fetchImpl).mockImplementation(async () => {
			context.events.push('fetch');
			throw new Error(hiddenReceiverDetail);
		});
		const consoleSpies = (
			['debug', 'error', 'info', 'log', 'warn'] as const
		).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));

		try {
			let caught: unknown;
			try {
				await deliverReaderDestination(context.options);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(DestinationError);
			expect((caught as DestinationError).code).toBe('local-http-outcome-unknown');
			expect((caught as Error).message).toBe('local-http-outcome-unknown');
			expect(String(caught)).toBe('DestinationError: local-http-outcome-unknown');
			for (const representation of [
				(caught as DestinationError).code,
				(caught as Error).message,
				String(caught),
				JSON.stringify(caught),
				(caught as Error).stack ?? '',
			]) {
				for (const privateValue of [TITLE, MARKDOWN, SOURCE_URL, TOKEN]) {
					expect(representation).not.toContain(privateValue);
				}
			}
			expect(context.recordSuccess).not.toHaveBeenCalled();
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of consoleSpies) spy.mockRestore();
		}
	});

	it.each(['custom-uri', 'local-http'] as const)(
		'fails %s closed before capture, secrets, or transmission when consent is denied',
		async destination => {
			const context = setup(destination);
			context.hasTransmissionConsent.mockImplementation(async () => {
				context.events.push('consent');
				return false;
			});

			await expect(deliverReaderDestination(context.options)).rejects.toMatchObject({
				name: 'DestinationError',
				code: 'destination-delivery-failed',
				message: 'destination-delivery-failed',
			});

			expect(context.hasTransmissionConsent).toHaveBeenCalledOnce();
			expect(context.capture).not.toHaveBeenCalled();
			expect(context.getLocalHttpToken).not.toHaveBeenCalled();
			expect(context.copy).not.toHaveBeenCalled();
			expect(context.openUri).not.toHaveBeenCalled();
			expect(context.fetchImpl).not.toHaveBeenCalled();
			expect(context.recordSuccess).not.toHaveBeenCalled();
			expect(context.events).toEqual(['consent']);
		},
	);

	it.each([
		['custom-uri', 2],
		['local-http', 2],
	] as const)(
		'observes revoked consent for %s before any external destination effect',
		async (destination, denyOnCheck) => {
			const context = setup(destination);
			let checks = 0;
			context.hasTransmissionConsent.mockImplementation(async () => {
				context.events.push('consent');
				checks += 1;
				return checks < denyOnCheck;
			});

			await expect(deliverReaderDestination(context.options)).rejects.toMatchObject({
				code: 'destination-delivery-failed',
			});
			expect(context.capture).toHaveBeenCalledOnce();
			expect(context.getLocalHttpToken).not.toHaveBeenCalled();
			expect(context.copy).not.toHaveBeenCalled();
			expect(context.openUri).not.toHaveBeenCalled();
			expect(context.fetchImpl).not.toHaveBeenCalled();
			expect(context.recordSuccess).not.toHaveBeenCalled();
			expect(context.events).toEqual(['consent', 'capture', 'consent']);
		},
	);

	it('sanitizes failures, records no success, opens nothing, and logs no sensitive content', async () => {
		const context = setup('clipboard');
		context.copy.mockImplementation(async () => {
			throw new Error(`${TITLE} ${MARKDOWN} ${SOURCE_URL} ${TOKEN}`);
		});
		const consoleSpies = (
			['debug', 'error', 'info', 'log', 'warn'] as const
		).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));

		try {
			await deliverReaderDestination(context.options);
			throw new Error('expected reader delivery to reject');
		} catch (error) {
			expect(error).toBeInstanceOf(DestinationError);
			expect((error as DestinationError).code).toBe('destination-delivery-failed');
			expect((error as Error).message).toBe('destination-delivery-failed');
			for (const sensitive of [TITLE, MARKDOWN, SOURCE_URL, TOKEN]) {
				expect((error as Error).message).not.toContain(sensitive);
			}
		}

		expect(context.capture).toHaveBeenCalledOnce();
		expect(context.recordSuccess).not.toHaveBeenCalled();
		expect(context.openUri).not.toHaveBeenCalled();
		expect(context.fetchImpl).not.toHaveBeenCalled();
		for (const spy of consoleSpies) {
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		}
	});

	it('sanitizes throwing option accessors and null runtime input without logging or leaking', async () => {
		const context = setup('clipboard');
		const sensitiveAccessorError = 'private-option-accessor-sentinel-c614';
		const throwingOptions = { ...context.options };
		Object.defineProperty(throwingOptions, 'destination', {
			enumerable: true,
			get() {
				throw new Error(sensitiveAccessorError);
			},
		});
		const invalidInputs = [
			throwingOptions as ReaderDestinationOptions,
			null as unknown as ReaderDestinationOptions,
		];
		const consoleSpies = (
			['debug', 'error', 'info', 'log', 'warn'] as const
		).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));

		try {
			for (const invalidInput of invalidInputs) {
				let caught: unknown;
				try {
					await deliverReaderDestination(invalidInput);
				} catch (error) {
					caught = error;
				}

				expect(caught).toBeInstanceOf(DestinationError);
				expect((caught as DestinationError).code).toBe('destination-delivery-failed');
				expect((caught as Error).message).toBe('destination-delivery-failed');
				expect((caught as Error).message).not.toContain(sensitiveAccessorError);
			}

			expect(context.capture).not.toHaveBeenCalled();
			expect(context.recordSuccess).not.toHaveBeenCalled();
			expect(context.openUri).not.toHaveBeenCalled();
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
