import { beforeEach, describe, expect, it } from 'vitest';
import {
	__getMockStorage,
	__resetMockStorage,
	__seedMockStorage,
} from './__mocks__/webextension-polyfill';
import {
	clearLocalHttpToken,
	getLocalHttpToken,
	hasLocalHttpToken,
	setLocalHttpToken,
} from './destination-secrets';

beforeEach(() => {
	__resetMockStorage();
});

describe('local HTTP destination secret', () => {
	it('stores the token only under browser-local destinationSecrets', async () => {
		const token = 'test-private-token-123';
		await setLocalHttpToken(token);

		expect(__getMockStorage('local')).toEqual({
			destinationSecrets: { localHttpToken: token },
		});
		expect(__getMockStorage('sync')).toEqual({});
		expect(await getLocalHttpToken()).toBe(token);
		expect(await hasLocalHttpToken()).toBe(true);
	});

	it('clears the complete secret container', async () => {
		await setLocalHttpToken('test-private-token-123');
		await clearLocalHttpToken();

		expect(__getMockStorage('local')).toEqual({});
		expect(await getLocalHttpToken()).toBe('');
		expect(await hasLocalHttpToken()).toBe(false);
	});

	it.each([
		'',
		'short',
		' leading-space-token',
		'trailing-space-token ',
		'private-token\n123',
		'x'.repeat(513),
	])('rejects invalid token input without persisting it %#', async (token) => {
		await expect(setLocalHttpToken(token)).rejects.toThrow('invalid-local-http-token');
		expect(__getMockStorage('local')).toEqual({});
	});

	it('treats corrupted stored secrets as unset', async () => {
		__seedMockStorage('local', {
			destinationSecrets: { localHttpToken: 'test-private\nsecret' },
		});
		expect(await getLocalHttpToken()).toBe('');
		expect(await hasLocalHttpToken()).toBe(false);
	});
});
