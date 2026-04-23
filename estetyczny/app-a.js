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

  function renderQuestion() {}
  function showSummary() {}

  function nextQuestion() {
    state.current++;
    renderQuestion();
  }

  function init() {
    fetch('../questions.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var all = data.filter(function (q) { return q.typ === 'abcd' || q.typ === 'tf'; });
        state.questions = shuffle(all);
        renderQuestion();
      });
  }

  init();
}());
