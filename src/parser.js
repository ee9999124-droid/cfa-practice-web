import { readZip } from './zip.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relId = node => node?.getAttributeNS(R, 'embed');
const textOf = node => [...node.getElementsByTagNameNS(W, 't')].map(n => n.textContent || '').join('');
export function stableId(prefix, value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${prefix}_${(h >>> 0).toString(36)}`;
}
function parseXml(value) { return new DOMParser().parseFromString(value, 'application/xml'); }
function makeBlocks(doc, imageMap) {
  const body = doc.getElementsByTagNameNS(W, 'body')[0], blocks = [];
  for (const node of body.children) {
    if (node.localName === 'p') {
      const text = textOf(node), images = [...node.getElementsByTagNameNS(A, 'blip')].map(n => imageMap[relId(n)]).filter(Boolean);
      if (text || images.length) blocks.push({ type: 'p', text, images });
    } else if (node.localName === 'tbl') {
      const rows = [...node.children].filter(n => n.localName === 'tr').map(tr => [...tr.children].filter(n => n.localName === 'tc').map(textOf));
      blocks.push({ type: 'table', rows });
    }
  }
  return blocks;
}

const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const mcHeader = value => /^\s*\d+\s*Multiple\s*Choice\b/i.test(value);
const anyQuestionHeader = value => /^\s*\d+\s*(?:Multiple\s*Choice|Fill\s*(?:in\s*the\s*Blank)?|Text\s*(?:Entry|Input)|Numeric\s*(?:Entry|Input)|Essay|Short\s*Answer)\b/i.test(value);
const unsupportedHeader = value => anyQuestionHeader(value) && !mcHeader(value);
const marker = value => /^(?:Your|Selected)\s+answer\s*:|^(?:Correct|Incorrect)\s+answer\s*:|^Correct$|^Incorrect$|^Not Selected$|^Feedback$|^(?:Correct|Incorrect) Answer Feedback\s*:/i.test(clean(value));

/** Only removes complete review/score/time UI rows, never arbitrary text containing a number or percent. */
export function isInterfaceSummary(value) {
  const text = clean(value);
  return /^(?:Quiz\s+review|Review)$/i.test(text)
    || /^You\s+scored\s+\d+(?:\.\d+)?\s*(?:percent|%)\s*,?\s*\d+(?:\.\d+)?\s+out\s+of\s+\d+(?:\.\d+)?\s+points?\.?$/i.test(text)
    || /^\d+(?:\.\d+)?\s*%$/i.test(text)
    || /^(?:\d+(?:\.\d+)?\s+)?out\s+of\s+\d+(?:\.\d+)?\s+points?\.?$/i.test(text)
    || /^(?:Average|Avg)\s+time\s+per\s+question\s*:?\s*(?:\d+\s*(?:seconds?|secs?)|\d{1,2}:\d{2})?$/i.test(text)
    || /^\d{1,2}:\d{2}$/.test(text);
}
const sanitizeBlocks = blocks => blocks.filter(block => block.type !== 'p' || !isInterfaceSummary(block.text));
const optionMatch = value => clean(value).match(/^([A-Z])[.)]\s*(.+)$/);
const answerValue = (texts, patterns) => {
  for (let i = 0; i < texts.length; i++) {
    const text = clean(texts[i]);
    const pattern = patterns.find(item => item.test(text));
    if (!pattern) continue;
    const inline = text.replace(pattern, '').replace(/^\s*:\s*/, '').trim();
    if (inline) return inline;
    const next = clean(texts[i + 1]);
    if (next && !marker(next)) return next;
  }
  return '';
};
const resolveKey = (raw, options) => {
  if (!raw) return '';
  const explicit = clean(raw).match(/^([A-Z])(?:[.)]|$)/)?.[1];
  if (explicit && options.some(option => option.key === explicit)) return explicit;
  const normalized = clean(raw).replace(/^[A-Z][.)]\s*/, '');
  const matches = options.filter(option => clean(option.text).replace(/^[A-Z][.)]\s*/, '') === normalized);
  return matches.length === 1 ? matches[0].key : '';
};

export function parseQuestion(blocks, topic, module, vignetteSeed) {
  const cleanBlocks = sanitizeBlocks(blocks), texts = cleanBlocks.filter(b => b.type === 'p').map(b => clean(b.text)).filter(Boolean);
  const header = texts.shift() || '';
  const rawOptions = texts.map((text, index) => ({ match: optionMatch(text), text, index })).filter(item => item.match);
  const optionMap = new Map(), conflicts = [];
  for (const item of rawOptions) {
    const option = { key: item.match[1], text: `${item.match[1]}. ${item.match[2]}` };
    if (!optionMap.has(option.key)) optionMap.set(option.key, option);
    else if (clean(optionMap.get(option.key).text).toLowerCase() !== clean(option.text).toLowerCase()) conflicts.push({ key: option.key, values: [optionMap.get(option.key).text, option.text] });
  }
  let options = [...optionMap.values()];
  let promptEnd = rawOptions.length ? rawOptions[0].index : texts.findIndex(marker);
  if (promptEnd < 0) promptEnd = texts.length;

  // Some exports omit A/B/C and place feedback immediately after each option.
  if (!options.length) {
    const candidates = texts.filter((text, index) => /^(?:Correct|Incorrect) Answer Feedback\s*:/i.test(texts[index + 1] || '') && !marker(text));
    options = [...new Set(candidates)].map((text, index) => ({ key: String.fromCharCode(65 + index), text }));
    if (candidates.length) promptEnd = texts.indexOf(candidates[0]);
  }

  const previousOption = index => {
    for (let cursor = index - 1; cursor >= 0; cursor--) { if (optionMatch(texts[cursor])) return texts[cursor]; if (!marker(texts[cursor])) break; }
    return '';
  };
  const correctMarker = texts.findIndex(text => /^Correct\s+answer\s*:/i.test(text));
  let correctRaw = answerValue(texts, [/^Correct\s+answer\s*:/i]);
  if (!resolveKey(correctRaw, options) && correctMarker >= 0) correctRaw = previousOption(correctMarker);
  let selectedRaw = answerValue(texts, [/^(?:Your|Selected)\s+answer\s*:/i]);
  if (!selectedRaw) {
    const incorrectMarker = texts.findIndex((text, index) => /^Incorrect\s+answer\s*:/i.test(text) && !/^Not Selected$/i.test(texts[index + 1] || ''));
    if (incorrectMarker >= 0) selectedRaw = previousOption(incorrectMarker);
    else if (texts.some(text => /^Correct$/i.test(text)) && correctMarker >= 0) selectedRaw = previousOption(correctMarker);
  }
  const correctKey = resolveKey(correctRaw, options);
  const selectedKey = resolveKey(selectedRaw, options);
  const notSelected = !selectedKey && texts.some(text => /^Not Selected$/i.test(text));
  let importedCorrect = null;
  if (notSelected) importedCorrect = null;
  else if (selectedKey && correctKey) importedCorrect = selectedKey === correctKey;
  else if (selectedKey && texts.some(text => /^Correct$/i.test(text))) importedCorrect = true;
  else if (selectedKey && texts.some(text => /^(?:Incorrect|Incorrect answer:)$/i.test(text))) importedCorrect = false;

  const feedbackAt = texts.findIndex(text => /^Feedback$/i.test(text));
  const explanation = feedbackAt >= 0 ? texts.slice(feedbackAt + 1).filter(text => !marker(text)) : texts.filter(text => /^(?:Correct|Incorrect) Answer Feedback\s*:/i.test(text));
  const stem = texts.slice(0, promptEnd).filter(text => !marker(text) && !isInterfaceSummary(text));
  const warnings = [];
  if (options.length < 2) warnings.push('無法可靠辨識至少兩個單選選項');
  if (conflicts.length) warnings.push(`選項標籤衝突：${conflicts.map(item => item.key).join('、')}（已保留衝突內容供確認）`);
  if (!correctKey) warnings.push('無法可靠配對正確答案');
  if (!notSelected && !selectedKey) warnings.push('無法可靠辨識原作答答案');
  const signature = [topic, module, vignetteSeed, stem.join('\n'), options.map(option => option.text).join('\n')].join('|');
  return {
    id: stableId('q', signature), header, stem, options, correctKey, answerRaw: correctRaw, explanation, warnings,
    optionConflicts: conflicts, importResult: { selectedKey, selectedRaw, correctKey, correctRaw, correct: importedCorrect, notSelected, needsConfirmation: (!notSelected && !selectedKey) || !correctKey || !!conflicts.length },
    sourceBlocks: blocks
  };
}

export function parseBlocks(blocks, filename = 'document.docx') {
  let topic = '未分類 Topic', module = '未分類 Module', group = null, pending = [];
  const vignettes = [], excluded = [], warnings = [];
  const flush = () => {
    if (group?.questions.length) {
      group.context = sanitizeBlocks(group.context);
      const identity = [group.topic, group.module, ...group.context.map(b => b.type === 'p' ? b.text : JSON.stringify(b.rows))];
      // Legacy vignette IDs remain stable; standalone groups need their question ID to avoid collisions within a module.
      if (group.form === 'standalone') identity.push(group.questions[0].id);
      group.id = stableId('v', identity.join('|'));
      group.questions.forEach(question => { question.vignetteId = group.id; });
      vignettes.push(group);
    }
    group = null;
  };
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index], text = block.type === 'p' ? clean(block.text) : '';
    if (isInterfaceSummary(text)) { index++; continue; }
    if (/^CFA-.*:\s*/.test(text)) { flush(); pending = []; topic = text.replace(/^.*?:\s*/, '') || text; index++; continue; }
    if (/^Module\s+\d+\s*:/i.test(text)) { flush(); pending = []; module = text; index++; continue; }
    if (/^Vignette$/i.test(text)) { flush(); group = { topic, module, form: 'vignette', formReason: '文件含有 Vignette 標記', context: sanitizeBlocks(pending), questions: [], warnings: [] }; pending = []; index++; continue; }
    if (unsupportedHeader(text)) {
      const skipped = [block]; index++;
      while (index < blocks.length) { const next = blocks[index].type === 'p' ? clean(blocks[index].text) : ''; if (anyQuestionHeader(next) || /^Module\s+\d+\s*:/i.test(next) || /^Vignette$/i.test(next)) break; skipped.push(blocks[index++]); }
      excluded.push({ header: text, reason: '非單選題（填充、文字輸入或其他作答形式）', sample: skipped.filter(b => b.type === 'p').slice(1, 3).map(b => clean(b.text)).join(' ') });
      continue;
    }
    if (mcHeader(text)) {
      const implicit = !group;
      if (implicit) group = { topic, module, form: pending.length ? 'unknown' : 'standalone', formReason: pending.length ? '題目前有內容，但沒有明確的 Vignette 標記' : '沒有共用情境或 Vignette 標記', context: sanitizeBlocks(pending), questions: [], warnings: pending.length ? ['題型待確認：請選擇 Vignette 題組或獨立單題'] : [] };
      pending = [];
      const questionBlocks = [];
      while (index < blocks.length) { const next = blocks[index].type === 'p' ? clean(blocks[index].text) : ''; if (questionBlocks.length && (anyQuestionHeader(next) || /^Vignette$/i.test(next) || /^Module\s+\d+\s*:/i.test(next))) break; questionBlocks.push(blocks[index++]); }
      group.questions.push(parseQuestion(questionBlocks, topic, module, group.context.map(item => item.text || '').join('|')));
      if (implicit) flush();
      continue;
    }
    if (group) group.context.push(block); else pending.push(block);
    index++;
  }
  flush();
  if (!vignettes.length) warnings.push('沒有找到可匯入的單選題');
  return { id: stableId('bank', vignettes.map(v => v.id).join('|')), name: filename, importedAt: new Date().toISOString(), vignettes, excluded, warnings, parserVersion: 2 };
}

export async function parseDocx(file) {
  const zip = await readZip(file), document = zip.get('word/document.xml');
  if (!document) throw new Error('不是有效的 DOCX：缺少 word/document.xml');
  const relsFile = zip.get('word/_rels/document.xml.rels'), rels = {};
  if (relsFile) { const xml = parseXml(await relsFile()); for (const relation of xml.documentElement.children) rels[relation.getAttribute('Id')] = relation.getAttribute('Target'); }
  const doc = parseXml(await document()), imageMap = {};
  for (const blip of doc.getElementsByTagNameNS(A, 'blip')) {
    const id = relId(blip), target = rels[id]; if (!target || imageMap[id]) continue;
    const path = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`, fileInZip = zip.get(path);
    if (fileInZip) { const extension = path.split('.').pop(); imageMap[id] = `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${await fileInZip('base64')}`; }
  }
  return parseBlocks(makeBlocks(doc, imageMap), file.name);
}
