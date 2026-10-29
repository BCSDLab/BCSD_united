import { routeHasNoDays, warningsForRoute } from './routeIssues';
import { totalRouteCount, type BusConversion, type BusRoute } from './types';
import { escapeHtml } from '~/services/koin/reviewPage';

const DAY_LABELS: Record<string, string> = {
  MON: '월',
  TUE: '화',
  WED: '수',
  THU: '목',
  FRI: '금',
  SAT: '토',
  SUN: '일',
};

const daysLabel = (days?: BusRoute['route_info'][number]['running_days']) =>
  days?.map((day) => DAY_LABELS[day] ?? day).join(', ') ?? '운행요일 미지정';

function routeHtml(target: string, semester: string, route: BusRoute, matchedWarnings: string[], noDays: boolean) {
  const trips = route.route_info;
  const heads = trips
    .map(
      (trip) =>
        '<th>' +
        escapeHtml(trip.name) +
        '<br><small' +
        (trip.running_days?.length ? '' : ' class="missing" title="Slack에서 !수정 으로 운행요일을 지정하세요"') +
        '>' +
        escapeHtml(daysLabel(trip.running_days)) +
        '</small></th>',
    )
    .join('');
  const rows = route.node_info
    .map(
      (node, index) =>
        '<tr><th>' +
        escapeHtml(node.name) +
        '</th>' +
        trips.map((trip) => '<td>' + escapeHtml(trip.arrival_time[index]) + '</td>').join('') +
        '</tr>',
    )
    .join('');
  const attrs = [
    'class="route"',
    matchedWarnings.length ? 'data-issue="true"' : '',
    noDays ? 'data-no-days="true"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const search = [
    target,
    semester,
    route.region,
    route.route_type,
    route.route_name,
    noDays && '운행요일미지정',
    ...matchedWarnings,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const warningBanners = matchedWarnings.length
    ? '<p class="route-warning">' + matchedWarnings.map((warning) => escapeHtml(warning)).join('<br>') + '</p>'
    : '';
  const noDaysBadge = noDays
    ? '<p class="no-days-badge">운행요일 미지정 — Slack에서 <code>!수정</code>으로 지정하세요</p>'
    : '';
  return (
    '<section ' +
    attrs +
    ' data-search="' +
    escapeHtml(search) +
    '">' +
    warningBanners +
    noDaysBadge +
    '<h2>' +
    escapeHtml(route.region) +
    ' · ' +
    escapeHtml(route.route_type) +
    ' · ' +
    escapeHtml(route.route_name) +
    '</h2><p class="route-meta">' +
    escapeHtml(target) +
    ' · ' +
    escapeHtml(semester) +
    ' · 정류장 ' +
    route.node_info.length +
    '개 · 운행 ' +
    trips.length +
    '개</p><div class="tablebox"><table><thead><tr><th>정류장</th>' +
    heads +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table></div></section>'
  );
}

/** Human review page: route stops and every trip time only; payload JSON remains separate. */
export function renderBusReviewHtml(id: string, conversions: BusConversion[]) {
  const totalRoutes = totalRouteCount(conversions);
  let totalIssueRoutes = 0;
  let totalNoDaysRoutes = 0;
  const groups = conversions
    .map((conversion) => {
      const warnings = conversion.warnings.map((warning) =>
        typeof warning === 'string' ? warning : JSON.stringify(warning),
      );
      let issueRoutes = 0;
      let noDaysRoutes = 0;
      const routes = conversion.payloads
        .flatMap((payload) =>
          Object.values(payload.body)
            .flat()
            .map((route) => {
              const matched = warningsForRoute(warnings, route);
              const noDays = routeHasNoDays(route);
              if (matched.length) issueRoutes++;
              if (noDays) noDaysRoutes++;
              return routeHtml(payload.target, payload.semester_type, route, matched, noDays);
            }),
        )
        .join('');
      totalIssueRoutes += issueRoutes;
      totalNoDaysRoutes += noDaysRoutes;
      return (
        '<div class="semester"><h2>' +
        escapeHtml(conversion.version_update.title) +
        '</h2><p class="period">' +
        escapeHtml(conversion.version_update.content) +
        '</p>' +
        routes +
        '</div>'
      );
    })
    .join('');
  const css =
    ':root{--bg:#fff;--fg:#1a1a1a;--dim:#6b7280;--line:#e5e7eb;--panel:#f9fafb;--warn-bg:#fef3c7;--warn-fg:#92400e;--warn-line:#fcd34d;--note-bg:#eff6ff;--note-fg:#1e40af;--note-line:#93c5fd;--ok:#047857}@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--dim:#9ca3af;--line:#262b33;--panel:#171a20;--warn-bg:#3a2c0a;--warn-fg:#fcd34d;--warn-line:#7c5e10;--note-bg:#0b1524;--note-fg:#93c5fd;--note-line:#1e40af;--ok:#34d399}}*{box-sizing:border-box}html,body{width:100%;max-width:100%;overflow-x:hidden}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,AppleSDGothicNeo,MalgunGothic,sans-serif}.wrap{width:100%;max-width:1400px;min-width:0;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 6px}h3{font-size:14px;margin:0 0 8px}.sub,.semester-meta,.route-meta{color:var(--dim);font-size:13px}.sub{margin-bottom:20px}.period{font-weight:700;margin:0 0 2px}.tiles{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:120px}.tile .n{font-size:22px;font-weight:600}.tile .k{color:var(--dim);font-size:12px}.tile.warn{background:var(--warn-bg);border-color:var(--warn-line)}.tile.warn .n,.tile.warn .k{color:var(--warn-fg)}.tile.note{background:var(--note-bg);border-color:var(--note-line)}.tile.note .n,.tile.note .k{color:var(--note-fg)}.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}input[type=search]{flex:1;min-width:220px;padding:8px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:14px}button{padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:13px;cursor:pointer}button[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}.count{color:var(--dim);font-size:13px;margin-left:auto}.legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:12px;color:var(--dim);font-size:12px}.legend .dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}.legend .dot.warn{background:var(--warn-bg);border:1px solid var(--warn-line)}.legend .dot.note{background:var(--note-bg);border:1px solid var(--note-line)}.semester{width:100%;max-width:100%;min-width:0;margin:30px 0 36px}.route{width:100%;max-width:100%;min-width:0;margin:20px 0;padding:18px;border:1px solid var(--line);border-radius:8px}h1,h2,h3,p{overflow-wrap:anywhere}.view-issue .route[data-issue="true"]{background:var(--warn-bg);border-color:var(--warn-line)}.view-no-days .route[data-no-days="true"]{background:var(--note-bg);border-color:var(--note-line)}.view-no-days .route[data-no-days="true"] .missing{color:var(--note-fg);font-weight:600}.view-issue .no-days-badge{display:none}.view-no-days .route-warning{display:none}.view-all .route-warning{background:transparent;border-color:var(--line);color:var(--dim);font-weight:400}.view-all .no-days-badge{background:transparent;border-color:var(--line);color:var(--dim);font-weight:400}.route-warning{display:block;margin:0 0 8px;padding:3px 10px;border:1px solid var(--warn-line);border-radius:4px;background:var(--bg);color:var(--warn-fg);font-size:12px;font-weight:600}.no-days-badge{display:inline-block;margin:0 0 8px;padding:3px 10px;border:1px solid var(--note-line);border-radius:4px;background:var(--note-bg);color:var(--note-fg);font-size:12px;font-weight:700}.route-meta{margin:0 0 10px}.tablebox{width:100%;max-width:100%;min-width:0;overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg)}table{border-collapse:collapse;width:100%;min-width:max-content;font-size:13px}th,td{padding:7px 10px;text-align:center;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}th{position:sticky;top:0;background:var(--panel);font-weight:600;z-index:1}tbody th{text-align:left}tbody tr:hover{background:var(--panel)}small{font-weight:400;color:var(--dim)}.dim{color:var(--dim)}footer{margin-top:24px;color:var(--dim);font-size:12px}';
  const script = [
    '(function(){',
    'var groups=document.getElementById("groups"),routes=Array.prototype.slice.call(document.querySelectorAll("#groups .route")),q=document.getElementById("q"),count=document.getElementById("count"),buttons={all:document.getElementById("f-all"),issue:document.getElementById("f-issue"),"no-days":document.getElementById("f-no-days")},mode="all",totalIssue=routes.filter(function(r){return r.dataset.issue==="true";}).length,totalNoDays=routes.filter(function(r){return r.dataset.noDays==="true";}).length;',
    'function apply(){groups.className="view-"+mode;var term=q.value.trim().toLowerCase(),shown=0;routes.forEach(function(route){var okMode=mode==="all"||(mode==="issue"&&route.dataset.issue==="true")||(mode==="no-days"&&route.dataset.noDays==="true"),okTerm=term===""||(!route.dataset.search||route.dataset.search.indexOf(term)!==-1),visible=okMode&&okTerm;route.style.display=visible?"":"none";if(visible)shown++;});count.textContent=shown+" / "+(mode==="all"?routes.length:(mode==="issue"?totalIssue:totalNoDays))+"개 노선";}',
    'Object.keys(buttons).forEach(function(key){buttons[key].addEventListener("click",function(){mode=key;Object.keys(buttons).forEach(function(name){buttons[name].setAttribute("aria-pressed",String(name===key));});apply();});});',
    'q.addEventListener("input",apply);apply();})();',
  ].join('');
  return (
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>버스 시간표 검토</title><style>' +
    css +
    '</style></head><body><div class="wrap"><h1>버스 시간표 검토</h1><div class="sub">검수 ID ' +
    escapeHtml(id) +
    ' · 변환 결과를 원본 기준으로 확인하세요.</div><div class="tiles"><div class="tile"><div class="n">' +
    totalRoutes +
    '</div><div class="k">전체 노선</div></div><div class="tile' +
    (totalIssueRoutes > 0 ? ' warn' : '') +
    '"><div class="n">' +
    totalIssueRoutes +
    '</div><div class="k">확인 필요 노선</div></div><div class="tile' +
    (totalNoDaysRoutes > 0 ? ' note' : '') +
    '"><div class="n">' +
    totalNoDaysRoutes +
    '</div><div class="k">운행요일 미지정 노선</div></div></div><div class="legend"><span class="dot warn"></span>노란색 = 경고가 걸린 노선<span class="dot note"></span>파란색 = 운행요일 미지정 노선</div><div class="controls"><input type="search" id="q" placeholder="지역 · 방향 · 노선명 검색"><button id="f-all" aria-pressed="true">전체</button><button id="f-issue" aria-pressed="false">확인 필요</button><button id="f-no-days" aria-pressed="false">운행요일 미지정</button><span class="count" id="count"></span></div><div id="groups">' +
    groups +
    '</div><footer>정류장과 도착 시간을 원본 Excel과 대조하세요. 수정·반영은 Slack 승인 흐름에서 진행됩니다.</footer></div><script>' +
    script +
    '</script></body></html>'
  );
}
