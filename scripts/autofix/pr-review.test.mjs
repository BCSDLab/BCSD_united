import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, validateReview } from './pr-review.mjs';

const finding = {
  severity: 'P2',
  path: 'apps/web/src/components/Order/index.tsx',
  line: 42,
  message: 'State is not reset',
};

test('structured review parsing takes only the final fenced block and closed enums', () => {
  const answer = [
    'I inspected the change. Example output format:',
    '```json',
    '{"decision":"approved","findings":[]}',
    '```',
    'Actual review:',
    '```json',
    JSON.stringify({ decision: 'changes-requested', findings: [finding] }),
    '```',
  ].join('\n');
  assert.deepEqual(parseReview(answer), { decision: 'changes-requested', findings: [finding] });
  assert.deepEqual(parseReview('```json\n{"decision":"approved","findings":[]}\n```'), {
    decision: 'approved',
    findings: [],
  });
  assert.deepEqual(
    parseReview(
      '```json\n{"decision":"approved","findings":[{"severity":"P3","path":"apps/web/README.md","line":0,"message":"typo \\u0007here"}]}\n```',
    ).findings[0].message,
    'typo here',
  );
  for (const bad of [
    'No fenced block at all {"decision":"approved","findings":[]}',
    '```json\nnot json\n```',
    '```json\n{"decision":"approved","findings":[{"severity":"P3","path":"apps/web/README.md","line":0,"message":"invalid \u0007 JSON"}]}\n```',
    '```json\n{"decision":"merge","findings":[]}\n```',
    '```json\n{"decision":"approved","findings":[],"publish":true}\n```',
    `\`\`\`json\n${JSON.stringify({ decision: 'approved', findings: [finding] })}\n\`\`\``,
    '```json\n{"decision":"changes-requested","findings":[]}\n```',
    `\`\`\`json\n${JSON.stringify({ decision: 'changes-requested', findings: [{ ...finding, severity: 'P0' }] })}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify({ decision: 'changes-requested', findings: [{ ...finding, line: 1.5 }] })}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify({ decision: 'changes-requested', findings: [{ ...finding, path: '../x' }] })}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify({ decision: 'changes-requested', findings: [{ ...finding, message: 'x'.repeat(1001) }] })}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify({ decision: 'changes-requested', findings: Array.from({ length: 51 }, () => finding) })}\n\`\`\``,
    undefined,
  ])
    assert.throws(() => parseReview(bad), undefined, String(bad).slice(0, 60));
  assert.throws(() => validateReview({ decision: 'approved', findings: [{ ...finding, severity: 'P1' }] }));
  assert.deepEqual(
    validateReview({ decision: 'approved', findings: [{ ...finding, severity: 'P3' }] }).findings.length,
    1,
  );
});
