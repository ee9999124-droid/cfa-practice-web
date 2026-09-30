import test from 'node:test';
import assert from 'node:assert/strict';
import { available, chooseQuestions, detachBankSessions, gradeSession, sessionGroups, summarize } from '../src/logic.js';

const q = (id, correctKey = 'A') => ({ id, correctKey });
const groups = [
  { id: 'v1', form: 'vignette', topic: 'Ethics', module: 'Standards', context: [{ type: 'p', text: 'Shared case' }], questions: [q('v-q1'), q('v-q2', 'B')] },
  { id: 's1', form: 'standalone', topic: 'Ethics', module: 'Applications', context: [], questions: [q('s-q1')] },
  { id: 's2', form: 'standalone', topic: 'Quant', module: 'Rates', context: [], questions: [q('s-q2')] },
  { id: 'old', topic: 'Quant', module: 'Legacy', context: [], questions: [q('old-q')] }
];

test('scope and form filters exclude unconfirmed legacy groups', () => {
  assert.deepEqual(available(groups, new Set(['all']), 'vignette').map(g => g.id), ['v1']);
  assert.deepEqual(available(groups, new Set(['t:Ethics']), 'standalone').map(g => g.id), ['s1']);
  assert.deepEqual(available(groups, new Set(['all']), 'all').map(g => g.id), ['v1', 's1', 's2']);
});

test('mixed draw preserves complete vignette and precisely draws standalone questions', () => {
  const random = () => 0.5;
  const picked = chooseQuestions(groups.slice(0, 3), 'random', 3, [], random);
  const vignette = picked.find(unit => unit.group.id === 'v1');
  assert.equal(vignette.questions.length, 2);
  assert.equal(picked.reduce((n, unit) => n + unit.questions.length, 0), 3);
});

test('session, grading, submit metrics and topic/module statistics count questions', () => {
  const session = { id: 'run', units: [{ groupId: 'v1', questionIds: ['v-q1', 'v-q2'] }, { groupId: 's1', questionIds: ['s-q1'] }], responses: { 'v-q1': { selected: 'A' }, 'v-q2': { selected: 'A' }, 's-q1': { selected: 'A' } } };
  const selected = sessionGroups(session, groups);
  const graded = gradeSession(session, selected);
  assert.equal(graded.answers.length, 3);
  assert.equal(graded.answers.filter(answer => answer.correct).length, 2);
  const stats = summarize([graded], groups);
  const ethics = stats.find(topic => topic.name === 'Ethics');
  assert.equal(ethics.total, 3);
  assert.equal(ethics.practiced, 3);
  assert.equal(ethics.vignetteCount, 1);
  assert.equal(ethics.modules.find(module => module.name === 'Standards').total, 2);
});

test('legacy vignetteIds sessions remain resolvable', () => {
  assert.equal(sessionGroups({ vignetteIds: ['v1'] }, groups)[0].questions.length, 2);
});

test('Word import attempts can be included explicitly and unselected answers do not affect coverage', () => {
  const word = { source: 'word', submittedAt: '2026-01-01', answers: [{ questionId: 's-q1', selected: 'A', correct: true }, { questionId: 'v-q1', selected: '', correct: false }] };
  const withWord = summarize([word], groups, true).find(topic => topic.name === 'Ethics');
  const withoutWord = summarize([word], groups, false).find(topic => topic.name === 'Ethics');
  assert.equal(withWord.practiced, 1);
  assert.equal(withoutWord.practiced, 0);
});

test('removing one bank deletes its dedicated records and trims cross-bank sessions', () => {
  const bankA = { id: 'bank-a', vignettes: [groups[0]] };
  const remaining = [groups[2]];
  const sessions = [
    { id: 'only-a', units: [{ bankId: 'bank-a', groupId: 'v1', questionIds: ['v-q1', 'v-q2'] }], responses: { 'v-q1': { selected: 'A' } } },
    { id: 'mixed', submittedAt: '2026-01-01', units: [{ bankId: 'bank-a', groupId: 'v1', questionIds: ['v-q1', 'v-q2'] }, { bankId: 'bank-b', groupId: 's2', questionIds: ['s-q2'] }], responses: { 'v-q1': { selected: 'A' }, 's-q2': { selected: 'A' } }, answers: [{ questionId: 'v-q1', selected: 'A', correct: true }, { questionId: 'v-q2', selected: 'B', correct: true }, { questionId: 's-q2', selected: 'A', correct: true }] },
    { id: 'word_bank-a', source: 'word', bankId: 'bank-a', answers: [{ questionId: 'v-q1', selected: 'A' }] },
    { id: 'word_bank-b', source: 'word', bankId: 'bank-b', answers: [{ questionId: 's-q2', selected: 'A' }] }
  ];
  const changes = detachBankSessions(bankA, remaining, sessions);
  assert.deepEqual(changes.removeIds.sort(), ['only-a', 'word_bank-a']);
  const mixed = changes.updates.find(session => session.id === 'mixed');
  assert.deepEqual(mixed.units.map(unit => unit.bankId), ['bank-b']);
  assert.deepEqual(mixed.answers.map(answer => answer.questionId), ['s-q2']);
  assert.deepEqual(Object.keys(mixed.responses), ['s-q2']);
  assert.equal(changes.removeIds.includes('word_bank-b'), false);
  const stats = summarize([mixed], remaining);
  assert.equal(stats[0].practiced, 1);
});

test('removing then reimporting a bank does not retain or double-count its old attempts', () => {
  const bank = { id: 'bank-a', vignettes: [groups[0]] };
  const oldWebsite = { id: 'old-run', submittedAt: '2026-01-01', units: [{ bankId: 'bank-a', groupId: 'v1', questionIds: ['v-q1', 'v-q2'] }], answers: [{ questionId: 'v-q1', selected: 'A', correct: true }] };
  const oldWord = { id: 'word_bank-a', source: 'word', bankId: 'bank-a', submittedAt: '2026-01-01', answers: [{ questionId: 'v-q1', selected: 'A', correct: true }] };
  const changes = detachBankSessions(bank, [], [oldWebsite, oldWord]);
  assert.deepEqual(changes.removeIds.sort(), ['old-run', 'word_bank-a']);
  const newWord = { ...oldWord, submittedAt: '2026-02-01' };
  const topic = summarize([newWord], bank.vignettes, true)[0];
  assert.equal(topic.firstN, 1);
  assert.equal(topic.latestN, 1);
  assert.equal(topic.practiced, 1);
});
