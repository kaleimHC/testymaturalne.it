// Quiz engine, wariant estetyczny.
(function () {
  'use strict';

  var SWAP_FADE_MS        = 110;  // fade między pytaniami, musi pasować do transition w CSS
  var NAV_OUT_MS          = 200;  // fade na przejście do innej strony (pg-out)
  var CODE_LINE_MAX       = 25;   // heurystyka parsera: linia krótsza → kandydat na code-block
  var CODE_BLOCK_MIN_ROWS = 3;    // ile krótkich linii z rzędu żeby wbić w <pre>

  // ═══════════════════════════════════════════════════════════════════════
  // STATE: jeden obiekt, trzy klucze, żadnego Reduksa
  //
  // questions -> pytania z JSON, przeshuffled przy starcie.
  // current   -> indeks aktualnego pytania.
  // answers   -> { questionId: { given, correct, timestamp } }.
  // ═══════════════════════════════════════════════════════════════════════

  var STORAGE_KEY = 'edu_progress_a';

  var state = {
    questions: [],
    current: 0,
    answers: {}
  };

  var app = document.getElementById('app');

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function saveProgress() {
    var data = {
      questionOrder: state.questions.map(function (q) { return q.id; }),
      current: state.current,
      answers: state.answers
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearProgress() { localStorage.removeItem(STORAGE_KEY); }

  // ═══════════════════════════════════════════════════════════════════════
  // DOM HELPERS: swapContent i renderKaTeX
  //
  // swapContent: fade out -> DOM swap -> fade in. Guard _swapBusy żeby
  // szybkie kliknięcia nie strzeliły dwóch równoległych przejść.
  // renderKaTeX: HACK: TreeWalker przepisuje \$ na placeholder zanim
  // KaTeX dostanie tekst, potem z powrotem. Inaczej KaTeX widzi \$ jako
  // otwierający delimiter i się sypie. Brzydkie. Działa.
  // ═══════════════════════════════════════════════════════════════════════

  var _swapBusy = false;
  var _prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function swapContent(fn) {
    if (_swapBusy || _prefersReducedMotion) { fn(); app.focus(); return; }
    _swapBusy = true;
    app.style.transition = 'opacity ' + SWAP_FADE_MS + 'ms ease';
    app.style.opacity = '0';
    setTimeout(function () {
      fn();
      app.focus();
      _swapBusy = false;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          app.style.transition = 'opacity ' + NAV_OUT_MS + 'ms ease';
          app.style.opacity = '1';
        });
      });
    }, SWAP_FADE_MS);
  }

  function renderKaTeX() {
    if (typeof renderMathInElement !== 'function') return;
    var PH = '', tw = document.createTreeWalker(app, NodeFilter.SHOW_TEXT), n;
    while ((n = tw.nextNode())) {
      if (n.nodeValue.indexOf('\\$') !== -1) n.nodeValue = n.nodeValue.replace(/\\\$/g, PH);
    }
    renderMathInElement(app, {
      delimiters: [{ left: '$', right: '$', display: false }],
      throwOnError: false,
      ignoredTags: ['pre', 'code', 'script', 'style', 'textarea']
    });
    tw = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
    while ((n = tw.nextNode())) {
      if (n.nodeValue.indexOf(PH) !== -1) n.nodeValue = n.nodeValue.split(PH).join('$');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEXT PARSING: surowy string z JSON -> HTML gotowy do DOM
  //
  // Pipe tables (|col|) -> <table>, SQL keywords -> <pre>,
  // ≥3 krótkie linie -> <pre>, ^^ -> wyśrodkowanie.
  // ═══════════════════════════════════════════════════════════════════════

  // escapeHtml: HTML entities, żeby nikt nie wstrzyknął <script>.
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // mdTable: pipe-table -> <table>. Pusty lewy-górny nagłówek -> pierwsza
  // kolumna danych dostaje <th scope="row"> (styl Excel-owy).
  function mdTable(lines) {
    var rows = lines
      .filter(function(l) { return !/^\s*\|[\s:|\-]+\|\s*$/.test(l); })
      .map(function(l) { return l.split('|').slice(1,-1).map(function(c){ return escapeHtml(c.trim()); }); });
    if (!rows.length) return '';
    var rowHdr = rows[0].length > 0 && rows[0][0] === '';
    return '<table class="q-table"><thead><tr>' +
      rows[0].map(function(c){ return '<th>' + c + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.slice(1).map(function(row){
        return '<tr>' + row.map(function(c, ci){
          return (rowHdr && ci === 0) ? '<th scope="row">' + c + '</th>' : '<td>' + c + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  // renderText: parser jednorazowego przejścia, linia po linii.
  //
  // Zbiera segmenty, mapuje na HTML na końcu. Typy: 'table', 'code',
  // 'center', 'text'. Żadnego backtracku. Żadnych regexpów na całości.
  function renderText(raw) {
    var lines = raw.split('\n'), segs = [], i = 0;
    while (i < lines.length) {
      var line = lines[i], tr = line.trim();
      if (tr.charAt(0) === '|') {
        var block = []; while (i < lines.length && lines[i].trim().charAt(0) === '|') block.push(lines[i++]);
        segs.push({ t: 'table', l: block }); continue;
      }
      if (tr.slice(0, 2) === '^^') { segs.push({ t: 'center', l: [tr.slice(2).trim()] }); i++; continue; }
      if (/^(SELECT|FROM|WHERE|GROUP|HAVING|ORDER|INSERT|UPDATE|DELETE|JOIN)\b/i.test(tr)) {
        var block = [line]; i++;
        while (i < lines.length && lines[i].trim()) block.push(lines[i++]);
        segs.push({ t: 'code', l: block }); continue;
      }
      if (tr && tr.length < CODE_LINE_MAX) {
        var j = i, block = [];
        while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().length < CODE_LINE_MAX)) block.push(lines[j++]);
        var nonEmpty = block.filter(function(l){ return l.trim(); }).length;
        if (nonEmpty >= CODE_BLOCK_MIN_ROWS) {
          while (block.length && !block[0].trim()) block.shift();
          while (block.length && !block[block.length-1].trim()) block.pop();
          segs.push({ t: 'code', l: block }); i = j; continue;
        }
      }
      var last = segs[segs.length-1];
      if (!last || last.t !== 'text') { segs.push({ t: 'text', l: [] }); last = segs[segs.length-1]; }
      last.l.push(line); i++;
    }
    return segs.map(function(s) {
      if (s.t === 'table') return mdTable(s.l);
      if (s.t === 'center') return '<p class="q-center">' + escapeHtml(s.l[0]) + '</p>';
      if (s.t === 'code') return '<pre class="code-block">' + escapeHtml(s.l.join('\n')) + '</pre>';
      var paras = [[]];
      s.l.forEach(function(l){ if (!l.trim()) paras.push([]); else paras[paras.length-1].push(escapeHtml(l)); });
      return paras.filter(function(p){ return p.length; }).map(function(p){ return p.join('<br>'); }).join('<br>');
    }).join('');
  }

  function renderQuestion() {}
  function showSummary() {}

  function nextQuestion() {
    state.current++;
    saveProgress();
    renderQuestion();
  }

  function init() {
    fetch('../questions.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var all = data.filter(function (q) { return q.typ === 'abcd' || q.typ === 'tf'; });
        var saved = loadProgress();
        if (saved && saved.questionOrder) {
          var idMap = {};
          all.forEach(function (q) { idMap[q.id] = q; });
          state.questions = saved.questionOrder.map(function (id) { return idMap[id]; }).filter(Boolean);
          state.current = saved.current || 0;
          state.answers = saved.answers || {};
        } else {
          state.questions = shuffle(all);
        }
        renderQuestion();
      });
  }

  init();
}());
