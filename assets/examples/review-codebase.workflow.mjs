export const meta = {
  name: 'review-codebase',
  description: 'Fan out structured code review over files, adversarially verify findings, aggregate a report',
  phases: [
    { title: 'Enumerate', detail: 'list candidate files' },
    { title: 'Review', detail: 'one reviewer agent per file' },
    { title: 'Verify', detail: 'adversarial check per finding' },
  ],
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'severity', 'title'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['isReal', 'reason'],
  properties: { isReal: { type: 'boolean' }, reason: { type: 'string' } },
}

phase('Enumerate')
const inventory = await agent(
  'List every source file worth reviewing in this repository. ' +
  'Return JSON: {"files": ["path", ...]} with at most 20 files.',
  { label: 'inventory', schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } } },
)
const files = (inventory && inventory.files) || []

phase('Review')
const reviewed = await pipeline(
  files,
  (file) => agent(
    'Review ' + file + ' for bugs, security issues and correctness problems. ' +
    'Only report findings you can point to concretely. Return JSON matching the schema.',
    { label: 'review:' + file, schema: FINDINGS },
  ),
  (review, file) => parallel(((review && review.findings) || []).map((f) => () =>
    agent(
      'Try to REFUTE this code review finding. Default to isReal=false if uncertain.\n' +
      'Finding: ' + JSON.stringify(f),
      { label: 'verify:' + file, schema: VERDICT },
    ).then((v) => ({ ...f, verdict: v })),
  )),
)

const confirmed = reviewed.flat().filter(Boolean).flat().filter((f) => f.verdict && f.verdict.isReal)
log(confirmed.length + ' confirmed findings')
return {
  filesReviewed: files.length,
  confirmed,
  report: '# Review Codebase Report\n\n- Files reviewed: ' + files.length + '\n- Confirmed findings: ' + confirmed.length + '\n\n' +
    confirmed.map((f) => '- [' + f.severity + '] ' + f.file + ':' + f.line + ' ' + f.title).join('\n'),
}
