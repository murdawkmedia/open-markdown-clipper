import { DestinationError } from '../destinations/types';
import browser from './browser-polyfill';

const SECRET_KEY = 'destinationSecrets';
const LOCAL_HTTP_TOKEN = /^[\x21-\x7e]{16,512}$/;

interface DestinationSecrets {
	readonly localHttpToken?: string;
}

function isValidToken(token: unknown): token is string {
	return typeof token === 'string' && LOCAL_HTTP_TOKEN.test(token);
}

export async function setLocalHttpToken(token: string): Promise<void> {
	if (!isValidToken(token)) {
		throw new DestinationError('invalid-local-http-token');
	}
	await browser.storage.local.set({
		[SECRET_KEY]: { localHttpToken: token },
	});
}

export async function getLocalHttpToken(): Promise<string> {
	const stored = await browser.storage.local.get(SECRET_KEY) as Record<string, unknown>;
	const secrets = stored[SECRET_KEY];
	if (!secrets || typeof secrets !== 'object') return '';
	const token = (secrets as DestinationSecrets).localHttpToken;
	return isValidToken(token) ? token : '';
}

export async function clearLocalHttpToken(): Promise<void> {
	await browser.storage.local.remove(SECRET_KEY);
}

export async function hasLocalHttpToken(): Promise<boolean> {
	return (await getLocalHttpToken()).length > 0;
}
