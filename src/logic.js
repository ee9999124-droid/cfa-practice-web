export function available(vignettes, selected) {
  return vignettes.filter(v => selected.has(`t:${v.topic}`) || selected.has(`m:${v.topic}|${v.module}`));
}
export function chooseVignettes(pool, mode, amountType, amount, sessions, random=Math.random) {
  const attempts=sessions.filter(s=>s.submittedAt).flatMap(s=>s.answers||[]);
  const byQ=new Map(); attempts.forEach(a=>{if(!byQ.has(a.questionId))byQ.set(a.questionId,[]);byQ.get(a.questionId).push(a);});
  let candidates=pool.filter(v=>mode!=='wrong'||v.questions.some(q=>(byQ.get(q.id)||[]).at(-1)?.correct===false));
  const score=v=>v.questions.reduce((n,q)=>n+(byQ.has(q.id)?0:1),0);
  candidates=[...candidates].sort(mode==='unseen'?(a,b)=>score(b)-score(a):()=>random()-.5);
  if(amountType==='vignettes') return candidates.slice(0,amount);
  const out=[];let count=0; for(const v of candidates){if(out.length&&Math.abs(count-amount)<=Math.abs(count+v.questions.length-amount))break;out.push(v);count+=v.questions.length;if(count>=amount)break;} return out;
}
export function gradeSession(session, vignettes) {
  const qs=new Map(vignettes.flatMap(v=>v.questions.map(q=>[q.id,{...q,topic:v.topic,module:v.module}])));
  const answers=[...qs.entries()].map(([questionId,q])=>{const r=(session.responses||{})[questionId]||{};return {questionId,selected:r.selected||'',confidence:r.confidence||'',flagged:!!r.flagged,correct:!!r.selected&&r.selected===q.correctKey,topic:q.topic,module:q.module};});
  return {...session,answers,submittedAt:new Date().toISOString()};
}
export function summarize(sessions,vignettes) {
 const submitted=sessions.filter(s=>s.submittedAt); const totalByGroup=new Map();
 vignettes.forEach(v=>v.questions.forEach(q=>{for(const key of ['全部',v.topic,`${v.topic} / ${v.module}`]){if(!totalByGroup.has(key))totalByGroup.set(key,new Set());totalByGroup.get(key).add(q.id);}}));
 const attempts=new Map();submitted.forEach(s=>(s.answers||[]).forEach(a=>{if(!attempts.has(a.questionId))attempts.set(a.questionId,[]);attempts.get(a.questionId).push({...a,at:s.submittedAt});}));
 const groups=[]; for(const [name,total] of totalByGroup){const ids=[...total],done=ids.filter(id=>attempts.has(id));const first=done.map(id=>attempts.get(id)[0]);const latest=done.map(id=>attempts.get(id).at(-1));const wrongAgain=done.filter(id=>attempts.get(id).filter(a=>!a.correct).length>=2).length;const retries=done.flatMap(id=>attempts.get(id).slice(1).filter((a,i,arr)=>attempts.get(id)[i]?.correct===false));groups.push({name,total:ids.length,practiced:done.length,firstCorrect:first.filter(a=>a.correct).length,firstN:first.length,latestCorrect:latest.filter(a=>a.correct).length,latestN:latest.length,repeatedWrong:wrongAgain,retryCorrect:retries.filter(a=>a.correct).length,retryN:retries.length});}
 return groups;
}
