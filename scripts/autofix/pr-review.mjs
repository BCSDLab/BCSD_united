const SEVERITIES = ['P1', 'P2', 'P3'];
const DECISIONS = ['approved', 'changes-requested'];
const MAX_FINDINGS = 50;
const CONTROL = /(?![\t\n])[\p{Cc}\u2028\u2029]/gu;

function exact(value, keys) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',')
  );
}

function plainText(value, max) {
  if (typeof value !== 'string') throw new Error('Review text must be a string');
  const text = value.replace(CONTROL, '').trim();
  if (!text || text.length > max) throw new Error('Review text is empty or exceeds its bound');
  return text;
}

/**
 * Normalizes and bounds a structured review. Decision/severity are closed
 * enums; approval requires zero material (P1/P2) findings; a change request
 * requires at least one finding. Nothing here is invented from prose.
 */
export function validateReview(value) {
  if (!exact(value, ['decision', 'findings']) || !DECISIONS.includes(value.decision))
    throw new Error('Review decision is not a known value');
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS)
    throw new Error(`Review permits at most ${MAX_FINDINGS} findings`);
  const findings = value.findings.map((finding) => {
    if (!exact(finding, ['severity', 'path', 'line', 'message']) || !SEVERITIES.includes(finding.severity))
      throw new Error('Review finding has an unknown shape or severity');
    if (!Number.isSafeInteger(finding.line) || finding.line < 0 || finding.line > 1_000_000)
      throw new Error('Review finding line is out of range');
    const path = plainText(finding.path, 300);
    if (path.includes('\n') || path.includes('..') || path.startsWith('/'))
      throw new Error('Review finding path is unsafe');
    return { severity: finding.severity, path, line: finding.line, message: plainText(finding.message, 1000) };
  });
  const material = findings.filter((finding) => finding.severity !== 'P3').length;
  if (value.decision === 'approved' && material) throw new Error('Approval cannot carry unresolved P1/P2 findings');
  if (value.decision === 'changes-requested' && !findings.length)
    throw new Error('A change request must name at least one finding');
  return { decision: value.decision, findings };
}

/** The final answer ends with a fenced ```json block carrying the review; the last block is authoritative. */
export function parseReview(answer) {
  if (typeof answer !== 'string') throw new Error('Model answer missing');
  const blocks = [...answer.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)];
  if (!blocks.length) throw new Error('Model answer lacks a fenced json review block');
  let parsed;
  try {
    parsed = JSON.parse(blocks.at(-1)[1]);
  } catch {
    throw new Error('Model review block is not valid JSON');
  }
  return validateReview(parsed);
}
