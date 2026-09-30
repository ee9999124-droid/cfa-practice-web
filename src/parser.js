import { readZip } from './zip.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relId = (node) => node?.getAttributeNS(R, 'embed');
const textOf = (node) => [...node.getElementsByTagNameNS(W, 't')].map(n => n.textContent || '').join('');
export function stableId(prefix, value) {
  let h = 2166136261; for (let i=0;i<value.length;i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${prefix}_${(h>>>0).toString(36)}`;
}
function parseXml(value) { return new DOMParser().parseFromString(value, 'application/xml'); }
function makeBlocks(doc, imageMap) {
  const body = doc.getElementsByTagNameNS(W, 'body')[0]; const blocks=[];
  for (const node of body.children) {
    if (node.localName === 'p') {
      const text=textOf(node); const imgs=[...node.getElementsByTagNameNS(A,'blip')].map(n=>imageMap[relId(n)]).filter(Boolean);
      if (text || imgs.length) blocks.push({type:'p',text,images:imgs});
    } else if (node.localName === 'tbl') {
      const rows=[...node.children].filter(n=>n.localName==='tr').map(tr=>[...tr.children].filter(n=>n.localName==='tc').map(textOf));
      blocks.push({type:'table',rows});
    }
  } return blocks;
}
const qHeader = s => /^\d+MultipleChoice/i.test(s.replace(/\s/g,''));
const ignored = s => /^(Not Selected|Incorrect answer:|Correct answer:|Correct Answer:|Feedback|Incorrect Answer Feedback:|Correct Answer Feedback:)$/i.test(s.trim());
function parseQuestion(blocks, topic, module, vignetteSeed) {
  const texts=blocks.filter(b=>b.type==='p').map(b=>b.text.trim()).filter(Boolean);
  const header=texts.shift()||''; const feedbackAt=texts.findIndex(s=>/^Feedback$/i.test(s)||/^(Correct|Incorrect) Answer Feedback:/i.test(s));
  const working=feedbackAt>=0?texts.slice(0,feedbackAt):texts;
  let answerRaw='';
  for(let i=0;i<texts.length;i++) if (/^Correct answer:$/i.test(texts[i])) { answerRaw=texts[i+1]||''; break; }
  let optionLines=working.filter(s=>/^[A-Z][.)]\s+/.test(s));
  let promptEnd=optionLines.length ? working.findIndex(s=>/^[A-Z][.)]\s+/.test(s)) : 1;
  if (!optionLines.length) {
    // Newer CFA exports omit A/B/C, but put the feedback immediately after each option.
    optionLines=texts.filter((s,i)=>/^(Correct|Incorrect) Answer Feedback:/i.test(texts[i+1]||'')).map(s=>s.trim());
    optionLines=[...new Set(optionLines)]; promptEnd=Math.max(1,working.findIndex(s=>s===optionLines[0]));
  }
  const options=optionLines.map((text,i)=>({key:(text.match(/^([A-Z])[.)]/)?.[1]||String.fromCharCode(65+i)),text}));
  const correctKey=answerRaw.match(/^([A-Z])[.)]/)?.[1] || options.find(o=>o.text===answerRaw)?.key || '';
  const explanationStart=texts.findIndex(s=>/^Feedback$/i.test(s));
  const explanation=explanationStart>=0?texts.slice(explanationStart+1):texts.filter(s=>/^(Correct|Incorrect) Answer Feedback:/i.test(s));
  const stem=working.slice(0,Math.max(1,promptEnd)).filter(s=>!ignored(s));
  const warnings=[]; if(options.length<2) warnings.push('無法可靠辨識選項'); if(!correctKey) warnings.push('無法可靠配對正確答案');
  const signature=[topic,module,vignetteSeed,stem.join('\n'),options.map(o=>o.text).join('\n')].join('|');
  return {id:stableId('q',signature),header,stem,options,correctKey,answerRaw,explanation,warnings,sourceBlocks:blocks};
}
export function parseBlocks(blocks, filename='document.docx') {
  let topic='未分類 Topic', module='未分類 Module', vig=null; const vignettes=[]; const globalWarnings=[];
  const flush=()=>{if(vig&&vig.questions.length){vig.id=stableId('v',[topic,module,...vig.context.map(b=>b.type==='p'?b.text:JSON.stringify(b.rows))].join('|')); vig.questions.forEach(q=>q.vignetteId=vig.id); vignettes.push(vig);} vig=null;};
  for(let i=0;i<blocks.length;) {
    const b=blocks[i], s=b.type==='p'?b.text.trim():'';
    if(/^CFA-.*:\s*/.test(s)){topic=s.replace(/^.*?:\s*/,'')||s;i++;continue;}
    if(/^Module\s+\d+\s*:/i.test(s)){flush();module=s;i++;continue;}
    if(/^Vignette$/i.test(s)){flush();vig={topic,module,context:[],questions:[],warnings:[]};i++;continue;}
    if(qHeader(s)){
      if(!vig){vig={topic,module,context:[],questions:[],warnings:['題目前未找到 Vignette 標記']};}
      const q=[]; while(i<blocks.length){const t=blocks[i].type==='p'?blocks[i].text.trim():''; if(q.length&&(qHeader(t)||/^Vignette$/i.test(t)||/^Module\s+\d+\s*:/i.test(t)))break;q.push(blocks[i++]);}
      const parsed=parseQuestion(q,topic,module,vig.context.map(x=>x.text||'').join('|')); vig.questions.push(parsed); continue;
    }
    if(vig) vig.context.push(b); i++;
  } flush();
  if(!vignettes.length) globalWarnings.push('沒有找到可匯入的題組');
  return {id:stableId('bank',vignettes.map(v=>v.id).join('|')),name:filename,importedAt:new Date().toISOString(),vignettes,warnings:globalWarnings};
}
export async function parseDocx(file) {
  const zip=await readZip(file), document=zip.get('word/document.xml'); if(!document) throw new Error('不是有效的 DOCX：缺少 word/document.xml');
  const relsFile=zip.get('word/_rels/document.xml.rels'), rels={};
  if(relsFile){const xml=parseXml(await relsFile()); for(const r of xml.documentElement.children) rels[r.getAttribute('Id')]=r.getAttribute('Target');}
  const doc=parseXml(await document()), imageMap={};
  for(const blip of doc.getElementsByTagNameNS(A,'blip')) {const id=relId(blip),target=rels[id];if(!target||imageMap[id])continue;const path=target.startsWith('/')?target.slice(1):`word/${target.replace(/^\.\//,'')}`;const f=zip.get(path);if(f){const ext=path.split('.').pop();imageMap[id]=`data:image/${ext==='jpg'?'jpeg':ext};base64,${await f('base64')}`;}}
  return parseBlocks(makeBlocks(doc,imageMap),file.name);
}
