import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('generated icons byte-match committed PNGs at every required dimension', async () => {
	const generator = await import('./generate-icons.mjs');
	assert.equal(typeof generator.renderIcon, 'function');

	for (const size of [16, 48, 128]) {
		const rendered = await generator.renderIcon(size);
		const committed = await readFile(resolve(repositoryRoot, `src/icons/icon${size}.png`));
		assert.deepEqual(rendered, committed, `${size}px bytes`);

		const metadata = await sharp(rendered).metadata();
		assert.equal(metadata.width, size, `${size}px width`);
		assert.equal(metadata.height, size, `${size}px height`);
	}
});
