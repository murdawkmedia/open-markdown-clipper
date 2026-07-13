import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileTemplate } from '../template-compiler';
import { generalSettings } from '../storage-utils';
import { processPrompt } from './prompt';

const legacySettings = generalSettings as unknown as Record<string, unknown>;
const retiredEnableKey = ['inter', 'preterEnabled'].join('');
const originalRetiredFlag = legacySettings[retiredEnableKey];

afterEach(() => {
	if (originalRetiredFlag === undefined) delete legacySettings[retiredEnableKey];
	else legacySettings[retiredEnableKey] = originalRetiredFlag;
});

describe('retired prompt syntax', () => {
	it.each([
		'{{"summarize private content"}}',
		'{{prompt:"summarize private content"}}',
		'{{"summarize private content"|trim}}',
	])('deterministically resolves %s to an empty string', async syntax => {
		legacySettings[retiredEnableKey] = true;

		await expect(processPrompt(syntax, { content: 'private content' }, 'https://example.com'))
			.resolves.toBe('');
		await expect(compileTemplate(
			0,
			`before${syntax}after`,
			{ content: 'private content' },
			'https://example.com',
		)).resolves.toBe('beforeafter');
	});

	it('has no storage, browser, or network dependency', () => {
		const source = readFileSync(join(process.cwd(), 'src', 'utils', 'variables', 'prompt.ts'), 'utf8');
		expect(source).not.toContain('storage-utils');
		expect(source).not.toMatch(/\bfetch\b/u);
		expect(source).not.toMatch(/\bbrowser\b/u);
	});
});
