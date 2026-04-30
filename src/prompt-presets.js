export function createPromptPresetManager({ getSettings, saveSettings, getCustomPrompts, setCustomPrompts, saveCustomPrompts, getDefaultPrompt, setVal, val, setChecked, toast, t, showConfirmDialog, beforePromptPresetChange }) {
    let promptRenameId = null;
    const LONG_PRESS_MS = 550;
    const LONG_PRESS_MOVE_PX = 12;

    function normalizePromptParts(data) {
        const source = data && typeof data === 'object' ? data : {};
        return {
            systemPrompt: String(source.systemPrompt || ''),
            userPrompt: String(source.userPrompt || ''),
        };
    }

    function getDefaultPromptParts() {
        return normalizePromptParts(getDefaultPrompt?.());
    }

    function getPromptPresets() {
        return getCustomPrompts() || [];
    }

    function getActivePromptPreset() {
        const s = getSettings();
        if (s.activePromptPresetId === 'default') {
            return {
                id: 'default',
                name: t('prompt.defaultName'),
                ...getDefaultPromptParts(),
                readonly: true,
            };
        }
        const preset = getPromptPresets().find(p => p.id === s.activePromptPresetId);
        if (preset) return { ...normalizePromptParts(preset), id: preset.id, name: preset.name, readonly: false };
        s.activePromptPresetId = 'default';
        saveSettings();
        return {
            id: 'default',
            name: t('prompt.defaultName'),
            ...getDefaultPromptParts(),
            readonly: true,
        };
    }

    function getPromptTemplateForSummary() {
        const s = getSettings();
        if (s.activePromptPresetId === 'default') {
            return getDefaultPromptParts();
        }
        const preset = getPromptPresets().find(p => p.id === s.activePromptPresetId);
        return normalizePromptParts(preset || getDefaultPromptParts());
    }

    function getNextPromptPresetName() {
        const prefix = t('prompt.defaultPresetName');
        const nums = getPromptPresets()
            .map(p => new RegExp('^' + escapeRegex(prefix) + '(\d+)$').exec((p.name || '').trim()))
            .filter(Boolean)
            .map(m => Number(m[1]))
            .filter(n => Number.isFinite(n));
        let next = 1;
        while (nums.includes(next)) next++;
        return prefix + next;
    }

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function isPromptDirty() {
        const active = getActivePromptPreset();
        if (active.readonly) return false;
        const systemValue = val('sp-prompt-system-textarea');
        const userValue = val('sp-prompt-user-textarea');
        return systemValue !== active.systemPrompt || userValue !== active.userPrompt;
    }

    function updatePromptActionButtons() {
        const active = getActivePromptPreset();
        const revertBtn = document.getElementById('sp-prompt-revert-btn');
        const saveBtn = document.getElementById('sp-prompt-save-btn');
        const systemTa = document.getElementById('sp-prompt-system-textarea');
        const userTa = document.getElementById('sp-prompt-user-textarea');
        const dirty = isPromptDirty();

        if (systemTa) systemTa.readOnly = !!active.readonly;
        if (userTa) userTa.readOnly = !!active.readonly;
        if (revertBtn) revertBtn.disabled = active.readonly || !dirty;
        if (saveBtn) saveBtn.disabled = active.readonly || !dirty;
    }

    function scrollPromptTabs(dir) {
        const el = document.getElementById('sp-prompt-tabs-scroll');
        if (!el) return;
        el.scrollBy({ left: dir * 180, behavior: 'smooth' });
    }

    async function activatePromptPreset(id) {
        const s = getSettings();
        if (s.activePromptPresetId === id) return;
        const allowed = await beforePromptPresetChange?.({ type: 'switch', nextId: id });
        if (allowed === false) return;
        s.activePromptPresetId = id;
        saveSettings();
        renderPromptPresetTabs();
        loadPromptEditor();
    }

    async function addPromptPreset() {
        const allowed = await beforePromptPresetChange?.({ type: 'create' });
        if (allowed === false) return;
        const s = getSettings();
        const defaults = getDefaultPromptParts();
        const preset = {
            id: 'custom_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            name: getNextPromptPresetName(),
            systemPrompt: defaults.systemPrompt,
            userPrompt: defaults.userPrompt,
        };
        const presets = getPromptPresets();
        presets.push(preset);
        setCustomPrompts(presets);
        s.activePromptPresetId = preset.id;
        saveCustomPrompts();
        saveSettings();
        renderPromptPresetTabs();
        loadPromptEditor();
    }

    function revertPromptChanges() {
        const active = getActivePromptPreset();
        if (active.readonly) return;
        setVal('sp-prompt-system-textarea', active.systemPrompt || '');
        setVal('sp-prompt-user-textarea', active.userPrompt || '');
        updatePromptActionButtons();
    }

    function savePromptPreset() {
        const active = getActivePromptPreset();
        if (active.readonly) return;
        const preset = getPromptPresets().find(p => p.id === active.id);
        if (!preset) return;
        preset.systemPrompt = val('sp-prompt-system-textarea');
        preset.userPrompt = val('sp-prompt-user-textarea');
        saveCustomPrompts();
        updatePromptActionButtons();
        toast(t('toast.promptSaved'));
    }

    async function deletePromptPreset(id) {
        if (id === 'default') return;
        const s = getSettings();
        const preset = getPromptPresets().find(p => p.id === id);
        if (!preset) return;

        const confirmed = await showConfirmDialog(
            '⚠️ ' + t('confirm.deletePromptHeader'),
            t('confirm.deletePromptPreset', { name: preset.name || t('prompt.unnamed') })
        );
        if (!confirmed) return;

        setCustomPrompts(getPromptPresets().filter(p => p.id !== id));
        if (s.activePromptPresetId === id) {
            s.activePromptPresetId = 'default';
        }
        if (promptRenameId === id) {
            promptRenameId = null;
        }
        saveCustomPrompts();
        saveSettings();
        renderPromptPresetTabs();
        loadPromptEditor();
    }

    function startPromptPresetRename(id) {
        if (id === 'default') return;
        promptRenameId = id;
        renderPromptPresetTabs();
    }

    function finishPromptPresetRename(id, nextName, { cancel = false } = {}) {
        const preset = getPromptPresets().find(p => p.id === id);
        if (!preset) {
            promptRenameId = null;
            renderPromptPresetTabs();
            return;
        }

        if (!cancel) {
            const trimmed = (nextName || '').trim();
            if (trimmed) {
                preset.name = trimmed;
                saveCustomPrompts();
            }
        }

        promptRenameId = null;
        renderPromptPresetTabs();
    }

    function buildPromptRenameInput(id, preset) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'sp-prompt-tab-rename-input';
        input.value = preset.name || '';
        input.maxLength = 30;

        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });

        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('dblclick', e => e.stopPropagation());
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishPromptPresetRename(id, input.value);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishPromptPresetRename(id, input.value, { cancel: true });
            }
        });
        input.addEventListener('blur', () => finishPromptPresetRename(id, input.value));

        return input;
    }

    function renderPromptPresetTabs() {
        const host = document.getElementById('sp-prompt-tabs');
        if (!host) return;

        const s = getSettings();
        const presets = [{ id: 'default', name: t('prompt.defaultName'), readonly: true }, ...getPromptPresets().map(p => ({ ...p, readonly: false }))];
        host.innerHTML = '';

        for (const preset of presets) {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'sp-prompt-tab' + (preset.id === s.activePromptPresetId ? ' sp-prompt-tab-active' : '');
            tab.dataset.id = preset.id;
            tab.title = preset.readonly ? t('prompt.defaultTitle') : (preset.name || '');

            if (promptRenameId === preset.id && !preset.readonly) {
                tab.classList.add('sp-prompt-tab-renaming');
                tab.appendChild(buildPromptRenameInput(preset.id, preset));
            } else {
                const label = document.createElement('span');
                label.className = 'sp-prompt-tab-label';
                label.textContent = preset.name;
                tab.appendChild(label);
            }

            if (!preset.readonly) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'sp-prompt-tab-delete';
                del.textContent = '×';
                del.title = t('prompt.deleteTitle', { name: preset.name || t('prompt.unnamed') });
                del.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    deletePromptPreset(preset.id);
                });
                tab.appendChild(del);
            }

            tab.addEventListener('click', () => {
                if (promptRenameId === preset.id) return;
                if (tab.dataset.longPressTriggered === '1') {
                    tab.dataset.longPressTriggered = '0';
                    return;
                }
                void activatePromptPreset(preset.id);
            });
            if (!preset.readonly) {
                tab.addEventListener('dblclick', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    startPromptPresetRename(preset.id);
                });

                let longPressTimer = null;
                let touchStartX = 0;
                let touchStartY = 0;

                const clearLongPressTimer = () => {
                    if (longPressTimer) {
                        clearTimeout(longPressTimer);
                        longPressTimer = null;
                    }
                };

                tab.addEventListener('touchstart', e => {
                    if (promptRenameId === preset.id) return;
                    const touch = e.touches?.[0];
                    if (!touch) return;
                    touchStartX = touch.clientX;
                    touchStartY = touch.clientY;
                    tab.dataset.longPressTriggered = '0';
                    clearLongPressTimer();
                    longPressTimer = setTimeout(() => {
                        tab.dataset.longPressTriggered = '1';
                        startPromptPresetRename(preset.id);
                    }, LONG_PRESS_MS);
                }, { passive: true });

                tab.addEventListener('touchmove', e => {
                    if (!longPressTimer) return;
                    const touch = e.touches?.[0];
                    if (!touch) return;
                    const moved = Math.abs(touch.clientX - touchStartX) > LONG_PRESS_MOVE_PX
                        || Math.abs(touch.clientY - touchStartY) > LONG_PRESS_MOVE_PX;
                    if (moved) clearLongPressTimer();
                }, { passive: true });

                tab.addEventListener('touchend', clearLongPressTimer, { passive: true });
                tab.addEventListener('touchcancel', clearLongPressTimer, { passive: true });
            }

            host.appendChild(tab);
        }
    }

    function loadPromptEditor() {
        const active = getActivePromptPreset();
        setVal('sp-prompt-system-textarea', active.systemPrompt || '');
        setVal('sp-prompt-user-textarea', active.userPrompt || '');
        updatePromptActionButtons();
    }

    function migratePromptSettings() {
        const s = getSettings();

        if (Array.isArray(s.presets)) {
            for (const preset of s.presets) {
                if (!Array.isArray(preset.availableModels)) {
                    preset.availableModels = [];
                }
                if (!Number.isFinite(Number(preset.modelsFetchedAt))) {
                    preset.modelsFetchedAt = 0;
                }
            }
        }

        if (!s.activePromptPresetId) s.activePromptPresetId = 'default';
    }

    return {
        migratePromptSettings,
        getPromptTemplateForSummary,
        updatePromptActionButtons,
        scrollPromptTabs,
        addPromptPreset,
        revertPromptChanges,
        savePromptPreset,
        renderPromptPresetTabs,
        loadPromptEditor,
    };
}
