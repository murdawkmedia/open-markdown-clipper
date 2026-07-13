import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	decodeTrackedText,
	formatFindings,
	loadReleaseEntries,
	readTrackedEntry,
	runCli,
	scanEntries,
} from './public-release-scan.mjs';

const publicHomepage = 'https://github.com/murdawkmedia/open-markdown-clipper';
const legacyBrandName = ['Ob', 'sidian'].join('');
const legacyBrandLower = legacyBrandName.toLowerCase();
const legacyTransportPath = `src/utils/${legacyBrandLower}-note-creator.ts`;

function cleanEntries(extra = []) {
	const upstreamRepository = [`${legacyBrandLower}md`, [legacyBrandLower, '-', 'clipper'].join('')].join('/');
	return [
		{ path: 'NOTICE.md', content: `Forked from ${upstreamRepository}.` },
		{ path: 'LICENSE', content: `${legacyBrandName} upstream attribution.` },
		{ path: 'README.md', content: `${legacyBrandName} attribution only.` },
		{
			path: 'package.json',
			content: JSON.stringify({ name: 'open-markdown-clipper' }),
		},
		{
			path: 'package-lock.json',
			content: JSON.stringify({
				packages: { '': { name: 'open-markdown-clipper' } },
				dependencies: {},
			}),
		},
		{
			path: 'src/manifest.chrome.json',
			content: JSON.stringify({
				name: 'Open Markdown Clipper',
				homepage_url: publicHomepage,
			}),
		},
		{
			path: 'src/manifest.firefox.json',
			content: JSON.stringify({
				name: 'Open Markdown Clipper',
				homepage_url: publicHomepage,
				browser_specific_settings: {
					gecko: { id: 'open-markdown-clipper@murdawk.media' },
				},
			}),
		},
		...extra,
	];
}

test('historical attribution is allowed in designated files', () => {
	const extensionId = ['clipper', '@', legacyBrandLower, '.', 'md'].join('');
	const packageName = [legacyBrandLower, '-', 'clipper'].join('');
	const homepage = ['https://', legacyBrandLower, '.md/'].join('');
	const findings = scanEntries(cleanEntries([
		{
			path: 'docs/plans/design.md',
			content: `${extensionId} ${packageName} ${homepage}`,
		},
	]), { mode: 'identity' });

	assert.deepEqual(findings, []);
});

test('active legacy identity and excluded paths are rejected', () => {
	const identifiers = [
		['clipper', '@', legacyBrandLower, '.', 'md'].join(''),
		['md', '.', legacyBrandLower, '.', 'extension'].join(''),
		[legacyBrandLower, '-', 'clipper'].join(''),
		[legacyBrandName, 'Web', 'Clipper'].join(' '),
		['https://', legacyBrandLower, '.md/'].join(''),
	];
	for (const identifier of identifiers) {
		const findings = scanEntries(cleanEntries([
			{ path: 'src/background.ts', content: identifier },
		]), { mode: 'identity' });
		assert.ok(findings.some(({ rule }) => rule === 'legacy-active-identity'), identifier);
	}

	for (const path of [
		'assets/chrome/store.png',
		'assets/edge/store.png',
		'assets/safari/store.png',
		'xcode/project.pbxproj',
		'src/manifest.safari.json',
	]) {
		const findings = scanEntries(cleanEntries([{ path, content: null }]), { mode: 'identity' });
		assert.ok(findings.some(({ rule }) => rule === 'excluded-upstream-asset'), path);
	}
});

test('required public identity is validated without throwing on bad JSON', () => {
	const entries = cleanEntries().filter(({ path }) => path !== 'NOTICE.md');
	entries.find(({ path }) => path === 'package.json').content = '{';
	entries.find(({ path }) => path === 'src/manifest.firefox.json').content = '{}';

	const findings = scanEntries(entries, { mode: 'identity' });

	assert.ok(findings.some(({ rule }) => rule === 'missing-notice'));
	assert.ok(findings.some(({ rule }) => rule === 'invalid-package-identity'));
	assert.ok(findings.some(({ rule }) => rule === 'invalid-firefox-identity'));
});

test('Safari package dependency is rejected in every dependency section', () => {
	for (const dependencySection of [
		'dependencies',
		'devDependencies',
		'optionalDependencies',
		'peerDependencies',
	]) {
		const entries = cleanEntries();
		const packageEntry = entries.find(({ path }) => path === 'package.json');
		const packageJson = JSON.parse(packageEntry.content);
		packageJson[dependencySection] = { '@types/safari-extension': '^0.0.33' };
		packageEntry.content = JSON.stringify(packageJson);

		const findings = scanEntries(entries, { mode: 'identity' });
		assert.ok(
			findings.some(({ rule }) => rule === 'safari-package-dependency'),
			dependencySection,
		);
	}
});

test('Safari package dependency is rejected when stale in package-lock packages', () => {
	const entries = cleanEntries();
	const lockEntry = entries.find(({ path }) => path === 'package-lock.json');
	const packageLock = JSON.parse(lockEntry.content);
	packageLock.packages['node_modules/@types/safari-extension'] = { version: '0.0.33' };
	lockEntry.content = JSON.stringify(packageLock);

	const findings = scanEntries(entries, { mode: 'identity' });
	assert.ok(findings.some(({ path, rule }) => (
		path === 'package-lock.json' && rule === 'safari-package-dependency'
	)));
});

test('Safari package dependency is rejected in a legacy package-lock dependency map', () => {
	const entries = cleanEntries();
	const lockEntry = entries.find(({ path }) => path === 'package-lock.json');
	lockEntry.content = JSON.stringify({
		dependencies: { '@types/safari-extension': { version: '0.0.33' } },
	});

	const findings = scanEntries(entries, { mode: 'identity' });
	assert.ok(findings.some(({ path, rule }) => (
		path === 'package-lock.json' && rule === 'safari-package-dependency'
	)));
});

test('invalid package-lock JSON is reported without throwing', () => {
	const entries = cleanEntries();
	entries.find(({ path }) => path === 'package-lock.json').content = '{';

	const findings = scanEntries(entries, { mode: 'identity' });
	assert.ok(findings.some(({ path, rule }) => (
		path === 'package-lock.json' && rule === 'invalid-package-lock'
	)));
});

test('each browser identity field is required', () => {
	const cases = [
		['src/manifest.chrome.json', ['name'], 'Wrong Name', 'invalid-chrome-identity'],
		['src/manifest.chrome.json', ['homepage_url'], 'https://example.invalid', 'invalid-chrome-identity'],
		['src/manifest.firefox.json', ['name'], 'Wrong Name', 'invalid-firefox-identity'],
		['src/manifest.firefox.json', ['homepage_url'], 'https://example.invalid', 'invalid-firefox-identity'],
		[
			'src/manifest.firefox.json',
			['browser_specific_settings', 'gecko', 'id'],
			'wrong@example.invalid',
			'invalid-firefox-identity',
		],
	];

	for (const [path, keys, value, expectedRule] of cases) {
		const entries = cleanEntries();
		const entry = entries.find((candidate) => candidate.path === path);
		const parsed = JSON.parse(entry.content);
		let target = parsed;
		for (const key of keys.slice(0, -1)) target = target[key];
		target[keys.at(-1)] = value;
		entry.content = JSON.stringify(parsed);

		const findings = scanEntries(entries, { mode: 'identity' });
		assert.ok(
			findings.some(({ rule }) => rule === expectedRule),
			`${path}:${keys.join('.')}`,
		);
	}
});

test('private patterns are rejected even in attribution files', () => {
	const privateName = ['Mur', 'phy', 'OS'].join('');
	const uncPath = `${'\\\\'}server${'\\'}private-share`;
	const privateEndpoint = `endpoint=http://${['192', '168', '1', '10'].join('.')}:9000`;
	const privateKeyMarker = ['BEGIN', 'OPENSSH', 'PRIVATE KEY'].join(' ');
	const credential = `${['api', 'key'].join('_')}=${['abcdefgh', 'ijklmnop', '1234'].join('')}`;
	const findings = scanEntries(cleanEntries([
		{ path: 'README.md', content: `C:\\Users\\Person\\${privateName}` },
		{ path: 'NOTICE.md', content: uncPath },
		{ path: 'LICENSE', content: privateEndpoint },
		{ path: 'docs/plans/security.md', content: privateKeyMarker },
		{ path: 'docs/guide.md', content: credential },
	]), { mode: 'identity' });

	for (const rule of [
		'private-product-name',
		'private-absolute-path',
		'private-unc-path',
		'private-network-endpoint',
		'private-key-material',
		'credential-assignment',
	]) {
		assert.ok(findings.some((finding) => finding.rule === rule), rule);
	}
});

test('private paths and network identifiers are rejected across supported platforms', () => {
	const privateProduct = ['Mur', 'phy', 'OS'].join('');
	const cases = [
		['private-name-in-path', `docs/${privateProduct}/note.md`, 'safe'],
		['forward-slash-windows-home', 'src/config.ts', ['C:', 'Users', 'Person', 'private'].join('/')],
		['macos-home', 'src/config.ts', ['', 'Users', 'Person', 'private'].join('/')],
		['linux-home', 'src/config.ts', ['', 'home', 'person', 'private'].join('/')],
		['link-local-ipv4', 'src/config.ts', `http://${['169', '254', '10', '20'].join('.')}:9000`],
		['private-local-hostname', 'src/config.ts', `http://${['nas', 'local'].join('.')}:9000`],
		['private-ipv6-ula', 'src/config.ts', `http://[${['fd00', '', '1'].join(':')}]:9000`],
	];

	for (const [description, path, content] of cases) {
		const findings = scanEntries(cleanEntries([{ path, content }]), { mode: 'final' });
		assert.notDeepEqual(findings, [], description);
	}
});

test('active legacy branding is rejected outside attribution and migration contexts', () => {
	const legacyBrand = ['Ob', 'sidian'].join('');
	const legacyCssPrefix = ['ob', 'sidian', '-reader-active'].join('');
	const migrationKey = ['add', 'To', 'Ob', 'sidian'].join('');

	for (const content of [
		legacyBrand,
		`.${legacyCssPrefix}`,
		`window.__${legacyBrand.toLowerCase()}Highlighter`,
	]) {
		const findings = scanEntries(cleanEntries([
			{ path: 'src/runtime.ts', content },
		]), { mode: 'final' });
		assert.ok(findings.some(({ rule }) => rule === 'legacy-active-branding'), content);
	}

	assert.deepEqual(scanEntries(cleanEntries([
		{ path: 'README.md', content: `Fork attribution: ${legacyBrand}.` },
		{
			path: 'src/utils/storage-utils.ts',
			content: `if (value === '${migrationKey}') return 'download';`,
		},
	]), { mode: 'final' }), []);

	const disguisedBranding = scanEntries(cleanEntries([{
		path: 'src/utils/storage-utils.ts',
		content: `function ${migrationKey}Transport() {}`,
	}]), { mode: 'final' });
	assert.ok(disguisedBranding.some(({ rule }) => rule === 'legacy-active-branding'));
});

test('final mode rejects retired model-processing surfaces outside history and cleanup', () => {
	const retiredWord = ['inter', 'preter'].join('');
	const retiredStorageKey = [retiredWord, '_settings'].join('');
	const presetStorageKey = ['provider', '_presets'].join('');
	const remotePresetName = ['PROVIDERS', '_URL'].join('');
	const requestFunction = ['send', 'ToLLM'].join('');
	const credentialControl = ['provider', 'api', 'key'].join('-');
	const credentialField = ['api', 'Key'].join('');
	const activeCases = [
		`initialize${retiredWord[0].toUpperCase()}${retiredWord.slice(1)}Settings()`,
		`${requestFunction}()`,
		`const storageKey = '${presetStorageKey}';`,
		`const storageKey = '${retiredStorageKey}';`,
		`const ${remotePresetName} = 'https://example.com/presets.json';`,
		`<input id="${credentialControl}" name="${credentialField}">`,
		`const config = { ${credentialField}: userInput };`,
	];

	for (const content of activeCases) {
		const findings = scanEntries(cleanEntries([
			{ path: 'src/runtime.ts', content },
		]), { mode: 'final' });
		assert.ok(
			findings.some(({ rule }) => rule === 'retired-model-surface'),
			content,
		);
	}

	assert.deepEqual(scanEntries(cleanEntries([
		{ path: 'docs/plans/retired-feature.md', content: activeCases.join('\n') },
		{ path: 'src/utils/storage-utils.ts', content: `remove('${retiredStorageKey}')` },
		{
			path: 'src/utils/i18n-automation.ts',
			content: `class TranslationClient { ${credentialField} = process.env.TRANSLATION_KEY; }`,
		},
	]), { mode: 'final' }), []);

	const disguisedCleanup = scanEntries(cleanEntries([{
		path: 'src/utils/storage-utils.ts',
		content: `function initialize${retiredWord[0].toUpperCase()}${retiredWord.slice(1)}Settings() {}`,
	}]), { mode: 'final' });
	assert.ok(disguisedCleanup.some(({ rule }) => rule === 'retired-model-surface'));
});

test('final mode rejects retired model-processing files', () => {
	const retiredWord = ['inter', 'preter'].join('');
	for (const path of [
		'providers.json',
		`src/utils/${retiredWord}.ts`,
		`src/managers/${retiredWord}-settings.ts`,
		`src/styles/${retiredWord}.scss`,
	]) {
		const findings = scanEntries(cleanEntries([{ path, content: 'export {};' }]), { mode: 'final' });
		assert.ok(findings.some(({ rule }) => rule === 'retired-model-path'), path);
	}
});

test('identity mode rejects active branding and final mode also rejects legacy transport', () => {
	const uri = [legacyBrandLower, '://', 'new'].join('');
	const openFunction = ['open', legacyBrandName, 'Url'].join('');
	const saveFunction = ['saveTo', legacyBrandName].join('');
	const entries = cleanEntries([
		{
			path: 'src/utils/legacy.ts',
			content: `${openFunction}("${uri}"); ${saveFunction}();`,
		},
		{ path: legacyTransportPath, content: 'export {};' },
	]);

	const identityFindings = scanEntries(entries, { mode: 'identity' });
	assert.ok(identityFindings.some(({ rule }) => rule === 'legacy-active-branding'));
	assert.equal(identityFindings.some(({ rule }) => rule === 'legacy-transport'), false);
	const finalFindings = scanEntries(entries, { mode: 'final' });
	assert.ok(finalFindings.some(({ rule }) => rule === 'legacy-active-branding'));
	assert.ok(finalFindings.some(({ rule }) => rule === 'legacy-transport'));
	assert.ok(finalFindings.some(({ rule }) => rule === 'legacy-transport-path'));
});

test('each legacy transport identifier is rejected in final mode', () => {
	const identifiers = [
		[legacyBrandLower, '://', 'new'].join(''),
		['open', legacyBrandName, 'Url'].join(''),
		['saveTo', legacyBrandName].join(''),
	];
	for (const identifier of identifiers) {
		const findings = scanEntries(cleanEntries([
			{ path: 'src/legacy.ts', content: identifier },
		]), { mode: 'final' });
		assert.ok(findings.some(({ rule }) => rule === 'legacy-transport'), identifier);
	}
});

test('retired native-host placeholder is rejected in active source', () => {
	const retiredHost = ['application', 'id'].join('.');
	const findings = scanEntries(cleanEntries([{
		path: 'src/background.ts',
		content: `browser.runtime.${['send', 'NativeMessage'].join('')}('${retiredHost}', request);`,
	}]), { mode: 'final' });

	assert.ok(findings.some(({ path, rule }) => (
		path === 'src/background.ts'
		&& rule === 'retired-native-host-placeholder'
	)));
});

test('the 0.1 release line rejects all unreviewed native messaging surfaces', () => {
	const entries = cleanEntries([{
		path: 'src/utils/native.ts',
		content: `browser.runtime.${['send', 'NativeMessage'].join('')}('com.example.host', request);`,
	}]);
	for (const manifestPath of [
		'src/manifest.chrome.json',
		'src/manifest.firefox.json',
	]) {
		const entry = entries.find(({ path }) => path === manifestPath);
		const manifest = JSON.parse(entry.content);
		manifest.optional_permissions = ['nativeMessaging'];
		entry.content = JSON.stringify(manifest);
	}

	const findings = scanEntries(entries, { mode: 'final' });

	assert.ok(findings.some(({ path, rule }) => (
		path === 'src/utils/native.ts'
		&& rule === 'unreviewed-native-messaging'
	)));
	for (const manifestPath of [
		'src/manifest.chrome.json',
		'src/manifest.firefox.json',
	]) {
		assert.ok(findings.some(({ path, rule }) => (
			path === manifestPath
			&& rule === 'unreviewed-native-messaging-permission'
		)));
	}
});

test('formatted findings expose rules and paths but never matched content', () => {
	const sensitiveValue = ['abcdefgh', 'ijklmnop', '1234'].join('');
	const secret = `${['api', 'key'].join('_')}=${sensitiveValue}`;
	const findings = scanEntries(cleanEntries([
		{ path: 'src/config.ts', content: secret },
	]), { mode: 'identity' });
	const output = formatFindings(findings);

	assert.match(output, /src\/config\.ts/);
	assert.match(output, /credential-assignment/);
	assert.equal(output.includes(sensitiveValue), false);
});

test('binary entries are ignored safely', () => {
	const findings = scanEntries(cleanEntries([
		{ path: 'src/icons/icon16.png', content: null },
	]), { mode: 'identity' });

	assert.deepEqual(findings, []);
});

test('ordinary token variables are not treated as credential assignments', () => {
	const findings = scanEntries(cleanEntries([
		{
			path: 'src/parser.ts',
			content: [
				'const token = advanceTokenizerState(currentState);',
				'const accessToken = await getLocalHttpToken();',
				'const authToken = input.value;',
				'const clientSecret = settings.clientSecret;',
				'useToken({ token });',
				"expect(output).not.toContain('token=');",
			].join('\n'),
		},
	]), { mode: 'identity' });

	assert.deepEqual(findings, []);
});

test('literal plain token assignments are treated as credentials', () => {
	const key = ['to', 'ken'].join('');
	const value = ['abcdefgh', 'ijklmnop', '1234'].join('');
	const findings = scanEntries(cleanEntries([
		{ path: 'src/config.ts', content: `${key} = "${value}";` },
	]), { mode: 'identity' });

	assert.ok(findings.some(({ rule }) => rule === 'credential-assignment'));
});

test('quoted dotted credential literals are never treated as code references', () => {
	const key = ['auth', 'token'].join('_');
	const value = [
		['abcdefgh', 'ijklmnop'].join(''),
		['qrstuvwx', 'yzabcdef'].join(''),
		['ghijklmn', 'opqrstuv'].join(''),
	].join('.');
	const findings = scanEntries(cleanEntries([
		{ path: 'src/config.ts', content: `const ${key} = "${value}";` },
	]), { mode: 'identity' });

	assert.ok(findings.some(({ rule }) => rule === 'credential-assignment'));
});

test('unquoted JavaScript declaration credentials are detected', () => {
	const key = ['sec', 'ret'].join('');
	const value = ['abcdefgh', 'ijklmnop'].join('');
	for (const declaration of ['const', 'let', 'var']) {
		const findings = scanEntries(cleanEntries([
			{ path: 'src/config.ts', content: `${declaration} ${key} = ${value};` },
		]), { mode: 'identity' });

		assert.ok(
			findings.some(({ rule }) => rule === 'credential-assignment'),
			declaration,
		);
	}
});

test('unquoted JavaScript declaration references are not embedded credentials', () => {
	const key = ['access', 'token'].join('_');
	for (const [description, reference] of [
		['environment', 'process.env.LONG_TOKEN_NAME'],
		['member', 'settings.localHttpToken'],
		['function', 'getLocalHttpToken()'],
		['awaited function', 'await getLocalHttpToken()'],
	]) {
		const findings = scanEntries(cleanEntries([
			{ path: 'src/config.ts', content: `const ${key} = ${reference};` },
		]), { mode: 'identity' });

		assert.deepEqual(findings, [], description);
	}
});

test('typed TypeScript, refresh-token, and literal bearer credentials are detected', () => {
	const value = ['abcdefgh', 'ijklmnop', 'qrstuvwx'].join('');
	const cases = [
		`const token: string = "${value}";`,
		`const refreshToken = "${value}";`,
		`const authorization = "Bearer ${value}";`,
	];

	for (const content of cases) {
		const findings = scanEntries(cleanEntries([
			{ path: 'src/config.ts', content },
		]), { mode: 'final' });
		assert.ok(findings.some(({ rule }) => rule === 'credential-assignment'), content);
	}
});

test('code references and neutral instructional prose are not embedded credentials', () => {
	const findings = scanEntries(cleanEntries([
		{
			path: 'src/config.ts',
			content: [
				'const options = {',
				'  token: settings.localHttpToken',
				'};',
				'const refreshToken: PopupRefreshToken = popupRefreshGate.begin(tabId);',
				'  token: PopupRefreshToken,',
				'const store = browser.storage.local;',
			].join('\n'),
		},
		{
			path: 'docs/setup.md',
			content: 'Choose a password: "sixteen characters minimum".',
		},
	]), { mode: 'final' });

	assert.deepEqual(findings, []);
});

test('unquoted lowercase token assignments are treated as credentials', () => {
	const key = ['to', 'ken'].join('');
	const value = ['abcdefgh', 'ijklmnop'].join('');
	const findings = scanEntries(cleanEntries([
		{ path: 'env.local', content: `${key}=${value}` },
	]), { mode: 'identity' });

	assert.ok(findings.some(({ rule }) => rule === 'credential-assignment'));
});

test('unquoted structured-config credentials are treated as credentials', () => {
	const key = ['auth', 'token'].join('_');
	const value = ['abcdefgh', 'ijklmnop'].join('');
	for (const path of ['settings.yaml', 'service.toml', 'client.ini']) {
		const findings = scanEntries(cleanEntries([
			{ path, content: `${key}: ${value}` },
		]), { mode: 'identity' });

		assert.ok(
			findings.some(({ rule }) => rule === 'credential-assignment'),
			path,
		);
	}
});

test('environment credential references are not embedded credentials', () => {
	const key = ['sec', 'ret'].join('');
	const reference = ['process', 'env', 'LONG_SECRET_NAME'].join('.');
	const findings = scanEntries(cleanEntries([
		{ path: 'src/config.ts', content: `${key}=${reference}` },
	]), { mode: 'identity' });

	assert.deepEqual(findings, []);
});

test('scanner paths receive the same legacy checks as active source', () => {
	const extensionId = ['clipper', '@', legacyBrandLower, '.', 'md'].join('');
	const uri = [legacyBrandLower, '://', 'new'].join('');
	const openFunction = ['open', legacyBrandName, 'Url'].join('');
	const saveFunction = ['saveTo', legacyBrandName].join('');
	const findings = scanEntries(cleanEntries([
		{
			path: 'scripts/public-release-scan.test.mjs',
			content: `${extensionId} ${uri} ${openFunction} ${saveFunction}`,
		},
	]), { mode: 'final' });

	assert.ok(findings.some(({ rule }) => rule === 'legacy-active-identity'));
	assert.ok(findings.some(({ rule }) => rule === 'legacy-transport'));
});

test('common credential placeholders are allowed', () => {
	const key = ['api', 'key'].join('_');
	const first = `${key}=${['your', 'api', 'key', 'here'].join('_')}`;
	const second = `password=${['replace', 'me', 'before', 'use'].join('-')}`;
	const findings = scanEntries(cleanEntries([
		{ path: 'env.example', content: `${first}\n${second}` },
	]), { mode: 'identity' });

	assert.deepEqual(findings, []);
});

test('invalid private-looking IPv4 addresses are not findings', () => {
	const address = ['192', '168', '999', '999'].join('.');
	const findings = scanEntries(cleanEntries([
		{ path: 'docs/example.md', content: `http://${address}:99999` },
	]), { mode: 'identity' });

	assert.deepEqual(findings, []);
});

test('malformed entries are ignored safely', () => {
	const findings = scanEntries([
		...cleanEntries(),
		null,
		{},
		{ path: 42, content: 'ignored' },
	], { mode: 'identity' });

	assert.deepEqual(findings, []);
});

test('tracked symlinks are not read', () => {
	let readCalled = false;
	const entry = readTrackedEntry('C:/repo', 'linked.txt', {
		lstat() {
			return { isFile: () => false };
		},
		read() {
			readCalled = true;
			return Buffer.from('private');
		},
	});

	assert.deepEqual(entry, { path: 'linked.txt', content: null });
	assert.equal(readCalled, false);
});

test('release loading includes existing untracked files and omits working-tree deletions', () => {
	let gitArguments;
	const entries = loadReleaseEntries('C:/repo', {
		runGit(_command, args) {
			gitArguments = args;
			return 'tracked.txt\0new.txt\0deleted.txt\0';
		},
		exists(path) {
			return !path.endsWith('deleted.txt');
		},
		readEntry(_root, path) {
			return { path, content: path };
		},
	});

	assert.deepEqual(gitArguments.slice(-5), [
		'ls-files',
		'--cached',
		'--others',
		'--exclude-standard',
		'-z',
	]);
	assert.deepEqual(entries, [
		{ path: 'tracked.txt', content: 'tracked.txt' },
		{ path: 'new.txt', content: 'new.txt' },
	]);
});

test('invalid UTF-8 is treated as binary', () => {
	assert.equal(decodeTrackedText(Buffer.from([0xc3, 0x28])), null);
});

test('CLI failures are content-free', () => {
	const output = [];
	const errors = [];
	const code = runCli([], {
		loadEntries() {
			throw new Error(['C:', 'Users', 'Person', 'private'].join('\\'));
		},
		writeOut(value) { output.push(value); },
		writeErr(value) { errors.push(value); },
	});

	assert.equal(code, 2);
	assert.deepEqual(output, []);
	assert.deepEqual(errors, ['Public release scan could not run.\n']);
});

test('unknown CLI arguments fail with content-free usage', () => {
	const script = fileURLToPath(new URL('./public-release-scan.mjs', import.meta.url));
	const result = spawnSync(process.execPath, [script, '--unknown'], {
		encoding: 'utf8',
	});

	assert.equal(result.status, 2);
	assert.equal(result.stdout, '');
	assert.equal(
		result.stderr,
		'Usage: node scripts/public-release-scan.mjs [--identity]\n',
	);
});
