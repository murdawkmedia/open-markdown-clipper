import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const CONTENT_SOURCE = readFileSync(join(process.cwd(), 'src', 'content.ts'), 'utf8');

describe('content destination integration', () => {
	it('routes Markdown copy and download messages through the shared strict dispatcher', () => {
		expect(CONTENT_SOURCE).toContain('createDocumentDestinationRuntime');
		expect(CONTENT_SOURCE).toContain('dispatchDocumentDestinationMessage');
		expect(CONTENT_SOURCE).not.toContain('request.action === "copyMarkdownToClipboard"');
		expect(CONTENT_SOURCE).not.toContain('request.action === "saveMarkdownToFile"');
		expect(CONTENT_SOURCE).not.toMatch(/import\s+\{\s*saveFile\s*\}/);
	});
});
