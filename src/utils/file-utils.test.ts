// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveFile } from './file-utils';

vi.mock('./browser-detection', () => ({
	detectBrowser: vi.fn(async () => 'chrome'),
}));

describe('saveFile', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('calls onError and rejects when the browser save effect fails', async () => {
		const failure = new Error('browser-save-failed');
		const onError = vi.fn();
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw failure; });

		await expect(saveFile({
			content: '# private markdown',
			fileName: 'Page.md',
			onError,
		})).rejects.toBe(failure);

		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith(failure);
		expect(errorLog).toHaveBeenCalledWith('Failed to save file');
	});
});
