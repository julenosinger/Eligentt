/**
 * Elligentt Pagination Component (Phase 2)
 * Attached to: window.PaginationComponent
 */
(function () {
  'use strict';

  /**
   * Render pagination controls.
   * @param {Object} opts
   * @param {Element|string} opts.container
   * @param {number} opts.total - Total items
   * @param {number} opts.pageSize - Items per page
   * @param {number} opts.currentPage - 1-based current page
   * @param {Function} opts.onPageChange - (page: number) => void
   */
  function render(opts) {
    var o = opts || {};
    var container = typeof o.container === 'string'
      ? document.getElementById(o.container) : o.container;
    if (!container) return;

    var total = Math.max(0, o.total || 0);
    var pageSize = Math.max(1, o.pageSize || 10);
    var current = Math.max(1, o.currentPage || 1);
    var totalPages = Math.max(1, Math.ceil(total / pageSize));

    if (totalPages <= 1 && total <= pageSize) {
      container.innerHTML = '';
      return;
    }

    var html = '<div style="display:flex;align-items:center;gap:4px;font-size:9px">';

    // Previous
    html += _btn(current === 1, '<i class="ti ti-chevron-left"></i>', current - 1, o.onPageChange);

    // Page numbers
    var start = Math.max(1, current - 2);
    var end = Math.min(totalPages, current + 2);
    if (start > 1) html += _btn(false, '1', 1, o.onPageChange) + '<span style="color:var(--muted2);padding:0 2px">...</span>';
    for (var p = start; p <= end; p++) {
      html += _btn(false, String(p), p, o.onPageChange, p === current);
    }
    if (end < totalPages) html += '<span style="color:var(--muted2);padding:0 2px">...</span>' + _btn(false, String(totalPages), totalPages, o.onPageChange);

    // Next
    html += _btn(current === totalPages, '<i class="ti ti-chevron-right"></i>', current + 1, o.onPageChange);

    // Info
    html += '<span style="color:var(--muted2);margin-left:8px;font-size:8px">' + total + ' items</span>';
    html += '</div>';

    container.innerHTML = html;
  }

  function _btn(disabled, label, page, onPageChange, isActive) {
    if (disabled) {
      return '<span style="display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:22px;border-radius:4px;color:var(--muted2);opacity:.4;cursor:not-allowed">' + label + '</span>';
    }
    var style = 'display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:22px;border-radius:4px;cursor:pointer;transition:all .12s;';
    if (isActive) style += 'background:rgba(167,139,250,.15);color:var(--purple);font-weight:700';
    else style += 'color:var(--muted);';
    var escFn = onPageChange.toString().replace(/"/g, '&quot;');
    return '<span style="' + style + '" onclick="(' + escFn + ')(' + page + ')" onmouseenter="this.style.background=\'rgba(167,139,250,.08)\'" onmouseleave="' + (isActive ? 'this.style.background=\'rgba(167,139,250,.15)\'' : 'this.style.background=\'\'') + '">' + label + '</span>';
  }

  /** @public */
  window.PaginationComponent = {
    VERSION: '1.0.0',
    render: render
  };
})();
