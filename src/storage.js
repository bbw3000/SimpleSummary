import { createDefaultChatState, normalizeChatState } from './segments.js';

const STORAGE_VERSION = 1;
const EXPIRY_DAYS = 180;
const EXPIRY_MS = EXPIRY_DAYS * 24 * 60 * 60 * 1000;
const SETTINGS_FILE_NAME = 'SP_settings.json';
const BROWSER_SETTINGS_STORAGE_KEY = 'SimpleSummary:browserSettings';
const SUMMARY_INDEX_FILE_NAME = 'SP_summary_index.json';
const SUMMARY_FILE_PREFIX = 'SP_summary_';
const SUMMARY_FILE_SUFFIX = '.json';
const CUSTOM_PROMPTS_FILE_NAME = 'SP_custom_prompts.json';
const SETTINGS_FILE_DEBOUNCE_MS = 10000;

function encodeTextToBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function hashChatId(chatId) {
    const bytes = new TextEncoder().encode(String(chatId ?? ''));
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = (hash * prime) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
}

function getChatFileName(chatId) {
    return `${SUMMARY_FILE_PREFIX}${hashChatId(chatId)}${SUMMARY_FILE_SUFFIX}`;
}

function getUserFilePath(fileName) {
    return `/user/files/${encodeURIComponent(fileName)}`;
}

export function createStorageManager({ defaultSettings, browserSettingsKeys, moduleName, getST, translate, toast } = {}) {
    const t = typeof translate === 'function' ? translate : (key) => key;
    let settingsState = structuredClone(defaultSettings || {});
    let summaryIndexState = { version: STORAGE_VERSION, chats: {} };
    let currentChatId = '';
    let currentChatFileName = '';
    let currentChatState = null;
    let settingsLoaded = false;
    let indexLoaded = false;
    let settingsLoadPromise = null;
    let indexLoadPromise = null;
    let currentChatLoadPromise = null;
    let currentChatSavePromise = Promise.resolve();
    let persistChain = Promise.resolve();
    let customPromptsState = [];
    let customPromptsLoaded = false;
    let customPromptsLoadPromise = null;
    let settingsSaveTimer = null;
    let lastWrittenSettingsJson = null;

    const getSettings = () => {
        const s = settingsState;
        for (const k of Object.keys(defaultSettings || {})) {
            if (!Object.hasOwn(s, k)) s[k] = defaultSettings[k];
        }
        return s;
    };

    const getRequestHeaders = () => getST?.()?.getRequestHeaders?.() || {};

    const readUserFileText = async (fileName) => {
        const response = await fetch(getUserFilePath(fileName), {
            method: 'GET',
            headers: getRequestHeaders(),
            cache: 'no-store',
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            throw new Error(`Failed to load ${fileName}: ${response.status}`);
        }

        const raw = await response.text();
        if (!raw.trim()) return null;
        return raw;
    };

    const writeUserFileText = async (fileName, text) => {
        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers: {
                ...getRequestHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: fileName,
                data: encodeTextToBase64(String(text ?? '')),
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Failed to save ${fileName}`);
        }
    };

    const deleteUserFile = async (fileName) => {
        const response = await fetch('/api/files/delete', {
            method: 'POST',
            headers: {
                ...getRequestHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ path: `/user/files/${fileName}` }),
        });

        if (!response.ok && response.status !== 404) {
            const error = await response.text();
            throw new Error(error || `Failed to delete ${fileName}`);
        }
    };

    const getBrowserSettings = () => {
        try {
            const raw = window.localStorage?.getItem(BROWSER_SETTINGS_STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            console.warn('[SimpleSummary] Failed to read browser settings.', error);
            return {};
        }
    };

    const saveBrowserSettings = () => {
        const s = getSettings();
        const payload = {};
        for (const key of browserSettingsKeys || []) {
            payload[key] = structuredClone(s[key]);
        }

        try {
            window.localStorage?.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
        } catch (error) {
            console.warn('[SimpleSummary] Failed to save browser settings.', error);
        }
    };

    const clearBrowserSettings = () => {
        try {
            window.localStorage?.removeItem(BROWSER_SETTINGS_STORAGE_KEY);
        } catch (error) {
            console.warn('[SimpleSummary] Failed to clear browser settings.', error);
        }
    };

    const applyBrowserSettingsToState = () => {
        const browser = getBrowserSettings();
        const s = getSettings();
        for (const key of browserSettingsKeys || []) {
            if (Object.hasOwn(browser, key)) s[key] = browser[key];
        }
    };

    const buildSettingsJson = () => {
        const presetsToSave = Array.isArray(settingsState.presets)
            ? settingsState.presets.map(preset => {
                if (!preset || typeof preset !== 'object') return preset;
                const next = { ...preset };
                delete next.availableModels;
                delete next.modelsFetchedAt;
                return next;
            })
            : [];
        return JSON.stringify({
            version: STORAGE_VERSION,
            presets: presetsToSave,
            chatLogPreprocess: structuredClone(settingsState.chatLogPreprocess || {}),
        }, null, 2);
    };

    const writeSettingsFile = async () => {
        const json = buildSettingsJson();
        if (json === lastWrittenSettingsJson) return;
        await writeUserFileText(SETTINGS_FILE_NAME, json);
        lastWrittenSettingsJson = json;
    };

    const queueSettingsSave = () => {
        saveBrowserSettings();
        clearTimeout(settingsSaveTimer);
        settingsSaveTimer = setTimeout(() => {
            persistChain = persistChain
                .then(() => writeSettingsFile())
                .catch(error => {
                    console.error('[SimpleSummary] Failed to save settings file:', error);
                });
        }, SETTINGS_FILE_DEBOUNCE_MS);
        return persistChain;
    };

    const writeSummaryIndexFile = async () => {
        await writeUserFileText(SUMMARY_INDEX_FILE_NAME, JSON.stringify(summaryIndexState, null, 2));
    };

    const writeCustomPromptsFile = async () => {
        await writeUserFileText(CUSTOM_PROMPTS_FILE_NAME, JSON.stringify({
            version: STORAGE_VERSION,
            prompts: customPromptsState,
        }, null, 2));
    };

    const queueIndexSave = () => {
        persistChain = persistChain
            .then(() => writeSummaryIndexFile())
            .catch(error => {
                console.error('[SimpleSummary] Failed to save summary index:', error);
            });
        return persistChain;
    };

    const queueCustomPromptsSave = () => {
        persistChain = persistChain
            .then(() => writeCustomPromptsFile())
            .catch(error => {
                console.error('[SimpleSummary] Failed to save custom prompts file:', error);
            });
        return persistChain;
    };

    const ensureSettingsLoaded = async () => {
        if (settingsLoaded) return settingsState;
        if (settingsLoadPromise) return settingsLoadPromise;

        settingsLoadPromise = (async () => {
            const browserSettings = getBrowserSettings();
            const next = structuredClone(defaultSettings || {});
            let browserSettingsChanged = false;
            let loadedChatLogPreprocess = false;
            const raw = await readUserFileText(SETTINGS_FILE_NAME);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') {
                        const source = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
                        if (Array.isArray(source.presets)) next.presets = structuredClone(source.presets);
                        if (source.chatLogPreprocess && typeof source.chatLogPreprocess === 'object') {
                            next.chatLogPreprocess = structuredClone(source.chatLogPreprocess);
                            loadedChatLogPreprocess = true;
                        }
                        for (const key of browserSettingsKeys || []) {
                            if (!Object.hasOwn(source, key)) continue;
                            next[key] = source[key];
                            browserSettingsChanged = true;
                        }
                    }
                } catch (error) {
                    console.warn('[SimpleSummary] Failed to parse settings file, using defaults.', error);
                }
            }

            for (const key of browserSettingsKeys || []) {
                if (Object.hasOwn(browserSettings, key)) next[key] = browserSettings[key];
            }

            settingsState = next;
            if (!loadedChatLogPreprocess) {
                const legacyPreprocess = browserSettings.chatLogPreprocess;
                if (legacyPreprocess && typeof legacyPreprocess === 'object') {
                    next.chatLogPreprocess = structuredClone(legacyPreprocess);
                    browserSettingsChanged = true;
                }
            }
            if (browserSettingsChanged) saveBrowserSettings();
            lastWrittenSettingsJson = buildSettingsJson();
            settingsLoaded = true;
            return settingsState;
        })();

        return settingsLoadPromise;
    };

    const ensureCustomPromptsLoaded = async () => {
        if (customPromptsLoaded) return customPromptsState;
        if (customPromptsLoadPromise) return customPromptsLoadPromise;

        customPromptsLoadPromise = (async () => {
            const raw = await readUserFileText(CUSTOM_PROMPTS_FILE_NAME);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        customPromptsState = parsed;
                    } else if (parsed && Array.isArray(parsed.prompts)) {
                        customPromptsState = parsed.prompts;
                    }
                } catch (error) {
                    console.warn('[SimpleSummary] Failed to parse custom prompts file, starting fresh.', error);
                    customPromptsState = [];
                }
            }

            customPromptsLoaded = true;
            return customPromptsState;
        })();

        return customPromptsLoadPromise;
    };

    const ensureSummaryIndexLoaded = async () => {
        if (indexLoaded) return summaryIndexState;
        if (indexLoadPromise) return indexLoadPromise;

        indexLoadPromise = (async () => {
            const raw = await readUserFileText(SUMMARY_INDEX_FILE_NAME);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') {
                        summaryIndexState = {
                            version: STORAGE_VERSION,
                            chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
                        };
                    }
                } catch (error) {
                    console.warn('[SimpleSummary] Failed to parse summary index, starting fresh.', error);
                    summaryIndexState = { version: STORAGE_VERSION, chats: {} };
                }
            }

            const legacy = getST?.()?.extensionSettings?.[moduleName];
            if (legacy && legacy.chats && typeof legacy.chats === 'object') {
                for (const [chatId, state] of Object.entries(legacy.chats)) {
                    const fileName = getChatFileName(chatId);
                    summaryIndexState.chats[hashChatId(chatId)] = {
                        chatId,
                        fileName,
                        updatedAt: Number(state?.updatedAt || Date.now()),
                    };
                }
                await queueIndexSave();
            }

            indexLoaded = true;
            return summaryIndexState;
        })();

        return indexLoadPromise;
    };

    const getCurrentChatId = () => {
        const ctx = getST?.() || {};
        const chatId = ctx.chatId ?? ctx.getCurrentChatId?.();
        if (chatId === undefined || chatId === null) return '';
        return String(chatId).trim();
    };

    const getCurrentChatFileName = (chatId = currentChatId) => chatId ? getChatFileName(chatId) : '';

    const ensureCurrentChatLoaded = async () => {
        const chatId = getCurrentChatId();
        if (!chatId) {
            currentChatId = '';
            currentChatFileName = '';
            currentChatState = null;
            return null;
        }

        if (currentChatState && currentChatId === chatId) return currentChatState;

        currentChatId = chatId;
        currentChatFileName = getCurrentChatFileName(chatId);
        if (currentChatLoadPromise) return currentChatLoadPromise;

        currentChatLoadPromise = (async () => {
            const raw = await readUserFileText(currentChatFileName);
            if (raw) {
                try {
                    currentChatState = normalizeChatState(JSON.parse(raw), chatId);
                } catch (error) {
                    console.warn('[SimpleSummary] Failed to parse summary file, starting fresh.', error);
                    currentChatState = createDefaultChatState(chatId);
                }
            } else {
                currentChatState = createDefaultChatState(chatId);
            }

            currentChatState = normalizeChatState(currentChatState, chatId);
            summaryIndexState.chats[hashChatId(chatId)] = {
                chatId,
                fileName: currentChatFileName,
                updatedAt: currentChatState.updatedAt,
            };
            await queueIndexSave();
            currentChatLoadPromise = null;
            return currentChatState;
        })();

        return currentChatLoadPromise;
    };

    const touchCurrentChatState = () => {
        if (!currentChatState) return null;
        currentChatState.updatedAt = Date.now();
        return currentChatState;
    };

    const saveCurrentChatState = async () => {
        const state = touchCurrentChatState();
        if (!state || !currentChatFileName) return;
        currentChatSavePromise = currentChatSavePromise
            .then(async () => {
                await writeUserFileText(currentChatFileName, JSON.stringify(state, null, 2));
                summaryIndexState.chats[hashChatId(currentChatId)] = {
                    chatId: currentChatId,
                    fileName: currentChatFileName,
                    updatedAt: state.updatedAt,
                };
                await queueIndexSave();
            })
            .catch(error => {
                console.error('[SimpleSummary] Failed to save current chat state:', error);
            });
        await currentChatSavePromise;
    };

    const resetCurrentChatState = async () => {
        if (!currentChatFileName || !currentChatId) return;
        currentChatState = createDefaultChatState(currentChatId);
        delete summaryIndexState.chats[hashChatId(currentChatId)];
        await deleteUserFile(currentChatFileName);
        await queueIndexSave();
    };

    const cleanupExpiredSummaries = async ({ force = false, silent = false } = {}) => {
        if (!force && !getSettings().autoCleanupExpired) return 0;

        await ensureSummaryIndexLoaded();
        const cutoff = Date.now() - EXPIRY_MS;
        let removed = 0;

        for (const [hash, entry] of Object.entries(summaryIndexState.chats || {})) {
            const updatedAt = Number(entry?.updatedAt || 0);
            if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt >= cutoff) continue;

            const fileName = entry.fileName || `${SUMMARY_FILE_PREFIX}${hash}${SUMMARY_FILE_SUFFIX}`;
            try {
                await deleteUserFile(fileName);
            } catch (error) {
                console.warn('[SimpleSummary] Failed to delete expired summary file:', fileName, error);
            }
            delete summaryIndexState.chats[hash];
            removed++;
        }

        if (removed > 0) {
            await queueIndexSave();
            if (!silent && typeof toast === 'function') {
                toast(t('toast.expiredSummariesCleared', { count: removed }));
            }
        }

        return removed;
    };

    return {
        getSettings,
        getBrowserSettings,
        saveBrowserSettings,
        clearBrowserSettings,
        applyBrowserSettingsToState,
        saveSettings: queueSettingsSave,
        getCustomPrompts: () => Array.isArray(customPromptsState) ? customPromptsState : [],
        setCustomPrompts: (prompts) => { customPromptsState = Array.isArray(prompts) ? prompts : []; },
        ensureSettingsLoaded,
        ensureCustomPromptsLoaded,
        ensureSummaryIndexLoaded,
        queueCustomPromptsSave,
        getCurrentChatId,
        getCurrentChatFileName,
        ensureCurrentChatLoaded,
        getCurrentChatState: () => currentChatState,
        saveCurrentChatState,
        resetCurrentChatState,
        cleanupExpiredSummaries,
    };
}
