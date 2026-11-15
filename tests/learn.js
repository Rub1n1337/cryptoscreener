// «Учёба» data checks for the preview (learn.js: MODULES, GLOSS, CHECKS):
//   await (await import('/tests/learn.js?' + Date.now())).run()
// Returns {ok, ...lists}; every list must be empty: data-term without a dictionary entry, duplicate entry ids, lessons
// without 2–3 questions, malformed questions (no text, fewer than 2 answers, ok out of range, no explanation, repeated answers).
export async function run() {
  const {MODULES, GLOSS} = await import('/learn.js?' + Date.now());
  const ids = GLOSS.map(g => g.id), set = new Set(ids);
  const dupGloss = ids.filter((id, i) => ids.indexOf(id) !== i);
  const emptyGloss = GLOSS.filter(g => !g.t || !g.d).map(g => g.id);
  const missingTerms = [], noCheck = [], badCheck = [];
  for (const m of MODULES) for (const l of m.lessons) {
    const k = m.id + '/' + l.id;
    for (const r of l.body.matchAll(/data-term="([^"]*)"/g)) if (!set.has(r[1])) missingTerms.push(k + ': ' + r[1]);
    if (!l.check || l.check.length < 2 || l.check.length > 3) noCheck.push(k);
    (l.check || []).forEach((q, i) => {
      if (!q.q || !q.why || !(q.a?.length >= 2) || !(Number.isInteger(q.ok) && q.ok >= 0 && q.ok < q.a.length) || new Set(q.a).size !== q.a.length) badCheck.push(k + ' #' + (i + 1));
    });
  }
  const lessons = MODULES.reduce((n, m) => n + m.lessons.length, 0);
  const questions = MODULES.reduce((n, m) => n + m.lessons.reduce((s, l) => s + (l.check?.length || 0), 0), 0);
  const ok = !dupGloss.length && !emptyGloss.length && !missingTerms.length && !noCheck.length && !badCheck.length;
  return {ok, lessons, questions, terms:GLOSS.length, dupGloss, emptyGloss, missingTerms, noCheck, badCheck};
}
