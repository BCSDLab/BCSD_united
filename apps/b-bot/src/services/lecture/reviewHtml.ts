import { escapeHtml } from '~/services/koin/reviewPage';
import type { PreflightIssue } from './adminApi';
import { describeClassTime } from './describeTime';
import type { Lecture } from './types';

export interface ReviewPageInput {
  /** 어느 코인에 반영될 건지. 링크를 나중에 열었을 때도 알 수 있어야 한다. */
  envLabel: string;
  isProduction: boolean;
  year: number;
  /** `2학기`, `여름학기` 같은 한글 학기명. 사람이 읽는 값이라 enum이 아니다. */
  termName: string;
  sourceFileName: string;
  generatedAt: string;
  lectures: Lecture[];
  issues: PreflightIssue[];
  /** 변환 단계에서 강의시간을 해석하지 못한 행. */
  parseFailures: { row: number; value: string; message: string }[];
}

const ISSUE_LABEL: Record<PreflightIssue['kind'], string> = {
  too_long: '길이 초과',
  missing: '읽지 못함',
  empty_value: '값 없음',
  too_many_slots: '시간 개수 초과',
  slot_out_of_range: '시간 범위 벗어남',
  duplicate: '중복',
};

/**
 * 검토용 정적 HTML. 외부 요청 없이 파일 하나로 열린다.
 *
 * 검토자가 할 일은 900행을 다 읽는 게 아니라 **파싱이 맞았는지 판단하는 것**이다.
 * 그래서 원본 강의시간 문자열과 해석 결과를 나란히 놓는 열이 이 페이지의 핵심이고,
 * 확인이 필요한 행을 맨 위로 올린다.
 */
export function renderReviewPage(input: ReviewPageInput): string {
  const { envLabel, isProduction, year, termName, sourceFileName, generatedAt, lectures, issues, parseFailures } =
    input;

  const issuesByLecture = new Map<string, PreflightIssue[]>();
  for (const issue of issues) {
    const list = issuesByLecture.get(issue.lecture) ?? [];
    list.push(issue);
    issuesByLecture.set(issue.lecture, list);
  }

  const withoutTime = lectures.filter((l) => l.lecture_infos.length === 0).length;

  const rows = lectures
    .map((lecture) => {
      const label = `${lecture.code}|${lecture.lecture_class} ${lecture.name}`;
      const own = issuesByLecture.get(label) ?? [];
      const blocking = own.some((i) => i.severity === 'blocking');
      const noTime = lecture.lecture_infos.length === 0;
      const flags = [blocking ? 'issue' : '', own.length > 0 ? 'flagged' : '', noTime ? 'notime' : '']
        .filter(Boolean)
        .join(' ');

      const chips = own
        .map((i) => `<span class="chip ${i.severity}" title="${escapeHtml(i.detail)}">${ISSUE_LABEL[i.kind]}</span>`)
        .join('');

      return `<tr class="${flags}" data-search="${escapeHtml(
        `${lecture.code} ${lecture.name} ${lecture.professor} ${lecture.department}`.toLowerCase(),
      )}">
<td class="mono">${escapeHtml(lecture.code)}</td>
<td class="mono num">${escapeHtml(lecture.lecture_class)}</td>
<td>${escapeHtml(lecture.name)}${chips}</td>
<td>${escapeHtml(lecture.professor) || '<span class="dim">—</span>'}</td>
<td class="dim">${escapeHtml(lecture.department)}</td>
<td class="num">${escapeHtml(lecture.grades)}</td>
<td class="num">${escapeHtml(lecture.regular_number) || '<span class="dim">—</span>'}</td>
<td class="mono raw">${escapeHtml(lecture.raw_class_time) || '<span class="dim">—</span>'}</td>
<td class="parsed${noTime ? ' dim' : ''}">${escapeHtml(describeClassTime(lecture.lecture_infos))}</td>
</tr>`;
    })
    .join('\n');

  const blocking = issues.filter((i) => i.severity === 'blocking');
  const info = issues.filter((i) => i.severity === 'info');

  const summarize = (list: PreflightIssue[]) =>
    Object.entries(
      list.reduce<Record<string, number>>((acc, i) => {
        acc[ISSUE_LABEL[i.kind]] = (acc[ISSUE_LABEL[i.kind]] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([kind, count]) => `<li><b>${count}</b>건 · ${kind}</li>`)
      .join('');

  const failureRows = parseFailures
    .slice(0, 50)
    .map((f) => `<li><span class="mono">${f.row}행</span> "${escapeHtml(f.value)}" — ${escapeHtml(f.message)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${year} ${escapeHtml(termName)} 강의 검토</title>
<style>
:root {
  --bg: #ffffff; --fg: #1a1a1a; --dim: #6b7280; --line: #e5e7eb;
  --panel: #f9fafb; --warn-bg: #fef3c7; --warn-fg: #92400e; --warn-line: #fcd34d;
  --ok: #047857; --accent: #1d4ed8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --fg: #e5e7eb; --dim: #9ca3af; --line: #262b33;
    --panel: #171a20; --warn-bg: #3a2c0a; --warn-fg: #fcd34d; --warn-line: #7c5e10;
    --ok: #34d399; --accent: #93b4ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
}
.wrap { max-width: 1400px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: var(--dim); font-size: 13px; margin-bottom: 20px; }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
.tile {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 16px; min-width: 120px;
}
.tile .n { font-size: 22px; font-weight: 600; }
.tile .k { color: var(--dim); font-size: 12px; }
.tile.warn { background: var(--warn-bg); border-color: var(--warn-line); }
.tile.warn .n, .tile.warn .k { color: var(--warn-fg); }
.panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 14px 18px; margin-bottom: 20px;
}
.panel h2 { font-size: 14px; margin: 0 0 8px; }
.panel ul { margin: 0; padding-left: 18px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
input[type=search] {
  flex: 1; min-width: 200px; padding: 8px 12px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--bg); color: var(--fg); font-size: 14px;
}
button {
  padding: 8px 14px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); font-size: 13px; cursor: pointer;
}
button[aria-pressed=true] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.tablebox { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
th { position: sticky; top: 0; background: var(--panel); font-weight: 600; white-space: nowrap; z-index: 1; }
tbody tr:hover { background: var(--panel); }
tr.issue { background: var(--warn-bg); }
tr.issue:hover { filter: brightness(0.97); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.num { text-align: right; }
.dim { color: var(--dim); }
.raw { color: var(--dim); }
.parsed { color: var(--ok); }
.env {
  display: inline-block; margin-left: 8px; padding: 2px 10px; border-radius: 999px;
  background: var(--line); color: var(--dim); font-size: 12px; vertical-align: middle;
}
.env.prod { background: var(--warn-line); color: var(--warn-fg); font-weight: 600; }
.chip {
  display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 4px;
  font-size: 11px; white-space: nowrap;
}
.chip.blocking { background: var(--warn-line); color: var(--warn-fg); }
.chip.info { background: var(--line); color: var(--dim); }
footer { margin-top: 24px; color: var(--dim); font-size: 12px; }
.count { color: var(--dim); font-size: 13px; margin-left: auto; }
</style>
</head>
<body>
<div class="wrap">
<h1>${year} ${escapeHtml(termName)} 강의 검토 <span class="env${isProduction ? ' prod' : ''}">${escapeHtml(envLabel)}</span></h1>
<div class="sub">${escapeHtml(sourceFileName)} · ${escapeHtml(generatedAt)} 생성</div>

<div class="tiles">
  <div class="tile"><div class="n">${lectures.length}</div><div class="k">강의</div></div>
  <div class="tile"><div class="n">${withoutTime}</div><div class="k">시간 없음</div></div>
  <div class="tile${blocking.length > 0 ? ' warn' : ''}"><div class="n">${blocking.length}</div><div class="k">반영 불가</div></div>
  <div class="tile"><div class="n">${info.length}</div><div class="k">값 없음</div></div>
  <div class="tile${parseFailures.length > 0 ? ' warn' : ''}"><div class="n">${parseFailures.length}</div><div class="k">파싱 실패</div></div>
</div>

${
  parseFailures.length > 0 ? `<div class="panel"><h2>강의시간을 해석하지 못한 행</h2><ul>${failureRows}</ul></div>` : ''
}
${
  blocking.length > 0
    ? `<div class="panel"><h2>반영을 막는 항목</h2><ul>${summarize(blocking)}</ul>
<p class="dim" style="margin:8px 0 0">아래 표에서 노란 행이 해당 강의입니다. 하나라도 남으면 요청 전체가 거절됩니다.</p></div>`
    : ''
}
${
  info.length > 0
    ? `<div class="panel"><h2>엑셀에 값이 없는 항목</h2><ul>${summarize(info)}</ul>
<p class="dim" style="margin:8px 0 0">원본이 비어 있는 값입니다. 빈 값으로 보내며 반영은 됩니다. 정원은 0으로 보냅니다.</p></div>`
    : ''
}

<div class="controls">
  <input type="search" id="q" placeholder="과목코드 · 과목명 · 교수 · 학과 검색">
  <button id="f-all" aria-pressed="true">전체</button>
  <button id="f-issue" aria-pressed="false">반영 불가</button>
  <button id="f-flagged" aria-pressed="false">값 없음</button>
  <button id="f-notime" aria-pressed="false">시간 없음</button>
  <span class="count" id="count"></span>
</div>

<div class="tablebox">
<table>
<thead><tr>
<th>과목코드</th><th>분반</th><th>교과목명</th><th>담당교수</th><th>학과</th>
<th>학점</th><th>정원</th><th>원본 강의시간</th><th>해석된 시간</th>
</tr></thead>
<tbody id="rows">
${rows}
</tbody>
</table>
</div>

<footer>
원본 강의시간과 해석된 시간을 나란히 두었습니다. 둘이 어긋나면 파싱이 틀린 것입니다.<br>
반영·수정은 슬랙에서 진행합니다. 이 페이지는 확인용입니다.
</footer>
</div>

<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll("#rows tr"));
  var q = document.getElementById("q");
  var count = document.getElementById("count");
  var buttons = { all: document.getElementById("f-all"), issue: document.getElementById("f-issue"), flagged: document.getElementById("f-flagged"), notime: document.getElementById("f-notime") };
  var mode = "all";

  function apply() {
    var term = q.value.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (row) {
      var okMode = mode === "all" || row.classList.contains(mode);
      var okTerm = term === "" || row.dataset.search.indexOf(term) !== -1;
      var visible = okMode && okTerm;
      row.style.display = visible ? "" : "none";
      if (visible) shown += 1;
    });
    count.textContent = shown + " / " + rows.length + "건";
  }

  Object.keys(buttons).forEach(function (key) {
    buttons[key].addEventListener("click", function () {
      mode = key;
      Object.keys(buttons).forEach(function (k) {
        buttons[k].setAttribute("aria-pressed", String(k === key));
      });
      apply();
    });
  });

  q.addEventListener("input", apply);
  apply();
})();
</script>
</body>
</html>`;
}
