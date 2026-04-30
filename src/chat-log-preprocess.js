const DEFAULT_PREPROCESS_SETTINGS = Object.freeze({
    structuredCleanup: true,
    stripHtmlText: true,
    regexRules: [],
});

const STRUCTURED_CLEANUP_SELECTORS = [
    'script',
    'style',
    'noscript',
    'template',
    'iframe',
    'canvas',
    'svg',
    'video',
    'audio',
    'source',
    'track',
    'button',
    'input',
    'textarea',
    'select',
    'option',
    'form',
    '[hidden]',
    '[aria-hidden="true"]',
].join(',');

const REGEX_FLAG_ORDER = ['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'];

function createRuleId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `rule_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
}

function normalizeRegexFlags(flags, fallback = 'gi') {
    const raw = String(flags ?? '');
    return raw || fallback;
}

function normalizeRegexRule(rule) {
    const source = rule && typeof rule === 'object' ? rule : {};
    return {
        id: String(source.id || createRuleId()),
        enabled: source.enabled !== false,
        pattern: String(source.pattern || ''),
        replacement: String(source.replacement ?? ''),
        flags: normalizeRegexFlags(source.flags),
    };
}

export function normalizePreprocessSettings(source) {
    const input = source && typeof source === 'object' ? source : {};
    return {
        structuredCleanup: input.structuredCleanup !== false,
        stripHtmlText: input.stripHtmlText !== false,
        regexRules: Array.isArray(input.regexRules) ? input.regexRules.map(normalizeRegexRule) : [],
    };
}

export function getDefaultPreprocessSettings() {
    return normalizePreprocessSettings(DEFAULT_PREPROCESS_SETTINGS);
}

export function stripHtmlText(html) {
    const div = document.createElement('div');
    div.innerHTML = String(html || '');
    return div.textContent || '';
}

export function cleanupStructuredHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = String(html || '');
    div.querySelectorAll(STRUCTURED_CLEANUP_SELECTORS).forEach(el => el.remove());
    return div.innerHTML;
}

function tryCompileRule(rule) {
    if (!rule || !rule.pattern.trim()) return { ok: true, regex: null };
    try {
        return { ok: true, regex: new RegExp(rule.pattern, rule.flags || 'gi') };
    } catch (error) {
        return { ok: false, error };
    }
}

export function applyRegexRules(text, rules) {
    let next = String(text || '');
    for (const rawRule of Array.isArray(rules) ? rules : []) {
        if (!rawRule || rawRule.enabled === false) continue;
        const rule = normalizeRegexRule(rawRule);
        const compiled = tryCompileRule(rule);
        if (!compiled.ok || !compiled.regex) continue;
        next = next.replace(compiled.regex, rule.replacement);
    }
    return next;
}

export function preprocessChatMessageText(html, preprocessSettings) {
    const settings = normalizePreprocessSettings(preprocessSettings);
    let text = String(html || '');

    text = applyRegexRules(text, settings.regexRules);
    if (settings.structuredCleanup) {
        text = cleanupStructuredHtml(text);
    }
    if (settings.stripHtmlText) {
        text = stripHtmlText(text);
    }

    return String(text || '').trim();
}

export function buildChatText(messages, ctx = {}, preprocessSettings) {
    const list = Array.isArray(messages) ? messages : [];
    return list
        .map(m => {
            const who = m?.is_user ? (ctx.name1 || 'User') : (m?.name || ctx.name2 || 'Char');
            const body = preprocessChatMessageText(m?.mes || '', preprocessSettings);
            if (!body) return '';
            return `${who}: ${body}`;
        })
        .filter(Boolean)
        .join('\n\n');
}

export function buildChatAfterText(chat, endIndex, count = 1, ctx = {}, preprocessSettings) {
    const msgs = [];
    const list = Array.isArray(chat) ? chat : [];
    for (let i = Number(endIndex) + 1; i < list.length && msgs.length < count; i++) {
        if (!list[i] || list[i].is_system) continue;
        msgs.push(list[i]);
    }
    return buildChatText(msgs, ctx, preprocessSettings);
}

export function createChatLogPreprocessManager({ getSettings, saveSettings, setChecked, toast, t } = {}) {
    const translate = typeof t === 'function' ? t : (key) => key;

    const getPreprocessSettings = () => {
        const s = getSettings?.();
        if (!s) return getDefaultPreprocessSettings();
        s.chatLogPreprocess = normalizePreprocessSettings(s.chatLogPreprocess);
        return s.chatLogPreprocess;
    };

    const setStepToggle = (id, value) => {
        if (typeof setChecked === 'function') setChecked(id, !!value);
    };

    const validateRule = (rule) => {
        if (!rule?.pattern?.trim()) return { ok: true, error: '' };
        try {
            new RegExp(rule.pattern, rule.flags || 'gi');
            return { ok: true, error: '' };
        } catch (error) {
            return { ok: false, error: error?.message || translate('preprocess.invalidRule') };
        }
    };

    const updateRuleField = (ruleId, field, value) => {
        const settings = getPreprocessSettings();
        const rule = settings.regexRules.find(item => item.id === ruleId);
        if (!rule) return;
        if (field === 'enabled') {
            rule.enabled = !!value;
        } else if (field === 'pattern' || field === 'replacement' || field === 'flags') {
            rule[field] = String(value ?? '');
        }
        saveSettings?.();
    };

    const renderPreprocessRules = () => {
        const host = document.getElementById('sp-preprocess-rules-list');
        if (!host) return;

        const settings = getPreprocessSettings();
        host.innerHTML = '';

        if (!settings.regexRules.length) {
            const empty = document.createElement('div');
            empty.className = 'sp-preprocess-empty';
            empty.dataset.i18n = 'preprocess.emptyRules';
            empty.textContent = translate('preprocess.emptyRules');
            host.appendChild(empty);
            return;
        }

        for (const rule of settings.regexRules) {
            const row = document.createElement('div');
            row.className = 'sp-preprocess-rule';
            row.dataset.ruleId = rule.id;

            const enabledWrap = document.createElement('label');
            enabledWrap.className = 'sp-switch sp-preprocess-rule-switch';
            enabledWrap.title = translate('preprocess.ruleEnabled');

            const enabled = document.createElement('input');
            enabled.type = 'checkbox';
            enabled.checked = !!rule.enabled;
            enabledWrap.appendChild(enabled);

            const slider = document.createElement('span');
            slider.className = 'sp-slider';
            enabledWrap.appendChild(slider);

            const pattern = document.createElement('input');
            pattern.type = 'text';
            pattern.className = 'sp-preprocess-rule-input';
            pattern.placeholder = translate('preprocess.rulePattern');
            pattern.value = rule.pattern || '';
            pattern.title = translate('preprocess.rulePattern');

            const replacement = document.createElement('input');
            replacement.type = 'text';
            replacement.className = 'sp-preprocess-rule-input';
            replacement.placeholder = translate('preprocess.ruleReplacement');
            replacement.value = rule.replacement || '';
            replacement.title = translate('preprocess.ruleReplacement');

            const flags = document.createElement('input');
            flags.type = 'text';
            flags.className = 'sp-preprocess-rule-input sp-preprocess-rule-flags';
            flags.placeholder = translate('preprocess.ruleFlags');
            flags.value = rule.flags || 'gi';
            flags.title = translate('preprocess.ruleFlags');

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'sp-btn sp-btn-secondary sp-preprocess-rule-remove';
            remove.textContent = '×';
            remove.title = translate('preprocess.removeRule');

            const error = document.createElement('div');
            error.className = 'sp-preprocess-rule-error';

            const syncValidation = () => {
                const currentRule = {
                    ...rule,
                    pattern: pattern.value,
                    replacement: replacement.value,
                    flags: flags.value,
                };
                const result = validateRule(currentRule);
                row.classList.toggle('sp-preprocess-rule-invalid', !result.ok);
                error.textContent = result.ok ? '' : result.error;
            };

            enabled.addEventListener('change', e => {
                updateRuleField(rule.id, 'enabled', e.target.checked);
                row.classList.toggle('sp-preprocess-rule-disabled', !e.target.checked);
            });
            pattern.addEventListener('input', e => {
                updateRuleField(rule.id, 'pattern', e.target.value);
                syncValidation();
            });
            replacement.addEventListener('input', e => {
                updateRuleField(rule.id, 'replacement', e.target.value);
            });
            flags.addEventListener('input', e => {
                updateRuleField(rule.id, 'flags', e.target.value);
                syncValidation();
            });
            remove.addEventListener('click', () => deleteRegexRule(rule.id));

            const topLine = document.createElement('div');
            topLine.className = 'sp-preprocess-rule-line sp-preprocess-rule-line-main';
            topLine.appendChild(enabledWrap);
            topLine.appendChild(pattern);

            const secondLine = document.createElement('div');
            secondLine.className = 'sp-preprocess-rule-line sp-preprocess-rule-line-extra';
            secondLine.appendChild(replacement);
            secondLine.appendChild(flags);
            secondLine.appendChild(remove);

            row.appendChild(topLine);
            row.appendChild(secondLine);
            row.appendChild(error);
            host.appendChild(row);

            if (!rule.enabled) row.classList.add('sp-preprocess-rule-disabled');
            syncValidation();
        }
    };

    const migratePreprocessSettings = () => {
        getPreprocessSettings();
    };

    const loadPreprocessEditor = () => {
        const settings = getPreprocessSettings();
        setStepToggle('sp-preprocess-structured-toggle', settings.structuredCleanup);
        setStepToggle('sp-preprocess-strip-toggle', settings.stripHtmlText);
        renderPreprocessRules();
    };

    const updateStepSetting = (key, value) => {
        const settings = getPreprocessSettings();
        settings[key] = !!value;
        saveSettings?.();
    };

    const addRegexRule = () => {
        const settings = getPreprocessSettings();
        settings.regexRules.push(normalizeRegexRule({ enabled: true, pattern: '', replacement: '', flags: 'gi' }));
        saveSettings?.();
        renderPreprocessRules();
        requestAnimationFrame(() => {
            const last = document.querySelector('#sp-preprocess-rules-list .sp-preprocess-rule:last-child .sp-preprocess-rule-input');
            if (last) last.focus();
        });
    };

    const deleteRegexRule = (ruleId) => {
        const settings = getPreprocessSettings();
        settings.regexRules = settings.regexRules.filter(rule => rule.id !== ruleId);
        saveSettings?.();
        renderPreprocessRules();
    };

    return {
        migratePreprocessSettings,
        loadPreprocessEditor,
        renderPreprocessRules,
        getPreprocessSettings,
        updateStepSetting,
        addRegexRule,
        deleteRegexRule,
    };
}
