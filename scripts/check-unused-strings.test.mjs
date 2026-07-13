import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

test('string checker reads the packaged English locale and completes meaningfully', () => {
	const result = spawnSync(process.execPath, [
		join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js'),
		'--project',
		join(process.cwd(), 'scripts', 'tsconfig.json'),
		join(process.cwd(), 'scripts', 'check-unused-strings.ts'),
	], {
		cwd: process.cwd(),
		encoding: 'utf8',
	});

	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /Error checking unused strings/u);
	assert.match(result.stdout, /Statistics:/u);
	assert.match(result.stdout, /Total strings: \d+/u);
});
