import { generateSummaryText, getApiTestPrompt } from './llm-utils.js';

export function createApiPresetManager({
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
}) {
    let presetView = null;
    let presetDraft = null;
    const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    const MODEL_CACHE_PREFIX = 'SimpleSummary:modelCache:';

    const API_DEFAULTS = {
        openai: {
            url: '',
        },
        anthropic: {
            url: 'https://api.anthropic.com',
        },
        google: {
            url: 'https://generativelanguage.googleapis.com',
        },
        openrouter: {
            url: 'https://openrouter.ai/api',
        },
        deepseek: {
            url: 'https://api.deepseek.com',
        },
        siliconflow_cn: {
            url: 'https://api.siliconflow.cn/v1',
        },
        siliconflow_global: {
            url: 'https://api.siliconflow.com/v1',
        },
        mistral: {
            url: 'https://api.mistral.ai',
        },
        nvidia: {
            url: 'https://integrate.api.nvidia.com/v1',
        },
    };

    function getApiDefaults() {
        return API_DEFAULTS;
    }

    function clonePreset(preset) {
        return preset ? structuredClone(preset) : null;
    }

    function normalizePresetForCompare(preset) {
        if (!preset) return null;
        return {
            id: preset.id || '',
            name: preset.name || '',
            type: preset.type || 'openai',
            url: preset.url || '',
            key: preset.key || '',
            model: preset.model || '',
            manualModel: preset.manualModel || '',
            useManualModel: !!preset.useManualModel,
            temperature: Number(preset.temperature ?? 0.7),
            top_p: Number(preset.top_p ?? 1.0),
            top_k: Number(preset.top_k ?? 50),
            freq_penalty: Number(preset.freq_penalty ?? 0),
            pres_penalty: Number(preset.pres_penalty ?? 0),
            max_completion_tokens: Number(preset.max_completion_tokens ?? 4000),
            en_maxtokens: !!preset.en_maxtokens,
            en_topk: !!preset.en_topk,
            en_freqp: !!preset.en_freqp,
            en_presp: !!preset.en_presp,
        };
    }

    function isApiPresetDirty() {
        if (!presetView || !presetDraft) return false;
        return JSON.stringify(normalizePresetForCompare(presetDraft)) !== JSON.stringify(normalizePresetForCompare(presetView));
    }

    function updateApiActionButtons() {
        const saveBtn = document.getElementById('sp-api-save-btn');
        const wrap = document.getElementById('sp-api-save-floating');
        const dirty = isApiPresetDirty();
        if (saveBtn) saveBtn.disabled = !dirty;
        if (wrap) wrap.style.display = dirty ? 'flex' : 'none';
    }

    function addPreset() {
        const id = 'p_' + Date.now();
        const p = {
            id,
            name: t('api.newPresetName'),
            type: 'openai',
            url: '',
            key: '',
            model: '',
            manualModel: '',
            useManualModel: false,
            temperature: 0.7,
            top_p: 1.0,
            top_k: 50,
            freq_penalty: 0,
            pres_penalty: 0,
            max_completion_tokens: 4000,
            en_maxtokens: false,
            en_topk: false,
            en_freqp: false,
            en_presp: false,
            availableModels: [],
        };
        const s = getSettings();
        s.presets.push(p);
        s.activePresetId = id;
        saveSettings();
        renderApiPresets();
    }

    async function deletePreset() {
        if (!presetView) return;
        const confirmed = await showConfirmDialog(
            '⚠️ ' + t('confirm.deletePresetHeader'),
            t('confirm.deletePreset', { name: presetView.name })
        );
        if (!confirmed) return;
        const s = getSettings();
        s.presets = s.presets.filter(p => p.id !== presetView.id);
        s.activePresetId = s.presets[0]?.id || null;
        presetView = null;
        presetDraft = null;
        saveSettings();
        renderApiPresets();
    }

    function syncPresetForm() {
        if (!presetDraft) return null;
        presetDraft.name = val('sp-api-name');
        presetDraft.type = val('sp-api-type');
        presetDraft.url = val('sp-api-url');
        presetDraft.key = val('sp-api-key');
        
        const useManual = document.getElementById('sp-api-manual-model-toggle')?.checked ?? false;
        presetDraft.useManualModel = useManual;
        presetDraft.model = useManual ? val('sp-api-model-manual') : val('sp-api-model-select');
        presetDraft.manualModel = val('sp-api-model-manual');
        
        presetDraft.temperature = +val('sp-api-p-temp') || 0;
        presetDraft.top_p = +val('sp-api-p-topp') || 0;
        presetDraft.top_k = +val('sp-api-p-topk') || 50;
        presetDraft.freq_penalty = +val('sp-api-p-freqp') || 0;
        presetDraft.pres_penalty = +val('sp-api-p-presp') || 0;
        presetDraft.en_maxtokens = document.getElementById('sp-api-en-maxtokens')?.checked ?? false;
        presetDraft.max_completion_tokens = (+val('sp-api-p-maxtokens') || 4) * 1000;
        presetDraft.en_topk = document.getElementById('sp-api-en-topk')?.checked ?? false;
        presetDraft.en_freqp = document.getElementById('sp-api-en-freqp')?.checked ?? false;
        presetDraft.en_presp = document.getElementById('sp-api-en-presp')?.checked ?? false;
        renderApiPresetList();
        updateApiActionButtons();
        return presetDraft;
    }

    function discardActivePresetChanges() {
        if (!presetView) return;
        presetDraft = clonePreset(presetView);
        fillPresetForm(presetDraft);
        renderApiPresetList();
        updateApiActionButtons();
    }

    function saveActivePreset() {
        if (!presetView || !presetDraft) return false;
        syncPresetForm();
        Object.assign(presetView, clonePreset(presetDraft));
        saveSettings();
        renderApiPresets();
        return true;
    }

    function selectPreset(id) {
        const s = getSettings();
        const next = s.presets.find(p => p.id === id);
        if (!next) return false;
        s.activePresetId = id;
        saveSettings();
        renderApiPresets();
        return true;
    }

    function getModelCacheKey(type, baseUrl) {
        return MODEL_CACHE_PREFIX + `${type || 'openai'}|${baseUrl || ''}`;
    }

    function readModelCache(type, baseUrl) {
        try {
            const raw = window.localStorage?.getItem(getModelCacheKey(type, baseUrl));
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            const fetchedAt = Number(parsed?.fetchedAt || 0);
            if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > MODEL_CACHE_TTL_MS) {
                return [];
            }
            return Array.isArray(parsed?.models) ? parsed.models.filter(Boolean) : [];
        } catch (_) {
            return [];
        }
    }

    function writeModelCache(type, baseUrl, models) {
        try {
            window.localStorage?.setItem(getModelCacheKey(type, baseUrl), JSON.stringify({
                fetchedAt: Date.now(),
                models: Array.isArray(models) ? models.filter(Boolean) : [],
            }));
        } catch (error) {
            log('Model cache save failed:', error?.message || error);
        }
    }

    function hydratePresetModelsFromCache(preset) {
        if (!preset) return [];
        const ids = Array.isArray(preset.availableModels) ? preset.availableModels : [];
        if (ids.length > 0) return ids;
        const baseUrl = normalizeBaseUrl(preset.url || '', preset.type);
        const cached = readModelCache(preset.type, baseUrl);
        if (cached.length > 0) {
            preset.availableModels = cached;
        }
        return cached;
    }

    function renderApiPresetList() {
        const s = getSettings();
        const list = document.getElementById('sp-api-preset-list');
        if (!list) return;
        list.innerHTML = '';

        for (const p of s.presets) {
            const div = document.createElement('div');
            div.className = 'sp-api-list-item' + (p.id === s.activePresetId ? ' sp-api-list-item-active' : '');
            div.dataset.id = p.id;
            const label = p.id === presetView?.id && presetDraft
                ? (presetDraft.name || '(unnamed)')
                : (p.name || '(unnamed)');
            div.textContent = label;
            list.appendChild(div);
        }
    }

    function renderApiPresets() {
        const s = getSettings();
        const list = document.getElementById('sp-api-preset-list');
        if (!list) return;
        list.innerHTML = '';

        if (s.presets.length === 0) {
            show('sp-api-empty');
            hide('sp-api-form');
            presetView = null;
            presetDraft = null;
            updateApiActionButtons();
            return;
        }

        presetView = s.presets.find(p => p.id === s.activePresetId) || s.presets[0];
        if (presetView && s.activePresetId !== presetView.id) {
            s.activePresetId = presetView.id;
            saveSettings();
        } else if (presetView) {
            s.activePresetId = presetView.id;
        }
        presetDraft = clonePreset(presetView);
        renderApiPresetList();

        hide('sp-api-empty');
        show('sp-api-form');
        fillPresetForm(presetDraft);
        updateApiActionButtons();
    }

    function fillPresetForm(p) {
        if (!p) return;
        setVal('sp-api-name', p.name);
        setVal('sp-api-type', p.type);
        setVal('sp-api-url', p.url || API_DEFAULTS[p.type]?.url || '');
        setVal('sp-api-key', p.key);
        
        const manualToggle = document.getElementById('sp-api-manual-model-toggle');
        const manualInput = document.getElementById('sp-api-model-manual');
        const manualRow = document.getElementById('sp-api-model-manual-row');
        const modelSelect = document.getElementById('sp-api-model-select');
        const fetchBtn = document.getElementById('sp-api-fetch-models');
        
        const useManual = p.useManualModel ?? false;
        setChecked('sp-api-manual-model-toggle', useManual);
        setVal('sp-api-model-manual', p.manualModel || '');
        
        if (manualToggle) manualToggle.disabled = false;
        if (manualInput) manualInput.disabled = !useManual;
        if (manualRow) manualRow.style.display = useManual ? '' : 'none';
        if (modelSelect) modelSelect.disabled = useManual;
        if (fetchBtn) fetchBtn.disabled = useManual;
        
        renderPresetModelsSelect(p);
        
        setRange('sp-api-p-temp', 'sp-api-val-temp', p.temperature ?? 0.7);
        setRange('sp-api-p-topp', 'sp-api-val-topp', p.top_p ?? 1.0);
        setRange('sp-api-p-topk', 'sp-api-val-topk', p.top_k ?? 50);
        setRange('sp-api-p-freqp', 'sp-api-val-freqp', p.freq_penalty ?? 0);
        setRange('sp-api-p-presp', 'sp-api-val-presp', p.pres_penalty ?? 0);
        const maxtokensVal = Math.round((p.max_completion_tokens ?? 4000) / 1000);
        setChecked('sp-api-en-maxtokens', p.en_maxtokens ?? false);
        document.getElementById('sp-api-p-maxtokens').value = maxtokensVal;
        document.getElementById('sp-api-val-maxtokens').textContent = maxtokensVal + 'K';

        setChecked('sp-api-en-topk', p.en_topk ?? false);
        setChecked('sp-api-en-freqp', p.en_freqp ?? false);
        setChecked('sp-api-en-presp', p.en_presp ?? false);
        const topkSlider = document.getElementById('sp-api-p-topk');
        const freqpSlider = document.getElementById('sp-api-p-freqp');
        const prespSlider = document.getElementById('sp-api-p-presp');
        if (topkSlider) topkSlider.disabled = !(p.en_topk ?? false);
        if (freqpSlider) freqpSlider.disabled = !(p.en_freqp ?? false);
        if (prespSlider) prespSlider.disabled = !(p.en_presp ?? false);

        setText('sp-test-status', '');
        const keyEl = document.getElementById('sp-api-key');
        if (keyEl) keyEl.type = 'password';
        const toggleEl = document.getElementById('sp-api-key-toggle');
        if (toggleEl) toggleEl.textContent = '👁';
    }

    function getBuiltinModelSelectId(type) {
        if (type === 'anthropic') return 'model_claude_select';
        if (type === 'google') return 'model_google_select';
        return '';
    }

    function getBuiltinModelsFromSt(type) {
        const selectId = getBuiltinModelSelectId(type);
        if (!selectId) return [];

        const select = document.getElementById(selectId);
        if (!select) return [];

        const ids = [];
        for (const opt of Array.from(select.querySelectorAll('option'))) {
            const value = String(opt.value || '').trim();
            if (value) ids.push(value);
        }

        return [...new Set(ids)];
    }

    function renderPresetModelsSelect(preset) {
        const select = document.getElementById('sp-api-model-select');
        if (!select) return;
        const ids = hydratePresetModelsFromCache(preset);
        const currentModel = preset?.model || '';
        
        select.innerHTML = '<option value="" data-i18n="api.selectModel">' + t('api.selectModel') + '</option>';
        
        for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            if (id === currentModel) opt.selected = true;
            select.appendChild(opt);
        }
        
        if (currentModel && !ids.includes(currentModel)) {
            const opt = document.createElement('option');
            opt.value = currentModel;
            opt.textContent = currentModel;
            opt.selected = true;
            select.appendChild(opt);
        }
    }

    async function testPreset() {
        const targetPreset = syncPresetForm();
        if (!targetPreset?.url) {
            setText('sp-test-status', t('api.status.missingUrl'));
            return;
        }
        if (!targetPreset?.model) {
            setText('sp-test-status', t('api.status.missingModel'));
            return;
        }

        const baseUrl = normalizeBaseUrl(targetPreset.url, targetPreset.type);
        log('── API Test (summary flow) ──');
        log('Base URL:', baseUrl, '| Model:', targetPreset.model);

        setText('sp-test-status', '⏳ → ' + baseUrl);

        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), 30000);

        try {
            const prompt = getApiTestPrompt();
            const result = await generateSummaryText(
                getST,
                targetPreset,
                prompt,
                false,
                controller.signal,
            );

            clearTimeout(timerId);

            const reply = String(result?.content || '').trim();
            if (!reply) {
                throw new Error('Empty reply from summary flow');
            }
            log('Test reply:', reply);
            setText('sp-test-status', t('api.status.success', { reply: reply.slice(0, 50) }));
        } catch (e) {
            clearTimeout(timerId);
            if (e.name === 'AbortError') {
                log('Test aborted (30s timeout)');
                setText('sp-test-status', t('api.status.timeout'));
            } else {
                logE('Test failed:', e);
                setText('sp-test-status', '❌ ' + (e.message || String(e)));
            }
        }
    }

    async function fetchModels() {
        const targetPreset = syncPresetForm();
        if (!targetPreset) return;

        try {
            let ids = [];
            let usedBuiltinList = false;

            if (targetPreset.type === 'anthropic') {
                ids = getBuiltinModelsFromSt('anthropic');
                usedBuiltinList = true;
            } else if (targetPreset.type === 'google') {
                ids = getBuiltinModelsFromSt('google');
                usedBuiltinList = true;
            } else {
                if (!targetPreset?.url || !targetPreset?.key) {
                    toast(t('api.status.fetchUrlKey'));
                    return;
                }

                const baseUrl = normalizeBaseUrl(targetPreset.url, targetPreset.type);
                log('Fetching models, baseUrl:', baseUrl, 'type:', targetPreset.type);
                toast(t('api.status.fetching'));

                if (ids.length === 0) {
                    ids = await fetchModelsViaStBackend(baseUrl, targetPreset.key);
                }
            }

            if (usedBuiltinList) {
                log('Using built-in ST models, type:', targetPreset.type, 'count:', ids.length);
            }

            targetPreset.availableModels = ids;
            if (presetDraft) presetDraft.availableModels = ids;
            if (targetPreset.type !== 'anthropic' && targetPreset.type !== 'google') {
                writeModelCache(targetPreset.type, normalizeBaseUrl(targetPreset.url, targetPreset.type), ids);
            }
            renderPresetModelsSelect(targetPreset);
            updateApiActionButtons();
            log('Models fetched:', ids.length);
            toast(t('api.status.fetchOk', { count: ids.length }));
        } catch (e) {
            logE('Model fetch failed:', e);
            toast(t('api.status.fetchFail', { error: e.message }));
        }
    }

    async function fetchModelsViaStBackend(baseUrl, apiKey) {
        const headers = getST().getRequestHeaders?.() || { 'Content-Type': 'application/json' };
        const resp = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                chat_completion_source: 'openai',
                reverse_proxy: baseUrl,
                proxy_password: apiKey,
            }),
        });

        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const d = await resp.json();
        const modelsData = d?.data || [];
        return (Array.isArray(modelsData) ? modelsData : []).map(m => m.id || m.model).filter(Boolean).sort();
    }

    function getActivePreset() {
        return presetView;
    }

    return {
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
        getActivePreset,
        getApiDefaults,
    };
}
