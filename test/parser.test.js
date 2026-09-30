import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks } from '../src/parser.js';
const p = text => ({ type: 'p', text, images: [] });
const table = rows => ({ type: 'table', rows });
const question = (number, stem) => [
  p(`${number} Multiple Choice`), p(stem), p('A. Yes'), p('B. No'),
  p('Your answer:'), p('B. No'), p('Correct answer:'), p('A. Yes'),
  p('Feedback'), p('The official explanation is preserved.')
];

test('distinguishes explicit shared context from a standalone question', () => {
  const bank = parseBlocks([
    p('CFA-Level II: Ethics'), p('Module 1: Conduct'), p('Vignette'), p('Lee advises two clients.'), table([['Year', 'Return']]),
    ...question(1, 'Is the conduct appropriate?'), ...question(2, 'Was disclosure required?'),
    p('Module 2: Independent practice'), ...question(3, 'What is the best answer?')
  ], 'mixed.docx');
  assert.equal(bank.vignettes.length, 2);
  assert.equal(bank.vignettes[0].form, 'vignette');
  assert.equal(bank.vignettes[0].questions.length, 2);
  assert.deepEqual(bank.vignettes[0].context[1].rows, [['Year', 'Return']]);
  assert.equal(bank.vignettes[1].form, 'standalone');
  assert.equal(bank.vignettes[1].questions.length, 1);
});

test('excludes summaries and non-multiple-choice questions without treating percentages as summaries', () => {
  const bank = parseBlocks([
    p('Quiz review'), p('You scored 75%'), p('1 Numeric Entry'), p('Enter the return.'),
    p('2 Multiple Choice'), p('The return was 12%. Which statement is correct?'), p('A. First'), p('B. Second'), p('Correct answer:'), p('B. Second')
  ]);
  assert.equal(bank.vignettes[0].questions.length, 1);
  assert.match(bank.vignettes[0].questions[0].stem[0], /12%/);
  assert.equal(bank.exclusions.length, 3);
  assert.ok(bank.exclusions.some(item => /非單選題/.test(item.reason)));
});

test('keeps imported response separate and preserves official feedback', () => {
  const bank = parseBlocks(question(1, 'Question?'));
  const parsed = bank.vignettes[0].questions[0];
  assert.equal(parsed.correctKey, 'A');
  assert.equal(parsed.originalAnswerKey, 'B');
  assert.equal(parsed.explanation[0], 'The official explanation is preserved.');
  assert.deepEqual(bank.importResponses, [{ questionId: parsed.id, selected: 'B', raw: 'B. No' }]);
});

test('deduplicates identical labels but quarantines conflicting duplicate labels', () => {
  const same = parseBlocks([p('1 Multiple Choice'), p('Question?'), p('A. One'), p('A. One'), p('B. Two'), p('Correct answer:'), p('A. One')]).vignettes[0].questions[0];
  assert.deepEqual(same.options.map(option => option.key), ['A', 'B']);
  assert.equal(same.ready, true);
  const conflict = parseBlocks([p('1 Multiple Choice'), p('Question?'), p('A. One'), p('A. Different'), p('B. Two'), p('Correct answer:'), p('A. One')]).vignettes[0].questions[0];
  assert.deepEqual(conflict.options.map(option => option.key), ['A', 'B']);
  assert.equal(conflict.ready, false);
  assert.match(conflict.warnings[0], /不同內容/);
});

test('ambiguous unmarked context remains unconfirmed', () => {
  const bank = parseBlocks([p('Introductory shared-looking text'), ...question(1, 'Question?')]);
  assert.equal(bank.vignettes[0].form, 'unknown');
  assert.match(bank.vignettes[0].warnings[0], /待確認/);
});

test('official review markers before options preserve all labels and original wrong answer', () => {
  const q = parseBlocks([p('1 Multiple Choice'), p('Which accounting method?'),
    p('Incorrect answer:'), p('A. FIFO and temporal'), p('Correct Answer:'), p('B. FIFO and current'),
    p('B. FIFO and current'), p('Not Selected'), p('C. Average and temporal'), p('Not Selected'),
    p('Feedback'), p('B is correct. Official explanation.')]).vignettes[0].questions[0];
  assert.deepEqual(q.options.map(o => o.key), ['A', 'B', 'C']);
  assert.equal(q.ready, true);
  assert.equal(q.originalAnswerKey, 'A');
  assert.equal(q.correctKey, 'B');
  assert.deepEqual(q.stem, ['Which accounting method?']);
});

test('summary score fragments disappear but bare percentages in a question survive', () => {
  const bank = parseBlocks([p('Quiz review'), p('You scored 72 percent, 48 out of 67 points'),
    p('Review'), p('72%'), p('48 out of 67 points'), p('Out of 67 points'), p('48'),
    p('Average time per question: 34 seconds'), p('Avg Time Per Question'), p('0:34'),
    p('1 Multiple Choice'), p('Review the portfolio return:'), p('72%'), p('A. Yes'), p('B. No'), p('Correct answer: A. Yes')]);
  assert.equal(bank.vignettes[0].form, 'standalone');
  assert.deepEqual(bank.vignettes[0].questions[0].stem, ['Review the portfolio return:', '72%']);
  assert.equal(bank.exclusions.length, 10);
});

test('answer metadata does not borrow a later feedback paragraph or option', () => {
  const q = parseBlocks([p('1 Multiple Choice'), p('Question?'), p('A. One'), p('B. Two'),
    p('Incorrect answer:'), p('Not Selected'), p('Correct answer: B. Two'), p('Feedback'), p('A statement in explanation.')]).vignettes[0].questions[0];
  assert.equal(q.originalAnswerKey, '');
});

test('CI map classifies every original number, preserves the owning contexts, and does not leak context to standalone questions', () => {
  const groupStarts = { 1: [5, 28, 30, 36, 40], 2: [1, 7, 11, 15, 19], 3: [1], 4: [1, 6] };
  const maxima = { 1: 69, 2: 28, 3: 27, 4: 31 };
  const blocks = [p('CFA-Level I: Corporate Issuers')];
  for (const module of [1, 2, 3, 4]) {
    blocks.push(p(`Module ${module}: CI module ${module}`));
    for (let number = 1; number <= maxima[module]; number++) {
      if (groupStarts[module].includes(number)) {
        blocks.push(p('Vignette'), p(module === 2 && number === 1 ? 'Titian situation' : `M${module} Q${number} situation`));
        blocks.push(table([[`M${module}-${number}`, 'context table']]));
        blocks.push({ type: 'p', text: '', images: [`context-${module}-${number}.png`] });
      }
      blocks.push(...question(number, `M${module} original question ${number}?`));
    }
  }
  const bank = parseBlocks(blocks, 'CI.docx');
  const vignetteGroups = bank.vignettes.filter(group => group.form === 'vignette');
  const standaloneGroups = bank.vignettes.filter(group => group.form === 'standalone');
  const numbers = group => group.questions.map(item => +item.header.match(/^\d+/)[0]);

  assert.equal(bank.classification.key, 'ci');
  assert.equal(vignetteGroups.length, 13);
  // The supplied ranges arithmetically contain 57 grouped and 96 standalone questions.
  assert.equal(vignetteGroups.reduce((sum, group) => sum + group.questions.length, 0), 57);
  assert.equal(standaloneGroups.length, 96);
  assert.equal(bank.vignettes.flatMap(group => group.questions).length, 153);
  assert.deepEqual(bank.exclusions.filter(item => /指定排除/.test(item.reason)).map(item => item.content), ['10 Multiple Choice', '4 Multiple Choice']);
  assert.deepEqual(vignetteGroups.map(numbers), [
    [5, 6, 7, 8, 9], [28, 29], [30, 31, 32, 33, 34, 35], [36, 37, 38, 39], [40, 41, 42, 43],
    [1, 2, 3, 5, 6], [7, 8, 9, 10], [11, 12, 13, 14], [15, 16, 17, 18], [19, 20, 21, 22],
    [1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [6, 7, 8, 9, 10]
  ]);
  const titian = vignetteGroups.find(group => group.module.startsWith('Module 2') && numbers(group).includes(5));
  assert.deepEqual(numbers(titian), [1, 2, 3, 5, 6]);
  assert.equal(titian.context.some(block => block.text === 'Titian situation'), true);
  assert.deepEqual(titian.context.find(block => block.type === 'table').rows, [['M2-1', 'context table']]);
  assert.deepEqual(titian.context.find(block => block.images?.length).images, ['context-2-1.png']);
  assert.equal(standaloneGroups.every(group => group.context.length === 0 && group.questions.length === 1), true);
  assert.equal(standaloneGroups.some(group => group.questions[0].header.startsWith('10 Multiple Choice') && group.module.startsWith('Module 1')), false);
  assert.equal(standaloneGroups.some(group => group.questions[0].header.startsWith('4 Multiple Choice') && group.module.startsWith('Module 2')), false);
});
