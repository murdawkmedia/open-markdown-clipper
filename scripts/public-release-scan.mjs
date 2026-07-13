import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const PUBLIC_HOMEPAGE = 'https://github.com/murdawkmedia/open-markdown-clipper';
const ATTRIBUTION_PATHS = new Set(['LICENSE', 'NOTICE.md', 'README.md']);
const EXCLUDED_PATH_PREFIXES = [
	'xcode/',
	'assets/chrome/',
	'assets/edge/',
	'assets/safari/',
];
const PRIVATE_PRODUCT_NAME = ['Mur', 'phy', 'OS'].join('');
const LEGACY_BRAND_NAME = ['Ob', 'sidian'].join('');
const LEGACY_BRAND_LOWER = LEGACY_BRAND_NAME.toLowerCase();
const LEGACY_EXTENSION_ID = ['clipper', '@', LEGACY_BRAND_LOWER, '.', 'md'].join('');
const LEGACY_PACKAGE_NAME = [LEGACY_BRAND_LOWER, '-', 'clipper'].join('');
const LEGACY_MANIFEST_NAME = [LEGACY_BRAND_NAME, 'Web', 'Clipper'].join(' ');
const LEGACY_HOMEPAGE = ['https://', LEGACY_BRAND_LOWER, '.md/'].join('');
const LEGACY_URI_PREFIX = [LEGACY_BRAND_LOWER, '://'].join('');
const LEGACY_OPEN_FUNCTION = ['open', LEGACY_BRAND_NAME, 'Url'].join('');
const LEGACY_SAVE_FUNCTION = ['saveTo', LEGACY_BRAND_NAME].join('');
const LEGACY_TRANSPORT_PATH = `src/utils/${LEGACY_BRAND_LOWER}-note-creator.ts`;
const LEGACY_MIGRATION_KEY = ['add', 'To', 'Ob', 'sidian'].join('');
const LEGACY_MIGRATION_PATHS = new Set([
	'src/utils/clip-stats.ts',
	'src/utils/import-export.test.ts',
	'src/utils/storage-utils.test.ts',
	'src/utils/storage-utils.ts',
]);
const RETIRED_MODEL_WORD = ['inter', 'preter'].join('');
const RETIRED_MODEL_STORAGE_KEY = [RETIRED_MODEL_WORD, '_settings'].join('');
const RETIRED_PRESET_STORAGE_KEY = ['provider', '_presets'].join('');
const RETIRED_MODEL_CLEANUP_PATHS = new Set([
	'src/utils/storage-utils.test.ts',
	'src/utils/storage-utils.ts',
]);
const RETIRED_MODEL_DEV_CREDENTIAL_PATHS = new Set([
	'src/utils/i18n-automation.ts',
]);
const RETIRED_MODEL_API_KEY_PATTERN = new RegExp(['\\bapi', 'Key\\b'].join(''), 'u');
const RETIRED_MODEL_PATHS = new Set([
	'providers.json',
	`src/managers/${RETIRED_MODEL_WORD}-settings.ts`,
	`src/styles/${RETIRED_MODEL_WORD}.scss`,
	`src/utils/${RETIRED_MODEL_WORD}.ts`,
]);
const RETIRED_MODEL_PATTERNS = [
	new RegExp(RETIRED_MODEL_WORD, 'iu'),
	new RegExp(RETIRED_PRESET_STORAGE_KEY, 'u'),
	new RegExp(['PROVIDERS', '_URL'].join(''), 'u'),
	new RegExp(['send', 'ToLLM'].join(''), 'u'),
	new RegExp(['provider', 'api', 'key'].join('[-_]?'), 'iu'),
	new RegExp(['apiKeys', 'Warning'].join(''), 'u'),
	new RegExp(['provider', 'ModelId'].join(''), 'u'),
	new RegExp(['initialize', 'ModelList'].join(''), 'u'),
	new RegExp(['model', 'provider'].join('[-_]'), 'iu'),
	new RegExp(['provider', 'list'].join('[-_]'), 'iu'),
	new RegExp(['model', 'list'].join('[-_]'), 'iu'),
	new RegExp(`name=["']${['api', 'Key'].join('')}["']`, 'iu'),
];
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function finding(path, rule) {
	return { path, rule };
}

function isAttributionPath(path) {
	return ATTRIBUTION_PATHS.has(path)
		|| path.startsWith('docs/plans/')
		|| path.startsWith('docs/superpowers/plans/');
}

function isHistoricalPlanPath(path) {
	return path.startsWith('docs/plans/')
		|| path.startsWith('docs/superpowers/plans/');
}

function isPlaceholder(value) {
	return /^(?:placeholder|example|sample|test|changeme|your[-_]|replace[-_]|insert[-_]|dummy|fake|x{4}|0{4}|<|\$\{|\{\{)/u.test(value.toLowerCase());
}

function isCredentialReference(value, allowMemberReference) {
	const normalized = value.replace(/^await[\t ]+/iu, '');
	return /^(?:process\.env\.|import\.meta\.env\.|os\.environ|env\[|getenv\(|[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\()/iu.test(normalized)
		|| (
			allowMemberReference
			&& (
				/^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+$/iu.test(normalized)
				|| /^[A-Z_$][\w$]*$/u.test(normalized)
			)
		);
}

const CREDENTIAL_NAME = '(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|consumer[_-]?secret|secret|password|passwd|token|authorization)';

function isCredentialLiteral(value) {
	const trimmed = value.trim().replace(/[,;][\t ]*$/u, '');
	const quoted = /^(?:["'])(.*)(?:["'])$/u.exec(trimmed);
	const candidate = quoted ? quoted[1] : trimmed;
	const bearer = /^Bearer[\t ]+([^\s]{16,})$/iu.exec(candidate);
	if (bearer) return !isPlaceholder(bearer[1]);
	return candidate.length >= 16
		&& !/[\t ]/u.test(candidate)
		&& !isPlaceholder(candidate);
}

function hasCredentialAssignment(path, content) {
	const quotedPattern = new RegExp(
		`\\b${CREDENTIAL_NAME}\\b\\s*[:=]\\s*["']([^"'\\r\\n]{16,})["']`,
		'giu',
	);
	if ([...content.matchAll(quotedPattern)].some((match) => isCredentialLiteral(match[1]))) {
		return true;
	}

	const declarationPattern = new RegExp(
		`^[\\t ]*(?:const|let|var)[\\t ]+${CREDENTIAL_NAME}[\\t ]*(?::[^=\\r\\n]+)?=[\\t ]*(.+?)[\\t ]*$`,
		'iu',
	);
	const assignmentPattern = new RegExp(
		`^[\\t ]*["']?${CREDENTIAL_NAME}["']?[\\t ]*[:=][\\t ]*(.+?)[\\t ]*$`,
		'iu',
	);
	const sourceCode = /\.[cm]?[jt]sx?$/iu.test(path);
	for (const line of content.split(/\r?\n/u)) {
		const declaration = declarationPattern.exec(line);
		const assignment = declaration ?? assignmentPattern.exec(line);
		if (!assignment) continue;
		const rawValue = assignment[1]
			.replace(/[\t ]*(?:\/\/|#).*$/u, '')
			.trim();
		if (
			isCredentialLiteral(rawValue)
			&& !isCredentialReference(
				rawValue.replace(/[,;][\t ]*$/u, ''),
				Boolean(declaration) || sourceCode,
			)
		) {
			return true;
		}
	}
	return false;
}

function hasPrivateNetworkEndpoint(content) {
	const pattern = /(?:https?:\/\/)?(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/giu;
	for (const match of content.matchAll(pattern)) {
		const octets = match[1].split('.').map(Number);
		const port = match[2] === undefined ? null : Number(match[2]);
		if (octets.some((octet) => octet > 255) || (port !== null && port > 65535)) {
			continue;
		}
		const [first, second] = octets;
		if (
			first === 10
			|| (first === 172 && second >= 16 && second <= 31)
			|| (first === 192 && second === 168)
			|| (first === 169 && second === 254)
		) {
			return true;
		}
	}
	return /\bhttps?:\/\/[a-z0-9][a-z0-9.-]*\.(?:local|lan)(?::\d{1,5})?\b/iu.test(content)
		|| /\[?(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]+\]?/iu.test(content);
}

function scanPrivateContent(path, content, findings) {
	const rules = [
		['private-product-name', new RegExp(PRIVATE_PRODUCT_NAME, 'iu')],
		['private-absolute-path', /(?:[a-z]:[\\/]Users[\\/]|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)[^\s"'<>]*/iu],
		['private-unc-path', /\\\\[a-z0-9.-]+\\[^\s\\/]+(?:\\[^\s"'<>]+)?/iu],
		['private-key-material', /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/iu],
	];
	for (const [rule, pattern] of rules) {
		if (pattern.test(content)) {
			findings.push(finding(path, rule));
		}
	}
	if (hasPrivateNetworkEndpoint(content)) {
		findings.push(finding(path, 'private-network-endpoint'));
	}
	if (hasCredentialAssignment(path, content)) {
		findings.push(finding(path, 'credential-assignment'));
	}
}

function scanPrivatePath(path, findings) {
	if (new RegExp(PRIVATE_PRODUCT_NAME, 'iu').test(path)) {
		findings.push(finding(path, 'private-product-name'));
	}
	if (/(?:[a-z]:[\\/]Users[\\/]|(?:^|\/)Users\/[^/]+\/|(?:^|\/)home\/[^/]+\/)/iu.test(path)) {
		findings.push(finding(path, 'private-absolute-path'));
	}
}

function withoutAllowedLegacyMigrationKey(path, content) {
	if (!LEGACY_MIGRATION_PATHS.has(path)) return content;
	return content.replace(
		new RegExp(`\\b${LEGACY_MIGRATION_KEY}\\b`, 'gu'),
		'',
	);
}

function withoutAllowedRetiredModelCleanup(path, content) {
	if (!RETIRED_MODEL_CLEANUP_PATHS.has(path)) return content;
	return content
		.replaceAll(RETIRED_MODEL_STORAGE_KEY, '')
		.replaceAll(RETIRED_PRESET_STORAGE_KEY, '');
}

function parseJson(entriesByPath, path, findings, rule) {
	const content = entriesByPath.get(path);
	if (typeof content !== 'string') {
		findings.push(finding(path, rule));
		return null;
	}
	try {
		const parsed = JSON.parse(content);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new TypeError('JSON root must be an object');
		}
		return parsed;
	} catch {
		findings.push(finding(path, rule));
		return null;
	}
}

function scanRequiredIdentity(entriesByPath, findings) {
	if (!entriesByPath.has('NOTICE.md')) {
		findings.push(finding('NOTICE.md', 'missing-notice'));
	}

	const packageJson = parseJson(
		entriesByPath,
		'package.json',
		findings,
		'invalid-package-identity',
	);
	if (packageJson && packageJson.name !== 'open-markdown-clipper') {
		findings.push(finding('package.json', 'invalid-package-identity'));
	}
	if (
		packageJson
		&& [
			'dependencies',
			'devDependencies',
			'optionalDependencies',
			'peerDependencies',
		].some((dependencySection) => (
			Object.hasOwn(packageJson[dependencySection] ?? {}, '@types/safari-extension')
		))
	) {
		findings.push(finding('package.json', 'safari-package-dependency'));
	}

	const packageLock = parseJson(
		entriesByPath,
		'package-lock.json',
		findings,
		'invalid-package-lock',
	);
	if (
		packageLock
		&& (
			Object.keys(packageLock.packages ?? {}).some((path) => (
				path === 'node_modules/@types/safari-extension'
				|| path.endsWith('/node_modules/@types/safari-extension')
			))
			|| Object.hasOwn(
				packageLock.dependencies ?? {},
				'@types/safari-extension',
			)
		)
	) {
		findings.push(finding('package-lock.json', 'safari-package-dependency'));
	}

	const chrome = parseJson(
		entriesByPath,
		'src/manifest.chrome.json',
		findings,
		'invalid-chrome-identity',
	);
	if (
		chrome
		&& (chrome.name !== 'Open Markdown Clipper'
			|| chrome.homepage_url !== PUBLIC_HOMEPAGE)
	) {
		findings.push(finding('src/manifest.chrome.json', 'invalid-chrome-identity'));
	}

	const firefox = parseJson(
		entriesByPath,
		'src/manifest.firefox.json',
		findings,
		'invalid-firefox-identity',
	);
	if (
		firefox
		&& (firefox.name !== 'Open Markdown Clipper'
			|| firefox.homepage_url !== PUBLIC_HOMEPAGE
			|| firefox.browser_specific_settings?.gecko?.id
				!== 'open-markdown-clipper@murdawk.media')
	) {
		findings.push(finding('src/manifest.firefox.json', 'invalid-firefox-identity'));
	}
}

export function scanEntries(entries, { mode }) {
	if (mode !== 'identity' && mode !== 'final') {
		throw new TypeError('mode must be identity or final');
	}
	const findings = [];
	const entriesByPath = new Map();
	for (const entry of entries) {
		if (!entry || typeof entry.path !== 'string') {
			continue;
		}
		entriesByPath.set(entry.path, entry.content);
		scanPrivatePath(entry.path, findings);
		if (typeof entry.content === 'string') {
			scanPrivateContent(entry.path, entry.content, findings);
		}
	}

	for (const [path, content] of entriesByPath) {
		if (
			path === 'src/manifest.safari.json'
			|| EXCLUDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
		) {
			findings.push(finding(path, 'excluded-upstream-asset'));
		}
		if (
			mode === 'final'
			&& typeof content === 'string'
			&& !isHistoricalPlanPath(path)
			&& (() => {
				const activeContent = withoutAllowedRetiredModelCleanup(path, content);
				return RETIRED_MODEL_PATTERNS.some((pattern) => pattern.test(activeContent))
					|| (
						!RETIRED_MODEL_DEV_CREDENTIAL_PATHS.has(path)
						&& RETIRED_MODEL_API_KEY_PATTERN.test(activeContent)
					);
			})()
		) {
			findings.push(finding(path, 'retired-model-surface'));
		}
		if (typeof content !== 'string' || isAttributionPath(path)) {
			continue;
		}
		if (new RegExp(LEGACY_BRAND_NAME, 'iu').test(
			withoutAllowedLegacyMigrationKey(path, content),
		)) {
			findings.push(finding(path, 'legacy-active-branding'));
		}
		if (
			content.includes(LEGACY_EXTENSION_ID)
			|| new RegExp(`md\\.${LEGACY_BRAND_LOWER}\\.`, 'iu').test(content)
			|| content.includes(LEGACY_PACKAGE_NAME)
			|| content.includes(LEGACY_MANIFEST_NAME)
			|| content.includes(LEGACY_HOMEPAGE)
		) {
			findings.push(finding(path, 'legacy-active-identity'));
		}
		if (
			mode === 'final'
			&& (
				content.includes(LEGACY_URI_PREFIX)
				|| content.includes(LEGACY_OPEN_FUNCTION)
				|| content.includes(LEGACY_SAVE_FUNCTION)
			)
		) {
			findings.push(finding(path, 'legacy-transport'));
		}
	}

	if (mode === 'final' && entriesByPath.has(LEGACY_TRANSPORT_PATH)) {
		findings.push(finding(
			LEGACY_TRANSPORT_PATH,
			'legacy-transport-path',
		));
	}
	if (mode === 'final') {
		for (const path of RETIRED_MODEL_PATHS) {
			if (entriesByPath.has(path)) {
				findings.push(finding(path, 'retired-model-path'));
			}
		}
	}

	scanRequiredIdentity(entriesByPath, findings);
	return findings.sort((left, right) => (
		left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule)
	));
}

export function formatFindings(findings) {
	return findings.map(({ path, rule }) => `${path}: ${rule}`).join('\n');
}

export function decodeTrackedText(bytes) {
	if (bytes.includes(0)) {
		return null;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function readTrackedEntry(
	repositoryRoot,
	path,
	{ lstat = lstatSync, read = readFileSync } = {},
) {
	const absolutePath = join(repositoryRoot, path);
	try {
		if (!lstat(absolutePath).isFile()) {
			return { path, content: null };
		}
		return { path, content: decodeTrackedText(read(absolutePath)) };
	} catch {
		return { path, content: null };
	}
}

export function loadReleaseEntries(
	repositoryRoot,
	{
		runGit = execFileSync,
		exists = existsSync,
		readEntry = readTrackedEntry,
	} = {},
) {
	const output = runGit('git', [
		'-C',
		repositoryRoot,
		'ls-files',
		'--cached',
		'--others',
		'--exclude-standard',
		'-z',
	], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return output
		.split('\0')
		.filter(Boolean)
		.filter((path) => exists(join(repositoryRoot, path)))
		.map((path) => readEntry(repositoryRoot, path));
}

export function runCli(
	argv,
	{
		loadEntries = () => loadReleaseEntries(REPOSITORY_ROOT),
		writeOut = (value) => process.stdout.write(value),
		writeErr = (value) => process.stderr.write(value),
	} = {},
) {
	let mode = 'final';
	if (argv.length === 1 && argv[0] === '--identity') {
		mode = 'identity';
	} else if (argv.length !== 0) {
		writeErr('Usage: node scripts/public-release-scan.mjs [--identity]\n');
		return 2;
	}
	try {
		const findings = scanEntries(loadEntries(), { mode });
		if (findings.length > 0) {
			writeErr(`${formatFindings(findings)}\n`);
			return 1;
		}
		writeOut(`Public release ${mode} scan passed.\n`);
		return 0;
	} catch {
		writeErr('Public release scan could not run.\n');
		return 2;
	}
}

const isMain = process.argv[1]
	&& resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	process.exitCode = runCli(process.argv.slice(2));
}
