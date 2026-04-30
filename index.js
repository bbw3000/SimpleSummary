/* ==========================================================================
   SimpleSummary — SillyTavern Chat Summary Extension
   ========================================================================== */

import { on, val, setVal, setText, setChecked, escapeHtml, show, hide, setRange } from './src/dom-utils.js';
import { log, logE } from './src/logger.js';
import { normalizeBaseUrl, generateSummaryText, buildStBackendRequestBody, buildSummaryMessages } from './src/llm-utils.js';
import { appendPreviewStreamDelta, updatePreviewFromRaw, resetPreviewThinkingUI, getPreviewSummaryTextToSave, setPreviewTextReadonly, getPreviewTextValue } from './src/thinking-utils.js';
import { createPromptPresetManager } from './src/prompt-presets.js';
import { createApiPresetManager } from './src/api-presets.js';
import { t, initI18n, setLocale, getCurrentLocale, getAvailableLocales, getLocaleLabel, applyAllDataI18n } from './src/i18n.js';
import { createStorageManager } from './src/storage.js';
import { createSegmentController, getSegmentLabel, normalizeRange } from './src/segments.js';
import { createPromptRuntime } from './src/prompt-runtime.js';
import { createChatLogPreprocessManager } from './src/chat-log-preprocess.js';

const MODULE_NAME = 'SimpleSummary';
const BASE_URL = new URL('.', import.meta.url).href;   // e.g. /scripts/extensions/third-party/SimpleSummary/

// ---------------------------------------------------------------------------
//  Settings helpers  (always call getST() fresh — never cache chatMetadata)
// ---------------------------------------------------------------------------

function getST() {
    return SillyTavern.getContext();
}

const defaultSettings = Object.freeze({
    presets: [],
    activePresetId: null,
    autoHide: true,
    useStream: true,
    summaryRetainCount: 5,
    lightTheme: false,
    injectionEnabled: true,
    injectionDepth: 999,
    autoCleanupExpired: true,
    activePromptPresetId: 'default',
    chatLogPreprocess: {
        structuredCleanup: true,
        stripHtmlText: true,
        regexRules: [],
    },
    windowSize: { width: 800, height: 680 },
    locale: 'en',
    uiFontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    uiFontSizePx: 15,
    textFontFamily: "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
    textFontSizePx: 18,
    textFontWeight: 400,
    enableGoogleFonts: false,
    apiSidebarWidth: 180,
});

const BROWSER_SETTINGS_KEYS = Object.freeze(
    Object.keys(defaultSettings).filter(key => key !== 'presets' && key !== 'chatLogPreprocess')
);

let loadedDefaultPromptData = { systemPrompt: '', userPrompt: '' };
let storage;
let segments;
let promptRuntime;


const API_SIDEBAR_WIDTH_LIMITS = Object.freeze({
    min: 150,
    max: 360,
    desktopViewportMin: 1024,
    fallback: 180,
});

function getSettings() {
    return storage.getSettings();
}


function normalizeRetainCount(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : defaultSettings.summaryRetainCount;
}

function getHomeSummaryRange(chat) {
    const firstVisible = chat.findIndex(m => !m.is_system);
    const lastVisible = chat.findLastIndex(m => !m.is_system);
    const retainCount = normalizeRetainCount(getSettings().summaryRetainCount);
    const start = firstVisible;
    const end = lastVisible === -1 ? -1 : lastVisible - retainCount;
    return { start, end, retainCount, lastVisible };
}

function stepNumericInput(input, delta, { min = 0, max = Infinity, step = 1 } = {}) {
    if (!input) return;
    const current = Math.floor(Number(input.value));
    const base = Number.isFinite(current) ? current : min;
    const next = Math.min(max, Math.max(min, base + delta * step));
    input.value = String(next);
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function bindNumericGestureInput(input, getLimits) {
    if (!input) return;

    input.addEventListener('wheel', e => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const limits = getLimits?.() || {};
        stepNumericInput(input, dir, limits);
    }, { passive: false });

    let pointerStartY = null;
    let pointerStartValue = null;
    let pointerActive = false;
    let pointerDragging = false;
    let pointerCurrentY = null;
    let pointerFrameId = null;
    let pointerLastTick = 0;
    let pointerCarry = 0;

    const isFullscreenMode = () => document.getElementById('sp-window')?.classList.contains('sp-fullscreen');

    const stopPointerLoop = () => {
        if (pointerFrameId !== null) {
            cancelAnimationFrame(pointerFrameId);
            pointerFrameId = null;
        }
        pointerLastTick = 0;
        pointerCarry = 0;
    };

    const tickPointerLoop = (ts) => {
        if (!pointerActive || !pointerDragging || pointerStartY === null || pointerStartValue === null || pointerCurrentY === null) {
            stopPointerLoop();
            return;
        }

        if (!isFullscreenMode()) {
            stopPointerLoop();
            return;
        }

        const deltaY = pointerStartY - pointerCurrentY;
        const absDeltaY = Math.abs(deltaY);
        const direction = deltaY > 0 ? 1 : deltaY < 0 ? -1 : 0;

        if (!direction) {
            pointerLastTick = ts;
            pointerFrameId = requestAnimationFrame(tickPointerLoop);
            return;
        }

        const limits = getLimits?.() || {};
        const min = Number.isFinite(limits.min) ? limits.min : 0;
        const max = Number.isFinite(limits.max) ? limits.max : Infinity;
        const stepSize = limits.step || 1;
        const speedBoost = 1 + Math.floor(absDeltaY / 40);
        const stepsPerSecond = 1 + speedBoost * 3;
        const elapsed = pointerLastTick ? (ts - pointerLastTick) / 1000 : 0;
        pointerLastTick = ts;
        pointerCarry += elapsed * stepsPerSecond;

        let wholeSteps = Math.floor(pointerCarry);
        if (!wholeSteps) {
            pointerFrameId = requestAnimationFrame(tickPointerLoop);
            return;
        }

        pointerCarry -= wholeSteps;
        let next = Math.floor(Number(input.value));
        if (!Number.isFinite(next)) next = pointerStartValue;
        next = Math.min(max, Math.max(min, next + direction * wholeSteps * stepSize));
        input.value = String(next);
        input.dispatchEvent(new Event('change', { bubbles: true }));

        pointerFrameId = requestAnimationFrame(tickPointerLoop);
    };

    const resetPointer = () => {
        stopPointerLoop();
        pointerStartY = null;
        pointerStartValue = null;
        pointerActive = false;
        pointerDragging = false;
        pointerCurrentY = null;
    };

    input.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
        if (!isFullscreenMode()) return;
        pointerActive = true;
        pointerDragging = false;
        pointerStartY = e.clientY;
        pointerStartValue = Math.floor(Number(input.value));
        pointerCurrentY = e.clientY;
        if (input.setPointerCapture) {
            try { input.setPointerCapture(e.pointerId); } catch (_) {}
        }
    });

    input.addEventListener('pointermove', e => {
        if (!pointerActive || pointerStartY === null || pointerStartValue === null) return;
        if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
        if (!isFullscreenMode()) return;
        pointerCurrentY = e.clientY;
        const deltaY = pointerStartY - e.clientY;
        const absDeltaY = Math.abs(deltaY);
        if (!pointerDragging && absDeltaY < 4) return;
        if (!pointerDragging) {
            pointerDragging = true;
            e.preventDefault();
            pointerLastTick = 0;
            pointerCarry = 0;
            if (pointerFrameId === null) {
                pointerFrameId = requestAnimationFrame(tickPointerLoop);
            }
        }
        e.preventDefault();
    });

    input.addEventListener('pointerup', resetPointer);
    input.addEventListener('pointercancel', resetPointer);
    input.addEventListener('lostpointercapture', resetPointer);
}

function saveSettings() {
    storage.saveSettings();
}

function getBrowserSettings() {
    return storage.getBrowserSettings();
}

function saveBrowserSettings() {
    storage.saveBrowserSettings();
}

function clearBrowserSettings() {
    storage.clearBrowserSettings();
}

function applyBrowserSettingsToState() {
    storage.applyBrowserSettingsToState();
}

function getCustomPrompts() {
    return storage.getCustomPrompts();
}

function setCustomPrompts(prompts) {
    storage.setCustomPrompts(prompts);
}

function getLoadedDefaultPrompt() {
    return {
        systemPrompt: String(loadedDefaultPromptData?.systemPrompt || ''),
        userPrompt: String(loadedDefaultPromptData?.userPrompt || ''),
    };
}

function setLoadedDefaultPrompt(data) {
    loadedDefaultPromptData = {
        systemPrompt: String(data?.systemPrompt || ''),
        userPrompt: String(data?.userPrompt || ''),
    };
}

globalThis.SimpleSummaryUpdateLocale = async (locale) => {
    const chosen = String(locale || '').trim();
    if (!chosen || chosen === getCurrentLocale()) return false;

    const activeTab = document.querySelector('.sp-tab.sp-tab-active')?.dataset?.tab || 'home';
    if (activeTab === 'edit') {
        const ok = await beforeSummaryEditorLeave();
        if (!ok) return false;
    } else if (activeTab === 'prompt') {
        const ok = await beforePromptEditorLeave();
        if (!ok) return false;
    } else if (activeTab === 'api') {
        const ok = await beforeApiPresetLeave();
        if (!ok) return false;
    }

    getSettings().locale = chosen;
    saveSettings();
    await setLocale(chosen);
    await reloadDefaultPrompt();
    refreshTypographyUI();
    renderLanguageMenu();
    renderApiPresets();
    refreshHome();
    if (activeTab === 'preprocess') {
        loadPreprocessEditor();
    }
    const previewStatus = document.getElementById('sp-preview-status');
    const previewStatusKey = previewStatus?.dataset?.i18nStatusKey;
    if (previewStatus && previewStatusKey) {
        previewStatus.textContent = t(previewStatusKey);
    }
    renderSegmentTimeline();
    updateEditFooterState();
    return true;
};

function ensureSettingsLoaded() {
    return storage.ensureSettingsLoaded();
}

function ensureCustomPromptsLoaded() {
    return storage.ensureCustomPromptsLoaded();
}

function ensureSummaryIndexLoaded() {
    return storage.ensureSummaryIndexLoaded();
}

function queueCustomPromptsSave() {
    return storage.queueCustomPromptsSave();
}

function getCurrentChatId() {
    return storage.getCurrentChatId();
}

function ensureCurrentChatLoaded() {
    return storage.ensureCurrentChatLoaded();
}

function saveCurrentChatState() {
    return storage.saveCurrentChatState();
}

function resetCurrentChatState() {
    return storage.resetCurrentChatState();
}

function cleanupExpiredSummaries(options) {
    return storage.cleanupExpiredSummaries(options);
}


function removeLegacyPersistentFiles() {
    // no-op placeholder for older single-file leftovers; intentionally not used.
}

function clampApiSidebarWidth(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return API_SIDEBAR_WIDTH_LIMITS.fallback;
    return Math.max(API_SIDEBAR_WIDTH_LIMITS.min, Math.min(API_SIDEBAR_WIDTH_LIMITS.max, Math.round(n)));
}

function isDesktopApiSidebarResizeEnabled() {
    const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
    return viewportWidth >= API_SIDEBAR_WIDTH_LIMITS.desktopViewportMin;
}

function applyApiSidebarWidth() {
    const sidebar = document.getElementById('sp-api-sidebar');
    const win = document.getElementById('sp-window');
    if (!sidebar || !win) return;

    if (sidebar.classList.contains('sp-api-sidebar-collapsed')) {
        sidebar.style.removeProperty('width');
        return;
    }

    if (win.classList.contains('sp-fullscreen') || !isDesktopApiSidebarResizeEnabled()) {
        sidebar.style.removeProperty('width');
        return;
    }

    const width = clampApiSidebarWidth(getSettings().apiSidebarWidth);
    sidebar.style.width = `${width}px`;
}

function setupApiSidebarResize() {
    const resizer = document.getElementById('sp-api-sidebar-resizer');
    const sidebar = document.getElementById('sp-api-sidebar');
    if (!resizer || !sidebar) return;

    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startWidth = 0;

    const stopDrag = () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('sp-resizing');
        if (pointerId !== null && typeof resizer.releasePointerCapture === 'function') {
            try { resizer.releasePointerCapture(pointerId); } catch (_) {}
        }
        pointerId = null;

        const currentWidth = sidebar.getBoundingClientRect().width;
        getSettings().apiSidebarWidth = clampApiSidebarWidth(currentWidth);
        saveBrowserSettings();
    };

    const onPointerMove = (e) => {
        if (!dragging) return;
        const nextWidth = clampApiSidebarWidth(startWidth + (e.clientX - startX));
        sidebar.style.width = `${nextWidth}px`;
    };

    resizer.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (!isDesktopApiSidebarResizeEnabled()) return;
        const win = document.getElementById('sp-window');
        if (win?.classList.contains('sp-fullscreen')) return;
        if (sidebar.classList.contains('sp-api-sidebar-collapsed')) return;

        dragging = true;
        pointerId = e.pointerId;
        startX = e.clientX;
        startWidth = sidebar.getBoundingClientRect().width;
        resizer.classList.add('sp-resizing');
        if (typeof resizer.setPointerCapture === 'function') {
            try { resizer.setPointerCapture(pointerId); } catch (_) {}
        }
        e.preventDefault();
    });

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', stopDrag);
    document.addEventListener('pointercancel', stopDrag);
}

const FONT_SIZE_LIMITS = Object.freeze({
    ui: { min: 14, max: 18, fallback: 15 },
    text: { min: 14, max: 24, fallback: 18 },
});

const GENERIC_FONT_FAMILIES = new Set([
    'inherit',
    'serif',
    'sans-serif',
    'monospace',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
    'emoji',
    'math',
    'fangsong',
    'cursive',
    'fantasy',
    '-apple-system',
    'blinkmacsystemfont',
]);

const FONT_PRESETS = Object.freeze([
    { value: 'inherit', labelKey: 'settings.fontInherit', google: false },
    { value: '__custom__', labelKey: 'settings.fontCustom', google: false },
    { value: "'Noto Sans SC', 'Microsoft YaHei UI', 'PingFang SC', 'Hiragino Sans GB', sans-serif", label: 'Noto Sans SC (CJK Sans)', google: false },
    { value: "'Noto Serif SC', 'Songti SC', 'STSong', serif", label: 'Noto Serif SC (CJK Serif)', google: false },
    { value: "'Source Han Sans SC', 'Microsoft YaHei UI', 'PingFang SC', sans-serif", label: 'Source Han Sans SC', google: false },
    { value: "'Source Han Serif SC', 'Songti SC', serif", label: 'Source Han Serif SC', google: false },
    { value: "'Segoe UI', system-ui, sans-serif", label: 'Segoe UI', google: false },
    { value: "'San Francisco', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif", label: 'San Francisco', google: false },
    { value: "system-ui, -apple-system, 'Segoe UI', sans-serif", label: 'System Sans', google: false },
    { value: "ui-serif, Georgia, Cambria, 'Times New Roman', serif", label: 'System Serif', google: false },
    { value: "ui-monospace, 'Cascadia Code', 'Consolas', monospace", label: 'System Monospace', google: false },
]);

let _localFontFamilies = [];

function clampFontSize(n, kind) {
    const cfg = FONT_SIZE_LIMITS[kind] || FONT_SIZE_LIMITS.ui;
    const parsed = Number(n);
    if (!Number.isFinite(parsed)) return cfg.fallback;
    return Math.max(cfg.min, Math.min(cfg.max, parsed));
}

function getRootFontSizePx() {
    try {
        const root = document.documentElement;
        const px = Number.parseFloat(window.getComputedStyle(root).fontSize);
        return Number.isFinite(px) ? px : FONT_SIZE_LIMITS.ui.fallback;
    } catch (_) {
        return FONT_SIZE_LIMITS.ui.fallback;
    }
}

function getDisplayFontSize(kind) {
    const s = getSettings();
    const key = kind === 'text' ? 'textFontSizePx' : 'uiFontSizePx';
    const cfg = FONT_SIZE_LIMITS[kind] || FONT_SIZE_LIMITS.ui;
    if (Number.isFinite(s[key])) return clampFontSize(s[key], kind);
    return clampFontSize(getRootFontSizePx(), kind);
}

function findFontPresetByValue(value) {
    return FONT_PRESETS.find(p => p.value === value) || null;
}

function normalizeFontFamilyForCss(value) {
    if (!value) return 'inherit';
    return String(value).replace(/\bgf:\s*/gi, '').trim() || 'inherit';
}

function quoteCssFontFamily(name) {
    const safe = String(name ?? '').trim();
    if (!safe) return '';
    return `'${safe.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function loadLocalFontFamilies() {
    if (typeof window.queryLocalFonts !== 'function') {
        _localFontFamilies = [];
        return { supported: false, count: 0 };
    }

    try {
        const fonts = await window.queryLocalFonts();
        const byFamily = new Map();

        for (const f of fonts || []) {
            const family = String(f?.family ?? '').trim();
            if (!family) continue;

            if (!byFamily.has(family)) {
                byFamily.set(family, {
                    family,
                    aliases: new Set(),
                });
            }

            const entry = byFamily.get(family);
            for (const name of [f?.family, f?.fullName, f?.postscriptName]) {
                const n = String(name ?? '').trim();
                if (n) entry.aliases.add(n);
            }
        }

        _localFontFamilies = [...byFamily.values()]
            .map(({ family, aliases }) => {
                const aliasList = [...aliases].filter(a => a !== family);
                const preferredAlias = aliasList[0] || family;

                return {
                    family,
                    value: quoteCssFontFamily(family),
                    label: preferredAlias,
                };
            })
            .sort((a, b) => a.family.localeCompare(b.family));

        return { supported: true, count: _localFontFamilies.length };
    } catch (_) {
        _localFontFamilies = [];
        return { supported: true, denied: true, count: 0 };
    }
}

function extractCustomGoogleFamily(fontValue) {
    if (!fontValue || fontValue === 'inherit') return null;
    if (findFontPresetByValue(fontValue)) return null;

    const normalized = normalizeFontFamilyForCss(fontValue);
    const first = normalized.split(',')[0]?.trim();
    if (!first) return null;
    const unquoted = first.replace(/^['"]+|['"]+$/g, '').trim();
    if (!unquoted) return null;
    if (GENERIC_FONT_FAMILIES.has(unquoted.toLowerCase())) return null;
    return unquoted;
}

function collectGoogleFamilies() {
    const s = getSettings();
    if (!s.enableGoogleFonts) return [];

    const families = new Set();
    const addIfGoogle = (fontValue) => {
        const preset = findFontPresetByValue(fontValue);
        if (preset?.google && preset.googleFamily) {
            families.add(preset.googleFamily);
            return;
        }

        const customFamily = extractCustomGoogleFamily(fontValue);
        if (customFamily) {
            families.add(customFamily);
        }
    };

    addIfGoogle(s.uiFontFamily);
    addIfGoogle(s.textFontFamily);
    return [...families];
}

function updateGoogleFontsLink() {
    const linkId = 'sp-google-fonts-link';
    let link = document.getElementById(linkId);
    const families = collectGoogleFamilies();

    if (!families.length) {
        if (link) link.remove();
        return;
    }

    const familyParam = families.map(f => `family=${encodeURIComponent(f)}`).join('&');
    const href = `https://fonts.googleapis.com/css2?${familyParam}&display=swap`;

    if (!link) {
        link = document.createElement('link');
        link.id = linkId;
        link.rel = 'stylesheet';
        document.head.appendChild(link);
    }
    if (link.href !== href) {
        link.href = href;
    }
}

function applyTypographyToWindow() {
    const win = document.getElementById('sp-window');
    if (!win) return;
    const s = getSettings();

    const uiFontFamily = normalizeFontFamilyForCss(s.uiFontFamily || 'inherit');
    const textFontFamily = normalizeFontFamilyForCss(s.textFontFamily || 'inherit');
    const uiFontSizePx = Number.isFinite(s.uiFontSizePx)
        ? clampFontSize(s.uiFontSizePx, 'ui')
        : getDisplayFontSize('ui');
    const textFontSizePx = Number.isFinite(s.textFontSizePx)
        ? clampFontSize(s.textFontSizePx, 'text')
        : getDisplayFontSize('text');
    const textFontWeight = Math.max(200, Math.min(900, Number(s.textFontWeight) || 400));

    win.style.setProperty('--sp-font-ui', uiFontFamily);
    win.style.setProperty('--sp-font-text', textFontFamily);
    win.style.setProperty('--sp-fontsize-ui-px', String(uiFontSizePx));
    win.style.setProperty('--sp-fontsize-text-px', String(textFontSizePx));
    win.style.setProperty('--sp-fontweight-text', String(textFontWeight));

    updateGoogleFontsLink();
}

function syncFontControls(kind) {
    const s = getSettings();
    const familyKey = kind === 'text' ? 'textFontFamily' : 'uiFontFamily';
    const sizeKey = kind === 'text' ? 'textFontSizePx' : 'uiFontSizePx';
    const family = s[familyKey] || 'inherit';

    const selectId = kind === 'text' ? 'sp-font-text-select' : 'sp-font-ui-select';
    const customId = kind === 'text' ? 'sp-font-text-custom' : 'sp-font-ui-custom';
    const rangeId = kind === 'text' ? 'sp-font-text-size-range' : 'sp-font-ui-size-range';
    const sizeValueId = kind === 'text' ? 'sp-font-text-size-value' : 'sp-font-ui-size-value';

    const select = document.getElementById(selectId);
    const custom = document.getElementById(customId);
    const customRow = document.getElementById(kind === 'text' ? 'sp-font-text-custom-row' : 'sp-font-ui-custom-row');
    const range = document.getElementById(rangeId);
    const sizeValue = document.getElementById(sizeValueId);
    const weightRange = document.getElementById('sp-font-text-weight-range');
    const weightValue = document.getElementById('sp-font-text-weight-value');

    const preset = findFontPresetByValue(family);
    if (select) {
        select.value = preset ? preset.value : '__custom__';
    }
    if (custom) {
        custom.value = preset || family === 'inherit' ? '' : family;
        custom.disabled = !!preset || family === 'inherit';
    }
    if (customRow) {
        customRow.style.display = select?.value === '__custom__' ? '' : 'none';
    }

    const displaySize = Number.isFinite(s[sizeKey]) ? clampFontSize(s[sizeKey], kind) : getDisplayFontSize(kind);
    if (range) range.value = String(displaySize);
    if (sizeValue) sizeValue.textContent = String(displaySize);

    if (kind === 'text') {
        const weight = Math.max(200, Math.min(900, Number(s.textFontWeight) || 400));
        if (weightRange) weightRange.value = String(weight);
        if (weightValue) weightValue.textContent = String(weight);
    }
}

function populateFontSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '';

    for (const preset of FONT_PRESETS) {
        const opt = document.createElement('option');
        opt.value = preset.value;
        opt.textContent = preset.labelKey ? t(preset.labelKey) : preset.label;
        select.appendChild(opt);
    }

    if (_localFontFamilies.length) {
        const group = document.createElement('optgroup');
        group.label = t('settings.localFontsGroup');
        for (const font of _localFontFamilies) {
            const opt = document.createElement('option');
            opt.value = font.value;
            opt.textContent = font.label;
            group.appendChild(opt);
        }
        select.appendChild(group);
    }

    if (current) {
        select.value = current;
    }
}

function saveFontFamily(kind) {
    const s = getSettings();
    const familyKey = kind === 'text' ? 'textFontFamily' : 'uiFontFamily';
    const selectId = kind === 'text' ? 'sp-font-text-select' : 'sp-font-ui-select';
    const customId = kind === 'text' ? 'sp-font-text-custom' : 'sp-font-ui-custom';

    const select = document.getElementById(selectId);
    const custom = document.getElementById(customId);
    if (!select) return;

    if (select.value === '__custom__') {
        const manual = custom?.value?.trim();
        if (manual) {
            s[familyKey] = manual;
        } else {
            const current = s[familyKey] || 'inherit';
            const currentPreset = findFontPresetByValue(current);
            if (currentPreset) {
                return;
            }
        }
    } else {
        s[familyKey] = select.value || 'inherit';
    }

    saveBrowserSettings();
    applyTypographyToWindow();
    syncFontControls(kind);
}

function onFontSelectChange(kind) {
    const selectId = kind === 'text' ? 'sp-font-text-select' : 'sp-font-ui-select';
    const customId = kind === 'text' ? 'sp-font-text-custom' : 'sp-font-ui-custom';
    const select = document.getElementById(selectId);
    const custom = document.getElementById(customId);
    if (!select) return;

    if (select.value === '__custom__') {
        if (custom) {
            custom.disabled = false;
            custom.focus();
        }
        const row = document.getElementById(kind === 'text' ? 'sp-font-text-custom-row' : 'sp-font-ui-custom-row');
        if (row) row.style.display = '';
        return;
    }

    saveFontFamily(kind);
}

function saveFontSize(kind, rawValue) {
    const s = getSettings();
    const sizeKey = kind === 'text' ? 'textFontSizePx' : 'uiFontSizePx';
    s[sizeKey] = clampFontSize(rawValue, kind);
    saveBrowserSettings();
    applyTypographyToWindow();
    syncFontControls(kind);
}

function saveTextFontWeight(rawValue) {
    const s = getSettings();
    const v = Math.max(200, Math.min(900, Number(rawValue) || 400));
    s.textFontWeight = Math.round(v / 50) * 50;
    saveBrowserSettings();
    applyTypographyToWindow();
    syncFontControls('text');
}

function resetTypographySettings() {
    const s = getSettings();
    s.uiFontFamily = defaultSettings.uiFontFamily;
    s.uiFontSizePx = FONT_SIZE_LIMITS.ui.fallback;
    s.textFontFamily = defaultSettings.textFontFamily;
    s.textFontSizePx = FONT_SIZE_LIMITS.text.fallback;
    s.textFontWeight = defaultSettings.textFontWeight;
    s.enableGoogleFonts = false;
    saveBrowserSettings();
    setChecked('sp-font-google-enable', s.enableGoogleFonts);
    syncFontControls('ui');
    syncFontControls('text');
    applyTypographyToWindow();
}

function refreshTypographyUI() {
    populateFontSelect('sp-font-ui-select');
    populateFontSelect('sp-font-text-select');
    setChecked('sp-font-google-enable', !!getSettings().enableGoogleFonts);
    syncFontControls('ui');
    syncFontControls('text');
}

const INJECTION_PROMPT_KEY = 'simple-summary/injection';
const INJECTION_POSITION = 1;

function getInjectionText() {
    if (!getSettings().injectionEnabled) return '';
    return resolvePrompt('{{SPSummaries}}', '');
}

function applySummaryInjection() {
    const ctx = getST();
    const s = getSettings();
    const depth = Math.max(0, Math.min(10000, Number(s.injectionDepth) || 0));
    ctx.setExtensionPrompt(
        INJECTION_PROMPT_KEY,
        getInjectionText(),
        INJECTION_POSITION,
        depth,
        false,
        0,
    );
}

function refreshInjectionSettingsUI() {
    const s = getSettings();
    setChecked('sp-injection-enabled', s.injectionEnabled);
    setVal('sp-injection-depth', String(s.injectionDepth ?? 999));
}

function saveInjectionSettingsFromForm() {
    const s = getSettings();
    s.injectionEnabled = !!document.getElementById('sp-injection-enabled')?.checked;
    s.injectionDepth = Math.max(0, Math.min(10000, Number(val('sp-injection-depth')) || 0));
    saveSettings();
    applySummaryInjection();
}

function syncLegacySummaryCleanup() {
    return stripLegacyChatMetadata();
}

function applySavedWindowSize() {
    const w = document.getElementById('sp-window');
    if (!w) return;

    const size = getSettings().windowSize;
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
        w.style.removeProperty('width');
        w.style.removeProperty('height');
        return;
    }

    w.style.width = `${Math.max(320, Math.round(size.width))}px`;
    w.style.height = `${Math.max(320, Math.round(size.height))}px`;
}

function saveCurrentWindowSize() {
    const w = document.getElementById('sp-window');
    if (!w || w.classList.contains('sp-fullscreen')) return;

    const rect = w.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const s = getSettings();
    s.windowSize = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
    saveBrowserSettings();
}

// ---------------------------------------------------------------------------
//  Persistent chat store  (user/files based segment system)
// ---------------------------------------------------------------------------

function stripLegacyChatMetadata() {
    const ctx = getST();
    const meta = ctx.chatMetadata;
    if (!meta || !Object.hasOwn(meta, 'simpleSummary')) return false;

    delete meta.simpleSummary;
    if (typeof ctx.saveMetadata === 'function') {
        ctx.saveMetadata();
    }
    return true;
}

function migrateLegacyMeta() {
    stripLegacyChatMetadata();
}

function getSegments() {
    return segments.getSegments();
}

function getChatSummary() {
    return segments.getChatSummary();
}

function getSegmentIndexById(id) {
    return segments.getSegmentIndexById(id);
}


function renderEditorView(targetId = null) {
    const editor = document.getElementById('sp-edit-textarea');
    if (!editor) return null;

    const segments = getSegments();
    if (!segments.length) {
        editor.innerHTML = `<div class="sp-edit-empty">${escapeHtml(t('edit.placeholder'))}</div>`;
        editor.dataset.segmentId = '';
        return null;
    }

    const targetIndex = Math.max(0, getSegmentIndexById(targetId) >= 0 ? getSegmentIndexById(targetId) : segments.length - 1);
    editor.innerHTML = '';

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const block = document.createElement('div');
        block.className = 'sp-edit-segment' + (i === targetIndex ? ' sp-edit-segment-current' : ' sp-edit-segment-ghost');
        block.dataset.segmentId = segment.id;
        block.dataset.range = `${segment.range?.start ?? 0}-${segment.range?.end ?? -1}`;
        block.textContent = String(segment.summaryText || '');
        if (i === targetIndex) {
            block.contentEditable = 'true';
            block.spellcheck = false;
        }
        editor.appendChild(block);
    }

    editor.dataset.segmentId = segments[targetIndex]?.id || '';
    const current = editor.querySelector('.sp-edit-segment-current');
    requestAnimationFrame(() => {
        const offset = Math.max(28, Math.round((editor.clientHeight || 0) * 0.12));
        const maxScroll = Math.max(0, editor.scrollHeight - editor.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScroll, (current?.offsetTop || 0) - offset));
        animateScrollTop(editor, targetTop, 320);
    });
    return current;
}

function getEditorCurrentSegmentId() {
    const editor = document.getElementById('sp-edit-textarea');
    return editor?.dataset?.segmentId || '';
}

function getEditorCurrentSegmentText() {
    const editor = document.getElementById('sp-edit-textarea');
    const current = editor?.querySelector('.sp-edit-segment-current');
    return current ? String(current.textContent || '') : '';
}

function scrollEditorToCurrentSegment(targetId) {
    const editor = document.getElementById('sp-edit-textarea');
    if (!editor) return;
    const target = targetId ? editor.querySelector(`[data-segment-id="${CSS.escape(targetId)}"]`) : editor.querySelector('.sp-edit-segment-current');
    if (!target) return;
    const offset = Math.max(28, Math.round((editor.clientHeight || 0) * 0.12));
    const maxScroll = Math.max(0, editor.scrollHeight - editor.clientHeight);
    const targetTop = Math.max(0, Math.min(maxScroll, target.offsetTop - offset));
    animateScrollTop(editor, targetTop, 320);
}

function animateScrollTop(el, targetTop, duration = 320) {
    const startTop = Number(el.scrollTop || 0);
    const change = targetTop - startTop;
    if (Math.abs(change) < 1) {
        el.scrollTop = targetTop;
        return;
    }

    if (el._spScrollRaf) {
        cancelAnimationFrame(el._spScrollRaf);
        el._spScrollRaf = 0;
    }

    const start = performance.now();
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
        const progress = Math.min(1, (now - start) / duration);
        el.scrollTop = startTop + change * easeOutCubic(progress);
        if (progress < 1) {
            el._spScrollRaf = requestAnimationFrame(step);
        } else {
            el._spScrollRaf = 0;
        }
    };

    el._spScrollRaf = requestAnimationFrame(step);
}

function getSegmentById(id) {
    return segments.getSegmentById(id);
}

function getLatestSegment() {
    return segments.getLatestSegment();
}

function setSegmentSummaryText(id, txt) {
    return segments.setSegmentSummaryText(id, txt);
}

function createSegment(summaryText, range) {
    return segments.createSegment(summaryText, range);
}

function deleteLatestSegment() {
    return segments.deleteLatestSegment();
}


// ---------------------------------------------------------------------------
//  Message hiding — sets is_system like ST's /hide command
// ---------------------------------------------------------------------------

function getSlashExecutor() {
    const ctx = getST();
    return window.executeSlashCommandsOnChatInput
        || window.executeSlashCommands
        || ctx.executeSlashCommandsOnChatInput
        || ctx.executeSlashCommands
        || null;
}

async function hideMessagesByRange(lo, hi) {
    if (lo > hi) return;
    const exec = getSlashExecutor();
    if (exec) {
        try {
            await exec(`/hide ${lo}-${hi}`);
            log('/hide', lo, '-', hi);
            return;
        } catch (e) {
            log('Slash /hide failed, fallback to manual:', e);
        }
    }
    const ctx = getST();
    for (let i = lo; i <= hi; i++) {
        const msg = ctx.chat?.[i];
        if (msg && !msg.is_system) {
            msg.is_system = true;
            document.querySelector(`.mes[mesid="${i}"]`)?.classList.add('is_system');
        }
    }
    if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
}

async function unhideMessagesByRange(lo, hi) {
    if (lo > hi) return;
    const exec = getSlashExecutor();
    if (exec) {
        try {
            await exec(`/unhide ${lo}-${hi}`);
            log('/unhide', lo, '-', hi);
            return;
        } catch (e) {
            log('Slash /unhide failed, fallback to manual:', e);
        }
    }

    const ctx = getST();
    for (let i = lo; i <= hi; i++) {
        const msg = ctx.chat?.[i];
        if (msg && msg.is_system) {
            msg.is_system = false;
            document.querySelector(`.mes[mesid="${i}"]`)?.classList.remove('is_system');
        }
    }
    if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
}

async function unhideUnsummarizedMessages() {
    const ctx = getST();
    const chat = ctx.chat || [];
    if (!chat.length) return;

    const lastIndex = chat.length - 1;
    const segments = getSegments();
    if (!segments.length) {
        await unhideMessagesByRange(0, lastIndex);
        return;
    }

    const ranges = segments
        .map(segment => normalizeRange(segment?.range))
        .filter(range => range.end >= range.start)
        .sort((a, b) => a.start - b.start);

    if (!ranges.length) {
        await unhideMessagesByRange(0, lastIndex);
        return;
    }

    const exec = getSlashExecutor();

    if (exec) {
        try {
            await exec(`/unhide 0-${lastIndex}`);
            log('/unhide', 0, '-', lastIndex);
            for (const range of ranges) {
                await exec(`/hide ${range.start}-${range.end}`);
                log('/hide', range.start, '-', range.end);
            }
            return;
        } catch (e) {
            log('Slash restore failed, fallback to manual:', e);
        }
    }

    for (let i = 0; i <= lastIndex; i++) {
        const msg = ctx.chat?.[i];
        if (msg && msg.is_system) {
            msg.is_system = false;
            document.querySelector(`.mes[mesid="${i}"]`)?.classList.remove('is_system');
        }
    }

    for (const range of ranges) {
        for (let i = range.start; i <= range.end; i++) {
            const msg = ctx.chat?.[i];
            if (msg && !msg.is_system) {
                msg.is_system = true;
                document.querySelector(`.mes[mesid="${i}"]`)?.classList.add('is_system');
            }
        }
    }

    if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
}

// ---------------------------------------------------------------------------
//  Preview helpers
// ---------------------------------------------------------------------------

function setPreviewCancelButtonBusy(busy) {
    const btn = document.getElementById('sp-preview-cancel-btn');
    if (!btn) return;
    btn.textContent = busy ? t('gen.stopRequest') : t('gen.cancel');
}

/** Active summary request — cancel button calls .abort() */
let activeSummaryAbort = null;

// ---------------------------------------------------------------------------
//  Prompt resolution
// ---------------------------------------------------------------------------

function buildChatText(messages) {
    return promptRuntime.buildChatText(messages);
}

function buildChatAfterText(chat, endIndex, count = 1) {
    return promptRuntime.buildChatAfterText(chat, endIndex, count);
}

function getLatestSummaryTextForLanguage(segments = null) {
    return promptRuntime.getLatestSummaryTextForLanguage(segments);
}

function getChatLangMacroValue(options = {}) {
    return promptRuntime.getChatLangMacroValue(options);
}

function resolvePrompt(template, chatText, chatAfterText = '') {
    return promptRuntime.resolvePrompt(template, chatText, chatAfterText);
}

function registerMacros() {
    return promptRuntime.registerMacros();
}


// ---------------------------------------------------------------------------
//  Toast
// ---------------------------------------------------------------------------

let _toastTimer;
function toast(msg) {
    let el = document.getElementById('sp-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'sp-toast';
        const host = document.getElementById('sp-header') || document.getElementById('sp-window') || document.body;
        host.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('sp-toast-show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('sp-toast-show'), 3000);
}

// ---------------------------------------------------------------------------
//  Confirm Dialog
// ---------------------------------------------------------------------------

function showConfirmDialog(header, body) {
    return new Promise(resolve => {
        const overlay = document.getElementById('sp-confirm-overlay');
        const headerEl = document.getElementById('sp-confirm-dialog-header');
        const bodyEl = document.getElementById('sp-confirm-dialog-body');
        const cancelBtn = document.getElementById('sp-confirm-cancel-btn');
        const confirmBtn = document.getElementById('sp-confirm-confirm-btn');
        
        if (!overlay) { resolve(false); return; }
        
        headerEl.textContent = header;
        bodyEl.innerHTML = body;
        overlay.style.display = 'flex';
        
        const close = (result) => {
            overlay.style.display = 'none';
            resolve(result);
        };
        
        cancelBtn.onclick = () => close(false);
        confirmBtn.onclick = () => close(true);
        overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    });
}

function showUnsavedChangesDialog() {
    return new Promise(resolve => {
        const overlay = document.getElementById('sp-unsaved-overlay');
        const cancelBtn = document.getElementById('sp-unsaved-cancel-btn');
        const discardBtn = document.getElementById('sp-unsaved-discard-btn');
        const saveBtn = document.getElementById('sp-unsaved-save-btn');

        if (!overlay) { resolve('cancel'); return; }

        overlay.style.display = 'flex';

        const close = (result) => {
            overlay.style.display = 'none';
            resolve(result);
        };

        cancelBtn.onclick = () => close('cancel');
        discardBtn.onclick = () => close('discard');
        saveBtn.onclick = () => close('save');
        overlay.onclick = (e) => { if (e.target === overlay) close('cancel'); };
    });
}

function getSummaryEditorCurrentBlock() {
    const editor = document.getElementById('sp-edit-textarea');
    return editor?.querySelector('.sp-edit-segment-current') || null;
}

function isSummaryEditorDirty() {
    const current = getSummaryEditorCurrentBlock();
    return current?.dataset?.dirty === '1';
}

function markSummaryEditorClean() {
    const current = getSummaryEditorCurrentBlock();
    if (current) current.dataset.dirty = '0';
}

function markSummaryEditorDirtyState(isDirty) {
    const current = getSummaryEditorCurrentBlock();
    if (current) current.dataset.dirty = isDirty ? '1' : '0';
    updateEditFooterState();
}

function saveCurrentSummaryEditor() {
    const targetId = _previewSegmentId || getEditorCurrentSegmentId() || getLatestSegment()?.id;
    if (!targetId) return false;
    const newText = getEditorCurrentSegmentText();
    setSegmentSummaryText(targetId, newText);

    renderSegmentTimeline();
    renderEditorView(targetId);
    scrollEditorToCurrentSegment(targetId);
    markSummaryEditorClean();
    updateEditFooterState();
    refreshHome();
    toast(t('toast.summarySaved'));
    return true;
}

function discardCurrentSummaryEditorChanges() {
    const segment = _previewSegmentId ? getSegmentById(_previewSegmentId) : getLatestSegment();
    renderEditorView(segment?.id || null);
    scrollEditorToCurrentSegment(segment?.id || null);
    markSummaryEditorClean();
    updateEditFooterState();
}

function isPromptEditorDirty() {
    const saveBtn = document.getElementById('sp-prompt-save-btn');
    return !!saveBtn && !saveBtn.disabled;
}

function saveCurrentPromptEditor() {
    if (!isPromptEditorDirty()) return true;
    savePromptPreset();
    return true;
}

function discardCurrentPromptEditorChanges() {
    revertPromptChanges();
}

function setActivePromptSection(section) {
    const systemSection = document.getElementById('sp-prompt-system-section');
    const userSection = document.getElementById('sp-prompt-user-section');
    const target = section === 'user' ? 'user' : 'system';
    systemSection?.classList.toggle('sp-prompt-section-open', target === 'system');
    userSection?.classList.toggle('sp-prompt-section-open', target === 'user');
}

function saveCurrentApiPreset() {
    return saveActivePreset();
}

function discardCurrentApiPresetChanges() {
    discardActivePresetChanges();
}

async function guardUnsavedChanges(kind, onSave, onDiscard) {
    const result = await showUnsavedChangesDialog();
    if (result === 'cancel') return false;
    if (result === 'save') return onSave() !== false;
    onDiscard?.();
    return true;
}

async function beforeSummaryEditorLeave() {
    if (!isSummaryEditorDirty()) return true;
    return guardUnsavedChanges('summary', saveCurrentSummaryEditor, discardCurrentSummaryEditorChanges);
}

async function beforePromptEditorLeave() {
    if (!isPromptEditorDirty()) return true;
    return guardUnsavedChanges('prompt', saveCurrentPromptEditor, discardCurrentPromptEditorChanges);
}

async function beforeApiPresetLeave() {
    if (!isApiPresetDirty()) return true;
    return guardUnsavedChanges('api', saveCurrentApiPreset, discardCurrentApiPresetChanges);
}

async function beforePromptPresetChange() {
    return beforePromptEditorLeave();
}

async function beforeTabSwitch(nextTab) {
    const activeTab = document.querySelector('.sp-tab.sp-tab-active')?.dataset?.tab || 'home';
    if (activeTab === nextTab) return true;
    if (activeTab === 'edit') return beforeSummaryEditorLeave();
    if (activeTab === 'prompt') return beforePromptEditorLeave();
    if (activeTab === 'api') return beforeApiPresetLeave();
    return true;
}

async function closeMainWindowWithGuard() {
    const activeTab = document.querySelector('.sp-tab.sp-tab-active')?.dataset?.tab || 'home';
    if (activeTab === 'edit') {
        const ok = await beforeSummaryEditorLeave();
        if (!ok) return false;
    } else if (activeTab === 'prompt') {
        const ok = await beforePromptEditorLeave();
        if (!ok) return false;
    } else if (activeTab === 'api') {
        const ok = await beforeApiPresetLeave();
        if (!ok) return false;
    }

    closeRequestPreviewOverlay();
    closePreviewOverlay();
    document.getElementById('sp-window').style.display = 'none';
    const backdrop = document.getElementById('sp-backdrop');
    if (backdrop) backdrop.style.display = 'none';
    return true;
}

storage = createStorageManager({
    defaultSettings,
    browserSettingsKeys: BROWSER_SETTINGS_KEYS,
    moduleName: MODULE_NAME,
    getST,
    translate: t,
    toast,
});

segments = createSegmentController({
    getMeta: () => storage.getCurrentChatState(),
    ensureMeta: () => storage.getCurrentChatState(),
    saveMeta: () => { void saveCurrentChatState(); },
    onChange: applySummaryInjection,
});

promptRuntime = createPromptRuntime({
    getST,
    getSegments,
    getChatSummary,
    getHomeSummaryRange,
    getRangeEndValue: () => val('sp-range-end'),
    getPreprocessConfig: () => getSettings().chatLogPreprocess,
    translate: t,
});

const preprocessManager = createChatLogPreprocessManager({
    getSettings,
    saveSettings,
    setChecked,
    toast,
    t,
});


const {
    migratePreprocessSettings,
    loadPreprocessEditor,
    renderPreprocessRules,
    getPreprocessSettings,
    updateStepSetting,
    addRegexRule,
    deleteRegexRule,
} = preprocessManager;

const promptManager = createPromptPresetManager({
    getSettings,
    saveSettings,
    getCustomPrompts,
    setCustomPrompts,
    saveCustomPrompts: queueCustomPromptsSave,
    getDefaultPrompt: getLoadedDefaultPrompt,
    setVal,
    val,
    setChecked,
    toast,
    t,
    showConfirmDialog,
    beforePromptPresetChange,
});

const {
    migratePromptSettings,
    getPromptTemplateForSummary,
    updatePromptActionButtons,
    scrollPromptTabs,
    addPromptPreset,
    revertPromptChanges,
    savePromptPreset,
    renderPromptPresetTabs,
    loadPromptEditor,
} = promptManager;

const apiManager = createApiPresetManager({
    getSettings,
    saveSettings,
    getST,
    normalizeBaseUrl,
    log,
    logE,
    toast,
    val,
    setVal,
    setText,
    setChecked,
    setRange,
    show,
    hide,
    escapeHtml,
    t,
    showConfirmDialog,
});

const {
    addPreset,
    deletePreset,
    syncPresetForm,
    isApiPresetDirty,
    discardActivePresetChanges,
    saveActivePreset,
    selectPreset,
    updateApiActionButtons,
    renderApiPresets,
    testPreset,
    fetchModels,
    getApiDefaults,
} = apiManager;

// ===========================================================================
//  UI
// ===========================================================================

async function buildUI() {
    // ---- Wand menu entry ----
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        const btn = document.createElement('div');
        btn.id = 'sp-menu-entry';
        btn.className = 'list-group-item flex-container flexGap5';
        btn.style.cursor = 'pointer';
        btn.innerHTML = '<span>📝</span> ' + t('header.title');
        btn.addEventListener('click', toggleWindow);
        menu.appendChild(btn);
        console.log('[SimpleSummary] Menu entry injected.');
    } else {
        console.warn('[SimpleSummary] #extensionsMenu not found!');
    }

    // ---- Load HTML template ----
    try {
        const resp = await fetch(BASE_URL + 'index.html');
        if (!resp.ok) throw new Error(resp.status);
        const wrapper = document.createElement('div');
        wrapper.innerHTML = await resp.text();
        // Move children into body
        while (wrapper.firstChild) document.body.appendChild(wrapper.firstChild);
    } catch (e) {
        console.error('[SimpleSummary] Failed to load index.html:', e);
        return;
    }

    bindEvents();
    applyAllDataI18n();
    refreshTypographyUI();
    applyTypographyToWindow();
    applySavedWindowSize();
    applyWindowResponsiveMode();
    renderApiPresets();
    renderPromptPresetTabs();
    loadPromptEditor();
}

let _lastFullscreenMode = false;
let _windowSizeSaveTimer = null;

function isMobileRangeGuardActive() {
    try {
        return window.matchMedia('(max-width: 760px)').matches;
    } catch (_) {
        return false;
    }
}

function isTouchPointerEvent(e) {
    if (!e) return false;
    if (typeof e.pointerType === 'string') {
        return e.pointerType === 'touch' || e.pointerType === 'pen';
    }
    return true;
}

function getPointerClientX(e) {
    if (typeof e.clientX === 'number') return e.clientX;
    const t = e.touches?.[0] || e.changedTouches?.[0];
    return typeof t?.clientX === 'number' ? t.clientX : null;
}

function isTouchNearRangeThumb(input, clientX) {
    if (!input || clientX === null) return false;
    const rect = input.getBoundingClientRect();
    if (!rect.width) return false;

    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value || min);
    const span = max - min;
    if (!Number.isFinite(span) || span <= 0) return false;

    const ratio = Math.max(0, Math.min(1, (value - min) / span));
    const thumbX = rect.left + rect.width * ratio;
    const touchTolerancePx = 18;
    return Math.abs(clientX - thumbX) <= touchTolerancePx;
}

function setupMobileApiRangeGuard() {
    const ranges = document.querySelectorAll('#sp-tab-api input[type="range"]');
    ranges.forEach(input => {
        const guard = (e) => {
            if (!isMobileRangeGuardActive()) return;
            if (!isTouchPointerEvent(e)) return;

            const clientX = getPointerClientX(e);
            if (isTouchNearRangeThumb(input, clientX)) return;

            e.preventDefault();
            e.stopPropagation();
        };

        input.addEventListener('pointerdown', guard);
        input.addEventListener('touchstart', guard, { passive: false });
    });
}

function isSingleColumnLayout() {
    const sheld = document.getElementById('sheld');
    if (!sheld) return window.innerWidth <= 768;
    const sheldWidth = sheld.getBoundingClientRect().width;
    const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
    return sheldWidth >= viewportWidth - 4;
}

function applyWindowResponsiveMode() {
    const w = document.getElementById('sp-window');
    const backdrop = document.getElementById('sp-backdrop');
    const apiSidebar = document.getElementById('sp-api-sidebar');
    if (!w) return;

    const fullscreen = isSingleColumnLayout();

    if (fullscreen && !_lastFullscreenMode) {
        saveCurrentWindowSize();
        w.style.removeProperty('width');
        w.style.removeProperty('height');
    } else if (!fullscreen && _lastFullscreenMode) {
        applySavedWindowSize();
    }

    w.classList.toggle('sp-fullscreen', fullscreen);
    _lastFullscreenMode = fullscreen;
    
    // API sidebar: collapse by default in fullscreen mode
    if (apiSidebar) {
        apiSidebar.classList.toggle('sp-api-sidebar-collapsed', fullscreen);
    }

    syncHomeStatusStackState();

    applyApiSidebarWidth();
    updateTabScrollState();

    const isOpen = w.style.display !== 'none' && !!w.style.display;

    if (!backdrop || !isOpen) return;

    backdrop.style.display = fullscreen ? 'none' : 'block';
}

function toggleWindow() {
    const w = document.getElementById('sp-window');
    const backdrop = document.getElementById('sp-backdrop');
    if (!w) return;
    applyWindowResponsiveMode();
    const fullscreen = w.classList.contains('sp-fullscreen');
    if (w.style.display === 'none' || !w.style.display) {
        if (backdrop) backdrop.style.display = fullscreen ? 'none' : 'block';
        w.style.display = 'flex';
        switchTab('home');
    } else {
        void closeMainWindowWithGuard();
    }
}

// ---------------------------------------------------------------------------
//  Event wiring  (called once after HTML injected)
// ---------------------------------------------------------------------------

function bindEvents() {
    window.addEventListener('resize', applyWindowResponsiveMode);
    setupMobileApiRangeGuard();
    setupApiSidebarResize();
    bindTabScrollState();

    const winEl = document.getElementById('sp-window');

    if (winEl && typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => {
            if (winEl.classList.contains('sp-fullscreen')) return;
            if (winEl.style.display === 'none' || !winEl.style.display) return;
            clearTimeout(_windowSizeSaveTimer);
            _windowSizeSaveTimer = setTimeout(saveCurrentWindowSize, 180);
        });
        ro.observe(winEl);
    }

    // Close
    on('sp-close-btn', 'click', () => { void closeMainWindowWithGuard(); });

    // Close on backdrop click (disabled when preview overlay is active)
    const backdrop = document.getElementById('sp-backdrop');
    if (backdrop) {
        backdrop.addEventListener('click', () => {
            // Don't close if preview overlay is showing
            const previewOverlay = document.getElementById('sp-preview-overlay');
            const requestPreviewOverlay = document.getElementById('sp-request-preview-overlay');
            if ((previewOverlay && previewOverlay.style.display !== 'none') || (requestPreviewOverlay && requestPreviewOverlay.style.display !== 'none')) {
                return;
            }
            void closeMainWindowWithGuard();
        });
    }

    // Tabs
    document.querySelectorAll('.sp-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            const nextTab = tab.dataset.tab;
            const allowed = await beforeTabSwitch(nextTab);
            if (!allowed) return;
            switchTab(nextTab);
        });
    });

    // ── Home ──
    const settings = getSettings();
    setChecked('sp-opt-auto-hide', settings.autoHide);
    setChecked('sp-opt-stream', settings.useStream);
    on('sp-home-char-status-right', 'click', () => {
        setHomeStatusStackExpanded(true, { autoCollapse: true });
    });
    const retainInput = document.getElementById('sp-range-retain');
    const rangeEnd = document.getElementById('sp-range-end');
    if (retainInput) retainInput.value = String(normalizeRetainCount(settings.summaryRetainCount));
    if (retainInput && !retainInput.dataset.boundGesture) {
        retainInput.dataset.boundGesture = '1';
        bindNumericGestureInput(retainInput, () => ({ min: 0, max: 999, step: 1 }));
    }
    if (rangeEnd && !rangeEnd.dataset.boundGesture) {
        rangeEnd.dataset.boundGesture = '1';
        bindNumericGestureInput(rangeEnd, () => {
            const chat = getST().chat || [];
            const { start, end: maxHi } = getHomeSummaryRange(chat);
            return { min: start === -1 ? 0 : start, max: maxHi, step: 1 };
        });
    }

    on('sp-opt-auto-hide', 'change', e => { getSettings().autoHide = e.target.checked; saveSettings(); });
    on('sp-opt-stream',    'change', e => { getSettings().useStream = e.target.checked; saveSettings(); });
    on('sp-range-retain', 'change', e => {
        const next = normalizeRetainCount(e.target.value);
        getSettings().summaryRetainCount = next;
        e.target.value = String(next);
        saveBrowserSettings();
        refreshHome();
    });
    on('sp-range-end', 'change', e => {
        e.target.dataset.userEdited = '1';
        const chat = getST().chat || [];
        const { start, end: maxHi } = getHomeSummaryRange(chat);
        const next = Math.floor(Number(e.target.value));
        const lower = start === -1 ? 0 : start;
        const upper = Math.max(lower, maxHi);
        const clamped = Number.isFinite(next) ? Math.min(Math.max(lower, next), upper) : upper;
        e.target.value = String(Number.isFinite(clamped) ? clamped : lower);
    });

    on('sp-start-btn',      'click', startSummary);
    on('sp-request-preview-btn', 'click', openSummaryRequestPreview);
    let unhideHelpTimer = null;
    on('sp-unhide-help', 'click', () => {
        const hint = document.getElementById('sp-unhide-hint');
        if (!hint) return;
        hint.style.display = 'block';
        clearTimeout(unhideHelpTimer);
        unhideHelpTimer = setTimeout(() => {
            hint.style.display = 'none';
        }, 5000);
    });

    on('sp-unhide-btn', 'click', async () => {
        await unhideUnsummarizedMessages();
        toast(t('toast.unsummarizedUnhidden'));
        refreshHome();
    });

    // ── Edit ──
    on('sp-edit-save-btn', 'click', saveCurrentSummaryEditor);
    on('sp-edit-revert-btn', 'click', discardCurrentSummaryEditorChanges);
    on('sp-segment-delete-btn', 'click', onDeleteLatestSegment);
    document.getElementById('sp-edit-textarea')?.addEventListener('input', () => {
        const editor = document.getElementById('sp-edit-textarea');
        const current = editor?.querySelector('.sp-edit-segment-current');
        if (!current) return;
        current.dataset.dirty = '1';
        updateEditFooterState();
    });

    // ── Prompt ──
    on('sp-prompt-save-btn', 'click', savePromptPreset);
    on('sp-prompt-revert-btn', 'click', revertPromptChanges);
    on('sp-prompt-add-btn', 'click', addPromptPreset);
    on('sp-prompt-tabs-prev', 'click', () => scrollPromptTabs(-1));
    on('sp-prompt-tabs-next', 'click', () => scrollPromptTabs(1));
    on('sp-prompt-system-header', 'click', () => setActivePromptSection('system'));
    on('sp-prompt-user-header', 'click', () => setActivePromptSection('user'));
    document.getElementById('sp-prompt-system-textarea')?.addEventListener('input', () => {
        updatePromptActionButtons();
    });
    document.getElementById('sp-prompt-user-textarea')?.addEventListener('input', () => {
        updatePromptActionButtons();
    });

    // ── Preprocess ──
    on('sp-preprocess-structured-toggle', 'change', e => {
        updateStepSetting('structuredCleanup', e.target.checked);
    });
    on('sp-preprocess-strip-toggle', 'change', e => {
        updateStepSetting('stripHtmlText', e.target.checked);
    });
    on('sp-preprocess-add-rule', 'click', addRegexRule);
    let preprocessStructureHelpTimer = null;
    on('sp-preprocess-structure-help', 'click', () => {
        const hint = document.getElementById('sp-preprocess-structure-hint');
        if (!hint) return;
        hint.style.display = 'block';
        clearTimeout(preprocessStructureHelpTimer);
        preprocessStructureHelpTimer = setTimeout(() => {
            hint.style.display = 'none';
        }, 10000);
    });
    let preprocessStripHelpTimer = null;
    on('sp-preprocess-strip-help', 'click', () => {
        const hint = document.getElementById('sp-preprocess-strip-hint');
        if (!hint) return;
        hint.style.display = 'block';
        clearTimeout(preprocessStripHelpTimer);
        preprocessStripHelpTimer = setTimeout(() => {
            hint.style.display = 'none';
        }, 10000);
    });
    let preprocessRegexHelpTimer = null;
    on('sp-preprocess-regex-help', 'click', () => {
        const hint = document.getElementById('sp-preprocess-regex-hint');
        if (!hint) return;
        hint.style.display = 'block';
        clearTimeout(preprocessRegexHelpTimer);
        preprocessRegexHelpTimer = setTimeout(() => {
            hint.style.display = 'none';
        }, 10000);
    });

    // ── Settings ──
    on('sp-injection-enabled', 'change', saveInjectionSettingsFromForm);
    on('sp-injection-depth', 'change', saveInjectionSettingsFromForm);
    on('sp-auto-cleanup-expired', 'change', e => {
        getSettings().autoCleanupExpired = !!e.target.checked;
        saveSettings();
    });
    refreshInjectionSettingsUI();
    refreshTypographyUI();
    setChecked('sp-auto-cleanup-expired', !!getSettings().autoCleanupExpired);

    on('sp-font-ui-select', 'change', () => onFontSelectChange('ui'));
    on('sp-font-text-select', 'change', () => onFontSelectChange('text'));
    on('sp-font-ui-custom', 'change', () => saveFontFamily('ui'));
    on('sp-font-text-custom', 'change', () => saveFontFamily('text'));
    on('sp-font-ui-size-range', 'input', e => saveFontSize('ui', e.target.value));
    on('sp-font-text-size-range', 'input', e => saveFontSize('text', e.target.value));
    on('sp-font-text-weight-range', 'input', e => saveTextFontWeight(e.target.value));
    on('sp-font-google-enable', 'change', e => {
        getSettings().enableGoogleFonts = !!e.target.checked;
        saveBrowserSettings();
        applyTypographyToWindow();
    });
    on('sp-font-reset-btn', 'click', () => {
        resetTypographySettings();
        toast(t('toast.typographyReset'));
    });
    on('sp-font-load-local-btn', 'click', async () => {
        const result = await loadLocalFontFamilies();
        refreshTypographyUI();
        if (!result.supported) {
            toast(t('toast.localFontsUnsupported'));
        } else if (result.denied) {
            toast(t('toast.localFontsDenied'));
        } else {
            toast(t('toast.localFontsLoaded', { count: result.count }));
        }
    });
    let googleHelpTimer = null;
    on('sp-font-google-help', 'click', () => {
        const hint = document.getElementById('sp-font-google-hint');
        if (!hint) return;
        hint.style.display = 'block';
        clearTimeout(googleHelpTimer);
        googleHelpTimer = setTimeout(() => {
            hint.style.display = 'none';
        }, 10000);
    });
    
    // Injection help toggle (auto-hide after 15s)
    let injectionHelpTimer = null;
    on('sp-injection-help', 'click', () => {
        const hint = document.getElementById('sp-injection-hint');
        if (!hint) return;
        hint.style.display = 'block';
        clearTimeout(injectionHelpTimer);
        injectionHelpTimer = setTimeout(() => {
            hint.style.display = 'none';
        }, 10000);
    });

    let autoHideHelpTimer = null;
    on('sp-auto-hide-help', 'click', () => {
        const hint = document.getElementById('sp-auto-hide-hint');
        if (!hint) return;
        hint.style.display = 'block';
        clearTimeout(autoHideHelpTimer);
        autoHideHelpTimer = setTimeout(() => {
            hint.style.display = 'none';
        }, 10000);
    });

    let autoCleanupHelpTimer = null;
    on('sp-auto-cleanup-help', 'click', () => {
        const hint = document.getElementById('sp-auto-cleanup-hint');
        if (!hint) return;
        hint.style.display = 'block';
        clearTimeout(autoCleanupHelpTimer);
        autoCleanupHelpTimer = setTimeout(() => {
            hint.style.display = 'none';
        }, 5000);
    });

    // ── Preview ── 生成中：仅中止请求；空闲时「取消」才关闭预览
    on('sp-preview-cancel-btn', 'click', () => {
        if (activeSummaryAbort) {
            try { activeSummaryAbort.abort(); } catch (_) {}
            return;
        }
        closePreviewOverlay();
    });
    on('sp-preview-save-btn', 'click', saveSummaryResult);
    on('sp-preview-textarea', 'input', () => {
        const el = document.getElementById('sp-preview-textarea');
        el?.classList.toggle('sp-preview-text-empty', !(el.textContent || '').trim());
    });
    on('sp-request-preview-cancel-btn', 'click', closeRequestPreviewOverlay);
    on('sp-request-preview-start-btn', 'click', async () => {
        await runSummaryRequest(_pendingSummaryRequest || buildSummaryRequestContext());
    });

    // ── API ──
    on('sp-api-add-preset',  'click', () => {
        const sidebar = document.getElementById('sp-api-sidebar');
        if (sidebar?.classList.contains('sp-api-sidebar-collapsed')) {
            sidebar.classList.remove('sp-api-sidebar-collapsed');
            applyApiSidebarWidth();
        }
        saveCurrentApiPreset();
        addPreset();
    });
    on('sp-api-save-btn',    'click', saveCurrentApiPreset);
    on('sp-api-del-btn',     'click', deletePreset);
    on('sp-api-test-btn',    'click', testPreset);
    on('sp-api-fetch-models','click', fetchModels);
    
    // API sidebar collapse toggle
    document.querySelector('.sp-api-sidebar-header')?.addEventListener('click', () => {
        const sidebar = document.getElementById('sp-api-sidebar');
        if (sidebar) {
            sidebar.classList.toggle('sp-api-sidebar-collapsed');
            applyApiSidebarWidth();
        }
    });

    // Key visibility toggle
    on('sp-api-key-toggle', 'click', () => {
        const inp = document.getElementById('sp-api-key');
        if (!inp) return;
        if (inp.type === 'password') {
            inp.type = 'text';
            document.getElementById('sp-api-key-toggle').textContent = '🔒';
        } else {
            inp.type = 'password';
            document.getElementById('sp-api-key-toggle').textContent = '👁';
        }
    });

    // Manual model toggle
    on('sp-api-manual-model-toggle', 'change', e => {
        const manualInput = document.getElementById('sp-api-model-manual');
        const manualRow = document.getElementById('sp-api-model-manual-row');
        const modelSelect = document.getElementById('sp-api-model-select');
        const fetchBtn = document.getElementById('sp-api-fetch-models');
        if (manualInput) manualInput.disabled = !e.target.checked;
        if (manualRow) manualRow.style.display = e.target.checked ? '' : 'none';
        if (modelSelect) modelSelect.disabled = e.target.checked;
        if (fetchBtn) fetchBtn.disabled = e.target.checked;
        syncPresetForm();
    });

    // Light theme toggle (moved to header)
    on('sp-theme-toggle-btn', 'click', () => {
        const win = document.getElementById('sp-window');
        if (!win) return;
        const isLight = win.classList.contains('sp-light');
        if (isLight) {
            win.classList.remove('sp-light');
        } else {
            win.classList.add('sp-light');
        }
        getSettings().lightTheme = !isLight;
        saveSettings();
    });
    // Restore theme on load
    if (getSettings().lightTheme) {
        document.getElementById('sp-window')?.classList.add('sp-light');
    }

    // Sliders live labels
    for (const key of ['temp', 'topp', 'topk', 'freqp', 'presp']) {
        on(`sp-api-p-${key}`, 'input', e => {
            const lbl = document.getElementById(`sp-api-val-${key}`);
            if (lbl) lbl.textContent = e.target.value;
            syncPresetForm();
        });
    }
    on('sp-api-p-maxtokens', 'input', e => {
        const lbl = document.getElementById('sp-api-val-maxtokens');
        if (lbl) lbl.textContent = e.target.value + 'K';
        syncPresetForm();
    });

    // Optional param checkboxes (enable/disable slider)
    for (const [cbId, sliderId, settingKey] of [
        ['sp-api-en-maxtokens', 'sp-api-p-maxtokens', 'en_maxtokens'],
        ['sp-api-en-topk',  'sp-api-p-topk',  'en_topk'],
        ['sp-api-en-freqp', 'sp-api-p-freqp', 'en_freqp'],
        ['sp-api-en-presp', 'sp-api-p-presp', 'en_presp'],
    ]) {
        on(cbId, 'change', e => {
            const slider = document.getElementById(sliderId);
            if (slider) slider.disabled = !e.target.checked;
            if (cbId === 'sp-api-en-maxtokens') {
                const valEl = document.getElementById('sp-api-val-maxtokens');
                if (valEl) valEl.textContent = document.getElementById('sp-api-p-maxtokens')?.value + 'K';
            }
            syncPresetForm();
        });
    }

    // Preset list delegation
    document.getElementById('sp-api-preset-list')?.addEventListener('click', e => {
        const item = e.target.closest('.sp-api-list-item');
        if (!item) return;
        const currentId = getSettings().activePresetId;
        if (item.dataset.id === currentId) return;
        saveCurrentApiPreset();
        selectPreset(item.dataset.id);
    });

    for (const inputId of [
        'sp-api-name',
        'sp-api-url',
        'sp-api-key',
        'sp-api-model-manual',
        'sp-api-custom-include-body',
        'sp-api-custom-exclude-body',
        'sp-api-custom-include-headers',
    ]) {
        document.getElementById(inputId)?.addEventListener('input', () => {
            syncPresetForm();
        });
    }

    document.getElementById('sp-api-model-select')?.addEventListener('change', () => {
        syncPresetForm();
    });

    document.getElementById('sp-api-reasoning-effort')?.addEventListener('change', () => {
        syncPresetForm();
    });

    document.getElementById('sp-api-custom-extra-toggle')?.addEventListener('change', e => {
        const fields = document.getElementById('sp-api-custom-extra-fields');
        const type = document.getElementById('sp-api-type')?.value || 'custom';
        if (fields) fields.style.display = type === 'custom' && e.target.checked ? '' : 'none';
        syncPresetForm();
    });

    // API type change: fill defaults only if key is empty (new preset workflow)
    document.getElementById('sp-api-type')?.addEventListener('change', (e) => {
        const keyInput = document.getElementById('sp-api-key');
        const keyIsEmpty = !keyInput?.value?.trim();

        if (keyIsEmpty) {
            const type = e.target.value;
            const defaults = getApiDefaults();
            const d = defaults[type] || defaults.custom || defaults.openai;
            setVal('sp-api-url', d.url);
        }

        const customRow = document.getElementById('sp-api-custom-extra-row');
        const customFields = document.getElementById('sp-api-custom-extra-fields');
        const customToggle = document.getElementById('sp-api-custom-extra-toggle');
        if (customRow) customRow.style.display = e.target.value === 'custom' ? '' : 'none';
        if (customFields) customFields.style.display = e.target.value === 'custom' && customToggle?.checked ? '' : 'none';
        syncPresetForm();
    });

    // Reset plugin dialog
    on('sp-reset-plugin-btn', 'click', () => {
        document.getElementById('sp-reset-overlay').style.display = 'flex';
    });
    on('sp-reset-cancel-btn', 'click', () => {
        document.getElementById('sp-reset-overlay').style.display = 'none';
    });
    on('sp-reset-confirm-btn', 'click', async () => {
        document.getElementById('sp-reset-overlay').style.display = 'none';
        const s = getSettings();
        for (const key of BROWSER_SETTINGS_KEYS) {
            s[key] = structuredClone(defaultSettings[key]);
        }
        clearBrowserSettings();
        await reloadDefaultPrompt();
        migratePreprocessSettings();
        refreshInjectionSettingsUI();
        refreshTypographyUI();
        applyTypographyToWindow();
        applySummaryInjection();
        
        // Update UI to reflect reset settings
        setChecked('sp-opt-auto-hide', s.autoHide);
        setChecked('sp-opt-stream', s.useStream);
        const retainInput = document.getElementById('sp-range-retain');
        if (retainInput) retainInput.value = String(s.summaryRetainCount);
        
        // Apply light theme class
        const win = document.getElementById('sp-window');
        if (win) {
            if (s.lightTheme) {
                win.classList.add('sp-light');
            } else {
                win.classList.remove('sp-light');
            }
        }
        
        toast(t('toast.pluginReset'));
        renderPromptPresetTabs();
        loadPromptEditor();
        loadPreprocessEditor();
        renderSegmentTimeline();
        refreshHome();
    });

    // Language selector
    initLanguageSelector();
}

// ---------------------------------------------------------------------------
//  Default prompt loader
// ---------------------------------------------------------------------------

async function reloadDefaultPrompt() {
    try {
        const r = await fetch(`${BASE_URL}DEFAULT_SUMMARY_PROMPT.json`);
        if (r.ok) {
            const data = await r.json();
            setLoadedDefaultPrompt(data);
            renderPromptPresetTabs();
            loadPromptEditor();
        }
    } catch (_) {}
}

// ---------------------------------------------------------------------------
//  Language selector
// ---------------------------------------------------------------------------

function initLanguageSelector() {
    const toggleBtn = document.getElementById('sp-lang-toggle-btn');
    const menu = document.getElementById('sp-lang-menu');
    if (!toggleBtn || !menu) return;

    renderLanguageMenu();

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = menu.classList.contains('sp-lang-menu-open');
        if (isOpen) {
            menu.classList.remove('sp-lang-menu-open');
        } else {
            menu.classList.add('sp-lang-menu-open');
            menu.querySelectorAll('.sp-lang-menu-item').forEach(el => {
                el.classList.toggle('sp-lang-menu-item-active', el.dataset.locale === getCurrentLocale());
            });
        }
    });

    menu.addEventListener('click', async (e) => {
        const item = e.target.closest('.sp-lang-menu-item');
        if (!item) return;
        const chosen = item.dataset.locale;
        menu.classList.remove('sp-lang-menu-open');
        if (chosen === getCurrentLocale()) return;
        await globalThis.SimpleSummaryUpdateLocale(chosen);
    });

    document.addEventListener('click', (e) => {
        if (!toggleBtn.contains(e.target) && !menu.contains(e.target)) {
            menu.classList.remove('sp-lang-menu-open');
        }
    });
}

function renderLanguageMenu() {
    const menu = document.getElementById('sp-lang-menu');
    if (!menu) return;
    
    const locales = getAvailableLocales();
    menu.innerHTML = '';
    
    for (const loc of locales) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sp-lang-menu-item';
        item.dataset.locale = loc;
        const label = getLocaleLabel(loc);
        const code = loc.toUpperCase();
        item.textContent = `${label} (${code})`;
        if (loc === getCurrentLocale()) {
            item.classList.add('sp-lang-menu-item-active');
        }
        menu.appendChild(item);
    }
}

// ---------------------------------------------------------------------------
//  Tab switching
// ---------------------------------------------------------------------------

function updateTabScrollState() {
    const tabs = document.getElementById('sp-tabs');
    const wrap = document.getElementById('sp-tabs-wrap');
    if (!tabs || !wrap) return;

    const maxLeft = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    const left = tabs.scrollLeft;
    wrap.classList.toggle('sp-tabs-has-left', left > 1);
    wrap.classList.toggle('sp-tabs-has-right', left < maxLeft - 1);
}

function centerActiveTab() {
    const tabs = document.getElementById('sp-tabs');
    const active = tabs?.querySelector('.sp-tab-active');
    if (!tabs || !active) return;

    const target = active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2;
    const maxLeft = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    const nextLeft = Math.min(maxLeft, Math.max(0, target));
    tabs.scrollTo({ left: nextLeft, behavior: 'smooth' });
    requestAnimationFrame(updateTabScrollState);
    setTimeout(updateTabScrollState, 220);
}

function bindTabScrollState() {
    const tabs = document.getElementById('sp-tabs');
    if (!tabs || tabs.dataset.scrollStateBound === '1') return;
    tabs.dataset.scrollStateBound = '1';

    tabs.addEventListener('scroll', updateTabScrollState, { passive: true });
    tabs.addEventListener('wheel', e => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        tabs.scrollLeft += e.deltaY;
        updateTabScrollState();
    }, { passive: false });
    requestAnimationFrame(updateTabScrollState);
}

function switchTab(name) {

    document.querySelectorAll('.sp-tab').forEach(t => {
        t.classList.toggle('sp-tab-active', t.dataset.tab === name);
    });
    document.querySelectorAll('.sp-tab-content').forEach(c => { c.style.display = 'none'; });
    const target = document.getElementById('sp-tab-' + name);
    if (target) target.style.display = '';

    if (name === 'home') refreshHome();
    if (name === 'edit') {
        _previewSegmentId = null;
        renderSegmentTimeline();
        const latest = getLatestSegment();
        renderEditorView(latest?.id || null);
        markSummaryEditorClean();
        updateEditFooterState();
    }
    if (name === 'prompt') {
        renderPromptPresetTabs();
        loadPromptEditor();
        setActivePromptSection('system');
    }
    if (name === 'preprocess') {
        loadPreprocessEditor();
    }
    centerActiveTab();
}


// ---------------------------------------------------------------------------
//  Segment timeline (edit tab)
// ---------------------------------------------------------------------------

function formatSegmentTime(ts) {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return { date: `${mm}/${dd}`, time: `${hh}:${mi}:${ss}` };
}

let _previewSegmentId = null;

function renderSegmentTimeline() {
    const container = document.getElementById('sp-segment-timeline');
    if (!container) return;
    container.innerHTML = '';

    const segments = getSegments();
    const total = segments.length;

    if (!total) {
        container.parentElement.style.display = 'none';
        return;
    }
    container.parentElement.style.display = '';

    const highlightId = _previewSegmentId || segments[segments.length - 1]?.id;

    segments.forEach((segment, idx) => {
        const isActive = segment.id === highlightId;
        const rangeStr = getSegmentLabel(segment);

        const el = document.createElement('div');
        el.className = 'sp-segment-item';
        if (isActive) el.className += ' sp-segment-active';
        el.dataset.id = segment.id;
        el.title = rangeStr;

        const progress = total > 1 ? idx / (total - 1) : 1;
        el.style.setProperty('--sp-segment-green', `${0.15 + progress * 0.85}`);

        el.innerHTML = `<span class="sp-segment-range">${rangeStr}</span>`;

        el.addEventListener('click', () => onSegmentPreview(segment.id));
        container.appendChild(el);
    });

    requestAnimationFrame(() => {
        const active = container.querySelector('.sp-segment-active');
        if (!active) return;
        const target = active.offsetLeft - (container.clientWidth - active.offsetWidth) / 2;
        const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
        const clamped = Math.min(maxLeft, Math.max(0, target));
        container.scrollTo({ left: clamped, behavior: 'smooth' });
    });
}

async function onSegmentPreview(id) {
    const segment = getSegmentById(id);
    if (!segment) return;

    if (id !== _previewSegmentId) {
        const allowed = await beforeSummaryEditorLeave();
        if (!allowed) return;
    }

    _previewSegmentId = id;
    renderEditorView(id);
    renderSegmentTimeline();
    markSummaryEditorClean();
    updateEditFooterState();
}

async function onDeleteLatestSegment() {
    const latest = getLatestSegment();
    if (!latest) return;

    const deleteMessage = isSummaryEditorDirty()
        ? `${t('confirm.deleteLatestSegment', { range: getSegmentLabel(latest) })}<br><br>${escapeHtml(t('confirm.deleteLatestSegmentUnsaved'))}`
        : t('confirm.deleteLatestSegment', { range: getSegmentLabel(latest) });

    const confirmed = await showConfirmDialog(
        '⚠️ ' + t('confirm.deleteSegmentHeader'),
        deleteMessage
    );
    if (!confirmed) return;

    const removed = deleteLatestSegment();
    if (!removed) return;

    const removedRange = normalizeRange(removed.range);
    if (removedRange.end >= removedRange.start) {
        await unhideMessagesByRange(removedRange.start, removedRange.end);
    }

    _previewSegmentId = null;
    const segment = getLatestSegment();
    renderEditorView(segment?.id || null);

    renderSegmentTimeline();
    updateEditFooterState();
    refreshHome();
    toast(t('toast.segmentDeleted'));
}

function updateEditFooterState() {
    const segments = getSegments();
    const hasSegments = segments.length > 0;
    const latestId = segments.at(-1)?.id || null;
    const canDeleteLatest = !!latestId && (!_previewSegmentId || _previewSegmentId === latestId);
    const isDirty = isSummaryEditorDirty();
    const removeBtn = document.getElementById('sp-segment-delete-btn');
    const revertBtn = document.getElementById('sp-edit-revert-btn');
    const saveBtn = document.getElementById('sp-edit-save-btn');

    if (removeBtn) {
        removeBtn.disabled = !canDeleteLatest;
        removeBtn.classList.toggle('sp-btn-danger', canDeleteLatest);
        removeBtn.classList.toggle('sp-btn-secondary', !canDeleteLatest);
    }
    if (revertBtn) revertBtn.disabled = !hasSegments || !isDirty;
    if (saveBtn) saveBtn.disabled = !hasSegments || !isDirty;
}

function getCurrentCharacterImageUrl() {
    try {
        const ctx = getST();
        const charId = ctx.characterId;
        if (charId === undefined || charId === null) return '';

        const char = Array.isArray(ctx.characters)
            ? ctx.characters[charId]
            : ctx.characters?.[charId];
        if (!char) return '';

        const raw = [
            char.avatar,
            char.avatar_url,
            char.data?.avatar,
            char.data?.avatar_url,
            char.data?.extensions?.avatar,
            char.data?.extensions?.avatar_url,
        ].find(v => typeof v === 'string' && v.trim());

        if (!raw) return '';
        const avatar = String(raw).trim();

        if (/^(https?:)?\/\//i.test(avatar) || avatar.startsWith('data:')) {
            return avatar;
        }

        if (avatar.startsWith('/characters/')) {
            return new URL(avatar, window.location.origin).href;
        }

        if (avatar.startsWith('characters/')) {
            return new URL(`/${avatar}`, window.location.origin).href;
        }

        const fileName = avatar.split('/').pop();
        if (!fileName) return '';
        return new URL(`/characters/${encodeURIComponent(fileName)}`, window.location.origin).href;
    } catch (_) {
        return '';
    }
}

// ---------------------------------------------------------------------------
//  Home tab
// ---------------------------------------------------------------------------

function refreshHome() {
    const ctx = getST();
    const chatName = ctx.chat?.name || ctx.name2 || '—';
    setText('sp-home-char-name', chatName);
    setText('sp-home-char-name-overlay', chatName);

    const charImage = document.getElementById('sp-home-char-image');
    const portraitPanel = document.querySelector('.sp-home-portrait-panel');
    if (charImage) {
        charImage.onerror = () => {
            charImage.removeAttribute('src');
            portraitPanel?.classList.add('sp-home-portrait-empty');
        };
        const imageUrl = getCurrentCharacterImageUrl();
        if (imageUrl) {
            charImage.src = imageUrl;
            portraitPanel?.classList.remove('sp-home-portrait-empty');
        } else {
            charImage.removeAttribute('src');
            portraitPanel?.classList.add('sp-home-portrait-empty');
        }
    }

    const chat = ctx.chat || [];
    
    const pending = chat.filter(m => !m.is_system).length;
    const total = chat.length;
    setText('sp-home-pending-count', `${pending}/${total}`);
    
    const summary = getChatSummary();
    const lenEl = document.getElementById('sp-home-summary-len');
    if (lenEl) {
        lenEl.innerHTML = `${summary.length}<span class="sp-len-unit">${t('home.summaryLengthUnit')}</span>`;
    }

    const rangeStart = document.getElementById('sp-range-start');
    const rangeEnd = document.getElementById('sp-range-end');
    const retainInput = document.getElementById('sp-range-retain');
    const { start, end, retainCount, lastVisible } = getHomeSummaryRange(chat);
    if (retainInput) {
        retainInput.value = String(retainCount);
    }
    if (rangeStart && rangeEnd && chat.length) {
        const minEnd = start !== -1 ? start : 0;
        const maxEnd = end !== -1 ? Math.max(minEnd, end) : minEnd;

        rangeStart.textContent = String(minEnd);
        rangeEnd.min = String(minEnd);
        rangeEnd.max = String(maxEnd);

        if (!rangeEnd.dataset.userEdited || !rangeEnd.value || Number(rangeEnd.value) < minEnd || Number(rangeEnd.value) > maxEnd) {
            rangeEnd.value = String(maxEnd);
        }
    }

    syncHomeStatusStackState();
}

// ---------------------------------------------------------------------------
//  Summary workflow
// ---------------------------------------------------------------------------

let _pendingHiddenRange = null;
let _generatedText = '';
let _contentAccumulator = '';
let _reasoningAccumulator = '';

function setPreviewStatus(statusEl, key, fallbackText = '') {
    if (!statusEl) return;
    if (key) {
        statusEl.textContent = t(key);
        statusEl.dataset.i18nStatusKey = key;
        return;
    }
    statusEl.textContent = fallbackText;
    delete statusEl.dataset.i18nStatusKey;
}

let _pendingSummaryRequest = null;
let _homeStatusStackExpanded = false;
let _homeStatusStackTimer = null;

function clearHomeStatusStackTimer() {
    if (_homeStatusStackTimer) {
        clearTimeout(_homeStatusStackTimer);
        _homeStatusStackTimer = null;
    }
}

function syncHomeStatusStackState() {
    const homeTab = document.getElementById('sp-tab-home');
    const win = document.getElementById('sp-window');
    if (!homeTab || !win) return;

    const fullscreen = win.classList.contains('sp-fullscreen');
    const shouldExpand = fullscreen && _homeStatusStackExpanded;
    homeTab.classList.toggle('sp-home-status-stack-expanded', shouldExpand);
    homeTab.classList.toggle('sp-home-status-stack-collapsed', fullscreen && !shouldExpand);

    if (!fullscreen) {
        clearHomeStatusStackTimer();
        _homeStatusStackExpanded = false;
    }
}

function setHomeStatusStackExpanded(expanded, { autoCollapse = false } = {}) {
    const win = document.getElementById('sp-window');
    const homeTab = document.getElementById('sp-tab-home');
    if (!win || !homeTab || !win.classList.contains('sp-fullscreen')) return;

    _homeStatusStackExpanded = !!expanded;
    syncHomeStatusStackState();
    clearHomeStatusStackTimer();

    if (autoCollapse && _homeStatusStackExpanded) {
        _homeStatusStackTimer = setTimeout(() => {
            _homeStatusStackTimer = null;
            _homeStatusStackExpanded = false;
            syncHomeStatusStackState();
        }, 5000);
    }
}

function getPreviewElements() {
    const overlay = document.getElementById('sp-preview-overlay');
    const textarea = document.getElementById('sp-preview-textarea');
    const actionBtn = document.getElementById('sp-preview-save-btn');
    const cancelBtn = document.getElementById('sp-preview-cancel-btn');
    const statusEl = document.getElementById('sp-preview-status');
    return { overlay, textarea, actionBtn, cancelBtn, statusEl };
}

function getRequestPreviewElements() {
    const overlay = document.getElementById('sp-request-preview-overlay');
    const textarea = document.getElementById('sp-request-preview-textarea');
    const startBtn = document.getElementById('sp-request-preview-start-btn');
    const cancelBtn = document.getElementById('sp-request-preview-cancel-btn');
    return { overlay, textarea, startBtn, cancelBtn };
}

function closePreviewOverlay() {
    const { overlay } = getPreviewElements();
    if (overlay) {
        overlay.style.display = 'none';
    }
    resetPreviewThinkingUI();
}

function closeRequestPreviewOverlay() {
    const { overlay } = getRequestPreviewElements();
    if (overlay) overlay.style.display = 'none';
}

function formatSummaryRequestPreview(prompts, preset, stream) {
    const body = buildStBackendRequestBody(preset, buildSummaryMessages(prompts), !!stream);

    return JSON.stringify(body, null, 2)
        .replace(/\\r\\n/g, '\r\n')
        .replace(/\\n/g, '\n');
}

function buildSummaryRequestContext() {
    const ctx = getST();
    const chat = ctx.chat || [];
    if (!chat.length) {
        toast(t('toast.noChat'));
        return null;
    }

    const s = getSettings();
    const preset = s.presets.find(p => p.id === s.activePresetId);
    if (!preset || !preset.url || !preset.model) {
        toast(t('toast.noApiPreset'));
        return null;
    }

    const { start: lo, end: maxHi } = getHomeSummaryRange(chat);
    const manualHiRaw = Number(val('sp-range-end'));
    const hi = Number.isFinite(manualHiRaw) ? Math.floor(manualHiRaw) : maxHi;
    const lower = lo === -1 ? 0 : lo;
    const upper = Math.max(lower, maxHi);
    const clampedHi = Math.min(Math.max(lower, hi), upper);
    if (lo === -1 || clampedHi < lo) {
        toast(t('toast.noMessagesInRange'));
        return null;
    }

    const msgs = [];
    for (let i = lo; i <= clampedHi; i++) {
        if (!chat[i] || chat[i].is_system) continue;
        msgs.push(chat[i]);
    }
    if (!msgs.length) {
        toast(t('toast.noMessagesInRange'));
        return null;
    }

    const hiddenRange = { start: lo, end: clampedHi };
    const chatText = buildChatText(msgs);
    const chatAfterText = buildChatAfterText(chat, clampedHi);
    const templates = getPromptTemplateForSummary() || { systemPrompt: '', userPrompt: '' };
    const systemPrompt = resolvePrompt(templates.systemPrompt || '', chatText, chatAfterText);
    let userPrompt = resolvePrompt(templates.userPrompt || '', chatText, chatAfterText);
    if (!(templates.userPrompt || '').match(/\{\{chatLog\}\}/i)) {
        userPrompt += '\n\n' + t('gen.chatLogAppend') + '\n' + chatText;
    }

    return {
        chat,
        preset,
        stream: !!s.useStream,
        prompts: { systemPrompt, userPrompt },
        hiddenRange,
        chatText,
        chatAfterText,
    };
}

function showRequestPreviewOverlay(request) {
    const { overlay, textarea, startBtn } = getRequestPreviewElements();
    if (!overlay || !textarea || !startBtn) return;

    _pendingSummaryRequest = request;
    overlay.style.display = 'flex';
    textarea.value = formatSummaryRequestPreview(request.prompts, request.preset, request.stream);
    textarea.readOnly = true;
    startBtn.disabled = false;
    _generatedText = '';
    _contentAccumulator = '';
    _reasoningAccumulator = '';
}

async function runSummaryRequest(request = null) {
    const req = request || _pendingSummaryRequest || buildSummaryRequestContext();
    if (!req) return;

    const { overlay, textarea, actionBtn, statusEl } = getPreviewElements();
    if (!overlay || !textarea || !actionBtn || !statusEl) return;

    _pendingHiddenRange = req.hiddenRange;
    closeRequestPreviewOverlay();
    overlay.style.display = 'flex';
    textarea.textContent = '';
    textarea.classList.add('sp-preview-text-empty');
    setPreviewTextReadonly(true);
    actionBtn.disabled = true;
    actionBtn.textContent = t('preview.saveAppend');
    setPreviewStatus(statusEl, 'preview.status.requesting');
    _generatedText = '';
    _contentAccumulator = '';
    _reasoningAccumulator = '';
    resetPreviewThinkingUI();

    const ac = new AbortController();
    activeSummaryAbort = ac;
    setPreviewCancelButtonBusy(true);

    try {
        if (req.stream) setPreviewStatus(statusEl, 'preview.status.streaming');

        const result = await generateSummaryText(
            getST,
            req.preset,
            req.prompts,
            req.stream,
            ac.signal,
            req.stream
                ? (delta) => {
                      _contentAccumulator = delta.fullContent || _contentAccumulator;
                      _reasoningAccumulator = delta.fullReasoning || _reasoningAccumulator;
                      appendPreviewStreamDelta(delta.content || '', delta.reasoning || '');
                      _generatedText = _contentAccumulator;
                  }
                : undefined,
        );

        updatePreviewFromRaw(result.content, result.reasoning);
        _generatedText = getPreviewTextValue();

        setPreviewStatus(statusEl, ac.signal.aborted ? 'preview.status.stopped' : 'preview.status.complete');
        if (!ac.signal.aborted || _generatedText.trim()) {
            actionBtn.disabled = false;
            setPreviewTextReadonly(false);
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            setPreviewStatus(statusEl, 'preview.status.stopped');
            if (_contentAccumulator || _reasoningAccumulator) {
                updatePreviewFromRaw(_contentAccumulator, _reasoningAccumulator);
            }
            _generatedText = getPreviewTextValue();
            if (_generatedText.trim()) {
                actionBtn.disabled = false;
                setPreviewTextReadonly(false);
            }
        } else {
            setPreviewStatus(statusEl, null, '❌ ' + e.message);
        }
    } finally {
        activeSummaryAbort = null;
        setPreviewCancelButtonBusy(false);
        _pendingSummaryRequest = null;
    }
}

async function startSummary() {
    const request = buildSummaryRequestContext();
    if (!request) return;
    await runSummaryRequest(request);
}

async function openSummaryRequestPreview() {
    const request = buildSummaryRequestContext();
    if (!request) return;
    showRequestPreviewOverlay(request);
}

async function saveSummaryResult() {
    const text = getPreviewSummaryTextToSave();
    if (!text) { toast(t('toast.contentEmpty')); return; }

    const range = _pendingHiddenRange || { start: 0, end: -1 };
    const hiddenRange = range.end >= range.start ? normalizeRange(range) : { start: 0, end: -1 };

    createSegment(text, hiddenRange);

    if (getSettings().autoHide && hiddenRange.end >= hiddenRange.start) {
        await hideMessagesByRange(hiddenRange.start, hiddenRange.end);
    }

    closePreviewOverlay();
    toast(t('toast.summarySaved'));
    refreshHome();
    renderSegmentTimeline();
}

// ===========================================================================
//  LIFECYCLE
// ===========================================================================

export function onActivate() {
    log('onActivate');

    // Use ST's event system (NOT jQuery)
    const { eventSource, event_types } = getST();

    eventSource.on(event_types.APP_READY, async () => {
        log('APP_READY — building UI');

        await ensureSettingsLoaded();
        await ensureCustomPromptsLoaded();
        await ensureSummaryIndexLoaded();
        await ensureCurrentChatLoaded();

        // Initialize i18n
        const s = getSettings();
        await initI18n(s.locale);
        syncLegacySummaryCleanup();
        await cleanupExpiredSummaries({ silent: true });

        migrateLegacyMeta();
        migratePreprocessSettings();
        registerMacros();

        migratePromptSettings();
        await reloadDefaultPrompt();

        await buildUI();
        applySummaryInjection();
        refreshHome();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        await ensureCurrentChatLoaded();
        syncLegacySummaryCleanup();
        applySummaryInjection();
        refreshHome();
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        refreshHome();
    });
}

