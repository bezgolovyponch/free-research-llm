import fs from 'node:fs';
const W=process.argv[2], f=process.argv[3];
const p=JSON.parse(fs.readFileSync(f,'utf8'));
const { candidateDeliverables } = await import(W+'/src/research/candidates.mjs');
const measures = await import(W+'/src/research/measures.mjs');
const M = measures.adaptForChecklist(measures.MEASURES);
const cl = p.decisionModel?.checklist ?? p.checklist ?? [];
const items = cl.flatMap(c=>c.items??[]).filter(i=>i.numeric?.measure);
console.log('numeric items:', items.map(i=>`${i.clause} [${i.numeric.measure} ${i.numeric.op} ${i.numeric.value}] hard=${i.hard}`));
const d = candidateDeliverables(p.candidates);
console.log('deliverables', d.length, 'keys', Object.keys(d[0]??{}).join(','));
const decisionCriteria = p.decisionModel?.criteria ?? [];
const ctx = {
  trends: p.candidates?.sites?.trends ?? null,
  euHpi: p.candidates?.sites?.euHpi ?? null,
};
for (const i of items) {
  const m = M[i.numeric.measure];
  if(!m){ console.log(i.numeric.measure,'NO MEASURE'); continue; }
  let yes=0, no=0, unk=0;
  for (const x of d) {
    let v = m.read(x, ctx);
    let usedMeasure = i.numeric.measure;
    if (v === undefined) {
      for (const criterion of decisionCriteria) {
        if (criterion.measure && criterion.op === i.numeric.op && criterion.value === i.numeric.value && M[criterion.measure]) {
          const criterionMeasure = M[criterion.measure];
          const criterionVal = criterionMeasure.read(x, ctx);
          if (criterionVal !== undefined) {
            v = criterionVal;
            usedMeasure = criterion.measure;
            break;
          }
        }
      }
    }
    if (v === undefined || v === null || Number.isNaN(v)) {
      unk++;
    } else if (measures.compare(v, i.numeric.op, i.numeric.value)) {
      yes++;
    } else {
      no++;
    }
  }
  console.log(i.numeric.measure, 'yes',yes,'no',no,'unknown',unk);
}
