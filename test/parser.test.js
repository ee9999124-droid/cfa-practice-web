import test from 'node:test';
import assert from 'node:assert/strict';
import { isInterfaceSummary, parseBlocks, parseQuestion, reconcileBank } from '../src/parser.js';
const p = text => ({ type: 'p', text, images: [] });
const question = (number, stem, selected = 'B. No') => [
  p(`${number} Multiple Choice`), p(stem), p('A. Yes'), p('B. No'),
  p('Your answer:'), p(selected), p('Correct answer:'), p('A. Yes'), p('Feedback'), p('Explanation')
];

test('review score and timing UI is recognized narrowly', () => {
  ['Quiz review', 'Review', 'You scored 72 percent, 48 out of 67 points', '72%', '48 out of 67 points', 'Out of 67 points', 'Average time per question: 34 seconds', 'Avg Time Per Question', '0:34'].forEach(text => assert.equal(isInterfaceSummary(text), true, text));
  ['A return of 72% is expected.', 'What is 48 out of 67?', 'The bond has 34 seconds remaining.'].forEach(text => assert.equal(isInterfaceSummary(text), false, text));
});

test('mixed Word blocks exclude UI and non-multiple-choice questions', () => {
  const bank = parseBlocks([
    p('Quiz review'), p('You scored 72 percent, 48 out of 67 points'),
    p('CFA-Level II: Ethics'), p('Module 1: Conduct'), p('Vignette'), p('Lee advises two clients.'),
    ...question(1, 'Is the conduct appropriate?'), ...question(2, 'Was disclosure required?', 'A. Yes'),
    p('3 Fill in the Blank'), p('Enter a policy name'), p('Module 2: Independent practice'), ...question(4, 'What is the best answer?')
  ], 'mixed.docx');
  assert.equal(bank.vignettes.length, 2);
  assert.equal(bank.vignettes[0].form, 'vignette');
  assert.equal(bank.vignettes[0].questions.length, 2);
  assert.equal(bank.vignettes[1].form, 'standalone');
  assert.equal(bank.excluded.length, 1);
  assert.match(bank.excluded[0].reason, /非單選題/);
  assert.equal(bank.vignettes.some(group => group.context.some(block => /scored|review/i.test(block.text))), false);
});

test('original and correct answers are parsed without mixing markers into stem', () => {
  const parsed = parseQuestion(question(1, 'Question text?', 'B. No'), 'Ethics', 'Module', 'case');
  assert.equal(parsed.importResult.selectedKey, 'B');
  assert.equal(parsed.correctKey, 'A');
  assert.equal(parsed.importResult.correct, false);
  assert.deepEqual(parsed.stem, ['Question text?']);
});

test('duplicate options deduplicate exact copies and flag conflicting labels', () => {
  const exact = parseQuestion([p('1 Multiple Choice'), p('Stem'), p('A. One'), p('B. Two'), p('C. Three'), p('C. Three'), p('Correct answer:'), p('C. Three')], 'T', 'M', '');
  assert.deepEqual(exact.options.map(option => option.key), ['A', 'B', 'C']);
  assert.equal(exact.correctKey, 'C');
  const conflict = parseQuestion([p('1 Multiple Choice'), p('Stem'), p('A. One'), p('B. Two'), p('C. Three'), p('C. Different'), p('Correct answer:'), p('C. Three')], 'T', 'M', '');
  assert.deepEqual(conflict.options.map(option => option.key), ['A', 'B', 'C']);
  assert.equal(conflict.optionConflicts.length, 1);
  assert.equal(conflict.importResult.needsConfirmation, true);
});

test('underscore in a multiple-choice stem is not treated as fill-in', () => {
  const bank = parseBlocks(question(1, 'Net income ______ when rates rise.'));
  assert.equal(bank.vignettes[0].questions.length, 1);
  assert.equal(bank.excluded.length, 0);
});

test('ambiguous unmarked context remains unconfirmed', () => {
  const bank = parseBlocks([p('Introductory shared-looking text'), ...question(1, 'Question?')]);
  assert.equal(bank.vignettes[0].form, 'unknown');
  assert.match(bank.vignettes[0].warnings[0], /待確認/);
});

test('reparse preserves matched IDs and reports additions, fixes, exclusions and unmatched', () => {
  const old = parseBlocks([...question(1, 'Same stem?'), ...question(2, 'Removed stem?')]);
  old.vignettes[0].questions[0].options.push({ key: 'C', text: 'C. Duplicate bug' });
  const updated = parseBlocks([...question(1, 'Same stem?'), ...question(3, 'Added stem?'), p('4 Text Entry'), p('type here')]);
  const oldId = old.vignettes[0].questions[0].id;
  const result = reconcileBank(old, updated);
  assert.equal(result.vignettes[0].questions[0].id, oldId);
  assert.deepEqual(result.updateReport, { added: 1, fixed: 1, excluded: 1, unmatched: 1 });
});
