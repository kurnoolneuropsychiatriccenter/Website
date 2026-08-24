// Prefix-match medicine autocomplete (no scrollbar).
// Usage:
//   const ac = MedicineAutocomplete.attach(inputEl, allMedicines, {
//     onSelect: (medObj) => { ... },
//     showStock: true // append [Stock:N] label
//   });
// The input's `data-medicine-id` attribute holds the currently selected id, or '' if none.
(function () {
  const style = document.createElement('style');
  style.textContent = `
    .med-ac-wrap { position: relative; display: inline-block; width: 100%; }
    .med-ac-list {
      position: absolute; left: 0; top: 100%;
      min-width: 260px;                              /* wide enough for long medicine names even in narrow cells */
      width: max-content;
      max-width: 380px;
      background: #fff; border: 1px solid #93c5fd; border-top: none;
      z-index: 40; box-shadow: 0 6px 12px rgba(0,0,0,0.08);
      max-height: none;      /* no scrollbar per user request */
      overflow: visible;
    }
    .med-ac-item { padding: 5px 8px; font-size: 12px; cursor: pointer; border-top: 1px dashed #eef; }
    .med-ac-item:first-child { border-top: none; }
    .med-ac-item:hover, .med-ac-item.active { background: #dbeafe; }
    .med-ac-item .stock { color:#666; font-size:10px; float:right; }
    .med-ac-hint { padding: 5px 8px; font-size: 11px; color: #666; font-style: italic; }
  `;
  document.head.appendChild(style);

  const MAX_VISIBLE = 12;   // hard cap so the dropdown never needs a scrollbar

  function attach(input, medicines, opts) {
    opts = opts || {};
    const showStock = opts.showStock !== false;

    // Wrap the input in a positioned container
    const wrap = document.createElement('span');
    wrap.className = 'med-ac-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const list = document.createElement('div');
    list.className = 'med-ac-list';
    list.style.display = 'none';
    wrap.appendChild(list);

    input.setAttribute('autocomplete', 'off');
    input.dataset.medicineId = '';

    function close() { list.style.display = 'none'; list.innerHTML = ''; }
    function open(items) {
      list.innerHTML = '';
      if (!items.length) { list.innerHTML = `<div class="med-ac-hint">No medicine starts with that.</div>`; list.style.display = 'block'; return; }
      items.slice(0, MAX_VISIBLE).forEach((m, i) => {
        const div = document.createElement('div');
        div.className = 'med-ac-item' + (i === 0 ? ' active' : '');
        div.innerHTML = `${m.medicine_name}${showStock ? `<span class="stock">stock: ${m.current_stock || 0}</span>` : ''}`;
        div.dataset.id = m.id;
        div.addEventListener('mousedown', (e) => { e.preventDefault(); pick(m); });
        list.appendChild(div);
      });
      list.style.display = 'block';
    }
    function pick(m) {
      input.value = m.medicine_name;
      input.dataset.medicineId = m.id;
      close();
      if (opts.onSelect) opts.onSelect(m);
    }

    function filter() {
      const q = input.value.trim().toLowerCase();
      // Clear previous selection whenever text changes
      input.dataset.medicineId = '';
      if (!q) { close(); return; }
      const matches = medicines.filter(m => (m.medicine_name || '').toLowerCase().startsWith(q));
      open(matches);
    }
    input.addEventListener('input', filter);
    input.addEventListener('focus', filter);
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => {
      const items = Array.from(list.querySelectorAll('.med-ac-item'));
      if (!items.length) return;
      let idx = items.findIndex(x => x.classList.contains('active'));
      if (e.key === 'ArrowDown') { e.preventDefault(); if (idx < items.length - 1) idx++; }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (idx > 0) idx--; }
      else if (e.key === 'Enter') {
        if (idx >= 0) {
          e.preventDefault();
          const id = items[idx].dataset.id;
          const m = medicines.find(x => String(x.id) === String(id));
          if (m) pick(m);
        }
        return;
      }
      else if (e.key === 'Escape') { close(); return; }
      else return;
      items.forEach((x, i) => x.classList.toggle('active', i === idx));
    });
    return {
      getSelectedId: () => input.dataset.medicineId,
      setSelected: (m) => pick(m),
      updateMedicines: (newList) => { medicines = newList; }
    };
  }

  window.MedicineAutocomplete = { attach };
})();
