import {
	ClipDestination,
	ClipDocument,
	DestinationError,
	DestinationResult,
} from './types';

export const DEFAULT_LOCAL_HTTP_TIMEOUT_MS = 10_000;
export const MAX_LOCAL_HTTP_ENDPOINT_LENGTH = 2048;
export const MIN_LOCAL_HTTP_TOKEN_LENGTH = 16;
export const MAX_LOCAL_HTTP_TOKEN_LENGTH = 512;

export interface LocalHttpDestinationOptions {
	readonly endpoint: string;
	readonly token: string;
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
}

export type LocalHttpProbeOptions = LocalHttpDestinationOptions;

const RAW_WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/u;
const LITERAL_LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:(\d{1,5})(\/[^?#\\]*)$/i;
const TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/;

function validateEndpoint(endpoint: string): void {
	if (
		endpoint.length === 0
		|| endpoint.length > MAX_LOCAL_HTTP_ENDPOINT_LENGTH
		|| RAW_WHITESPACE_OR_CONTROL.test(endpoint)
	) {
		throw new DestinationError('invalid-local-http-endpoint');
	}

	const rawMatch = LITERAL_LOOPBACK_ENDPOINT.exec(endpoint);
	if (!rawMatch) {
		throw new DestinationError('invalid-local-http-endpoint');
	}

	const port = Number(rawMatch[1]);
	if (!Number.isInteger(port) || port < 1 || port > 65_535 || rawMatch[2] === '/') {
		throw new DestinationError('invalid-local-http-endpoint');
	}

	try {
		const parsed = new URL(endpoint);
		if (
			parsed.protocol !== 'http:'
			|| parsed.hostname !== '127.0.0.1'
			|| parsed.username.length > 0
			|| parsed.password.length > 0
			|| parsed.search.length > 0
			|| parsed.hash.length > 0
			|| parsed.pathname === '/'
		) {
			throw new DestinationError('invalid-local-http-endpoint');
		}
	} catch {
		throw new DestinationError('invalid-local-http-endpoint');
	}
}

function validateToken(token: string): void {
	if (token.length > MAX_LOCAL_HTTP_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
		throw new DestinationError('invalid-local-http-token');
	}
}

function validateTimeout(timeoutMs: number): void {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
		throw new DestinationError('invalid-local-http-timeout');
	}
}

function requestBody(document: ClipDocument): string {
	return JSON.stringify({
		title: document.title,
		markdown: document.markdown,
		sourceUrl: document.sourceUrl,
		capturedAt: document.capturedAt,
	});
}

interface LocalHttpRequestOptions {
	readonly endpoint: string;
	readonly token: string;
	readonly fetchImpl: typeof fetch;
	readonly timeoutMs: number;
	readonly method: 'HEAD' | 'POST';
	readonly body?: string;
}

async function performLocalHttpRequest(
	options: LocalHttpRequestOptions,
	signal?: AbortSignal,
): Promise<number> {
	const { endpoint, token, fetchImpl, timeoutMs, method, body } = options;
	if (signal?.aborted) throw new DestinationError('delivery-aborted');

	validateEndpoint(endpoint);
	validateToken(token);
	validateTimeout(timeoutMs);

	const controller = new AbortController();
	let callerAborted = false;
	let timedOut = false;
	let rejectAbort: (error: DestinationError) => void = () => undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onCallerAbort = () => {
		callerAborted = true;
		rejectAbort(new DestinationError('delivery-aborted'));
		controller.abort();
	};
	signal?.addEventListener('abort', onCallerAbort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		rejectAbort(new DestinationError('local-http-timeout'));
		controller.abort();
	}, timeoutMs);

	let ok = false;
	let redirected = false;
	let status = 0;
	let type = '';
	try {
		const response = await Promise.race([
			fetchImpl(endpoint, {
				method,
				credentials: 'omit',
				cache: 'no-store',
				redirect: 'error',
				headers: {
					'Authorization': `Bearer ${token}`,
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				...(body === undefined ? {} : { body }),
				signal: controller.signal,
			}),
			abortPromise,
		]);
		if (!response || typeof response !== 'object') {
			throw new Error('invalid-response');
		}

		const responseOk = response.ok;
		const responseRedirected = response.redirected;
		const responseStatus = response.status;
		const responseType = response.type;
		const responseBody = response.body;
		if (
			typeof responseOk !== 'boolean'
			|| typeof responseRedirected !== 'boolean'
			|| !Number.isInteger(responseStatus)
			|| typeof responseType !== 'string'
			|| (responseBody !== null && typeof responseBody !== 'object')
		) {
			throw new Error('invalid-response');
		}

		if (responseBody !== null) {
			const cancel = responseBody.cancel;
			if (typeof cancel !== 'function') throw new Error('invalid-response');
			await Promise.race([
				Promise.resolve(cancel.call(responseBody)),
				abortPromise,
			]);
		}

		if (signal?.aborted) throw new DestinationError('delivery-aborted');
		ok = responseOk;
		redirected = responseRedirected;
		status = responseStatus;
		type = responseType;
	} catch (error) {
		if (method === 'POST') {
			throw new DestinationError('local-http-outcome-unknown');
		}
		if (error instanceof DestinationError) throw error;
		if (callerAborted || signal?.aborted) {
			throw new DestinationError('delivery-aborted');
		}
		if (timedOut) throw new DestinationError('local-http-timeout');
		throw new DestinationError('local-http-failed');
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener('abort', onCallerAbort);
	}

	if (redirected || type === 'opaqueredirect' || (status >= 300 && status < 400)) {
		throw new DestinationError('local-http-redirect');
	}
	if (!ok || !Number.isInteger(status) || status < 200 || status > 299) {
		throw new DestinationError('local-http-response-error');
	}

	return status;
}

export async function probeLocalHttpEndpoint(
	options: LocalHttpProbeOptions,
	signal?: AbortSignal,
): Promise<void> {
	const {
		endpoint,
		token,
		timeoutMs = DEFAULT_LOCAL_HTTP_TIMEOUT_MS,
		fetchImpl = globalThis.fetch.bind(globalThis),
	} = options;
	await performLocalHttpRequest({
		endpoint,
		token,
		fetchImpl,
		timeoutMs,
		method: 'HEAD',
	}, signal);
}

export function createLocalHttpDestination(
	options: LocalHttpDestinationOptions,
): ClipDestination {
	const {
		endpoint,
		token,
		timeoutMs = DEFAULT_LOCAL_HTTP_TIMEOUT_MS,
		fetchImpl = globalThis.fetch.bind(globalThis),
	} = options;

	return Object.freeze({
		kind: 'local-http' as const,
		async send(document: ClipDocument, signal?: AbortSignal): Promise<DestinationResult> {
			const status = await performLocalHttpRequest({
				endpoint,
				token,
				fetchImpl,
				timeoutMs,
				method: 'POST',
				body: requestBody(document),
			}, signal);
			return { destination: 'local-http', receipt: `HTTP ${status}` };
		},
	});
}
