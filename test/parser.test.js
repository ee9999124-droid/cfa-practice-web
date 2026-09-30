import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks } from '../src/parser.js';
const p = text => ({ type: 'p', text, images: [] });
const question = (number, stem) => [p(`${number} Multiple Choice`), p(stem), p('A. Yes'), p('B. No'), p('Correct answer:'), p('A. Yes')];

test('Word block parsing distinguishes explicit shared context from a standalone question', () => {
  const bank = parseBlocks([
    p('CFA-Level II: Ethics'), p('Module 1: Conduct'), p('Vignette'), p('Lee advises two clients.'),
    ...question(1, 'Is the conduct appropriate?'), ...question(2, 'Was disclosure required?'),
    p('Module 2: Independent practice'), ...question(3, 'What is the best answer?')
  ], 'mixed.docx');
  assert.equal(bank.vignettes.length, 2);
  assert.equal(bank.vignettes[0].form, 'vignette');
  assert.equal(bank.vignettes[0].questions.length, 2);
  assert.equal(bank.vignettes[1].form, 'standalone');
  assert.equal(bank.vignettes[1].questions.length, 1);
  assert.equal(bank.vignettes[1].context.length, 0);
});

test('ambiguous unmarked context remains unconfirmed', () => {
  const bank = parseBlocks([p('Introductory shared-looking text'), ...question(1, 'Question?')]);
  assert.equal(bank.vignettes[0].form, 'unknown');
  assert.match(bank.vignettes[0].warnings[0], /待確認/);
});
