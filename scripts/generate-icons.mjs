import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repositoryRoot, 'assets/source/icon.svg');
const outputDirectory = resolve(repositoryRoot, 'src/icons');
const sizes = [16, 48, 128];

export function renderIcon(size) {
	return sharp(source)
		.resize(size, size)
		.png()
		.toBuffer();
}

export async function generateIcons() {
	await mkdir(outputDirectory, { recursive: true });
	await Promise.all(sizes.map(async (size) => {
		const rendered = await renderIcon(size);
		await writeFile(resolve(outputDirectory, `icon${size}.png`), rendered);
	}));
}

const isMain = process.argv[1]
	&& resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	await generateIcons();
}
