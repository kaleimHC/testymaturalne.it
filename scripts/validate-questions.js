#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var file = path.join(__dirname, '..', 'data', 'questions.json');
var raw;

try {
  raw = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error('Cannot read ' + file);
  process.exit(1);
}

var questions;
try {
  questions = JSON.parse(raw);
} catch (e) {
  console.error('Invalid JSON: ' + e.message);
  process.exit(1);
}

var errors = [];

questions.forEach(function (q, i) {
  var loc = '#' + i + ' id=' + (q.id || '(missing)');

  if (!q.id) errors.push(loc + ': missing id');
  if (q.typ !== 'abcd' && q.typ !== 'tf') errors.push(loc + ': typ must be abcd or tf, got ' + q.typ);

  if (q.typ === 'abcd') {
    var keys = q.warianty ? Object.keys(q.warianty) : [];
    if (keys.length !== 4 || ['A','B','C','D'].some(function(k){ return keys.indexOf(k) === -1; })) {
      errors.push(loc + ': warianty must have exactly A,B,C,D');
    }
    if (['A','B','C','D'].indexOf(q['odpowiedź']) === -1) {
      errors.push(loc + ': odpowiedź must be A/B/C/D, got ' + q['odpowiedź']);
    }
  }

  if (q.typ === 'tf') {
    if (!Array.isArray(q.zdania) || q.zdania.length < 1) {
      errors.push(loc + ': zdania must be non-empty array');
    } else {
      q.zdania.forEach(function (s, j) {
        if (typeof s.t !== 'string') errors.push(loc + ' zdanie[' + j + ']: t must be string');
        if (typeof s.o !== 'boolean') errors.push(loc + ' zdanie[' + j + ']: o must be boolean');
      });
    }
  }
});

if (errors.length > 0) {
  errors.forEach(function (e) { console.error(e); });
  console.error('\n' + errors.length + ' error(s) found.');
  process.exit(1);
}

console.log('OK: ' + questions.length + ' questions validated.');
