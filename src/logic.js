export const formOf = group => ['vignette', 'standalone'].includes(group.form) ? group.form : 'unknown';

export function available(groups, selected, form = 'all') {
  const scoped = groups.filter(group => selected.has('all') || selected.has(`t:${group.topic}`) || selected.has(`m:${group.topic}|${group.module}`));
  const reliable = scoped.filter(g => g.questions?.length && g.questions.every(q => q.ready !== false && q.correctKey));
  return form === 'all' ? reliable.filter(group => formOf(group) !== 'unknown') : reliable.filter(group => formOf(group) === form);
}

const attemptsByQuestion = (sessions, includeWord = true) => {
  const result = new Map();
  sessions.filter(session => session.submittedAt && (includeWord || session.source !== 'word')).flatMap(session => (session.answers || []).map(answer => ({ ...answer, attemptedAt: session.submittedAt }))).filter(answer => answer.selected).forEach(answer => {
    if (!result.has(answer.questionId)) result.set(answer.questionId, []);
    result.get(answer.questionId).push(answer);
  });
  result.forEach(items => items.sort((a, b) => String(a.attemptedAt).localeCompare(String(b.attemptedAt))));
  return result;
};

/** Select atomic units: a vignette is always atomic; every standalone question is atomic. */
export function chooseQuestions(pool, mode, target, sessions, random = Math.random, countBy = 'questions') {
  const attempts = attemptsByQuestion(sessions);
  const units = pool.flatMap(group => formOf(group) === 'standalone'
    ? group.questions.map(question => ({ group, questions: [question] }))
    : [{ group, questions: group.questions }]);
  let candidates = units.filter(unit => mode !== 'wrong' || unit.questions.some(question => attempts.get(question.id)?.at(-1)?.correct === false));
  const unseen = unit => unit.questions.reduce((count, question) => count + (attempts.has(question.id) ? 0 : 1), 0);
  candidates = [...candidates].sort(mode === 'unseen' ? (a, b) => unseen(b) - unseen(a) : () => random() - .5);
  const chosen = [];
  let count = 0;
  for (const unit of candidates) {
    if (countBy === 'units') {
      if (chosen.length >= target) break;
      chosen.push(unit); count += unit.questions.length; continue;
    }
    if (formOf(unit.group) === 'vignette') {
      // Prefer the closest total, but never split a shared-context set.
      if (chosen.length && count >= target) break;
      if (chosen.length && Math.abs(target - count) < Math.abs(target - count - unit.questions.length)) continue;
    } else if (count >= target) break;
    chosen.push(unit);
    count += unit.questions.length;
  }
  return chosen;
}

export function sessionGroups(session, groups) {
  if (session.units) return session.units.map(unit => {
    const wanted = new Set(unit.questionIds || []);
    // Old standalone imports could share a group ID; question IDs are the authoritative fallback.
    const group = groups.find(item => item.id === unit.groupId && (!wanted.size || item.questions.some(question => wanted.has(question.id))))
      || groups.find(item => item.questions.some(question => wanted.has(question.id)));
    if (!group) return null;
    const ids = wanted.size ? wanted : new Set(group.questions.map(question => question.id));
    return { ...group, questions: group.questions.filter(question => ids.has(question.id)) };
  }).filter(Boolean);
  return (session.vignetteIds || []).map(id => groups.find(group => group.id === id)).filter(Boolean);
}

/** Build the exact session mutations needed when one bank is removed. */
export function detachBankSessions(bank, remainingGroups, sessions) {
  const removedGroups = new Set((bank.vignettes || []).map(group => group.id));
  const removedQuestions = new Set((bank.vignettes || []).flatMap(group => group.questions.map(question => question.id)));
  const remainingGroupIds = new Set(remainingGroups.map(group => group.id));
  const remainingQuestionIds = new Set(remainingGroups.flatMap(group => group.questions.map(question => question.id)));
  const removeIds = [], updates = [];
  for (const session of sessions) {
    if (session.source === 'word' && session.bankId === bank.id) { removeIds.push(session.id); continue; }
    let next = { ...session };
    if (session.units) {
      next.units = session.units.filter(unit => {
        if (unit.bankId) return unit.bankId !== bank.id;
        const questionIds = unit.questionIds || [];
        const onlyInRemovedBank = questionIds.length && questionIds.every(id => removedQuestions.has(id) && !remainingQuestionIds.has(id));
        return !(removedGroups.has(unit.groupId) && !remainingGroupIds.has(unit.groupId)) && !onlyInRemovedBank;
      });
      if (!next.units.length) { removeIds.push(session.id); continue; }
      const keptIds = new Set(next.units.flatMap(unit => unit.questionIds || []));
      next.responses = Object.fromEntries(Object.entries(session.responses || {}).filter(([id]) => keptIds.has(id)));
      if (session.answers) next.answers = session.answers.filter(answer => keptIds.has(answer.questionId));
    } else if (session.vignetteIds) {
      next.vignetteIds = session.vignetteIds.filter(id => !removedGroups.has(id) || remainingGroupIds.has(id));
      if (!next.vignetteIds.length) { removeIds.push(session.id); continue; }
      next.responses = Object.fromEntries(Object.entries(session.responses || {}).filter(([id]) => !removedQuestions.has(id) || remainingQuestionIds.has(id)));
      if (session.answers) next.answers = session.answers.filter(answer => !removedQuestions.has(answer.questionId) || remainingQuestionIds.has(answer.questionId));
    } else if ((session.answers || []).some(answer => removedQuestions.has(answer.questionId) && !remainingQuestionIds.has(answer.questionId))) {
      next.answers = session.answers.filter(answer => !removedQuestions.has(answer.questionId) || remainingQuestionIds.has(answer.questionId));
      if (!next.answers.length) { removeIds.push(session.id); continue; }
    } else continue;
    updates.push(next);
  }
  return { removeIds, updates };
}

export function gradeSession(session, groups) {
  const questions = new Map(groups.flatMap(group => group.questions.map(question => [question.id, { ...question, topic: group.topic, module: group.module }])));
  const answers = [...questions].map(([questionId, question]) => {
    const response = (session.responses || {})[questionId] || {};
    return { questionId, selected: response.selected || '', confidence: response.confidence || '', flagged: !!response.flagged, correct: !!response.selected && response.selected === question.correctKey, topic: question.topic, module: question.module };
  });
  return { ...session, answers, submittedAt: new Date().toISOString() };
}

const metrics = (ids, attempts) => {
  const done = ids.filter(id => attempts.has(id));
  const first = done.map(id => attempts.get(id)[0]);
  const latest = done.map(id => attempts.get(id).at(-1));
  const retries = done.flatMap(id => attempts.get(id).slice(1).filter((answer, index) => attempts.get(id)[index]?.correct === false));
  return { total: ids.length, practiced: done.length, firstCorrect: first.filter(a => a.correct).length, firstN: first.length, latestCorrect: latest.filter(a => a.correct).length, latestN: latest.length, repeatedWrong: done.filter(id => attempts.get(id).filter(a => !a.correct).length >= 2).length, retryCorrect: retries.filter(a => a.correct).length, retryN: retries.length };
};

export function summarize(sessions, groups, includeWord = true) {
  const attempts = attemptsByQuestion(sessions, includeWord);
  const topics = new Map();
  groups.forEach(group => {
    if (!topics.has(group.topic)) topics.set(group.topic, { ids: new Set(), vignetteIds: new Set(), modules: new Map() });
    const topic = topics.get(group.topic);
    if (!topic.modules.has(group.module)) topic.modules.set(group.module, { ids: new Set(), vignetteIds: new Set() });
    const module = topic.modules.get(group.module);
    group.questions.forEach(question => { topic.ids.add(question.id); module.ids.add(question.id); });
    if (formOf(group) === 'vignette') { topic.vignetteIds.add(group.id); module.vignetteIds.add(group.id); }
  });
  return [...topics].map(([name, topic]) => ({ name, vignetteCount: topic.vignetteIds.size, ...metrics([...topic.ids], attempts), modules: [...topic.modules].map(([moduleName, module]) => ({ name: moduleName, vignetteCount: module.vignetteIds.size, ...metrics([...module.ids], attempts) })) }));
}
