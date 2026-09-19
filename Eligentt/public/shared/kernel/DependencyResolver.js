/**
 * Elligentt DependencyResolver — Plugin Dependency Graph Resolver (Phase 5)
 * Validates the dependency graph. Detects missing deps and circular references.
 * Attached to: window.DependencyResolver
 */
(function () {
  'use strict';

  function validateGraph(plugins) {
    var missing = [];
    var circular = _detectCycles(plugins);
    for (var i = 0; i < plugins.length; i++) {
      var deps = plugins[i].dependencies || [];
      for (var j = 0; j < deps.length; j++) {
        var found = plugins.some(function (p) { return p.id === deps[j]; });
        if (!found) missing.push({ plugin: plugins[i].id, missing: deps[j] });
      }
    }
    return { valid: missing.length === 0 && circular.length === 0, missing: missing, circular: circular };
  }

  function _detectCycles(plugins) {
    var graph = {};
    for (var i = 0; i < plugins.length; i++) {
      graph[plugins[i].id] = plugins[i].dependencies || [];
    }
    var cycles = [];
    var ids = Object.keys(graph);
    for (var j = 0; j < ids.length; j++) {
      var visited = {};
      var path = [];
      _dfs(ids[j], graph, visited, path, cycles);
    }
    return cycles;
  }

  function _dfs(node, graph, visited, path, cycles) {
    if (visited[node]) return;
    if (path.indexOf(node) !== -1) {
      var cycle = path.slice(path.indexOf(node));
      cycle.push(node);
      cycles.push(cycle);
      return;
    }
    path.push(node);
    var deps = graph[node] || [];
    for (var i = 0; i < deps.length; i++) { _dfs(deps[i], graph, visited, path, cycles); }
    path.pop();
    visited[node] = true;
  }

  function getResolutionOrder(plugins) {
    var resolved = [];
    var unresolved = plugins.slice();
    var iterations = 0;
    var maxIterations = plugins.length * 2;

    while (unresolved.length > 0 && iterations < maxIterations) {
      iterations++;
      var ready = [];
      var stillWaiting = [];

      for (var i = 0; i < unresolved.length; i++) {
        var deps = unresolved[i].dependencies || [];
        var allDepsResolved = true;
        for (var j = 0; j < deps.length; j++) {
          if (resolved.indexOf(deps[j]) === -1) { allDepsResolved = false; break; }
        }
        if (allDepsResolved || deps.length === 0) {
          ready.push(unresolved[i]);
        } else {
          stillWaiting.push(unresolved[i]);
        }
      }

      if (ready.length === 0 && stillWaiting.length > 0) break; // circular
      ready.forEach(function (p) { resolved.push(p.id); });
      unresolved = stillWaiting;
    }

    return resolved;
  }

  window.DependencyResolver = {
    VERSION: '1.0.0',
    validateGraph: validateGraph,
    getResolutionOrder: getResolutionOrder
  };
})();
