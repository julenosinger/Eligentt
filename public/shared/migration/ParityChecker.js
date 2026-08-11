/**
 * Elligentt ParityChecker — Compare Legacy vs New Execution (Phase 8)
 * For every migrated operation: run legacy, run new, compare output.
 * Tracks discrepancies. Used to validate migration before enabling.
 * Attached to: window.ParityChecker
 */
(function () {
  'use strict';

  var _results = []; // [{ func, legacyOutput, newOutput, match, diff, timestamp }]
  var MAX_RESULTS = 200;

  /**
   * Run parity check: call legacyFn and newFn with same args, compare results.
   * @param {string} name - Function name
   * @param {Function} legacyFn - Original function
   * @param {Function} newFn - New architecture function
   * @param {Array} args - Arguments to pass
   * @param {Object} [opts] - { deepCompare, ignoreKeys }
   * @returns {{ match: boolean, legacy: *, new: *, diff: string }}
   */
  function check(name, legacyFn, newFn, args, opts) {
    var o = opts || {};
    var legacyOutput = null, legacyError = null;
    var newOutput = null, newError = null;

    try { legacyOutput = legacyFn.apply(null, args || []); } catch (e) { legacyError = e.message; }
    try { newOutput = newFn.apply(null, args || []); } catch (e) { newError = e.message; }

    var match = _compare(legacyOutput, newOutput, legacyError, newError, o);
    var diff = '';
    if (!match) {
      if (legacyError && newError) diff = 'Legacy error: ' + legacyError + ' | New error: ' + newError;
      else if (legacyError) diff = 'New succeeded but legacy threw: ' + legacyError;
      else if (newError) diff = 'Legacy succeeded but new threw: ' + newError;
      else diff = 'Output mismatch: legacy=' + JSON.stringify(legacyOutput).substring(0, 100) + ' vs new=' + JSON.stringify(newOutput).substring(0, 100);
    }

    var entry = {
      func: name, legacyOutput: legacyOutput, newOutput: newOutput,
      legacyError: legacyError, newError: newError, match: match,
      diff: diff, timestamp: Date.now()
    };
    _results.unshift(entry);
    if (_results.length > MAX_RESULTS) _results.length = MAX_RESULTS;

    try { if (typeof EventBus !== 'undefined') EventBus.emit('PARITY_CHECK', entry); } catch (_e) {}
    return entry;
  }

  function _compare(a, b, aErr, bErr, opts) {
    if (aErr || bErr) return aErr === bErr;
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a === 'object' && a !== null && b !== null) {
      if (opts.ignoreKeys) {
        var aClean = Object.assign({}, a); var bClean = Object.assign({}, b);
        opts.ignoreKeys.forEach(function (k) { delete aClean[k]; delete bClean[k]; });
        return JSON.stringify(aClean) === JSON.stringify(bClean);
      }
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  }

  function getResults(limit) { return _results.slice(0, limit || 20); }
  function getMatchRate() {
    var total = _results.length;
    var matches = _results.filter(function (r) { return r.match; }).length;
    return { total: total, matches: matches, mismatches: total - matches, rate: total > 0 ? Math.round((matches / total) * 100) : 100 };
  }
  function getMismatches() { return _results.filter(function (r) { return !r.match; }); }

  function clear() { _results = []; }

  window.ParityChecker = {
    VERSION: '1.0.0',
    check: check, getResults: getResults, getMatchRate: getMatchRate,
    getMismatches: getMismatches, clear: clear
  };
})();
