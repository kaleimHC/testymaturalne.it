// Quiz engine, wariant estetyczny.
(function () {
  'use strict';

  var SWAP_FADE_MS        = 110;  // fade między pytaniami, musi pasować do transition w style-X.css
  var NAV_OUT_MS          = 200;  // fade na przejście do innej strony (pg-out)
  var CODE_LINE_MAX       = 25;   // heurystyka parsera: linia krótsza → kandydat na code-block
  var CODE_BLOCK_MIN_ROWS = 3;    // ile krótkich linii z rzędu żeby wbić w <pre>

  // ═══════════════════════════════════════════════════════════════════════
  // STATE: jeden obiekt, trzy klucze, żadnego Reduksa
  //
  // questions -> ~95 pytań z JSON, przeshuffled przy starcie.
  // current   -> który pytanie pokazujemy teraz (indeks, nie ID).
  // answers   -> { questionId: { given, correct, timestamp } }.
  //
  // Reszta kodu to funkcje które to czytają albo modyfikują. Tyle.
  // ═══════════════════════════════════════════════════════════════════════

  var STORAGE_KEY = 'edu_progress_a';

  var state = {
    questions: [],
    current: 0,
    answers: {}
  };

  var app = document.getElementById('app');
  var tfSelections = {};

  // ─────────────────────────────────────────────────────────────────────
  // UTILITIES: shuffle i save/load postępów do localStorage
  // ─────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────
  // UI HELPERS: questionLabel: etykieta nad pytaniem (Zadanie X + meta)
  // ─────────────────────────────────────────────────────────────────────

  function questionLabel(q) {
    var m = q.id.match(/_z(\d+)(?:_(\d+))?/);
    var zNum = m ? m[1] : '?';
    if (q.source && q.source.indexOf('autorskie') !== -1) {
      return 'Zadanie ' + zNum;
    }
    var isPP = q.poziom === 'pp';
    var lbl = isPP ? 'poziom podstawowy' : 'poziom rozszerzony';
    var lbl2 = isPP ? 'p.p.' : 'p.r.';
    return 'Zadanie ' + zNum + ' - <span class="lbl-long">' + lbl + '</span>' +
      '<span class="lbl-short">' + lbl2 + '</span> - ' + q.sesja + ' ' + q.rok + ' r.';
  }

  // ─────────────────────────────────────────────────────────────────────
  // INIT FLOW: fetch JSON, filtr pytań z obrazkami, resume albo nowy start
  // ─────────────────────────────────────────────────────────────────────

  // init: fetch questions.json, filtr, potem resume albo nowy start
  //
  // Filtr !q.img: pytania z obrazkami wykluczone bo nie hostujemy skanów CKE.
  // Wątpliwe że kiedykolwiek będziemy.
  function init() {
    fetch('../questions.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (all) {
        var filtered = all.filter(function (q) {
          return !q.img && (q.typ === 'abcd' || q.typ === 'tf');
        });
        if (filtered.length === 0) {
          app.innerHTML = '<p style="padding:20px">Brak dostępnych pytań.</p>';
          return;
        }
        var saved = loadProgress();
        if (saved && saved.questionOrder && Object.keys(saved.answers).length > 0) {
          showResumeDialog(filtered, saved);
        } else {
          state.questions = shuffle(filtered);
          state.current = 0;
          state.answers = {};
          renderQuestion();
        }
      })
      .catch(function () {
        app.innerHTML = '<p style="padding:20px">Nie udało się załadować pytań. Sprawdź połączenie i odśwież stronę.</p>';
      });
  }

  // showResumeDialog: modal "masz zapisaną sesję, kontynuować?"
  //
  // TAK: odtwarza kolejność pytań z localStorage, nowe dorzuca na koniec.
  // NIE: clearProgress, shuffle, start od zera.
  function showResumeDialog(filtered, saved) {
    var count = Object.keys(saved.answers).length;
    app.innerHTML =
      '<div class="dialog-overlay">' +
        '<div class="dialog-box">' +
          '<p>Masz zapisaną sesję (' + count + '/' + saved.questionOrder.length + ' pytań).<br>Kontynuować?</p>' +
          '<div class="dialog-buttons">' +
            '<button class="primary" data-resume="yes">Kontynuuj</button>' +
            '<button data-resume="no">Od nowa</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    app.addEventListener('click', function handler(e) {
      var btn = e.target.closest('[data-resume]');
      if (!btn) return;
      app.removeEventListener('click', handler);
      if (btn.dataset.resume === 'yes') {
        var idMap = {};
        filtered.forEach(function (q) { idMap[q.id] = q; });
        var ordered = [];
        saved.questionOrder.forEach(function (id) { if (idMap[id]) ordered.push(idMap[id]); });
        filtered.forEach(function (q) { if (saved.questionOrder.indexOf(q.id) === -1) ordered.push(q); });
        state.questions = ordered;
        state.current = saved.current;
        state.answers = saved.answers;
      } else {
        clearProgress();
        state.questions = shuffle(filtered);
        state.current = 0;
        state.answers = {};
      }
      renderQuestion();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER: centrum quizu, tu wszystko się schodzi
  //
  // renderQuestion: state.current -> HTML -> swapContent -> KaTeX -> restore.
  // ABCD i T/F mają osobne renderery. showSummary jeśli pytań brak.
  // ═══════════════════════════════════════════════════════════════════════

  // renderQuestion: bierze state.current, składa HTML, wstawia do DOM
  //
  // Kolejność: HTML -> swapContent (fade) -> KaTeX -> restore jeśli był tu.
  // Widok rozgałęzia się na ABCD albo T/F. Nie zwraca nic.
  function renderQuestion() {
    if (state.current >= state.questions.length) { showSummary(); return; }

    var q = state.questions[state.current];
    var num = state.current + 1;
    var total = state.questions.length;

    var html = '<div class="sheet">';

    html += '<div class="top-bar">';
    html += '<a class="top-info site-link" href="../">' +
      '<span class="lbl-long">testymaturalne.it</span>' +
      '<span class="lbl-short">&lt;- WYBÓR</span></a>';
    html += '<span class="top-prog">' + num + '/' + total + '</span>';
    html += '<span class="top-time">Czas: --:--</span>';
    html += '</div>';

    html += '<div class="task-label"><span>' + questionLabel(q) + '</span></div>';

    html += '<div class="question-body">' + renderText(q.treść) + '</div>';

    if (q.typ === 'tf') {
      tfSelections = {};
      html += renderTFHtml(q);
      html += '<div class="actions">';
      html += '<button class="btn-check" id="checkBtn" disabled aria-disabled="true">Sprawdź</button>';
      html += '<button class="btn-next" id="nextBtn" disabled aria-disabled="true">Następne zadanie &rarr;</button>';
      html += '</div>';
    } else {
      html += renderABCDHtml(q);
      html += '<div class="actions single">';
      html += '<button class="btn-next" id="nextBtn" disabled aria-disabled="true">Następne zadanie &rarr;</button>';
      html += '</div>';
    }

    html += '<div class="cke-footer">';
    html += '<span>Arkusz egzaminacyjny CKE</span>';
    html += '<div class="foot-theme"><span class="foot-jasny">JASNY</span> | <span class="foot-ciemny">CIEMNY</span></div>';
    html += '</div>';

    html += '</div>';

    swapContent(function () {
      app.innerHTML = html;
      renderKaTeX();
      var prev = state.answers[q.id];
      if (prev) {
        if (q.typ === 'abcd') restoreABCD(q, prev);
        else restoreTF(q, prev);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // ABCD: render wariantów, kliknięcie, feedback correct/incorrect, restore
  // ─────────────────────────────────────────────────────────────────────

  function renderABCDHtml(q) {
    var html = '<div class="variants">';
    ['A', 'B', 'C', 'D'].forEach(function (letter) {
      if (!q.warianty[letter]) return;
      html += '<div class="variant" data-choice="' + letter + '">';
      html += '<span class="variant-key">' + letter + '.</span>';
      html += '<span class="variant-text">' + escapeHtml(q.warianty[letter]) + '</span>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function applyABCDClasses(q, choice, isCorrect) {
    app.querySelectorAll('.variant').forEach(function (el) {
      el.classList.add('locked');
      if (el.dataset.choice === q.odpowiedź) el.classList.add('correct');
      if (el.dataset.choice === choice && !isCorrect) el.classList.add('incorrect');
      if (el.dataset.choice === choice) el.classList.add('selected');
    });
  }

  function handleABCD(choice) {
    var q = state.questions[state.current];
    if (state.answers[q.id]) return;
    var isCorrect = choice === q.odpowiedź;
    applyABCDClasses(q, choice, isCorrect);
    state.answers[q.id] = { given: choice, correct: isCorrect, timestamp: Date.now() };
    document.getElementById('nextBtn').disabled = false;
    document.getElementById('nextBtn').removeAttribute('aria-disabled');
    saveProgress();
  }

  function restoreABCD(q, prev) {
    applyABCDClasses(q, prev.given, prev.correct);
    document.getElementById('nextBtn').disabled = false;
    document.getElementById('nextBtn').removeAttribute('aria-disabled');
  }

  // ─────────────────────────────────────────────────────────────────────
  // T/F: tabela Prawda/Fałsz, kółka, Sprawdź, restore
  // ─────────────────────────────────────────────────────────────────────

  function renderTFHtml(q) {
    var html = '<table class="tf-table" aria-label="Zdania do oceny prawda lub fałsz"><thead><tr>';
    html += '<th scope="col">Zdanie</th>';
    html += '<th class="tf-col" scope="col">P</th><th class="tf-col" scope="col">F</th>';
    html += '</tr></thead><tbody>';
    q.zdania.forEach(function (z, i) {
      html += '<tr data-row="' + i + '">';
      html += '<td>' + escapeHtml(z.t) + '</td>';
      html += '<td class="tf-cell" data-tf-row="' + i + '" data-tf-val="true"><div class="tf-circle"></div></td>';
      html += '<td class="tf-cell" data-tf-row="' + i + '" data-tf-val="false"><div class="tf-circle"></div></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function handleTFSelect(row, val) {
    var q = state.questions[state.current];
    if (state.answers[q.id]) return;
    tfSelections[parseInt(row, 10)] = (val === 'true');
    app.querySelectorAll('[data-tf-row="' + row + '"]').forEach(function (cell) {
      cell.classList.remove('chosen');
      if (cell.dataset.tfVal === val) cell.classList.add('chosen');
    });
    var allSelected = q.zdania.every(function (_, i) { return tfSelections[i] !== undefined; });
    var checkBtn = document.getElementById('checkBtn');
    if (checkBtn) checkBtn.disabled = !allSelected;
    if (checkBtn) checkBtn.setAttribute('aria-disabled', !allSelected ? 'true' : 'false');
  }

  function markTFRow(i, isRight, chosen) {
    var row = app.querySelector('tr[data-row="' + i + '"]');
    if (row) row.classList.add(isRight ? 'row-correct' : 'row-incorrect');
    var chosenVal = chosen !== undefined ? (chosen ? 'true' : 'false') : null;
    app.querySelectorAll('[data-tf-row="' + i + '"]').forEach(function (cell) {
      cell.classList.add('locked');
      if (chosenVal && cell.dataset.tfVal === chosenVal) cell.classList.add('chosen');
    });
  }

  function finishTF() {
    var checkBtn = document.getElementById('checkBtn');
    if (checkBtn) { checkBtn.disabled = true; checkBtn.setAttribute('aria-disabled', 'true'); }
    document.getElementById('nextBtn').disabled = false;
    document.getElementById('nextBtn').removeAttribute('aria-disabled');
  }

  // handleTFCheck: sprawdza wszystkie zdania T/F, zapisuje wynik, blokuje
  function handleTFCheck() {
    var q = state.questions[state.current];
    if (state.answers[q.id]) return;
    var allCorrect = true;
    q.zdania.forEach(function (z, i) {
      var given = tfSelections[i];
      var isRight = given === z.o;
      if (!isRight) allCorrect = false;
      markTFRow(i, isRight);
    });
    var tfCopy = {}, tfK;
    for (tfK in tfSelections) { if (tfSelections.hasOwnProperty(tfK)) tfCopy[tfK] = tfSelections[tfK]; }
    state.answers[q.id] = { given: tfCopy, correct: allCorrect, timestamp: Date.now() };
    finishTF();
    saveProgress();
  }

  function restoreTF(q, prev) {
    q.zdania.forEach(function (z, i) {
      var given = prev.given[i];
      markTFRow(i, given === z.o, given);
    });
    finishTF();
  }

  // ─────────────────────────────────────────────────────────────────────
  // SUMMARY: wynik, siatka kafelków, kliknięcie kafelka = review pytania
  // ─────────────────────────────────────────────────────────────────────

  function showSummary() {
    var total = state.questions.length;
    var correct = state.questions.filter(function (q) { return state.answers[q.id] && state.answers[q.id].correct; }).length;
    var html =
      '<div class="sheet"><div class="summary">' +
      '<h2>Podsumowanie</h2>' +
      '<p class="summary-stats">' + correct + ' / ' + total + ' poprawnych odpowiedzi</p>' +
      '<div class="summary-grid">' +
      state.questions.map(function (q, i) {
        var cls = state.answers[q.id] && state.answers[q.id].correct ? 'tile-correct' : 'tile-incorrect';
        return '<div class="summary-tile ' + cls + '" data-review="' + i + '">' + (i + 1) + '</div>';
      }).join('') +
      '</div><button class="btn-restart">Zacznij od nowa</button>' +
      '</div></div>';
    swapContent(function () { app.innerHTML = html; });
  }

  // ─────────────────────────────────────────────────────────────────────
  // NAVIGATION: nextQuestion: current++, saveProgress, renderQuestion
  // ─────────────────────────────────────────────────────────────────────

  function nextQuestion() {
    state.current++;
    saveProgress();
    renderQuestion();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EVENTS: jeden delegowany listener na #app obsługuje cały quiz
  //
  // e.target.closest('[data-...]') łapie: wariant ABCD, kółko T/F,
  // Sprawdź, Następne, kafelek summary, restart, powrót, motyw.
  // Zero osobnych listenerów na elementach.
  // ═══════════════════════════════════════════════════════════════════════

  app.addEventListener('click', function (e) {
    var siteLink = e.target.closest('a[href="../"]');
    if (siteLink) {
      e.preventDefault();
      document.body.classList.add('pg-out');
      setTimeout(function () { window.location.href = '../'; }, NAV_OUT_MS);
      return;
    }

    var variant = e.target.closest('.variant:not(.locked)');
    if (variant && variant.dataset.choice) { handleABCD(variant.dataset.choice); return; }

    var tfCell = e.target.closest('.tf-cell:not(.locked)');
    if (tfCell && tfCell.dataset.tfRow !== undefined) { handleTFSelect(tfCell.dataset.tfRow, tfCell.dataset.tfVal); return; }

    var checkBtn = e.target.closest('#checkBtn');
    if (checkBtn && !checkBtn.disabled) { handleTFCheck(); return; }

    var nextBtn = e.target.closest('#nextBtn');
    if (nextBtn && !nextBtn.disabled) { nextQuestion(); return; }

    var tile = e.target.closest('.summary-tile');
    if (tile && tile.dataset.review !== undefined) { state.current = parseInt(tile.dataset.review, 10); renderQuestion(); return; }

    if (e.target.closest('.btn-restart')) {
      clearProgress();
      state.current = 0;
      state.answers = {};
      state.questions = shuffle(state.questions);
      saveProgress();
      renderQuestion();
    }

    var footJasny = e.target.closest('.foot-jasny');
    var footCiemny = e.target.closest('.foot-ciemny');
    if (footJasny || footCiemny) { setTheme(!!footCiemny); }
  });


  // ─────────────────────────────────────────────────────────────────────
  // THEME: dark/light toggle, persyst w localStorage, IIFE przy starcie
  // ─────────────────────────────────────────────────────────────────────

  function setTheme(isDark) {
    document.body.classList.toggle('dark', isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = isDark ? '🌙' : '☀️';
      btn.setAttribute('aria-label', isDark ? 'Włącz tryb jasny' : 'Włącz tryb ciemny');
    }
  }

  (function applyTheme() {
    if (localStorage.getItem('theme') === 'dark') setTheme(true);
  })();

  var toggle = document.getElementById('themeToggle');
  if (toggle) toggle.addEventListener('click', function () {
    setTheme(!document.body.classList.contains('dark'));
  });

  // ─────────────────────────────────────────────────────────────────────
  // START
  // ─────────────────────────────────────────────────────────────────────
  init();
})();
