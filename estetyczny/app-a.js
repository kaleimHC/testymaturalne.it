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
  var tfSelections = {};

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
    if (q.generated === true || q.rok === null) {
      return 'Zadanie ' + zNum;
    }
    var isPP = q.poziom === 'pp';
    var lbl = isPP ? 'poziom podstawowy' : 'poziom rozszerzony';
    var lbl2 = isPP ? 'p.p.' : 'p.r.';
    return 'Zadanie ' + zNum + ' - <span class="lbl-long">' + lbl + '</span>' +
      '<span class="lbl-short">' + lbl2 + '</span> - ' + q.sesja + ' ' + q.rok + ' r.';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER: centrum quizu, tu wszystko się schodzi
  //
  // renderQuestion: state.current -> HTML -> swapContent -> KaTeX -> restore.
  // ABCD i T/F mają osobne renderery. showSummary jeśli pytań brak.
  // ═══════════════════════════════════════════════════════════════════════

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
    html += '<span class="top-time">' + _timeText + '</span>';
    html += '</div>';

    html += '<div class="task-label"><span>' + questionLabel(q) + '</span></div>';

    html += '<div class="question-body">' + renderText(q.tresc) + '</div>';

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

  function nextQuestion() {
    state.current++;
    saveProgress();
    renderQuestion();
  }

  // ─────────────────────────────────────────────────────────────────────
  // INIT FLOW: fetch JSON, filtr pytań, resume albo nowy start
  // ─────────────────────────────────────────────────────────────────────

  // ===== Ekran startowy (kreator zestawu) - wklejony w wariant =====
  var NAZWY = {
    'systemy-liczbowe': 'Systemy liczbowe',
    'algorytmika': 'Algorytmy i złożoność',
    'sieci-internet': 'Sieci i internet',
    'bazy-danych-sql': 'Bazy danych i SQL',
    'grafika-multimedia': 'Grafika i multimedia',
    'programowanie-sprzet-os': 'Programowanie i sprzęt',
    'reprezentacja-danych': 'Reprezentacja danych',
    'bezpieczenstwo-szyfrowanie': 'Bezpieczeństwo i szyfrowanie',
    'arkusz-kalkulacyjny': 'Arkusz kalkulacyjny',
    'prawo-licencje': 'Prawo i licencje'
  };
  var ORDER = ['systemy-liczbowe','algorytmika','sieci-internet','bazy-danych-sql','grafika-multimedia','programowanie-sprzet-os','reprezentacja-danych','bezpieczenstwo-szyfrowanie','arkusz-kalkulacyjny','prawo-licencje'];
  // 3 segmenty wg pola formula (autorytatywne); flex = proporcja wizualna jak we wzorcu
  var FORMULY = [
    { id: 'stara', label: 'Stara formuła', flex: 5 },
    { id: '2015',  label: 'Formuła 2015',  flex: 8 },
    { id: '2023',  label: 'Formuła 2023',  flex: 3 }
  ];
  var PRESETY = [10, 20, 50, 100];
  var CZASY = [0, 15, 30, 60];

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function kreatorShow(app, questions, onStart) {
    // liczniki dynamiczne (NIE hardkodowane)
    var dzC = {}, fC = {}, fY = {}, yMin = 9999, yMax = 0;
    questions.forEach(function (q) {
      if (q.dzial) dzC[q.dzial] = (dzC[q.dzial] || 0) + 1;
      if (q.formula) { fC[q.formula] = (fC[q.formula] || 0) + 1;
        if (!fY[q.formula]) fY[q.formula] = [q.rok, q.rok];
        else { if (q.rok < fY[q.formula][0]) fY[q.formula][0] = q.rok; if (q.rok > fY[q.formula][1]) fY[q.formula][1] = q.rok; } }
      if (typeof q.rok === 'number') { if (q.rok < yMin) yMin = q.rok; if (q.rok > yMax) yMax = q.rok; }
    });
    var dzialy = ORDER.filter(function (id) { return dzC[id]; })
      .map(function (id) { return { id: id, nazwa: NAZWY[id] || id, n: dzC[id] }; })
      .sort(function (a, b) { return b.n - a.n || ORDER.indexOf(a.id) - ORDER.indexOf(b.id); });
    var formuly = FORMULY.filter(function (f) { return fC[f.id]; }).map(function (f) { return { id: f.id, label: f.label, n: fC[f.id], lat: fY[f.id], flex: f.flex }; });

    var cfg = {
      dzialy: new Set(dzialy.map(function (d) { return d.id; })),
      formuly: new Set(formuly.map(function (f) { return f.id; })),
      liczba: 20, czas: null
    };

    function pool() { return questions.filter(function (q) { return cfg.dzialy.has(q.dzial) && cfg.formuly.has(q.formula); }); }

    function tplChips() {
      return dzialy.map(function (d) {
        var on = cfg.dzialy.has(d.id);
        return '<button type="button" class="dzial-chip' + (on ? ' is-selected' : '') + '" role="checkbox" aria-checked="' + on + '" data-dz="' + d.id + '">' +
          '<span class="dz-ck" aria-hidden="true">' + (on ? '✓' : '') + '</span>' +
          '<span class="dz-name">' + esc(d.nazwa) + '</span><span class="dz-n">' + d.n + '</span></button>';
      }).join('');
    }
    function tplFormuly() {
      return formuly.map(function (f) {
        var on = cfg.formuly.has(f.id);
        return '<button type="button" class="formula-seg' + (on ? ' is-selected' : '') + '" role="checkbox" aria-checked="' + on + '" data-fm="' + f.id + '" style="flex:' + f.flex + '">' +
          '<span class="fm-label">' + esc(f.label) + '</span><span class="fm-years">' + f.lat[0] + '-' + f.lat[1] + '</span></button>';
      }).join('');
    }
    function tplLiczba() {
      return PRESETY.map(function (v) {
        var on = cfg.liczba === v;
        return '<button type="button" class="preset-pill' + (on ? ' is-selected' : '') + '" role="radio" aria-checked="' + on + '" data-lb="' + v + '">' + v + '</button>';
      }).join('') +
        '<button type="button" class="preset-pill' + (cfg.liczba === 'all' ? ' is-selected' : '') + '" role="radio" aria-checked="' + (cfg.liczba === 'all') + '" data-lb="all">Wszystkie</button>';
    }
    function tplCzas() {
      return CZASY.map(function (v) {
        var on = (cfg.czas || 0) === v;
        var label = v === 0 ? 'Bez limitu' : (v + ' min');
        return '<button type="button" class="preset-pill' + (on ? ' is-selected' : '') + '" role="radio" aria-checked="' + on + '" data-cz="' + v + '">' + label + '</button>';
      }).join('');
    }
    function scale() {
      var marks = [yMin, 2015, 2023, yMax].filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      return marks.map(function (y) { return '<span>' + y + '</span>'; }).join('');
    }

    app.innerHTML =
      '<div class="sheet kreator">' +
        '<div class="top-bar">' +
          '<a class="top-info site-link" href="../"><span class="lbl-long">testymaturalne.it</span><span class="lbl-short">&lt;- WYBÓR</span></a>' +
          '<span class="top-prog" data-prog></span>' +
          '<span class="top-time">Czas: --:--</span>' +
        '</div>' +
        '<h1 class="kreator-h1">Ułóż swój zestaw</h1>' +
        '<div class="sect-label">Działy</div>' +
        '<div class="dzial-grid" role="group" aria-label="Działy">' + tplChips() + '</div>' +
        '<div class="sect-label">Roczniki - wg formuły matury</div>' +
        '<div class="formula-bar" role="group" aria-label="Roczniki wg formuły">' + tplFormuly() + '</div>' +
        '<div class="formula-scale">' + scale() + '</div>' +
        '<div class="config-row"><span class="sect-label">Liczba</span><div class="preset-row" data-liczba role="radiogroup" aria-label="Liczba pytań">' + tplLiczba() + '</div></div>' +
        '<div class="config-row"><span class="sect-label">Na czas</span><div class="preset-row" data-czas role="radiogroup" aria-label="Na czas">' + tplCzas() + '</div></div>' +
        '<div class="kreator-foot">' +
          '<span class="preview-line" data-preview aria-live="polite"></span>' +
          '<button type="button" class="kreator-cta" data-start>Rozpocznij →</button>' +
        '</div>' +
      '</div>';

    function update() {
      var M = pool().length;
      var prog = app.querySelector('[data-prog]'); if (prog) prog.textContent = M + ' pytań';
      app.querySelectorAll('.dzial-chip').forEach(function (chip) {
        var id = chip.getAttribute('data-dz'), n = 0;
        questions.forEach(function (q) { if (q.dzial === id && cfg.formuly.has(q.formula)) n++; });
        var el = chip.querySelector('.dz-n'); if (el) el.textContent = n;
      });
      // auto-korekta presetu liczby, jeśli nie mieści się w puli
      if (cfg.liczba !== 'all' && cfg.liczba > M) {
        var fit = PRESETY.filter(function (v) { return v <= M; });
        cfg.liczba = fit.length ? fit[fit.length - 1] : 'all';
      }
      app.querySelectorAll('[data-lb]').forEach(function (b) {
        var raw = b.getAttribute('data-lb'); var num = raw === 'all' ? 'all' : parseInt(raw, 10);
        var dis = num !== 'all' && num > M;
        if (dis) b.setAttribute('disabled', 'disabled'); else b.removeAttribute('disabled');
        b.classList.toggle('is-disabled', dis);
        var on = cfg.liczba === num;
        b.classList.toggle('is-selected', on); b.setAttribute('aria-checked', on);
      });
      var pv = app.querySelector('[data-preview]'); var cta = app.querySelector('[data-start]');
      if (M === 0) {
        pv.textContent = 'Wybierz co najmniej jeden dział.'; pv.classList.add('is-empty');
        if (cta) cta.setAttribute('disabled', 'disabled');
      } else {
        pv.classList.remove('is-empty');
        var N = cfg.liczba === 'all' ? M : Math.min(cfg.liczba, M);
        var s = 'Wylosujemy <b>' + N + '</b> z <b>' + M + '</b> pytań';
        if (cfg.czas) s += ', na czas <b>' + cfg.czas + ' min</b>';
        pv.innerHTML = s + '.';
        if (cta) cta.removeAttribute('disabled');
      }
    }

    function setOne(group, attr, val, value) {
      group.querySelectorAll('[' + attr + ']').forEach(function (b) {
        var on = b.getAttribute(attr) === val;
        b.classList.toggle('is-selected', on); b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on);
      });
    }

    function onClick(e) {
      var dz = e.target.closest('.dzial-chip'); if (dz) {
        var id = dz.getAttribute('data-dz');
        if (cfg.dzialy.has(id)) cfg.dzialy['delete'](id); else cfg.dzialy.add(id);
        var on = cfg.dzialy.has(id);
        dz.classList.toggle('is-selected', on); dz.setAttribute('aria-checked', on);
        dz.querySelector('.dz-ck').textContent = on ? '✓' : '';
        update(); return;
      }
      var fm = e.target.closest('.formula-seg'); if (fm) {
        var fid = fm.getAttribute('data-fm');
        if (cfg.formuly.has(fid)) cfg.formuly['delete'](fid); else cfg.formuly.add(fid);
        var fon = cfg.formuly.has(fid);
        fm.classList.toggle('is-selected', fon); fm.setAttribute('aria-checked', fon);
        update(); return;
      }
      var lb = e.target.closest('[data-lb]'); if (lb) {
        if (lb.hasAttribute('disabled')) return;
        var raw = lb.getAttribute('data-lb'); cfg.liczba = raw === 'all' ? 'all' : parseInt(raw, 10);
        update(); return;
      }
      var cz = e.target.closest('[data-cz]'); if (cz) {
        var cv = parseInt(cz.getAttribute('data-cz'), 10); cfg.czas = cv === 0 ? null : cv;
        setOne(cz.parentNode, 'data-cz', cz.getAttribute('data-cz')); update(); return;
      }
      var st = e.target.closest('[data-start]'); if (st) {
        if (st.hasAttribute('disabled')) return;
        app.removeEventListener('click', onClick); app.removeEventListener('keydown', onKey);
        onStart(pool(), cfg); return;
      }
    }

    // klawiatura: strzałki w grupach radio (liczba/czas)
    function onKey(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      var grp = e.target.closest('[role="radiogroup"]'); if (!grp) return;
      var items = Array.prototype.filter.call(grp.querySelectorAll('[role="radio"]'), function (b) { return !b.hasAttribute('disabled'); });
      var i = items.indexOf(e.target); if (i < 0) return;
      e.preventDefault();
      var next = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? (i - 1 + items.length) % items.length : (i + 1) % items.length;
      items[next].focus(); items[next].click();
    }

    app.addEventListener('click', onClick);
    app.addEventListener('keydown', onKey);
    update();
  }

  // ── Timer (hook istniejącego .top-time) ──
  var _timer = null, _timeText = 'Czas: --:--';
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function kreatorStartTimer(minutes, onExpire) {
    kreatorStopTimer();
    var endsAt = Date.now() + minutes * 60000;
    var announced = false;
    function tick() {
      var el = document.querySelector('.top-time');
      if (!el) { kreatorStopTimer(); return; }                 // opuszczono ekran pytań
      var rem = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      _timeText = 'Czas: ' + pad(Math.floor(rem / 60)) + ':' + pad(rem % 60); el.textContent = _timeText;
      el.classList.toggle('time-low', rem <= 60);
      if (rem <= 60 && !announced) { announced = true; el.setAttribute('aria-live', 'polite'); }
      if (rem <= 0) { kreatorStopTimer(); if (onExpire) onExpire(); }
    }
    tick(); setTimeout(tick, 150); _timer = setInterval(tick, 1000);  // 150ms: domknij okno po swapContent pytania
  }
  function kreatorStopTimer() { if (_timer) { clearInterval(_timer); _timer = null; } _timeText = 'Czas: --:--'; }

  function startQuiz(pool, config) {
    kreatorStopTimer();
    var N = config.liczba === 'all' ? pool.length : Math.min(config.liczba, pool.length);
    state.questions = shuffle(pool.slice()).slice(0, N);
    state.current = 0;
    state.answers = {};
    renderQuestion();
    if (config.czas) kreatorStartTimer(config.czas, showSummary);
  }

  function init() {
    fetch('../questions.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (all) {
        var filtered = all.filter(function (q) {
          return q.typ === 'abcd' || q.typ === 'tf';
        });
        if (filtered.length === 0) {
          app.innerHTML = '<p style="padding:20px">Brak dostępnych pytań.</p>';
          return;
        }
        var saved = loadProgress();
        if (saved && saved.questionOrder && Object.keys(saved.answers).length > 0) {
          showResumeDialog(filtered, saved);
        } else {
          kreatorShow(app, filtered, startQuiz);
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
        kreatorShow(app, filtered, startQuiz);
        return;
      }
      renderQuestion();
    });
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

  // ═══════════════════════════════════════════════════════════════════════
  // EVENTS: jeden delegowany listener na #app obsługuje cały quiz
  //
  // e.target.closest('[data-...]') łapie: wariant ABCD, kółko T/F,
  // Sprawdź, Następne. Zero osobnych listenerów na elementach.
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
  // ABCD: render wariantów, kliknięcie, feedback correct/incorrect, restore
  // ─────────────────────────────────────────────────────────────────────

  function renderABCDHtml(q) {
    var html = '<div class="variants">';
    ['A', 'B', 'C', 'D'].forEach(function (letter) {
      if (!q.odpowiedzi[letter]) return;
      html += '<div class="variant" data-choice="' + letter + '">';
      html += '<span class="variant-key">' + letter + '.</span>';
      html += '<span class="variant-text">' + escapeHtml(q.odpowiedzi[letter]) + '</span>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function applyABCDClasses(q, choice, isCorrect) {
    app.querySelectorAll('.variant').forEach(function (el) {
      el.classList.add('locked');
      if (el.dataset.choice === q.poprawna) el.classList.add('correct');
      if (el.dataset.choice === choice && !isCorrect) el.classList.add('incorrect');
      if (el.dataset.choice === choice) el.classList.add('selected');
    });
  }

  function handleABCD(choice) {
    var q = state.questions[state.current];
    if (state.answers[q.id]) return;
    var isCorrect = choice === q.poprawna;
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
}());
