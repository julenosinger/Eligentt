/**
 * Elligentt Table Component — Reusable Table Factory (Phase 2)
 * Reuses existing table HTML patterns. No redesign.
 * Attached to: window.TableComponent
 */
(function () {
  'use strict';

  /**
   * Build a table from column definitions and row data.
   * @param {Object} opts
   * @param {Element|string} opts.container - Container element or ID
   * @param {Object[]} opts.columns - [{key, label, render?, width?, align?}]
   * @param {Object[]} opts.rows - Data rows
   * @param {string} [opts.emptyMessage] - Message when no rows
   * @param {string} [opts.emptyId] - ID of empty-state element to show/hide
   * @param {Function} [opts.onRowClick] - (row, index, event)
   * @param {string} [opts.tableClass] - Additional CSS class for table
   */
  function render(opts) {
    var o = opts || {};
    var container = typeof o.container === 'string'
      ? document.getElementById(o.container)
      : o.container;
    if (!container) return;

    var rows = o.rows || [];
    var cols = o.columns || [];
    var emptyEl = o.emptyId ? document.getElementById(o.emptyId) : null;

    if (!rows.length) {
      container.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    // Build table
    var table = document.createElement('table');
    table.className = (o.tableClass || '') + ' data-table';
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:10px';

    // Header
    var thead = document.createElement('thead');
    var tr = document.createElement('tr');
    for (var c = 0; c < cols.length; c++) {
      var th = document.createElement('th');
      th.textContent = cols[c].label || '';
      th.style.cssText = 'text-align:' + (cols[c].align || 'left') + ';padding:6px 8px;border-bottom:1px solid var(--border);color:var(--muted2);font-size:9px;font-weight:600;text-transform:uppercase';
      if (cols[c].width) th.style.width = cols[c].width;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);

    // Body
    var tbody = document.createElement('tbody');
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var rowEl = document.createElement('tr');
      rowEl.style.cssText = 'border-bottom:1px solid var(--border);transition:background .12s';
      rowEl.addEventListener('mouseenter', function () { this.style.background = 'rgba(167,139,250,.04)'; });
      rowEl.addEventListener('mouseleave', function () { this.style.background = ''; });

      if (typeof o.onRowClick === 'function') {
        rowEl.style.cursor = 'pointer';
        (function (idx) {
          rowEl.addEventListener('click', function (e) { o.onRowClick(rows[idx], idx, e); });
        })(r);
      }

      for (var c2 = 0; c2 < cols.length; c2++) {
        var td = document.createElement('td');
        td.style.cssText = 'padding:6px 8px;text-align:' + (cols[c2].align || 'left');

        if (typeof cols[c2].render === 'function') {
          var rendered = cols[c2].render(row[cols[c2].key], row, r);
          if (typeof rendered === 'string') td.innerHTML = rendered;
          else if (rendered instanceof Node) td.appendChild(rendered);
        } else {
          td.textContent = row[cols[c2].key] != null ? String(row[cols[c2].key]) : '';
        }
        rowEl.appendChild(td);
      }
      tbody.appendChild(rowEl);
    }
    table.appendChild(tbody);

    container.innerHTML = '';
    container.appendChild(table);
  }

  /** @public */
  window.TableComponent = {
    VERSION: '1.0.0',
    render: render
  };
})();
