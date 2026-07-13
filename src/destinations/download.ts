import { saveFile, SaveFileOptions } from '../utils/file-utils';
import {
	ClipDocument,
	ClipDestination,
	DestinationError,
	DestinationResult,
} from './types';

export type SaveEffect = (options: SaveFileOptions, signal?: AbortSignal) => Promise<void>;

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_FILE_NAME_STEM_UNITS = 240;

function truncateFileNameStem(name: string): string {
	const encoder = new TextEncoder();
	let utf8Bytes = 0;
	let utf16Units = 0;
	let result = '';

	for (const codePoint of name) {
		const nextBytes = encoder.encode(codePoint).byteLength;
		const nextUnits = codePoint.length;
		if (
			utf8Bytes + nextBytes > MAX_FILE_NAME_STEM_UNITS
			|| utf16Units + nextUnits > MAX_FILE_NAME_STEM_UNITS
		) {
			break;
		}
		result += codePoint;
		utf8Bytes += nextBytes;
		utf16Units += nextUnits;
	}

	return result;
}

export function createDownloadFileName(title: string): string {
	let name = title
		.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '-')
		.replace(/^\.+/, '')
		.replace(/[ .]+$/, '')
		.trim();

	name = truncateFileNameStem(name).replace(/[ .]+$/, '');
	if (name.length === 0) {
		name = 'capture';
	} else if (WINDOWS_RESERVED_NAME.test(name)) {
		name = `_${name}`;
	}

	return `${name}.md`;
}

export function createDownloadDestination(
	save: SaveEffect = saveFile,
): ClipDestination {
	return Object.freeze({
		kind: 'download' as const,
		async send(document: ClipDocument, signal?: AbortSignal): Promise<DestinationResult> {
			if (signal?.aborted) {
				throw new DestinationError('delivery-aborted');
			}

			const fileName = createDownloadFileName(document.title);
			try {
				const options = {
					content: document.markdown,
					fileName,
					mimeType: 'text/markdown',
				};
				if (signal) await save(options, signal);
				else await save(options);
			} catch {
				if (signal?.aborted) throw new DestinationError('delivery-aborted');
				throw new DestinationError('download-failed');
			}
			if (signal?.aborted) throw new DestinationError('delivery-aborted');

			return { destination: 'download', receipt: fileName };
		},
	});
}
