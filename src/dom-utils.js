export function on(id, evt, fn) {
    document.getElementById(id)?.addEventListener(evt, fn);
}

export function val(id) {
    return document.getElementById(id)?.value ?? '';
}

export function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v ?? '';
}

export function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v ?? '';
}

export function setChecked(id, v) {
    const el = document.getElementById(id);
    if (el) el.checked = !!v;
}

export function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function show(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
}

export function hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

export function setRange(sliderId, labelId, v) {
    setVal(sliderId, v);
    setText(labelId, v);
}
