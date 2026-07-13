const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const createWebpackConfig = require('../webpack.config.js');

function configFor(browser) {
	const [config] = createWebpackConfig({ BROWSER: browser }, { mode: 'production' });
	return config;
}

test('missing, unknown, and Safari browser targets are rejected', () => {
	for (const [label, env] of [
		['missing', undefined],
		['unknown', { BROWSER: 'edge' }],
		['safari', { BROWSER: 'safari' }],
	]) {
		assert.throws(
			() => createWebpackConfig(env, { mode: 'production' }),
			/BROWSER must be one of: chrome, firefox/u,
			label,
		);
	}
});

test('Chrome and Firefox targets return the intended output configurations', () => {
	for (const [browser, outputDirectory, manifest] of [
		['chrome', 'dist', 'src/manifest.chrome.json'],
		['firefox', 'dist_firefox', 'src/manifest.firefox.json'],
	]) {
		const config = configFor(browser);
		assert.equal(path.basename(config.output.path), outputDirectory);
		const copyPlugin = config.plugins.find(({ patterns }) => Array.isArray(patterns));
		assert.ok(copyPlugin, `${browser} CopyPlugin`);
		assert.ok(copyPlugin.patterns.some(({ from, to }) => (
			from === manifest && to === 'manifest.json'
		)), `${browser} manifest`);
	}
});

test('both browser targets copy license and notice provenance into their archives', () => {
	for (const browser of ['chrome', 'firefox']) {
		const config = configFor(browser);
		const copyPlugin = config.plugins.find(({ patterns }) => Array.isArray(patterns));
		const copies = new Map(copyPlugin.patterns.map((pattern) => (
			[`${pattern.from}:${pattern.to}`, pattern]
		)));
		assert.equal(copies.get('LICENSE:LICENSE')?.toType, 'file', `${browser} LICENSE`);
		assert.equal(copies.get('NOTICE.md:NOTICE.md')?.toType, 'file', `${browser} NOTICE.md`);
	}
});

test('verification and packing leave the declared npm artifacts intact', () => {
	const packageJson = JSON.parse(readFileSync(
		path.join(__dirname, '..', 'package.json'),
		'utf8',
	));
	assert.deepEqual(packageJson.files, [
		'dist/cli.cjs',
		'dist/api.mjs',
		'NOTICE.md',
	]);
	for (const scriptName of ['verify', 'prepack']) {
		const steps = packageJson.scripts[scriptName]?.split(' && ') ?? [];
		const browserBuild = steps.indexOf('npm run build');
		const cliBuild = steps.indexOf('npm run build:cli');
		const apiBuild = steps.indexOf('npm run build:api');
		assert.ok(browserBuild >= 0, `${scriptName} browser build`);
		assert.ok(cliBuild > browserBuild, `${scriptName} CLI build order`);
		assert.ok(apiBuild > cliBuild, `${scriptName} API build order`);
	}
	assert.equal(packageJson.scripts.prepublishOnly, undefined);
});
