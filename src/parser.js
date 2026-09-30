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
  const match = text.match(/^(\d+)\s*(Multiple\s*Choice|Numeric\s*(?:Entry|Response)|Fill\s*(?:in\s*the\s*Blank)?|Text\s*(?:Entry|Response)|Essay)\b/i);
  return match ? { number: match[1], kind: match[2].replace(/\s+/g, ' ').toLowerCase(), raw: text } : null;
};
const marker = value => normalized(value).replace(/：$/, ':').toLowerCase();
const markerType = value => {
  const text = marker(value);
  if (/^correct answer\s*:/.test(text) || /^correct answer$/.test(text)) return 'correct';
  if (/^(your answer|selected answer|response|answer given|incorrect answer)\s*:/.test(text) || /^(your answer|selected answer|response|answer given)$/.test(text)) return 'original';
  if (/^(feedback|answer explanation|explanation)\s*:/.test(text) || /^(feedback|answer explanation|explanation)$/.test(text)) return 'feedback';
  if (/^(correct|incorrect) answer feedback\s*:/.test(text) || /^(correct|incorrect) answer feedback$/.test(text)) return 'feedback-label';
  if (/^not selected$/.test(text)) return 'status';
  return '';
};
const markerPayload = value => normalized(value).match(/^[^:：]+[:：]\s*(.+)$/)?.[1] || '';
const isSummary = value => /^(quiz review|review|you scored\b|out of\b.*points?\b|average time per question|avg\.?\s*time per question)\b/i.test(normalized(value));
const optionMatch = value => normalized(value).match(/^([A-Z])[.)]\s*(.+)$/);
const answerKey = (value, options) => {
  const text = normalized(value);
  const label = text.match(/^([A-Z])(?:[.)]|\b)/i)?.[1]?.toUpperCase();
  if (label && options.some(option => option.key === label)) return label;
  return options.find(option => normalized(option.text.replace(/^[A-Z][.)]\s*/, '')) === text)?.key || '';
};
const blockSignature = block => block.type === 'table' ? JSON.stringify(block.rows) : `${block.text}|${(block.images || []).join('|')}`;

function parseQuestion(blocks, topic, module, vignetteSeed) {
  const header = blocks[0]?.type === 'p' ? normalized(blocks[0].text) : '';
  const content = blocks.slice(1);
  const paragraphs = content.map((block, index) => ({ block, index, text: block.type === 'p' ? normalized(block.text) : '', marker: block.type === 'p' ? markerType(block.text) : '' }));
  const boundary = paragraphs.find(item => ['correct', 'original', 'feedback', 'feedback-label', 'status'].includes(item.marker))?.index ?? content.length;
  const optionCandidates = paragraphs.filter(item => item.index < boundary && optionMatch(item.text));
  const firstOption = optionCandidates[0]?.index ?? boundary;
  const stemBlocks = content.slice(0, firstOption).filter(block => block.type !== 'p' || !isSummary(block.text));
  const options = [];
  const seen = new Map();
  const warnings = [];
  for (const item of optionCandidates) {
    const [, key, optionText] = optionMatch(item.text);
    if (!seen.has(key)) {
      const option = { key, text: item.text, blocks: [item.block] };
      seen.set(key, option); options.push(option);
    } else if (normalized(seen.get(key).text) !== normalized(item.text)) {
      warnings.push(`選項 ${key} 出現不同內容，請手動確認；系統未重新編號`);
    }
  }
  const valueAfter = type => {
    const at = paragraphs.findIndex(item => item.marker === type);
    if (at < 0) return '';
    const inline = markerPayload(paragraphs[at].text);
    if (inline) return inline;
    return paragraphs.slice(at + 1).find(item => item.text && !item.marker)?.text || '';
  };
  const correctRaw = valueAfter('correct');
  const originalAnswerRaw = valueAfter('original');
  const feedbackAt = paragraphs.findIndex(item => item.marker === 'feedback');
  let explanationBlocks = feedbackAt < 0 ? [] : content.slice(feedbackAt + 1).filter(block => block.type !== 'p' || !markerType(block.text));
  const inlineFeedback = feedbackAt >= 0 && markerPayload(paragraphs[feedbackAt].text);
  if (inlineFeedback) explanationBlocks = [{ type: 'p', text: inlineFeedback, images: [] }, ...explanationBlocks];
  if (!explanationBlocks.length) explanationBlocks = paragraphs.filter(item => item.marker === 'feedback-label').flatMap(item => {
    const payload = markerPayload(item.text);
    return payload ? [{ type: 'p', text: payload, images: [] }] : [];
  });
  const correctKey = answerKey(correctRaw, options);
  const originalAnswerKey = answerKey(originalAnswerRaw, options);
  if (options.length < 2) warnings.push('無法可靠辨識至少兩個選項');
  if (!correctKey) warnings.push('缺少或無法可靠配對正確答案');
  if (originalAnswerRaw && !originalAnswerKey) warnings.push('無法可靠配對 Word 原作答答案');
  const signature = [topic, module, vignetteSeed, ...stemBlocks.map(blockSignature), ...options.map(o => `${o.key}:${o.text}`)].join('|');
  return {
    id: stableId('q', signature), header, stem: stemBlocks.filter(b => b.type === 'p').map(b => b.text), stemBlocks,
    options, correctKey, answerRaw: correctRaw, originalAnswerKey, originalAnswerRaw,
    explanation: explanationBlocks.filter(b => b.type === 'p').map(b => b.text), explanationBlocks,
    warnings, ready: options.length >= 2 && !!correctKey && !warnings.some(w => w.startsWith('選項 ')), sourceBlocks: blocks
  };
}

export function parseBlocks(blocks, filename = 'document.docx') {
  let topic = '未分類 Topic', module = '未分類 Module', group = null, pending = [];
  const vignettes = [], exclusions = [], globalWarnings = [];
  blocks = blocks.filter(block => {
    if (block.type !== 'p' || !isSummary(block.text)) return true;
    exclusions.push({ content: normalized(block.text), reason: '測驗成績摘要或介面文字' });
    return false;
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
        exclusions.push({ content: header.raw, reason: `非單選題（${header.kind}）`, blocks: questionBlocks });
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
  const contentId = stableId('bank', vignettes.map(v => v.id).join('|'));
  return { id: contentId, contentId, name: filename, importedAt: new Date().toISOString(), vignettes, exclusions, importResponses: vignettes.flatMap(v => v.questions.filter(q => q.originalAnswerRaw).map(q => ({ questionId: q.id, selected: q.originalAnswerKey, raw: q.originalAnswerRaw }))), warnings: globalWarnings };
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
