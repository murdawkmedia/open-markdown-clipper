// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './clipboard-utils';

const PRIVATE_MARKDOWN = '# private clipboard payload 7f3d';
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');

function setClipboard(writeText: (text: string) => Promise<void>): void {
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText },
	});
}

function setExecCommand(copy: () => boolean): void {
	Object.defineProperty(document, 'execCommand', {
		configurable: true,
		value: vi.fn(copy),
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
	if (originalClipboardDescriptor) {
		Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
	} else {
		Reflect.deleteProperty(navigator, 'clipboard');
	}
	if (originalExecCommandDescriptor) {
		Object.defineProperty(document, 'execCommand', originalExecCommandDescriptor);
	} else {
		Reflect.deleteProperty(document, 'execCommand');
	}
});

describe('extension document clipboard helper', () => {
	it('uses the Clipboard API without creating a fallback node', async () => {
		const writeText = vi.fn(async () => undefined);
		setClipboard(writeText);
		const createElement = vi.spyOn(document, 'createElement');

		await expect(copyToClipboard(PRIVATE_MARKDOWN)).resolves.toBe(true);

		expect(writeText).toHaveBeenCalledWith(PRIVATE_MARKDOWN);
		expect(createElement).not.toHaveBeenCalledWith('textarea');
	});

	it('falls back only inside the current extension document and removes the payload', async () => {
		setClipboard(vi.fn(async () => { throw new Error(PRIVATE_MARKDOWN); }));
		let copiedValue = '';
		setExecCommand(() => {
			copiedValue = (document.querySelector('textarea') as HTMLTextAreaElement).value;
			return true;
		});
		const appendChild = vi.spyOn(document.body, 'appendChild');

		await expect(copyToClipboard(PRIVATE_MARKDOWN, undefined, {
			document,
			isExtensionDocument: () => true,
		})).resolves.toBe(true);

		expect(appendChild).toHaveBeenCalledOnce();
		const textArea = appendChild.mock.calls[0][0] as HTMLTextAreaElement;
		expect(textArea.tagName).toBe('TEXTAREA');
		expect(copiedValue).toBe(PRIVATE_MARKDOWN);
		expect(textArea.value).toBe('');
		expect(textArea.isConnected).toBe(false);
		expect(document.body.textContent).not.toContain(PRIVATE_MARKDOWN);
		expect(document.execCommand).toHaveBeenCalledWith('copy');
	});

	it('fails closed and removes the node when the local fallback cannot copy', async () => {
		setClipboard(vi.fn(async () => { throw new Error(PRIVATE_MARKDOWN); }));
		setExecCommand(() => false);

		await expect(copyToClipboard(PRIVATE_MARKDOWN, undefined, {
			document,
			isExtensionDocument: () => true,
		})).resolves.toBe(false);

		expect(document.querySelector('textarea')).toBeNull();
	});

	it('never creates a fallback node in a non-extension document', async () => {
		setClipboard(vi.fn(async () => { throw new Error(PRIVATE_MARKDOWN); }));
		setExecCommand(() => true);
		const appendChild = vi.spyOn(document.body, 'appendChild');

		await expect(copyToClipboard(PRIVATE_MARKDOWN, undefined, { document })).resolves.toBe(false);

		expect(appendChild).not.toHaveBeenCalled();
		expect(document.execCommand).not.toHaveBeenCalled();
	});
});
