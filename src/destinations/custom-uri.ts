import { copyToClipboard } from '../utils/clipboard-utils';
import {
	ClipDestination,
	ClipDocument,
	DestinationError,
	DestinationResult,
} from './types';
import { CopyEffect } from './clipboard';

export const MAX_CUSTOM_URI_LENGTH = 2048;

export type OpenUriEffect = (uri: string, signal?: AbortSignal) => void | Promise<void>;

export interface CustomUriDestinationOptions {
	readonly template: string;
	readonly openUri: OpenUriEffect;
	readonly copy?: CopyEffect;
}

const CUSTOM_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const RAW_WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/u;
const BLOCKED_SCHEMES = new Set([
	'about',
	'blob',
	'browser',
	'browser-extension',
	'brave',
	'chrome',
	'chrome-distiller',
	'chrome-error',
	'chrome-extension',
	'chrome-search',
	'chrome-untrusted',
	'data',
	'devtools',
	'edge',
	'file',
	'filesystem',
	'ftp',
	'git',
	'gopher',
	'http',
	'https',
	'imap',
	'imaps',
	'irc',
	'ircs',
	'javascript',
	'jar',
	'ldap',
	'ldaps',
	'moz-extension',
	'ms-browser-extension',
	'nfs',
	'nntp',
	'opera',
	'opera-extension',
	'pop',
	'pops',
	'rdp',
	'resource',
	'rsync',
	'rtmp',
	'rtsp',
	'rtsps',
	'safari-extension',
	'safari-web-extension',
	'sftp',
	'smb',
	'smtp',
	'smtps',
	'ssh',
	'svn',
	'svn+ssh',
	'telnet',
	'view-source',
	'vivaldi',
	'vnc',
	'ws',
	'wss',
]);

function requireAllowedCustomScheme(value: string): void {
	const schemeMatch = CUSTOM_SCHEME.exec(value);
	if (!schemeMatch || BLOCKED_SCHEMES.has(schemeMatch[1].toLowerCase())) {
		throw new DestinationError('invalid-custom-uri');
	}
}

export function validateFinalCustomUri(value: unknown): string {
	if (
		typeof value !== 'string'
		|| value.length === 0
		|| RAW_WHITESPACE_OR_CONTROL.test(value)
		|| value.includes('{')
		|| value.includes('}')
	) {
		throw new DestinationError('invalid-custom-uri');
	}

	requireAllowedCustomScheme(value);
	if (value.length > MAX_CUSTOM_URI_LENGTH) {
		throw new DestinationError('custom-uri-too-long');
	}

	return value;
}

function expandCustomUri(template: string, document: ClipDocument): string {
	if (
		template.length === 0
		|| RAW_WHITESPACE_OR_CONTROL.test(template)
	) {
		throw new DestinationError('invalid-custom-uri');
	}

	requireAllowedCustomScheme(template);

	for (const match of template.match(/\{[^{}]*\}/g) ?? []) {
		if (match !== '{title}' && match !== '{sourceUrl}') {
			throw new DestinationError('invalid-custom-uri');
		}
	}

	let uri: string;
	try {
		uri = template
			.replace(/\{title\}/g, encodeURIComponent(document.title))
			.replace(/\{sourceUrl\}/g, encodeURIComponent(document.sourceUrl));
	} catch {
		throw new DestinationError('invalid-custom-uri');
	}

	return validateFinalCustomUri(uri);
}

export function createCustomUriDestination(
	options: CustomUriDestinationOptions,
): ClipDestination {
	const { template, openUri, copy = copyToClipboard } = options;

	return Object.freeze({
		kind: 'custom-uri' as const,
		async send(document: ClipDocument, signal?: AbortSignal): Promise<DestinationResult> {
			if (signal?.aborted) {
				throw new DestinationError('delivery-aborted');
			}

			const uri = expandCustomUri(template, document);
			try {
				const copied = signal
					? await copy(document.markdown, signal)
					: await copy(document.markdown);
				if (!copied) {
					throw new DestinationError('custom-uri-copy-failed');
				}
			} catch {
				if (signal?.aborted) throw new DestinationError('delivery-aborted');
				throw new DestinationError('custom-uri-copy-failed');
			}

			if (signal?.aborted) {
				throw new DestinationError('delivery-aborted');
			}

			try {
				if (signal) await openUri(uri, signal);
				else await openUri(uri);
			} catch {
				if (signal?.aborted) throw new DestinationError('delivery-aborted');
				throw new DestinationError('custom-uri-open-failed');
			}
			if (signal?.aborted) throw new DestinationError('delivery-aborted');

			return { destination: 'custom-uri' };
		},
	});
}
