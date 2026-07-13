import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalHttpDestination, probeLocalHttpEndpoint } from './local-http';
import { ClipDocument, DestinationError } from './types';

const DOCUMENT: ClipDocument = Object.freeze({
	title: 'Private page',
	markdown: '# private markdown',
	sourceUrl: 'https://example.com/private',
	capturedAt: '2026-07-12T18:00:00.000Z',
});

const ENDPOINT = 'http://127.0.0.1:8765/captures';
const TOKEN = 'test-token-123456';

function response(overrides: Partial<Response> = {}): Response {
	return {
		body: null,
		ok: true,
		redirected: false,
		status: 201,
		type: 'basic',
		...overrides,
	} as Response;
}

function setup(overrides: {
	endpoint?: string;
	token?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
} = {}) {
	const fetchImpl = overrides.fetchImpl ?? (
		vi.fn(async () => response()) as unknown as typeof fetch
	);
	const destination = createLocalHttpDestination({
		endpoint: overrides.endpoint ?? ENDPOINT,
		token: overrides.token ?? TOKEN,
		timeoutMs: overrides.timeoutMs,
		fetchImpl,
	});
	return { destination, fetchImpl };
}

async function expectCode(run: () => Promise<unknown>, code: string) {
	try {
		await run();
		throw new Error('expected destination to reject');
	} catch (error) {
		expect(error).toBeInstanceOf(DestinationError);
		const destinationError = error as DestinationError;
		expect(destinationError.code).toBe(code);
		expect(destinationError.message).toBe(code);
		expect(String(destinationError)).toBe(`DestinationError: ${code}`);
		const boundedRepresentations = [
			destinationError.code,
			destinationError.message,
			String(destinationError),
			JSON.stringify(destinationError),
			destinationError.stack ?? '',
		];
		for (const privateValue of [
			DOCUMENT.title,
			DOCUMENT.markdown,
			DOCUMENT.sourceUrl,
			TOKEN,
			ENDPOINT,
		]) {
			for (const representation of boundedRepresentations) {
				expect(representation).not.toContain(privateValue);
			}
		}
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe('local HTTP destination', () => {
	it('posts the exact immutable document with an isolated authenticated request', async () => {
		const { destination, fetchImpl } = setup();

		await expect(destination.send(DOCUMENT)).resolves.toEqual({
			destination: 'local-http',
			receipt: 'HTTP 201',
		});
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(fetchImpl).toHaveBeenCalledWith(
			ENDPOINT,
			expect.objectContaining({
				method: 'POST',
				credentials: 'omit',
				cache: 'no-store',
				redirect: 'error',
				headers: {
					'Authorization': `Bearer ${TOKEN}`,
					'Content-Type': 'application/json',
				},
			}),
		);

		const request = vi.mocked(fetchImpl).mock.calls[0][1]!;
		expect(JSON.parse(request.body as string)).toEqual({
			title: DOCUMENT.title,
			markdown: DOCUMENT.markdown,
			sourceUrl: DOCUMENT.sourceUrl,
			capturedAt: DOCUMENT.capturedAt,
		});
		expect(Object.keys(JSON.parse(request.body as string))).toEqual([
			'title', 'markdown', 'sourceUrl', 'capturedAt',
		]);
		expect(request.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		'http://localhost:8765/captures',
		'http://[::1]:8765/captures',
		'http://127.1:8765/captures',
		'http://2130706433:8765/captures',
		'http://0x7f000001:8765/captures',
		'http://0177.0.0.1:8765/captures',
		'http://127.0.0.01:8765/captures',
		'http://127.0.0.1.evil.example:8765/captures',
		'http://user:pass@127.0.0.1:8765/captures',
		'http://127.0.0.1:8765/captures?token=private',
		'http://127.0.0.1:8765/captures#private',
		'https://127.0.0.1:8765/captures',
		'http://192.0.2.10:8765/captures',
		'http://127.0.0.1:8765/',
		'http://127.0.0.1:8765',
		'http://127.0.0.1/captures',
		'http://127.0.0.1:0/captures',
		'http://127.0.0.1:65536/captures',
		' http://127.0.0.1:8765/captures',
		'http://127.0.0.1:8765/captures\n',
		'http://127.0.0.1:8765\\@evil.example/captures',
	])('rejects unsafe endpoint syntax before fetch: %s', async (endpoint) => {
		const { destination, fetchImpl } = setup({ endpoint });
		await expectCode(() => destination.send(DOCUMENT), 'invalid-local-http-endpoint');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each(['', ' ', 'too-short', 'token\nprivate', 'x'.repeat(513)])(
		'rejects unsafe access tokens before fetch %#',
		async (token) => {
			const { destination, fetchImpl } = setup({ token });
			await expectCode(() => destination.send(DOCUMENT), 'invalid-local-http-token');
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it('rejects redirects without reading response content', async () => {
		const cancel = vi.fn(async () => undefined);
		const redirect = response({
			body: { cancel } as unknown as ReadableStream<Uint8Array>,
			ok: true,
			redirected: true,
			status: 200,
		});
		Object.defineProperty(redirect, 'text', { get: () => { throw new Error(DOCUMENT.markdown); } });
		const fetchImpl = vi.fn(async () => redirect) as unknown as typeof fetch;
		await expectCode(
			() => setup({ fetchImpl }).destination.send(DOCUMENT),
			'local-http-redirect',
		);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([300, 301, 302, 307, 308])('rejects redirect status HTTP %s', async (status) => {
		const fetchImpl = vi.fn(async () => response({ ok: false, status })) as unknown as typeof fetch;
		await expectCode(
			() => setup({ fetchImpl }).destination.send(DOCUMENT),
			'local-http-redirect',
		);
	});

	it.each([199, 400, 401, 500])('rejects HTTP %s without reading the body', async (status) => {
		const failure = response({ ok: false, status });
		Object.defineProperty(failure, 'text', {
			get: () => { throw new Error(DOCUMENT.markdown); },
		});
		const fetchImpl = vi.fn(async () => failure) as unknown as typeof fetch;
		await expectCode(
			() => setup({ fetchImpl }).destination.send(DOCUMENT),
			'local-http-response-error',
		);
	});

	it('marks a rejected POST as outcome unknown without leaking or logging request data', async () => {
		const sensitiveFailure = [
			DOCUMENT.title,
			DOCUMENT.markdown,
			DOCUMENT.sourceUrl,
			TOKEN,
			ENDPOINT,
		].join(' ');
		const fetchImpl = vi.fn(async () => { throw new Error(sensitiveFailure); }) as unknown as typeof fetch;
		const consoleSpies = (
			['debug', 'error', 'info', 'log', 'warn'] as const
		).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));

		try {
			await expectCode(
				() => setup({ fetchImpl }).destination.send(DOCUMENT),
				'local-http-outcome-unknown',
			);
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of consoleSpies) spy.mockRestore();
		}
	});

	it('marks a synchronously throwing POST dispatch as outcome unknown', async () => {
		const fetchImpl = vi.fn(() => {
			throw new Error(`${DOCUMENT.title} ${TOKEN} ${ENDPOINT}`);
		}) as unknown as typeof fetch;

		await expectCode(
			() => setup({ fetchImpl }).destination.send(DOCUMENT),
			'local-http-outcome-unknown',
		);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it('maps invalid responses and throwing metadata getters to bounded errors', async () => {
		const nullResponse = vi.fn(async () => null) as unknown as typeof fetch;
		await expectCode(
			() => setup({ fetchImpl: nullResponse }).destination.send(DOCUMENT),
			'local-http-outcome-unknown',
		);

		const throwingResponse = response();
		Object.defineProperty(throwingResponse, 'status', {
			get: () => { throw new Error(DOCUMENT.markdown); },
		});
		const throwingFetch = vi.fn(async () => throwingResponse) as unknown as typeof fetch;
		await expectCode(
			() => setup({ fetchImpl: throwingFetch }).destination.send(DOCUMENT),
			'local-http-outcome-unknown',
		);
	});

	it('cancels a successful response body without reading it', async () => {
		const cancel = vi.fn(async () => undefined);
		const streamed = response({ body: { cancel } as unknown as ReadableStream<Uint8Array> });
		Object.defineProperty(streamed, 'text', { get: () => { throw new Error(DOCUMENT.markdown); } });
		const fetchImpl = vi.fn(async () => streamed) as unknown as typeof fetch;

		await expect(setup({ fetchImpl }).destination.send(DOCUMENT)).resolves.toEqual({
			destination: 'local-http',
			receipt: 'HTTP 201',
		});
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('maps response-body cancellation failures to a bounded error', async () => {
		const cancel = vi.fn(async () => { throw new Error(DOCUMENT.markdown); });
		const streamed = response({ body: { cancel } as unknown as ReadableStream<Uint8Array> });
		const fetchImpl = vi.fn(async () => streamed) as unknown as typeof fetch;
		await expectCode(
			() => setup({ fetchImpl }).destination.send(DOCUMENT),
			'local-http-outcome-unknown',
		);
	});

	it('keeps the timeout active while canceling a response body', async () => {
		vi.useFakeTimers();
		const cancel = vi.fn(() => new Promise<void>(() => undefined));
		const streamed = response({ body: { cancel } as unknown as ReadableStream<Uint8Array> });
		const fetchImpl = vi.fn(async () => streamed) as unknown as typeof fetch;
		const pending = setup({ fetchImpl }).destination.send(DOCUMENT);
		const assertion = expectCode(() => pending, 'local-http-outcome-unknown');

		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('aborts at the ten-second timeout with a distinct bounded error', async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		})) as unknown as typeof fetch;
		const pending = setup({ fetchImpl }).destination.send(DOCUMENT);
		const assertion = expectCode(() => pending, 'local-http-outcome-unknown');

		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
	});

	it('honors caller aborts and removes the in-flight request', async () => {
		const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		})) as unknown as typeof fetch;
		const controller = new AbortController();
		const pending = setup({ fetchImpl }).destination.send(DOCUMENT, controller.signal);
		const assertion = expectCode(() => pending, 'local-http-outcome-unknown');
		controller.abort();

		await assertion;
	});

	it('does not fetch when the caller has already aborted', async () => {
		const { destination, fetchImpl } = setup();
		const controller = new AbortController();
		controller.abort();

		await expectCode(() => destination.send(DOCUMENT, controller.signal), 'delivery-aborted');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('local HTTP connection probe', () => {
	it.each([200, 204, 299])(
		'accepts HTTP %s from authenticated bodyless HEAD and cancels any response body',
		async (status) => {
			const cancel = vi.fn(async () => undefined);
			const fetchImpl = vi.fn(async () => response({
				body: { cancel } as unknown as ReadableStream<Uint8Array>,
				status,
			})) as unknown as typeof fetch;

			await expect(probeLocalHttpEndpoint({
				endpoint: ENDPOINT,
				token: TOKEN,
				fetchImpl,
			})).resolves.toBeUndefined();

			expect(fetchImpl).toHaveBeenCalledOnce();
			const [endpoint, request] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
			expect(endpoint).toBe(ENDPOINT);
			expect(request).toMatchObject({
				method: 'HEAD',
				credentials: 'omit',
				cache: 'no-store',
				redirect: 'error',
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect(request.body).toBeUndefined();
			expect(request.signal).toBeInstanceOf(AbortSignal);
			expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it('reuses strict endpoint and token validation before fetch', async () => {
		const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch;
		await expectCode(
			() => probeLocalHttpEndpoint({
				endpoint: 'http://localhost:8765/captures',
				token: TOKEN,
				fetchImpl,
			}),
			'invalid-local-http-endpoint',
		);
		await expectCode(
			() => probeLocalHttpEndpoint({
				endpoint: ENDPOINT,
				token: 'token\nprivate',
				fetchImpl,
			}),
			'invalid-local-http-token',
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('retains a bounded timeout for a non-settling HEAD request', async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => (
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					'abort',
					() => reject(new DOMException('Aborted', 'AbortError')),
				);
			})
		)) as unknown as typeof fetch;
		const pending = probeLocalHttpEndpoint({
			endpoint: ENDPOINT,
			token: TOKEN,
			fetchImpl,
			timeoutMs: 25,
		});
		const assertion = expectCode(() => pending, 'local-http-timeout');

		await vi.advanceTimersByTimeAsync(25);
		await assertion;
	});

	it('honors caller abort while HEAD is in flight', async () => {
		const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => (
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					'abort',
					() => reject(new DOMException('Aborted', 'AbortError')),
				);
			})
		)) as unknown as typeof fetch;
		const controller = new AbortController();
		const pending = probeLocalHttpEndpoint({
			endpoint: ENDPOINT,
			token: TOKEN,
			fetchImpl,
		}, controller.signal);
		const assertion = expectCode(() => pending, 'delivery-aborted');

		controller.abort();
		await assertion;
	});

	it('keeps rejected, invalid, and uncancelable HEAD responses as known probe failures', async () => {
		const rejectedFetch = vi.fn(async () => {
			throw new Error(`${DOCUMENT.markdown} ${TOKEN} ${ENDPOINT}`);
		}) as unknown as typeof fetch;
		await expectCode(
			() => probeLocalHttpEndpoint({
				endpoint: ENDPOINT,
				token: TOKEN,
				fetchImpl: rejectedFetch,
			}),
			'local-http-failed',
		);

		const invalidFetch = vi.fn(async () => null) as unknown as typeof fetch;
		await expectCode(
			() => probeLocalHttpEndpoint({
				endpoint: ENDPOINT,
				token: TOKEN,
				fetchImpl: invalidFetch,
			}),
			'local-http-failed',
		);

		const cancel = vi.fn(async () => {
			throw new Error(`${DOCUMENT.title} ${DOCUMENT.sourceUrl}`);
		});
		const uncancelableFetch = vi.fn(async () => response({
			body: { cancel } as unknown as ReadableStream<Uint8Array>,
		})) as unknown as typeof fetch;
		await expectCode(
			() => probeLocalHttpEndpoint({
				endpoint: ENDPOINT,
				token: TOKEN,
				fetchImpl: uncancelableFetch,
			}),
			'local-http-failed',
		);
		expect(cancel).toHaveBeenCalledOnce();
	});
});
