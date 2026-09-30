import { readZip } from './zip.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relId = node => node?.getAttributeNS(R, 'embed');
const textOf = node => [...node.getElementsByTagNameNS(W, 't')].map(n => n.textContent || '').join('');
const normalized = value => value.replace(/\s+/g, ' ').trim();

export function stableId(prefix, value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${prefix}_${(h >>> 0).toString(36)}`;
}

function parseXml(value) { return new DOMParser().parseFromString(value, 'application/xml'); }
function makeBlocks(doc, imageMap) {
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  const blocks = [];
  for (const node of body.children) {
    if (node.localName === 'p') {
      const text = textOf(node);
      const images = [...node.getElementsByTagNameNS(A, 'blip')].map(n => imageMap[relId(n)]).filter(Boolean);
      if (text || images.length) blocks.push({ type: 'p', text, images });
    } else if (node.localName === 'tbl') {
      const rows = [...node.children].filter(n => n.localName === 'tr').map(tr => [...tr.children].filter(n => n.localName === 'tc').map(textOf));
      blocks.push({ type: 'table', rows });
    }
  }
  return blocks;
}

const headerInfo = value => {
  const text = normalized(value);
  const match = text.match(/^(\d+)\s*(Multiple\s*Choice|Numeric\s*(?:Entry|Response|Input)|Fill\s*(?:in\s*the\s*Blank)?|Text\s*(?:Entry|Response|Input)|Essay|Short\s*Answer)(?=\s|\d|$)/i);
  return match ? { number: match[1], kind: match[2].replace(/\s+/g, ' ').toLowerCase(), raw: text } : null;
};
const marker = value => normalized(value).replace(/：$/, ':').toLowerCase();
const markerType = value => {
  const text = marker(value);
  if (/^correct answer\s*:/.test(text) || /^correct answer$/.test(text)) return 'correct';
  if (/^(your answer|selected answer|response|answer given|incorrect answer)\s*:/.test(text) || /^(your answer|selected answer|response|answer given)$/.test(text)) return 'original';
  if (/^(feedback|answer explanation|explanation)\s*:/.test(text) || /^(feedback|answer explanation|explanation)$/.test(text)) return 'feedback';
  if (/^(correct|incorrect) answer feedback\s*:/.test(text) || /^(correct|incorrect) answer feedback$/.test(text)) return 'feedback-label';
  if (/^(not selected|correct|incorrect|your answers:?)$/.test(text)) return 'status';
  return '';
};
const markerPayload = value => normalized(value).match(/^[^:：]+[:：]\s*(.+)$/)?.[1] || '';
const isSummary = value => /^(quiz review(?:\.\s*You scored\s+\d+\s+percent,\s*\d+\s+out of\s+\d+\s+points?)?|review|practice topics|your answers:?)$/i.test(normalized(value))
  || /^you scored\s+\d+(?:\.\d+)?\s*(?:percent|%)(?:\s*,?\s*\d+\s+out of\s+\d+\s+points?)?\.?$/i.test(normalized(value))
  || /^(?:\d+\s+)?out of\s+\d+\s+points?\.?$/i.test(normalized(value))
  || /^(average|avg\.?)\s*time per question(?:\s*:?\s*(?:\d+\s*(?:seconds?|secs?)|\d{1,2}:\d{2}))?$/i.test(normalized(value));
const optionMatch = value => normalized(value).match(/^([A-Z])[.)]\s*(.+)$/);
const answerKey = (value, options) => {
  const text = normalized(value);
  const label = text.match(/^([A-Z])(?:[.)]|$)/)?.[1]?.toUpperCase();
  if (label && options.some(option => option.key === label)) return label;
  return options.find(option => normalized(option.text.replace(/^[A-Z][.)]\s*/, '')) === text)?.key || '';
};
const blockSignature = block => block.type === 'table' ? JSON.stringify(block.rows) : `${block.text}|${(block.images || []).join('|')}`;

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

// Question numbers in classification maps are always the original Word numbers. They are
// deliberately arrays (rather than inferred runs) so exclusions never shift later matches.
export const QUESTION_GROUP_MAPS = {
  ci: {
    label: 'CI 已核對題組對照表',
    topicPattern: /(?:corporate\s+issuers|公司發行人|企業發行人|^CI$)/i,
    modules: {
      1: { groups: [range(5, 9), range(28, 29), range(30, 35), range(36, 39), range(40, 43)], standalone: [...range(1, 4), ...range(11, 27), ...range(44, 69)], exclude: [10] },
      2: { groups: [[...range(1, 3), ...range(5, 6)], range(7, 10), range(11, 14), range(15, 18), range(19, 22)], standalone: range(23, 28), exclude: [4] },
      3: { groups: [range(1, 5)], standalone: range(6, 27), exclude: [] },
      4: { groups: [range(1, 5), range(6, 10)], standalone: range(11, 31), exclude: [] }
    }
  }
};

const moduleNumber = value => +(normalized(value).match(/^Module\s+(\d+)/i)?.[1] || 0);
const questionNumber = question => +(headerInfo(question.header)?.number || 0);

function applyQuestionGroupMap(bank, map) {
  const sourceGroups = bank.vignettes;
  const sources = new Map();
  for (const group of sourceGroups) for (const question of group.questions) {
    const key = `${moduleNumber(group.module)}:${questionNumber(question)}`;
    if (!sources.has(key)) sources.set(key, { question, group });
    else bank.warnings.push(`${map.label}：${group.module} 原始題號 ${questionNumber(question)} 重複，僅採用第一題`);
  }
  const classified = [], consumed = new Set();
  const addGroup = (source, questions, form, numbers) => {
    const context = form === 'vignette' ? source.group.context : [];
    const group = {
      topic: source.group.topic, module: source.group.module, form,
      formReason: `${map.label}（Word 原始題號 ${numbers.join('、')}）`, context,
      questions, warnings: []
    };
    group.id = stableId('v', [group.topic, group.module, form, ...context.map(blockSignature), ...questions.map(q => q.id)].join('|'));
    questions.forEach(question => { question.vignetteId = group.id; });
    classified.push(group);
  };
  for (const [module, rules] of Object.entries(map.modules)) {
    for (const numbers of rules.groups) {
      const entries = numbers.map(number => sources.get(`${module}:${number}`));
      if (entries.some(entry => !entry)) {
        bank.warnings.push(`${map.label}：Module ${module} 題組 ${numbers.join('、')} 有原始題號缺漏，未套用此組`);
        continue;
      }
      entries.forEach(entry => consumed.add(`${module}:${questionNumber(entry.question)}`));
      // The first question owns the corresponding Vignette. This also intentionally makes
      // Module 2 questions 5–6 reuse the Titian context belonging to question 1.
      addGroup(entries[0], entries.map(entry => entry.question), 'vignette', numbers);
    }
    for (const number of rules.standalone) {
      const entry = sources.get(`${module}:${number}`);
      if (!entry) { bank.warnings.push(`${map.label}：Module ${module} 獨立題原始題號 ${number} 缺漏`); continue; }
      consumed.add(`${module}:${number}`);
      addGroup(entry, [entry.question], 'standalone', [number]);
    }
    for (const number of rules.exclude) {
      const key = `${module}:${number}`, entry = sources.get(key);
      consumed.add(key);
      if (entry) bank.exclusions.push({ content: entry.question.header, reason: `${map.label}指定排除（Module ${module} 原始題號 ${number}）`, blocks: entry.question.sourceBlocks });
      else if (!bank.exclusions.some(item => headerInfo(item.content)?.number === String(number) && moduleNumber(item.module || `Module ${module}`) === +module)) {
        bank.warnings.push(`${map.label}：找不到指定排除的 Module ${module} 原始題號 ${number}`);
      }
    }
  }
  for (const [key] of sources) if (!consumed.has(key)) bank.warnings.push(`${map.label}：${key.replace(':', ' 原始題號 ')} 未列入對照表，因此未匯入`);
  bank.vignettes = classified;
  bank.classification = { key: 'ci', label: map.label };
}

function parseQuestion(blocks, topic, module, vignetteSeed) {
  const header = blocks[0]?.type === 'p' ? normalized(blocks[0].text) : '';
  const content = blocks.slice(1);
  const paragraphs = content.map((block, index) => ({ block, index, text: block.type === 'p' ? normalized(block.text) : '', marker: block.type === 'p' ? markerType(block.text) : '' }));
  const boundary = paragraphs.find(item => ['correct', 'original', 'feedback', 'feedback-label', 'status'].includes(item.marker))?.index ?? content.length;
  const feedbackBoundary = paragraphs.find(item => ['feedback', 'feedback-label'].includes(item.marker))?.index ?? content.length;
  let optionCandidates = paragraphs.filter(item => item.index < feedbackBoundary && optionMatch(item.text));
  const inlineOptionFeedback = paragraphs.filter(item => item.marker === 'feedback-label');
  const unlabelled = !optionCandidates.length && inlineOptionFeedback.length >= 2;
  if (unlabelled) optionCandidates = inlineOptionFeedback.map(item => paragraphs[item.index - 1]).filter(item => item?.text && !item.marker);
  const firstOption = Math.min(optionCandidates[0]?.index ?? boundary, boundary);
  const stemBlocks = content.slice(0, firstOption).filter(block => block.type !== 'p' || !isSummary(block.text));
  const options = [];
  const seen = new Map();
  const warnings = [], optionConflicts = [];
  for (const [position, item] of optionCandidates.entries()) {
    const key = unlabelled ? String.fromCharCode(65 + position) : optionMatch(item.text)[1];
    if (!seen.has(key)) {
      const option = { key, text: item.text, blocks: [item.block] };
      seen.set(key, option); options.push(option);
    } else if (normalized(seen.get(key).text) !== normalized(item.text)) {
      optionConflicts.push({ key, values: [seen.get(key).text, item.text] });
      warnings.push(`選項 ${key} 出現不同內容，請手動確認；系統未重新編號`);
    }
  }
  const valueAfter = type => {
    const at = paragraphs.findIndex(item => item.marker === type);
    if (at < 0) return '';
    const inline = markerPayload(paragraphs[at].text);
    if (inline) return inline;
    for (let i = at + 1; i < paragraphs.length; i++) {
      if (paragraphs[i].marker) break;
      if (paragraphs[i].text) return paragraphs[i].text;
    }
    if (paragraphs[at + 1]?.text.toLowerCase() === 'not selected') return '';
    const previous = paragraphs[at - 1];
    return previous && optionMatch(previous.text) ? previous.text : '';
  };
  const correctRaw = valueAfter('correct');
  let originalAnswerRaw = valueAfter('original');
  if (!originalAnswerRaw && paragraphs.some(p => /^Correct$/i.test(p.text)) && !paragraphs.some(p => /^Incorrect$/i.test(p.text))) {
    const at = paragraphs.findIndex(p => p.marker === 'correct');
    const previous = paragraphs[at - 1];
    if (previous && optionMatch(previous.text)) originalAnswerRaw = previous.text;
  }
  const feedbackAt = paragraphs.findIndex(item => item.marker === 'feedback');
  let explanationBlocks = feedbackAt < 0 ? [] : content.slice(feedbackAt + 1).filter(block => block.type !== 'p' || !markerType(block.text));
  const inlineFeedback = feedbackAt >= 0 && markerPayload(paragraphs[feedbackAt].text);
  if (inlineFeedback) explanationBlocks = [{ type: 'p', text: inlineFeedback, images: [] }, ...explanationBlocks];
  if (!explanationBlocks.length) explanationBlocks = inlineOptionFeedback.flatMap((item, index) => {
    let end = optionCandidates[index + 1]?.index ?? content.length;
    while (end > item.index + 1 && paragraphs[end - 1]?.marker) end--;
    const payload = markerPayload(item.text);
    return [...(payload ? [{ type: 'p', text: payload, images: [] }] : []), ...content.slice(item.index + 1, end).filter(b => b.type !== 'p' || !markerType(b.text))];
  });
  options.sort((a, b) => a.key.localeCompare(b.key));
  const correctKey = answerKey(correctRaw, options);
  const score = header.match(/Multiple\s*Choice\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*points?/i);
  if (!originalAnswerRaw && correctKey && score && +score[2] > 0 && +score[1] === +score[2]) originalAnswerRaw = correctRaw;
  const originalAnswerKey = answerKey(originalAnswerRaw, options);
  if (options.length < 2) warnings.push('無法可靠辨識至少兩個選項');
  if (!correctKey) warnings.push('缺少或無法可靠配對正確答案');
  if (originalAnswerRaw && !originalAnswerKey) warnings.push('無法可靠配對 Word 原作答答案');
  const signature = [topic, module, vignetteSeed, ...stemBlocks.map(blockSignature), ...options.map(o => `${o.key}:${o.text}`)].join('|');
  return {
    id: stableId('q', signature), header, stem: stemBlocks.filter(b => b.type === 'p').map(b => b.text), stemBlocks,
    options, correctKey, answerRaw: correctRaw, originalAnswerKey, originalAnswerRaw,
    explanation: explanationBlocks.filter(b => b.type === 'p').map(b => b.text), explanationBlocks,
    warnings, optionConflicts, ready: options.length >= 2 && !!correctKey && !warnings.some(w => w.startsWith('選項 ')), sourceBlocks: blocks
  };
}

export function parseBlocks(blocks, filename = 'document.docx', classification = 'auto') {
  let topic = '未分類 Topic', module = '未分類 Module', group = null, pending = [];
  const vignettes = [], exclusions = [], globalWarnings = [];
  // Bare scores and times are interface data only inside an identified review summary.
  let inSummary = false;
  blocks = blocks.filter(block => {
    if (block.type !== 'p') return true;
    const text = normalized(block.text);
    if (headerInfo(text) || /^CFA-|^Module\s+\d+|^Vignette$/i.test(text)) inSummary = false;
    const summary = isSummary(text);
    if (summary) inSummary = true;
    if (summary || inSummary && /^(?:\d+(?:\.\d+)?\s*%?|\d{1,2}:\d{2})$/.test(text)) {
      exclusions.push({ content: text, reason: '測驗成績摘要或介面文字' });
      return false;
    }
    return true;
  });
  const flush = () => {
    if (group?.questions.length) {
      group.id = stableId('v', [group.topic, group.module, group.form, ...group.context.map(blockSignature), ...group.questions.map(q => q.id)].join('|'));
      group.questions.forEach(question => { question.vignetteId = group.id; });
      vignettes.push(group);
    }
    group = null;
  };
  for (let i = 0; i < blocks.length;) {
    const block = blocks[i], text = block.type === 'p' ? normalized(block.text) : '';
    if (/^CFA-.*:\s*/i.test(text)) { flush(); pending = []; topic = text.replace(/^.*?:\s*/, '') || text; i++; continue; }
    if (/^Module\s+\d+\s*:/i.test(text)) { flush(); pending = []; module = text; i++; continue; }
    if (/^Vignette$/i.test(text)) { flush(); group = { topic, module, form: 'vignette', formReason: '文件含有明確 Vignette 標記', context: pending, questions: [], warnings: [] }; pending = []; i++; continue; }
    const header = headerInfo(text);
    if (header) {
      const questionBlocks = [block]; i++;
      while (i < blocks.length) {
        const next = blocks[i].type === 'p' ? normalized(blocks[i].text) : '';
        if (headerInfo(next) || /^Vignette$/i.test(next) || /^Module\s+\d+\s*:/i.test(next) || /^CFA-.*:\s*/i.test(next)) break;
        questionBlocks.push(blocks[i++]);
      }
      if (header.kind !== 'multiple choice') {
        // An excluded exercise ends the preceding shared-context run.
        flush(); pending = [];
        exclusions.push({ content: header.raw, reason: `非單選題（${header.kind}）`, blocks: questionBlocks, module });
        continue;
      }
      const implicit = !group;
      if (implicit) group = { topic, module, form: pending.length ? 'unknown' : 'standalone', formReason: pending.length ? '題目前有內容，但缺少明確 Vignette 標記' : '題目前沒有共用情境', context: pending, questions: [], warnings: pending.length ? ['題目形式待確認'] : [] };
      pending = [];
      group.questions.push(parseQuestion(questionBlocks, topic, module, group.context.map(blockSignature).join('|')));
      if (implicit) flush();
      continue;
    }
    if (group) group.context.push(block); else pending.push(block);
    i++;
  }
  flush();
  if (!vignettes.length) globalWarnings.push('沒有找到可匯入的單選題');
  const bank = { name: filename, importedAt: new Date().toISOString(), vignettes, exclusions, warnings: globalWarnings };
  const selectedMap = classification === 'auto'
    ? Object.values(QUESTION_GROUP_MAPS).find(map => vignettes.some(group => map.topicPattern.test(normalized(group.topic))) || /(?:^|[^a-z])CI(?:[^a-z]|$)/i.test(filename))
    : QUESTION_GROUP_MAPS[classification];
  if (selectedMap) applyQuestionGroupMap(bank, selectedMap);
  bank.contentId = stableId('bank', bank.vignettes.map(v => v.id).join('|'));
  bank.id = bank.contentId;
  bank.importResponses = bank.vignettes.flatMap(v => v.questions.filter(q => q.originalAnswerRaw).map(q => ({ questionId: q.id, selected: q.originalAnswerKey, raw: q.originalAnswerRaw })));
  return bank;
}

export async function parseDocx(file) {
  const zip = await readZip(file), document = zip.get('word/document.xml');
  if (!document) throw new Error('不是有效的 DOCX：缺少 word/document.xml');
  const relsFile = zip.get('word/_rels/document.xml.rels'), rels = {};
  if (relsFile) { const xml = parseXml(await relsFile()); for (const rel of xml.documentElement.children) rels[rel.getAttribute('Id')] = rel.getAttribute('Target'); }
  const doc = parseXml(await document()), imageMap = {};
  for (const blip of doc.getElementsByTagNameNS(A, 'blip')) {
    const id = relId(blip), target = rels[id];
    if (!target || imageMap[id]) continue;
    const path = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`, media = zip.get(path);
    if (media) { const ext = path.split('.').pop(); imageMap[id] = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${await media('base64')}`; }
  }
  return parseBlocks(makeBlocks(doc, imageMap), file.name);
}
