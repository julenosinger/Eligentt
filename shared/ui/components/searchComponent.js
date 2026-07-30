/**
 * Elligentt Search Component — Search Bar Factory (Phase 2)
 * Attached to: window.SearchComponent
 */
(function () {
  'use strict';

  /**
   * Create an inline search input with optional debounce.
   * @param {Object} opts
   * @param {Element|string} opts.container
   * @param {string} [opts.placeholder] - "Search..."
   * @param {Function} opts.onSearch - (query: string) => void
   * @param {number} [opts.debounce] - Debounce ms (default 250)
   * @param {string} [opts.initialValue]
   * @returns {{ input: HTMLInputElement, clear: Function, focus: Function }}
   */
  function create(opts) {
    var o = opts || {};
    var container = typeof o.container === 'string'
      ? document.getElementById(o.container) : o.container;
    if (!container) return { input: null, clear: function () {}, focus: function () {} };

    var debounce = o.debounce !== undefined ? o.debounce : 250;
    var timer = null;

    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:4px 10px';

    var icon = document.createElement('i');
    icon.className = 'ti ti-search';
    icon.style.cssText = 'font-size:13px;color:var(--muted2);flex-shrink:0';
    wrapper.appendChild(icon);

    var input = document.createElement('input');
    input.className = 'cinput';
    input.type = 'text';
    input.placeholder = o.placeholder || 'Search...';
    input.style.cssText = 'border:none;background:transparent;outline:none;font-size:10px;color:var(--text);flex:1;min-width:0;padding:3px 0';
    if (o.initialValue) input.value = o.initialValue;

    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        if (typeof o.onSearch === 'function') o.onSearch(input.value);
      }, debounce);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; if (typeof o.onSearch === 'function') o.onSearch(''); }
    });

    wrapper.appendChild(input);

    var clearBtn = document.createElement('button');
    clearBtn.className = 'btn';
    clearBtn.style.cssText = 'padding:0;width:18px;height:18px;min-width:18px;border-radius:50%;font-size:10px;border:none;background:transparent;color:var(--muted2);cursor:pointer;display:none;align-items:center;justify-content:center';
    clearBtn.innerHTML = '&times;';
    clearBtn.title = 'Clear search';
    clearBtn.addEventListener('click', function () {
      input.value = '';
      clearBtn.style.display = 'none';
      if (typeof o.onSearch === 'function') o.onSearch('');
    });
    wrapper.appendChild(clearBtn);

    input.addEventListener('input', function () {
      clearBtn.style.display = input.value ? 'flex' : 'none';
    });

    container.innerHTML = '';
    container.appendChild(wrapper);

    return {
      input: input,
      clear: function () { input.value = ''; clearBtn.style.display = 'none'; },
      focus: function () { input.focus(); }
    };
  }

  /** @public */
  window.SearchComponent = {
    VERSION: '1.0.0',
    create: create
  };
})();
