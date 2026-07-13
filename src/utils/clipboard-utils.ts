const EXTENSION_DOCUMENT_PROTOCOLS = new Set([
	'chrome-extension:',
	'moz-extension:',
	'safari-web-extension:',
]);

export interface ClipboardFallbackOptions {
	readonly document?: Document;
	readonly isExtensionDocument?: (document: Document) => boolean;
}

function defaultIsExtensionDocument(document: Document): boolean {
	try {
		return EXTENSION_DOCUMENT_PROTOCOLS.has(document.location.protocol);
	} catch {
		return false;
	}
}

/**
 * Copies text from an extension-owned page. The fallback is deliberately
 * restricted to an extension-origin document so private text is never relayed
 * through a content script or inserted into the captured web page.
 */
export async function copyToClipboard(
	text: string,
	_signal?: AbortSignal,
	options: ClipboardFallbackOptions = {},
): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Continue only to the extension-document fallback below.
	}

	const extensionDocument = options.document ?? globalThis.document;
	const isExtensionDocument = options.isExtensionDocument ?? defaultIsExtensionDocument;
	if (!extensionDocument || !isExtensionDocument(extensionDocument)) return false;

	let textArea: HTMLTextAreaElement | undefined;
	try {
		const parent = extensionDocument.body ?? extensionDocument.documentElement;
		if (!parent || typeof extensionDocument.execCommand !== 'function') return false;
		textArea = extensionDocument.createElement('textarea');
		textArea.value = text;
		textArea.setAttribute('readonly', '');
		textArea.setAttribute('aria-hidden', 'true');
		textArea.style.position = 'fixed';
		textArea.style.left = '-9999px';
		textArea.style.opacity = '0';
		textArea.style.pointerEvents = 'none';
		parent.appendChild(textArea);
		textArea.select();
		return extensionDocument.execCommand('copy') === true;
	} catch {
		return false;
	} finally {
		if (textArea) {
			textArea.value = '';
			try {
				textArea.remove();
			} catch {}
		}
	}
}
