import { escapeHtml } from '~/services/koin/reviewPage';
import { displayHour } from './convert';
import type {
  AdminOperationHour,
  ConversionIssue,
  ConvertedCoopShop,
  RegularConversionResult,
  VacationSplitConversionResult,
} from './types';

function formatKoreanDate(value: string, includeYear: boolean): string {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return `${includeYear ? `${year}년 ` : ''}${month}월 ${day}일`;
}

const displayDay = (day: string): string => (day === 'FRIDAY' ? '금요일' : day);

function iconFor(name: string): string {
  const attrs = 'viewBox="0 0 24 24" aria-hidden="true"';
  if (name.includes('식당')) {
    return `<svg ${attrs}><path d="M6 3v7M9 3v7M6 7h3M7.5 10v11M16 3c-2 3-2 7 0 9v9M16 3c3 2 3 7 0 9"/></svg>`;
  }
  if (name.includes('서점')) {
    return `<svg ${attrs}><path d="M5 5.5 17 3v16.5L5 21zM8 5v13M17 19.5l2 1V4l-2-1"/></svg>`;
  }
  if (name.includes('우편')) {
    return `<svg ${attrs}><path d="M4 9h13v10H4zM4 10l6.5 5L17 10M17 12h3V5a3 3 0 0 0-3-3h-6"/></svg>`;
  }
  if (name.includes('세탁')) {
    return `<svg ${attrs}><path d="M4 7l5-3 3 3 3-3 5 3-3 5-2-1v9H9v-9l-2 1zM9 16c2-1 4 2 6 0"/></svg>`;
  }
  if (name.includes('미용')) {
    return `<svg ${attrs}><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="m8 8 11 11M8 16 19 5M11 11l-3 3"/></svg>`;
  }
  if (name.includes('안경')) {
    return `<svg ${attrs}><path d="M3 9h5l1 5a4 4 0 0 0 7 0l1-5h4M9 11h6"/></svg>`;
  }
  if (name.includes('복사')) {
    return `<svg ${attrs}><path d="M7 8V3h10v5M6 18H3V9h18v9h-3M7 14h10v7H7z"/></svg>`;
  }
  return `<svg ${attrs}><path d="M5 6h12v7a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5zM17 8h2a2 2 0 0 1 0 4h-2M5 21h13"/></svg>`;
}

function issueList(issues: ConversionIssue[]): string {
  if (issues.length === 0) return '';
  return `<ul class="issues">${issues
    .map(
      (issue) =>
        `<li class="${issue.severity}"><strong>${issue.severity === 'blocking' ? '확인 필요' : '안내'}</strong> ${escapeHtml(issue.detail)}</li>`,
    )
    .join('')}</ul>`;
}

function restaurantSchedule(hours: AdminOperationHour[]): string {
  const types = [...new Set(hours.map((hour) => hour.type).filter((type): type is string => Boolean(type)))];
  const days = ['평일', ...(hours.some((hour) => hour.day_of_week === 'FRIDAY') ? ['FRIDAY'] : []), '주말'];
  return `<div class="schedule-table"><table>
    <thead><tr><th>시간</th>${days.map((day) => `<th>${escapeHtml(displayDay(day))}</th>`).join('')}</tr></thead>
    <tbody>${types
      .map(
        (type) =>
          `<tr><th>${escapeHtml(type)}</th>${days
            .map((day) => {
              const hour =
                hours.find((item) => item.type === type && item.day_of_week === day) ??
                hours.find(
                  (item) =>
                    !item.type &&
                    item.day_of_week === day &&
                    item.open_time === item.close_time &&
                    !/^\d{1,2}:\d{2}$/.test(item.open_time),
                );
              return `<td${hour && !/^\d/.test(hour.open_time) ? ' class="state"' : ''}>${hour ? escapeHtml(displayHour(hour)) : '-'}</td>`;
            })
            .join('')}</tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

function simpleSchedule(hours: AdminOperationHour[]): string {
  return `<div class="schedule-lines">${hours
    .map(
      (hour) =>
        `<div><span>${escapeHtml(displayDay(hour.day_of_week))}${hour.type ? ` · ${escapeHtml(hour.type)}` : ''}</span><strong>${escapeHtml(displayHour(hour))}</strong></div>`,
    )
    .join('')}</div>`;
}

function rawHours(shop: ConvertedCoopShop): string {
  return shop.source.operationHours
    .map(
      (hour) =>
        `<li><span>${escapeHtml(hour.dayLabel)}${hour.type ? ` · ${escapeHtml(hour.type)}` : ''}</span>${escapeHtml(hour.rawText || `${hour.openTime} - ${hour.closeTime}`)}</li>`,
    )
    .join('');
}

function normalizedHours(shop: ConvertedCoopShop): string {
  return shop.admin.operation_hours
    .map(
      (hour) =>
        `<li><span>${escapeHtml(displayDay(hour.day_of_week))}${hour.type ? ` · ${escapeHtml(hour.type)}` : ''}</span>${escapeHtml(displayHour(hour))}</li>`,
    )
    .join('');
}

function shopCard(shop: ConvertedCoopShop, allIssues: ConversionIssue[]): string {
  const name = shop.admin.coop_shop_info.name;
  const issues = allIssues.filter(
    (issue) => issue.shop === name || issue.shop === `${shop.source.groupLabel} ${shop.source.shopLabel}`.trim(),
  );
  const hasBlocking = issues.some((issue) => issue.severity === 'blocking');
  const hasTypedHours = shop.admin.operation_hours.some((hour) => Boolean(hour.type));
  const originalName = `${shop.source.groupLabel} ${shop.source.shopLabel}`.trim();

  return `<article class="card${hasBlocking ? ' has-issue' : ''}">
    <div class="card-heading">
      <span class="icon">${iconFor(name)}</span>
      <div><h2>${escapeHtml(name)}</h2>${hasBlocking ? '<span class="badge">확인 필요</span>' : ''}</div>
    </div>
    ${hasTypedHours ? restaurantSchedule(shop.admin.operation_hours) : simpleSchedule(shop.admin.operation_hours)}
    <details>
      <summary>상세 검증</summary>
      <dl>
        <div><dt>위치</dt><dd>${escapeHtml(shop.admin.coop_shop_info.location)}</dd></div>
        <div><dt>전화</dt><dd>${escapeHtml(shop.admin.coop_shop_info.phone)}</dd></div>
        <div><dt>비고</dt><dd>${escapeHtml(shop.admin.coop_shop_info.remark || '없음')}</dd></div>
        <div><dt>원본 이름</dt><dd>${escapeHtml(originalName)}</dd></div>
        <div><dt>원본 전화</dt><dd>${escapeHtml(shop.source.phone || '없음')}</dd></div>
      </dl>
      <div class="compare">
        <section><h3>이미지 원문</h3><ul>${rawHours(shop)}</ul></section>
        <section><h3>최종 변환</h3><ul>${normalizedHours(shop)}</ul></section>
      </div>${
        issues.length > 0
          ? `
      ${issueList(issues)}`
          : ''
      }
    </details>
  </article>`;
}

export function renderRegularCoopReview(result: RegularConversionResult): string {
  const period = `${formatKoreanDate(result.fromDate, true)} - ${formatKoreanDate(result.toDate, false)}`;
  const cards = result.shops.map((shop) => shopCard(shop, result.issues)).join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(result.semester)} 시설물 운영 시간</title>
<style>
:root{color-scheme:light;--ink:#081a3a;--muted:#657084;--line:#d8dde5;--card:#fbfbfc;--icon:#eef7ff;--blue:#1685c7;--warn:#b42318;--warn-bg:#fff4f2;--info-bg:#f4f8fc}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;line-height:1.5}
main{max-width:1280px;margin:0 auto;padding:40px 40px 60px}header{margin-bottom:26px}h1{margin:0;color:#050505;font-size:clamp(28px,2.2vw,38px);letter-spacing:-.04em}header p{margin:8px 0 0;color:#424750;font-size:16px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start;gap:18px}.card{min-width:0;padding:20px;border-radius:18px;background:var(--card);border:1px solid transparent;box-shadow:0 1px 0 rgba(0,0,0,.02)}.card.has-issue{border-color:#f5b7ad;background:var(--warn-bg)}
.card-heading{display:flex;align-items:center;gap:14px;margin-bottom:14px}.icon{display:grid;place-items:center;flex:0 0 58px;width:58px;height:58px;border-radius:12px;background:var(--icon)}.icon svg{width:30px;height:30px;fill:none;stroke:#20242c;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.card h2{display:inline;margin:0;color:#050505;font-size:21px;letter-spacing:-.03em}.badge{display:inline-block;margin-left:6px;padding:2px 6px;border-radius:999px;background:#fee4e2;color:var(--warn);font-size:10px;vertical-align:3px}
.schedule-lines{display:grid;gap:6px;padding-left:72px;font-size:14px}.schedule-lines div{display:grid;grid-template-columns:minmax(62px,auto) 1fr;gap:9px}.schedule-lines span{font-weight:650}.schedule-lines strong{font-weight:650;color:var(--ink)}
.schedule-table{overflow-x:auto}.schedule-table table{width:100%;border-collapse:collapse;font-size:14px}.schedule-table th,.schedule-table td{padding:7px 8px;border-bottom:1px solid #d4d4d4;text-align:center}.schedule-table thead th{background:#f1f1f1}.schedule-table th:first-child{text-align:left}.schedule-table td.state{color:var(--blue)}
details{margin-top:16px;border-top:1px solid var(--line);padding-top:10px}summary{cursor:pointer;color:var(--muted);font-size:12px;font-weight:650}dl{display:grid;gap:4px;margin:10px 0;font-size:13px}dl div{display:grid;grid-template-columns:68px 1fr;gap:7px}dt{color:var(--muted)}dd{margin:0;word-break:break-word}.compare{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}.compare section{padding:9px;border-radius:8px;background:#fff;border:1px solid var(--line)}.compare h3{margin:0 0 5px;font-size:12px}.compare ul{list-style:none;margin:0;padding:0;font-size:11px}.compare li{display:grid;grid-template-columns:minmax(62px,auto) 1fr;gap:5px;margin-top:4px}.compare li span{color:var(--muted)}
.issues{margin:9px 0 0;padding:0;list-style:none}.issues li{margin-top:5px;padding:7px 8px;border-radius:7px;font-size:12px}.issues .blocking{background:#fee4e2;color:var(--warn)}.issues .info{background:var(--info-bg)}
@media(max-width:1050px){main{padding:32px 26px 50px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:680px){main{padding:26px 16px 42px}header{margin-bottom:22px}header p{font-size:15px}.grid{grid-template-columns:1fr;gap:14px}.card{padding:18px;border-radius:16px}.card h2{font-size:20px}.icon{width:54px;height:54px;flex-basis:54px}.schedule-lines{padding-left:0}.compare{grid-template-columns:1fr}}
@media print{main{max-width:none;padding:20px}summary{display:none}.grid{gap:12px}.card{break-inside:avoid;border:1px solid var(--line);padding:18px}details[open]>*:not(summary){display:none}}
</style>
</head>
<body><main>
<header><h1>${escapeHtml(result.semester)} 시설물 운영 시간</h1><p>기간 : ${escapeHtml(period)}</p></header>
<section class="grid">${cards}</section>
</main>
</body></html>`;
}

export function renderVacationCoopReview(result: VacationSplitConversionResult): string {
  const sections = [
    { label: '계절학기', value: result.seasonal },
    { label: '방학', value: result.vacation },
  ]
    .map(({ label, value }) => {
      const period = `${formatKoreanDate(value.fromDate, true)} - ${formatKoreanDate(value.toDate, false)}`;
      const cards = value.shops.map((shop) => shopCard(shop, value.issues)).join('\n');
      return `<section class="period"><header><h2>${escapeHtml(value.semester)} · ${label}</h2><p>기간 : ${escapeHtml(period)}</p></header><div class="grid">${cards}</div></section>`;
    })
    .join('\n');

  const regular = renderRegularCoopReview(result.seasonal);
  const style = regular.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${result.year}년 ${result.season} 생협 운영 시간</title>
<style>${style}
.period{margin-top:38px}.period>header{margin-bottom:18px}.period>header h2{font-size:26px}.period+.period{padding-top:34px;border-top:2px solid var(--line)}
</style></head><body><main>
<header><h1>${result.year}년 ${result.season} 생협 운영 시간</h1><p>방학 시작일 ${escapeHtml(formatKoreanDate(result.vacationStartDate, true))} 기준으로 두 학기를 분리했습니다.</p></header>
${sections}
</main></body></html>`;
}
