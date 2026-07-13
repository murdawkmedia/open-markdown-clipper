import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_SOURCE = readFileSync(
	fileURLToPath(new URL('./cli.ts', import.meta.url)),
	'utf8',
);

const LEGACY_OPTIONS = ['vault', 'open', 'uri', 'silent'];
const LEGACY_PRODUCT_NAME = ['Ob', 'sidian'].join('');
const LEGACY_TRANSPORT_MODULE = ['./utils/', 'cli', '-utils'].join('');
const LEGACY_TRANSPORT_INVOCATION = ['open', 'In', LEGACY_PRODUCT_NAME].join('');

describe('public CLI contract', () => {
	it('advertises only generic Markdown output behavior', () => {
		expect(CLI_SOURCE).toContain('Output .md file path (default: stdout)');
		for (const option of LEGACY_OPTIONS) {
			expect(CLI_SOURCE).not.toContain(`--${option}`);
		}
		expect(CLI_SOURCE).not.toContain(LEGACY_PRODUCT_NAME);
	});

	it('cannot parse or invoke a legacy application transport', () => {
		for (const option of LEGACY_OPTIONS) {
			expect(CLI_SOURCE).not.toContain(`case '--${option}'`);
		}
		expect(CLI_SOURCE).not.toContain(LEGACY_TRANSPORT_MODULE);
		expect(CLI_SOURCE).not.toContain(LEGACY_TRANSPORT_INVOCATION);
	});
});
