// Stubs for browser-only modules used in CLI build.
// These are aliased by esbuild so that transitive imports
// of browser-polyfill and storage-utils resolve without error.

import type { Settings } from '../types/types';

export default {} as any;

export const generalSettings: Settings = {
	betaFeatures: false,
	openBehavior: 'popup',
	highlighterEnabled: false,
	alwaysShowHighlights: false,
	highlightBehavior: 'no-highlights',
	showMoreActionsButton: false,
	propertyTypes: [],
	readerSettings: {
		fontSize: 16,
		lineHeight: 1.5,
		maxWidth: 700,
		lightTheme: 'default',
		darkTheme: 'same',
		appearance: 'auto',
		fonts: [],
		defaultFont: '',
		blendImages: true,
		colorLinks: false,
		followLinks: true,
		pinPlayer: true,
		autoScroll: true,
		highlightActiveLine: true,
		customCss: '',
	},
	stats: {
		clipboard: 0,
		download: 0,
		'custom-uri': 0,
		'local-http': 0,
		share: 0,
	},
	ratings: [],
	defaultDestination: 'download',
	customUriTemplate: '',
	localHttpEndpoint: '',
};

export const loadSettings = async () => {};
export const saveSettings = async () => {};
export const incrementStat = async () => {};
export const getLocalStorage = async () => ({});
export const setLocalStorage = async () => {};
