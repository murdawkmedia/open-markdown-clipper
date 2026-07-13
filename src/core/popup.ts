import dayjs from 'dayjs';
import { Template, Property } from '../types/types';
import { incrementStat } from '../utils/storage-utils';
import { generateFrontmatter } from '../utils/frontmatter';
import { extractPageContent, initializePageContent } from '../utils/content-extractor';
import { compileTemplate } from '../utils/template-compiler';
import { initializeIcons, getPropertyTypeIcon } from '../icons/icons';
import { findMatchingTemplate, initializeTriggers } from '../utils/triggers';
import { getLocalStorage, setLocalStorage, loadSettings, generalSettings, Settings } from '../utils/storage-utils';
import { escapeHtml, unescapeValue } from '../utils/string-utils';
import { loadTemplates, createDefaultTemplate } from '../managers/template-manager';
import browser from '../utils/browser-polyfill';
import { addBrowserClassToHtml, detectBrowser } from '../utils/browser-detection';
import { createElementWithClass } from '../utils/dom-utils';
import { adjustNoteNameHeight } from '../utils/ui-utils';
import { debugLog } from '../utils/debug';
import { showVariables, initializeVariablesPanel, updateVariablesPanel } from '../managers/inspect-variables';
import { isBlankPage, isValidUrl, isRestrictedUrl } from '../utils/active-tab-manager';
import { memoizeWithExpiration } from '../utils/memoize';
import { debounce } from '../utils/debounce';
import { sanitizeFileName } from '../utils/string-utils';
import { saveFile } from '../utils/file-utils';
import { copyToClipboard } from '../utils/clipboard-utils';
import { getLocalHttpToken } from '../utils/destination-secrets';
import {
	createDataConsentController,
	DataConsentPermissionsApi,
} from '../utils/data-consent';
import { translatePage, getMessage, setupLanguageAndDirection } from '../utils/i18n';
import { formatPropertyValue } from '../utils/shared';
import {
	captureStablePopupSnapshot,
	createPopupDestinationDelivery,
	createRefreshReadinessGate,
	PopupDestinationDelivery,
	PopupRefreshToken,
} from './popup-delivery';
import {
	createQuickClipPopupDispatcher,
	parseQuickClipPopupContext,
} from './quick-clip-popup';

interface ReaderModeResponse {
	success: boolean;
	isActive: boolean;
}

let loadedSettings: Settings;
let currentTemplate: Template | null = null;
let templates: Template[] = [];
let currentVariables: { [key: string]: string } = {};
let currentTabId: number | undefined;
let popupDestinationDelivery: PopupDestinationDelivery | null = null;
const popupRefreshGate = createRefreshReadinessGate(
	ready => popupDestinationDelivery?.setReady(ready),
);
let popupRefreshQueue: Promise<void> = Promise.resolve();
const popupDataConsentController = createDataConsentController(
	browser.permissions as unknown as DataConsentPermissionsApi,
);
const popupDataConsentPrime = popupDataConsentController.prime();

const isSidePanel = window.location.pathname.includes('side-panel.html');
const urlParams = new URLSearchParams(window.location.search);
const isIframe = urlParams.get('context') === 'iframe';
const parsedQuickClipPopupContext = parseQuickClipPopupContext(window.location.search);
const quickClipPopupContext = !isSidePanel && !isIframe
	? parsedQuickClipPopupContext
	: undefined;
const isDedicatedQuickClipPopup = quickClipPopupContext !== undefined;
const quickClipMessageDispatcher = createQuickClipPopupDispatcher({
	context: quickClipPopupContext,
	getController: () => popupDestinationDelivery,
});

// Memoize compileTemplate with a short expiration and URL-sensitive key
const memoizedCompileTemplate = memoizeWithExpiration(
	async (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) => {
		return compileTemplate(tabId, template, variables, currentUrl);
	},
	{
		expirationMs: 5000,
		keyFn: (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) =>
			`${tabId}-${template}-${currentUrl}`
	}
);

// Memoize generateFrontmatter with a longer expiration
const memoizedGenerateFrontmatter = memoizeWithExpiration(
	async (properties: Property[]) => {
		return generateFrontmatter(properties);
	},
	{ expirationMs: 5000 }
);

function getPropertiesFromDOM(): Property[] {
	return Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
		const inputElement = input as HTMLInputElement;
		return {
			id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
			name: inputElement.id,
			value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
		};
	}) as Property[];
}

// Helper function to get tab info from background script
async function getTabInfo(tabId: number): Promise<{ id: number; url: string }> {
	const response = await browser.runtime.sendMessage({ action: "getTabInfo", tabId }) as { success?: boolean; tab?: { id: number; url: string }; error?: string };
	if (!response || !response.success || !response.tab) {
		throw new Error((response && response.error) || 'Failed to get tab info');
	}
	// On the reader page, tabs.get() can't see the extension page URL
	// without the tabs permission. Fall back to the readerUrl param
	// passed through the iframe src.
	if (!response.tab.url) {
		const readerUrl = urlParams.get('readerUrl');
		if (readerUrl) {
			response.tab.url = readerUrl;
		}
	}
	return response.tab;
}

// Helper function to get current tab URL and title for stats
async function getCurrentTabInfo(): Promise<{ url: string; title?: string }> {
	if (currentTabId === undefined) {
		return { url: '' };
	}
	
	try {
		const tab = await getTabInfo(currentTabId);
		// Try to get the title from the extracted content if available
		const extractedData = await memoizedExtractPageContent(currentTabId);
		return { 
			url: tab.url, 
			title: extractedData?.title || document.title 
		};
	} catch (error) {
		console.warn('Failed to get current tab info for stats:', error);
		return { url: '' };
	}
}

// Memoize extractPageContent with URL-sensitive key
const memoizedExtractPageContent = memoizeWithExpiration(
	async (tabId: number) => {
		await getTabInfo(tabId);
		return extractPageContent(tabId);
	},
	{
		expirationMs: 5000,
		keyFn: async (tabId: number) => {
			const tab = await getTabInfo(tabId);
			return `${tabId}-${tab.url}`;
		}
	}
);

// Width is used to update the note name field height
let previousWidth = window.innerWidth;

function setPopupDimensions() {
	// Get the actual height of the popup after the browser has determined its maximum
	const actualHeight = document.documentElement.offsetHeight;
	
	// Calculate the viewport height and width
	const viewportHeight = window.innerHeight;
	const viewportWidth = window.innerWidth;
	
	// Use the smaller of the two heights
	const finalHeight = Math.min(actualHeight, viewportHeight);
	
	// Set the --popup-height CSS variable to the final height
	document.documentElement.style.setProperty('--chromium-popup-height', `${finalHeight}px`);

	// Check if the width has changed
	if (viewportWidth !== previousWidth) {
		previousWidth = viewportWidth;
		
		// Adjust the note name field height
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
		if (noteNameField) {
			adjustNoteNameHeight(noteNameField);
		}
	}
}

const debouncedSetPopupDimensions = debounce(setPopupDimensions, 100); // 100ms delay

async function initializeExtension(tabId: number) {
	try {
		// Initialize translations
		await translatePage();
		
		// Setup language and RTL support
		await setupLanguageAndDirection();
		
		// First, add the browser class to allow browser-specific styles to apply
		await addBrowserClassToHtml();
		
		// Set an initial large height to allow the browser to determine the maximum height
		// This is necessary for browsers that allow scaling the popup via page zoom
		document.documentElement.style.setProperty('--chromium-popup-height', '2000px');
		
		// Use setTimeout to ensure the DOM has updated before we measure
		setTimeout(() => {
			setPopupDimensions();
		}, 0);

		debugLog('Settings', 'General settings:', loadedSettings);

		templates = await loadTemplates();
		debugLog('Templates', 'Loaded templates:', templates);

		if (templates.length === 0) {
			console.error('No templates loaded');
			return false;
		}

		// Initialize triggers to speed up template matching
		initializeTriggers(templates);

		currentTemplate = templates[0];
		debugLog('Templates', 'Current template set to:', currentTemplate);

		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}
		if (isRestrictedUrl(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}

		// Setup message listeners
		setupMessageListeners();
		setupStorageListeners();

		await checkHighlighterModeState(tabId);

		return true;
	} catch (error) {
		console.error('Error initializing extension:', error);
		showError('failedToInitialize');
		return false;
	}
}

const debouncedHighlightRefresh = debounce(() => {
	if (currentTabId !== undefined) {
		memoizedExtractPageContent.clear();
		memoizedCompileTemplate.clear();
		refreshFields(currentTabId, { checkTemplateTriggers: false, rebuildSkeleton: false });
	}
}, 300);

function setupStorageListeners() {
	browser.storage.onChanged.addListener((changes, areaName) => {
		if (areaName === 'local' && changes.highlights) {
			debouncedHighlightRefresh();
		}
		if (areaName !== 'sync' || !changes.general_settings || !popupDestinationDelivery) {
			return;
		}

		const value = changes.general_settings.newValue;
		if (!value || typeof value !== 'object') return;
		const settings = value as Record<string, unknown>;
		const destination = settings.defaultDestination;
		const defaultDestination = (
			destination === 'clipboard'
			|| destination === 'download'
			|| destination === 'custom-uri'
			|| destination === 'local-http'
		) ? destination : loadedSettings.defaultDestination;
		const customUriTemplate = typeof settings.customUriTemplate === 'string'
			? settings.customUriTemplate.slice(0, 2048)
			: loadedSettings.customUriTemplate;
		const localHttpEndpoint = typeof settings.localHttpEndpoint === 'string'
			? settings.localHttpEndpoint.slice(0, 2048)
			: loadedSettings.localHttpEndpoint;

		loadedSettings.defaultDestination = defaultDestination;
		loadedSettings.customUriTemplate = customUriTemplate;
		loadedSettings.localHttpEndpoint = localHttpEndpoint;
		popupDestinationDelivery.updateConfiguration({
			defaultDestination,
			preferences: { customUriTemplate, localHttpEndpoint },
		});
	});
}

function setupMessageListeners() {
	browser.runtime.onMessage.addListener((request: any, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void) => {
		const quickClipResult = quickClipMessageDispatcher(request, sendResponse);
		if (quickClipResult === true) return true;

		if (request.action === "tabUrlChanged") {
			if (request.tabId === currentTabId) {
				if (currentTabId !== undefined) {
					refreshFields(currentTabId);
				}
			}
		} else if (request.action === "activeTabChanged") {
			// Only handle active tab changes if we're in side panel mode, not iframe mode
			if (!isIframe && !isDedicatedQuickClipPopup) {
				currentTabId = request.tabId;
				popupRefreshGate.begin(request.tabId);
				if (request.isRestrictedUrl) {
					showError('pageCannotBeClipped');
				} else if (request.isValidUrl) {
					if (currentTabId !== undefined) {
						refreshFields(currentTabId); // Force template check when URL changes
					}
				} else if (request.isBlankPage) {
					showError('pageCannotBeClipped');
				} else {
					showError('onlyHttpSupported');
				}
			}
		} else if (request.action === "updatePopupHighlighterUI") {
			// This message is now handled by checkHighlighterModeState
		} else if (request.action === "highlighterModeChanged") {
			// This message is now handled by checkHighlighterModeState
		}
	});
}

document.addEventListener('DOMContentLoaded', async function() {
	loadedSettings = await loadSettings();
	if (isIframe) {
		document.documentElement.classList.add('is-reader-panel');
	}

	const isSidePanel = document.documentElement.classList.contains('is-side-panel');

	try {
		// Dedicated Quick Clip launches remain bound to the command's source tab.
		const response = quickClipPopupContext
			? { tabId: quickClipPopupContext.tabId }
			: await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
		if (!response || ('error' in response && response.error) || response.tabId === undefined) {
			showError(getMessage('pleaseReload'));
			return;
		}
		
		currentTabId = response.tabId;
		const tab = await getTabInfo(currentTabId);
		const currentBrowser = await detectBrowser();
		const isMobile = currentBrowser === 'mobile-safari';

		const openBehavior: Settings['openBehavior'] = isMobile && loadedSettings.openBehavior !== 'reader' ? 'popup' : loadedSettings.openBehavior;

		// Check if we should open in reader mode
		if (isValidUrl(tab.url) && !isBlankPage(tab.url) && openBehavior === 'reader' && !isIframe && !isSidePanel && !isDedicatedQuickClipPopup) {
			try {
				const response = await browser.runtime.sendMessage({
					action: "toggleReaderMode",
					tabId: currentTabId
				}) as ReaderModeResponse;
				if (response && response.success) {
					window.close();
					return;
				}
			} catch (error) {
				console.error('Error toggling reader mode:', error);
				// If there's an error, we'll fall through and open the normal popup.
			}
		}

		// Connect to the background script for communication
		browser.runtime.connect({ name: 'popup' });

		// Setup event listeners for popup buttons
		const refreshButton = document.getElementById('refresh-pane');
		if (refreshButton) {
			if (isIframe) {
				refreshButton.style.display = 'none';
			} else {
				refreshButton.addEventListener('click', (e) => {
					e.preventDefault();
					refreshPopup();
					initializeIcons(refreshButton);
				});
			}
		}
		const settingsButton = document.getElementById('open-settings');
		if (settingsButton) {
			settingsButton.addEventListener('click', async function() {
				try {
					await browser.runtime.sendMessage({ action: "openOptionsPage" });
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error opening options page:', error);
				}
			});
			initializeIcons(settingsButton);
		}

		// Initialize the rest of the popup
		if (currentTabId !== undefined) {
			const initialized = await initializeExtension(currentTabId);
			if (!initialized) {
				return;
			}

			try {
				// DOM-dependent initializations
				populateTemplateDropdown();
				setupEventListeners(currentTabId);
				await popupDataConsentPrime;
				popupDestinationDelivery = createPopupDestinationDelivery({
					document,
					defaultDestination: loadedSettings.defaultDestination,
					preferences: {
						customUriTemplate: loadedSettings.customUriTemplate,
						localHttpEndpoint: loadedSettings.localHttpEndpoint,
					},
					getSnapshot: capturePopupSnapshot,
					getToken: getLocalHttpToken,
					dataConsent: popupDataConsentController,
					copy: copyToClipboard,
					save: options => saveFile({ ...options, tabId: currentTabId }),
					sendRuntimeMessage: message => browser.runtime.sendMessage(message),
					fetchImpl: globalThis.fetch.bind(globalThis),
					recordSuccess: (destination, sourceUrl, title) =>
						incrementStat(destination, sourceUrl, title),
					now: () => new Date(),
					getMessage,
					initializeIcons,
					closePopup: () => window.close(),
					canClosePopup: !isSidePanel && !isIframe,
				});
				await initializeUI();

				const showMoreActionsButton = document.getElementById('show-variables');
				if (showMoreActionsButton) {
					showMoreActionsButton.addEventListener('click', (e) => {
						e.preventDefault();
						showVariables();
					});
				}

				// Initial content load
				await refreshFields(currentTabId);
			} catch (error) {
				console.error('Error initializing popup:', error);
				showError(getMessage('pleaseReload'));
			}
		} else {
			showError(getMessage('pleaseReload'));
		}
	} catch (error) {
		console.error('Error getting active tab:', error);
		showError(getMessage('pleaseReload'));
	}
});

function setupEventListeners(tabId: number) {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown) {
		templateDropdown.addEventListener('change', function(this: HTMLSelectElement) {
			handleTemplateChange(this.value);
		});
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.addEventListener('input', () => adjustNoteNameHeight(noteNameField));
		noteNameField.addEventListener('keydown', function(e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
			}
		});
	}

	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		highlighterModeButton.addEventListener('click', () => toggleHighlighterMode(tabId));
	}

	const readerPanelCloseButton = document.getElementById('reader-panel-close');
		if (readerPanelCloseButton) {
			readerPanelCloseButton.addEventListener('click', async function() {
				try {
					await browser.runtime.sendMessage({ action: 'toggleReaderSidePanel' });
					setTimeout(() => window.close(), 50);
				} catch {
					// The background rejects non-reader and non-extension senders.
				}
			});
		}

	const moreButton = document.getElementById('more-btn');
	const moreDropdown = document.getElementById('more-dropdown');

	if (moreButton && moreDropdown) {
		moreButton.addEventListener('click', (e) => {
			e.stopPropagation();
			moreDropdown.classList.toggle('show');
		});

		// Close dropdown when clicking outside
		document.addEventListener('click', (e) => {
			if (!moreButton.contains(e.target as Node)) {
				moreDropdown.classList.remove('show');
			}
		});
	}

	const shareButtons = document.querySelectorAll('.share-content');
	if (shareButtons) {
		shareButtons.forEach(button => {
			button.addEventListener('click', async (e) => {
				// Get content synchronously
				const properties = getPropertiesFromDOM();

				const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
				
				// Use Promise.all to prepare the data
				Promise.all([
					generateFrontmatter(properties),
					Promise.resolve(noteContentField.value)
				]).then(([frontmatter, noteContent]) => {
					const fileContent = frontmatter + noteContent;
					
					// Call share directly from the click handler
					const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
					let fileName = noteNameField?.value || 'untitled';
					fileName = sanitizeFileName(fileName);
					if (!fileName.toLowerCase().endsWith('.md')) {
						fileName += '.md';
					}

					if (navigator.share && navigator.canShare) {
						const blob = new Blob([fileContent], { type: 'text/markdown;charset=utf-8' });
						const file = new File([blob], fileName, { type: 'text/markdown;charset=utf-8' });
						
						const shareData = {
							files: [file],
							text: 'Shared from Open Markdown Clipper'
						};

						if (navigator.canShare(shareData)) {
							navigator.share(shareData)
								.then(async () => {
									const tabInfo = await getCurrentTabInfo();
									await incrementStat('share', tabInfo.url, tabInfo.title);
									const moreDropdown = document.getElementById('more-dropdown');
									if (moreDropdown) {
											moreDropdown.classList.remove('show');
									}
								})
								.catch((error) => {
									console.error('Error sharing:', error);
								});
						}
					}
				});
			});
		});
	}

	const shareButtonElements = document.querySelectorAll('.share-content');
	if (shareButtonElements.length > 0) {
		detectBrowser().then(browser => {
			const isSafariBrowser = ['safari', 'mobile-safari', 'ipad-os'].includes(browser);
			if (!isSafariBrowser || !navigator.share || !navigator.canShare) {
				shareButtonElements.forEach(button => {
					const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
					if (parentElement) {
						parentElement.style.display = 'none';
					}
				});
			} else {
				// Test if we can share files (only on Safari)
				try {
					const testFile = new File(["test"], "test.txt", { type: "text/plain" });
					const testShare = { files: [testFile] };
					if (!navigator.canShare(testShare)) {
						throw new Error('canShare returned false');
					}
				} catch {
					shareButtonElements.forEach(button => {
						const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
						if (parentElement) {
							parentElement.style.display = 'none';
						}
					});
				}
			}
		});
	}

	const readerModeButton = document.getElementById('reader-mode');
	if (readerModeButton) {
		readerModeButton.addEventListener('click', () => toggleReaderMode(tabId));
		checkReaderModeState(tabId);
	}
}

async function initializeUI() {
	const clipButton = document.getElementById('clip-btn');
	if (clipButton) {
		clipButton.focus();
	} else {
		console.warn('Clip button not found');
	}

	const showMoreActionsButton = document.getElementById('show-variables') as HTMLElement;
	const variablesPanel = document.createElement('div');
	variablesPanel.className = 'variables-panel';
	document.body.appendChild(variablesPanel);

	if (showMoreActionsButton) {
		showMoreActionsButton.addEventListener('click', async (e) => {
			e.preventDefault();
			// Initialize the variables panel with the latest data
			initializeVariablesPanel(variablesPanel, currentTemplate, currentVariables);
			await showVariables();
		});
	}

	if (isSidePanel) {
		browser.runtime.sendMessage({ action: "sidePanelOpened" });
		
		window.addEventListener('unload', () => {
			browser.runtime.sendMessage({ action: "sidePanelClosed" });
		});
	}
}

function showError(messageKey: string): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.textContent = getMessage(messageKey);
		errorMessage.style.display = 'flex';
		clipper.style.display = 'none';

		document.body.classList.add('has-error');
	}
}
function clearError(): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.style.display = 'none';
		clipper.style.display = 'block';

		document.body.classList.remove('has-error');
	}
}

function logError(message: string, error?: any): void {
	console.error(message, error);
	showError(message);
}

async function capturePopupSnapshot(signal?: AbortSignal): Promise<{
	title: string;
	markdown: string;
	sourceUrl: string;
}> {
	return captureStablePopupSnapshot<Template, Property[]>({
		getState: () => ({
			tabId: currentTabId,
			template: currentTemplate,
			revision: popupRefreshGate.currentRevision(),
			ready: popupRefreshGate.isReady()
				&& popupDestinationDelivery?.isReady() === true,
			readyUrl: popupRefreshGate.readyUrl(),
		}),
		readDom: () => {
			const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement | null;
			const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement | null;
			if (!noteNameField || !noteContentField) {
				throw new Error('destination-delivery-failed');
			}
			return {
				title: noteNameField.value,
				noteContent: noteContentField.value,
				properties: getPropertiesFromDOM(),
			};
		},
		buildMarkdown: async (properties, noteContent, signal) => {
			if (signal?.aborted) throw new Error('destination-delivery-failed');
			const markdown = (await generateFrontmatter(properties)) + noteContent;
			if (signal?.aborted) throw new Error('destination-delivery-failed');
			return markdown;
		},
		getSourceUrl: async (tabId, signal) => {
			if (signal?.aborted) throw new Error('destination-delivery-failed');
			const sourceUrl = (await getTabInfo(tabId)).url;
			if (signal?.aborted) throw new Error('destination-delivery-failed');
			return sourceUrl;
		},
	}, signal);
}

async function refreshFields(tabId: number, { checkTemplateTriggers = true, rebuildSkeleton = true }: { checkTemplateTriggers?: boolean; rebuildSkeleton?: boolean } = {}) {
	const refreshToken: PopupRefreshToken = popupRefreshGate.begin(tabId);
	const previousRefresh = popupRefreshQueue;
	let releaseRefresh!: () => void;
	popupRefreshQueue = new Promise<void>(resolve => {
		releaseRefresh = resolve;
	});
	await previousRefresh;
	let succeeded = false;
	let successfulRefreshUrl: string | null = null;
	const isCurrent = () => popupRefreshGate.isCurrent(refreshToken, currentTabId);

	try {
		if (!isCurrent()) return;
		if (templates.length === 0) {
			console.warn('No templates available');
			showError('noTemplates');
			return;
		}

		const tab = await getTabInfo(tabId);
		if (!isCurrent()) return;
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}
		if (isRestrictedUrl(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}

		// Start content extraction (don't await yet)
		const extractionPromise = memoizedExtractPageContent(tabId);

		// Match URL/regex triggers immediately (schema triggers will await extraction)
		if (checkTemplateTriggers) {
			const getSchemaOrgData = async () => {
				const data = await extractionPromise;
				return data?.schemaOrgData;
			};

			const matchedTemplate = await findMatchingTemplate(tab.url, getSchemaOrgData);
			if (!isCurrent()) return;
			if (matchedTemplate) {
				currentTemplate = matchedTemplate;
				updateTemplateDropdown();
			}
		}

		if (rebuildSkeleton) {
			buildTemplateFieldsSkeleton(currentTemplate);
			setupMetadataToggle();
		}

		const extractedData = await extractionPromise;
		if (!isCurrent()) return;
		if (extractedData) {
			const currentUrl = tab.url;

			const initializedContent = await initializePageContent(
				extractedData.content,
				extractedData.selectedHtml,
				extractedData.extractedContent,
				currentUrl,
				extractedData.schemaOrgData,
				extractedData.fullHtml,
				extractedData.highlights || [],
				extractedData.title,
				extractedData.author,
				extractedData.description,
				extractedData.favicon,
				extractedData.image,
				extractedData.published,
				extractedData.site,
				extractedData.wordCount,
				extractedData.language || '',
				extractedData.metaTags
			);
			if (!isCurrent()) return;
			if (initializedContent) {
				currentVariables = initializedContent.currentVariables;
				const fieldsFilled = await fillTemplateFieldValues(
					tabId,
					currentTemplate,
					initializedContent.currentVariables,
					extractedData.schemaOrgData,
					isCurrent,
				);
				if (!fieldsFilled || !isCurrent()) return;

				// Update variables panel if it's open
				updateVariablesPanel(currentTemplate, currentVariables);
				succeeded = true;
				successfulRefreshUrl = tab.url;
			} else {
				throw new Error('Unable to initialize page content.');
			}
		} else {
			throw new Error('Unable to extract page content.');
		}
	} catch (error) {
		if (!isCurrent()) return;
		console.error('Error refreshing fields:', error);
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
		showError(errorMessage);
	} finally {
		popupRefreshGate.complete(
			refreshToken,
			succeeded,
			currentTabId,
			successfulRefreshUrl,
		);
		releaseRefresh();
	}
}

function updateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		templateDropdown.value = currentTemplate.id;
	}
}

function populateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		// Clear existing options
		templateDropdown.textContent = '';
		templates.forEach((template: Template) => {
			const option = document.createElement('option');
			option.value = template.id;
			option.textContent = template.name;
			templateDropdown.appendChild(option);
		});
		templateDropdown.value = currentTemplate.id;
	}
}

function buildTemplateFieldsSkeleton(template: Template | null) {
	if (!template) return;

	const existingTemplateProperties = document.querySelector('.metadata-properties') as HTMLElement;

	const newTemplateProperties = createElementWithClass('div', 'metadata-properties');

	if (Array.isArray(template.properties)) {
		for (const property of template.properties) {
			const propertyDiv = createElementWithClass('div', 'metadata-property');
			const propertyType = generalSettings.propertyTypes.find(p => p.name === property.name)?.type || 'text';

			// Create metadata property key container
			const metadataPropertyKey = document.createElement('div');
			metadataPropertyKey.className = 'metadata-property-key';

			const propertyIconSpan = document.createElement('span');
			propertyIconSpan.className = 'metadata-property-icon';
			const iconElement = document.createElement('i');
			iconElement.setAttribute('data-lucide', getPropertyTypeIcon(propertyType));
			propertyIconSpan.appendChild(iconElement);

			const propertyLabel = document.createElement('label');
			propertyLabel.setAttribute('for', property.name);
			propertyLabel.textContent = property.name;

			metadataPropertyKey.appendChild(propertyIconSpan);
			metadataPropertyKey.appendChild(propertyLabel);

			// Create metadata property value container with empty input
			const metadataPropertyValue = document.createElement('div');
			metadataPropertyValue.className = 'metadata-property-value';

			const inputElement = document.createElement('input');
			inputElement.id = property.name;
			inputElement.setAttribute('data-type', propertyType);
			inputElement.setAttribute('data-template-value', property.value);
			inputElement.type = propertyType === 'checkbox' ? 'checkbox' : 'text';

			metadataPropertyValue.appendChild(inputElement);

			propertyDiv.appendChild(metadataPropertyKey);
			propertyDiv.appendChild(metadataPropertyValue);
			newTemplateProperties.appendChild(propertyDiv);
		}
	}

	// Replace the existing element
	if (existingTemplateProperties && existingTemplateProperties.parentNode) {
		existingTemplateProperties.parentNode.replaceChild(newTemplateProperties, existingTemplateProperties);
		existingTemplateProperties.remove();
	}

	initializeIcons(newTemplateProperties);

	// Set up editable note fields with template values
	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.setAttribute('data-template-value', template.noteNameFormat);
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.setAttribute('data-template-value', template.noteContentFormat || '');
	}

}

async function fillTemplateFieldValues(
	currentTabId: number,
	template: Template | null,
	variables: { [key: string]: string },
	schemaOrgData?: any,
	isCurrent: () => boolean = () => true,
): Promise<boolean> {
	if (!template || !isCurrent()) return false;

	const currentUrl = (await getTabInfo(currentTabId)).url || '';
	if (!isCurrent()) return false;

	currentVariables = variables;

	if (!Array.isArray(template.properties)) return false;

	// Compile all templates in parallel
	const [compiledPropertyValues, formattedNoteName, formattedContent] = await Promise.all([
		Promise.all(template.properties.map(property =>
			memoizedCompileTemplate(currentTabId!, unescapeValue(property.value), variables, currentUrl)
		)),
		memoizedCompileTemplate(currentTabId!, template.noteNameFormat, variables, currentUrl),
		template.noteContentFormat
			? memoizedCompileTemplate(currentTabId!, template.noteContentFormat, variables, currentUrl)
			: Promise.resolve('')
	]);
	if (!isCurrent()) return false;

	// Fill property values into existing DOM elements
	for (let i = 0; i < template.properties.length; i++) {
		const property = template.properties[i];
		const inputElement = document.getElementById(property.name) as HTMLInputElement;
		if (!inputElement) continue;

		let value = compiledPropertyValues[i];
		const propertyType = inputElement.getAttribute('data-type') || 'text';

		// Apply type-specific parsing
		value = formatPropertyValue(value, propertyType, property.value);

		if (propertyType === 'checkbox') {
			inputElement.checked = value === 'true';
		} else {
			inputElement.value = value;
		}
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.value = formattedNoteName.trim();
		adjustNoteNameHeight(noteNameField);
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.value = template.noteContentFormat ? formattedContent : '';
	}

	const replacedTemplate = await getReplacedTemplate(template, variables, currentTabId!, currentUrl);
	if (!isCurrent()) return false;
	debugLog('Variables', 'Current template with replaced variables:', JSON.stringify(replacedTemplate, null, 2));
	return true;
}

function setupMetadataToggle() {
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	
	if (metadataHeader && metadataProperties) {
		metadataHeader.removeEventListener('click', toggleMetadataProperties);
		metadataHeader.addEventListener('click', toggleMetadataProperties);

		// Set initial state
		getLocalStorage('propertiesCollapsed').then((isCollapsed) => {
			if (isCollapsed === undefined) {
				// If the value is not set, default to not collapsed
				updateMetadataToggleState(false); 
			} else {
				updateMetadataToggleState(isCollapsed);
			}
		});
	}
}

function toggleMetadataProperties() {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	
	if (metadataProperties && metadataHeader) {
		const isCollapsed = metadataProperties.classList.toggle('collapsed');
		metadataHeader.classList.toggle('collapsed');
		setLocalStorage('propertiesCollapsed', isCollapsed);
	}
}

function updateMetadataToggleState(isCollapsed: boolean) {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	
	if (metadataProperties && metadataHeader) {
		if (isCollapsed) {
			metadataProperties.classList.add('collapsed');
			metadataHeader.classList.add('collapsed');
		} else {
			metadataProperties.classList.remove('collapsed');
			metadataHeader.classList.remove('collapsed');
		}
	}
}

async function getReplacedTemplate(template: Template, variables: { [key: string]: string }, tabId: number, currentUrl: string): Promise<any> {
	const replacedTemplate: any = {
		schemaVersion: "0.1.0",
		name: template.name,
		behavior: template.behavior,
		noteNameFormat: await compileTemplate(tabId, template.noteNameFormat, variables, currentUrl),
		path: template.path,
		noteContentFormat: await compileTemplate(tabId, template.noteContentFormat, variables, currentUrl),
		properties: [],
		triggers: template.triggers
	};

	for (const prop of template.properties) {
		const replacedProp: Property = {
			id: prop.id,
			name: prop.name,
			value: await compileTemplate(tabId, prop.value, variables, currentUrl)
		};
		replacedTemplate.properties.push(replacedProp);
	}

	return replacedTemplate;
}

function refreshPopup() {
	window.location.reload();
}

function handleTemplateChange(templateId: string) {
	currentTemplate = templates.find(t => t.id === templateId) || templates[0];
	refreshFields(currentTabId!, { checkTemplateTriggers: false });
}

function setReaderButtonState(isActive: boolean) {
	const readerButton = document.getElementById('reader-mode');
	if (readerButton) {
		readerButton.classList.toggle('active', isActive);
		readerButton.setAttribute('aria-pressed', isActive.toString());
		readerButton.title = isActive ? getMessage('disableReader') : getMessage('enableReader');
	}
}

async function checkReaderModeState(tabId: number) {
	try {
		// When nested in a reader.html page, we know reader mode is active
		if (urlParams.get('readerUrl')) {
			setReaderButtonState(true);
			return;
		}

		// Query the actual page DOM via content script rather than
		// relying on background state, which can be stale across tabs
		const response = await browser.runtime.sendMessage({
			action: "sendMessageToTab",
			tabId: tabId,
			message: { action: "getReaderModeState" }
		}) as { isActive: boolean } | undefined;

		setReaderButtonState(response?.isActive ?? false);
	} catch (error) {
		// Tab may not have content script loaded yet
		console.error('Error checking reader mode state:', error);
	}
}

async function checkHighlighterModeState(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({
			action: "getHighlighterMode",
			tabId: tabId
		}) as { isActive: boolean };

		const isHighlighterMode = response.isActive;
		
		loadedSettings = await loadSettings();
		
		updateHighlighterModeUI(isHighlighterMode);
	} catch (error) {
		console.error('Error checking highlighter mode state:', error);
		// If there's an error, assume highlighter mode is off
		updateHighlighterModeUI(false);
	}
}

async function toggleHighlighterMode(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({
			action: "toggleHighlighterMode",
			tabId: tabId
		}) as { success: boolean, isActive: boolean, error?: string };

		if (response && response.success) {
			const isNowActive = response.isActive;
			updateHighlighterModeUI(isNowActive);

			// Close the popup if highlighter mode is turned on and not in side panel
			if (isNowActive && !isSidePanel && !isIframe) {
				setTimeout(() => window.close(), 50);
			}
		} else {
			throw new Error(response.error || "Failed to toggle highlighter mode.");
		}
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		showError('failedToToggleHighlighter');
	}
}

function updateHighlighterModeUI(isActive: boolean) {
	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		if (generalSettings.highlighterEnabled) {
			highlighterModeButton.style.display = 'flex';
			highlighterModeButton.classList.toggle('active', isActive);
			highlighterModeButton.setAttribute('aria-pressed', isActive.toString());
			highlighterModeButton.title = isActive ? getMessage('disableHighlighter') : getMessage('highlighterOn');
		} else {
			highlighterModeButton.style.display = 'none';
		}
	}
}

async function toggleReaderMode(tabId: number) {
	try {
		// When nested in a reader.html page, pass the reader URL
		// so the background can navigate away even without tab URL access
		const response = await browser.runtime.sendMessage({
			action: "toggleReaderMode",
			tabId: tabId,
			readerUrl: urlParams.get('readerUrl') || undefined
		}) as ReaderModeResponse;

		if (response && response.success) {
			setReaderButtonState(response.isActive ?? false);
		}

		// Close the popup if not in side panel or iframe
		if (!isSidePanel && !isIframe) {
			window.close();
		}
	} catch (error) {
		console.error('Error toggling reader mode:', error);
		showError('failedToToggleReaderMode');
	}
}

// Update the resize event listener to use the debounced version
window.addEventListener('resize', debouncedSetPopupDimensions);
