// TriSeason — thème clair / sombre.
// Préférence de l'appareil (pas du compte) : localStorage 'triseason_theme' =
// 'dark' (par défaut), 'light' ou 'auto' (comme le téléphone). Chargé en premier
// dans le <head> de chaque page pour éviter un flash de la mauvaise couleur.
// Les couleurs viennent des variables de style.css (:root[data-theme="light"]).
// Les couleurs écrites en dur dans les pages (graphiques Chart.js, styles en
// ligne générés en JavaScript) sont converties vers la palette claire ici.
(function () {
  var KEY = 'triseason_theme';
  function pref() { try { return localStorage.getItem(KEY) || 'dark'; } catch (e) { return 'dark'; } }
  function wantsLight(p) {
    return p === 'light' || (p === 'auto' && !!(window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches));
  }
  var theme = wantsLight(pref()) ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  window.TS_THEME = {
    get: pref,
    current: function () { return theme; },
    set: function (p) { try { localStorage.setItem(KEY, p); } catch (e) {} location.reload(); },
  };
  if (pref() === 'auto' && window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: light)');
    var onChange = function () { if ((mq.matches ? 'light' : 'dark') !== theme) location.reload(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  function setMeta() {
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', theme === 'light' ? '#eef1f5' : '#0d1016');
  }
  if (theme !== 'light') return;

  // Palette sombre → palette claire (mêmes rôles ; couleurs de sport vérifiées :
  // contraste ≥ 4,4 sur blanc, distinctes avec les trois formes de daltonisme).
  var MAP = {
    '#2f95e6': '#2273c9', '#d8791a': '#bd5f00', '#dc3d6a': '#cb2f63', '#9256fb': '#4b2a85',
    '#34c48b': '#1a8a5f', '#2fb8a6': '#187e74', '#ef5350': '#c9302c', '#f0b941': '#9a6500',
    '#a48be0': '#7a5fc0', '#7d8aa0': '#5b6576', '#a3abb9': '#4a5466', '#6b7383': '#6b7486',
    '#242b36': '#dde2e9', '#151a22': '#ffffff', '#b9ec4a': '#5a8c00', '#cdf56e': '#4f7d00',
  };
  var RE = /#[0-9a-fA-F]{6}|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.0\d\s*\)|rgba\(\s*185\s*,\s*236\s*,\s*74\s*,\s*0?\.\d+\s*\)/g;
  function swap(str) {
    return str.replace(RE, function (m) {
      if (m.charAt(0) === '#') return MAP[m.toLowerCase()] || m;
      if (m.indexOf('185') < 0) return 'rgba(20,30,45,.09)';
      // citron vert un peu plus soutenu sur fond clair, même transparence (×1,3)
      var alpha = parseFloat(m.replace(/.*,\s*([\d.]+)\s*\)$/, '$1'));
      return 'rgba(147,201,50,' + Math.min(1, Math.round(alpha * 130) / 100) + ')';
    });
  }

  // Styles en ligne (cartes, zones, niveaux…) ajoutés au fil de l'affichage
  function fix(el) {
    var s = el.getAttribute && el.getAttribute('style');
    if (s && (s.indexOf('#') >= 0 || s.indexOf('rgba') >= 0)) { var n = swap(s); if (n !== s) el.setAttribute('style', n); }
  }
  function fixTree(node) {
    if (node.nodeType !== 1) return;
    fix(node);
    var list = node.querySelectorAll('[style]');
    for (var i = 0; i < list.length; i++) fix(list[i]);
  }
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      if (m.type === 'attributes') fix(m.target);
      else m.addedNodes.forEach(fixTree);
    });
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  document.addEventListener('DOMContentLoaded', function () { setMeta(); fixTree(document.body); });

  // Graphiques : couleurs du réglage converties à la création (Chart.js est
  // chargé après ce fichier : on l'intercepte au moment où il arrive).
  function walk(o, depth) {
    if (!o || depth > 8) return o;
    if (typeof o === 'string') {
      var v = /^var\((--[\w-]+)\)$/.exec(o); // Chart.js ne comprend pas var(--…)
      return v ? (getComputedStyle(document.documentElement).getPropertyValue(v[1]).trim() || o) : swap(o);
    }
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) o[i] = walk(o[i], depth + 1); return o; }
    if (typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype) {
      Object.keys(o).forEach(function (k) { if (k !== 'data' || depth > 0) o[k] = walk(o[k], depth + 1); });
    }
    return o;
  }
  function wrapChart(C) {
    if (!C || C.__tsLight) return C;
    C.defaults.color = '#4a5466';
    C.defaults.borderColor = 'rgba(20,30,45,.09)';
    var W = function (item, cfg) {
      if (cfg) { walk(cfg.options, 1); if (cfg.data && cfg.data.datasets) walk(cfg.data.datasets, 1); }
      return Reflect.construct(C, [item, cfg], W);
    };
    W.prototype = C.prototype;
    Object.setPrototypeOf(W, C);
    W.__tsLight = true;
    return W;
  }
  var Wrapped;
  try {
    Object.defineProperty(window, 'Chart', {
      configurable: true,
      get: function () { return Wrapped; },
      set: function (v) { Wrapped = wrapChart(v); },
    });
  } catch (e) {}
})();
