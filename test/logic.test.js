import test from 'node:test';
import assert from 'node:assert/strict';
import { available, chooseQuestions, gradeSession, sessionGroups, summarize } from '../src/logic.js';

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
