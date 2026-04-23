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
