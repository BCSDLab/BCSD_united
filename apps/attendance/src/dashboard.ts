/**
 * 벽걸이 화면용 단일 HTML입니다. 서버 데이터는 모두 textContent로만 그려
 * 회원 이름 등 사용자 입력이 마크업으로 해석되지 않게 합니다.
 */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>BCSD 출근부</title>
<style>
  :root {
    color-scheme:light;
    --bg:#f7f8fc; --surface:#fff; --surface-low:#f0f2f8; --surface-high:#e7eaf4;
    --text:#1c2436; --muted:#626c80; --outline:#d7ddeb; --line:#e6eaf2;
    --primary:#4c5dcc; --on-primary:#fff; --primary-container:#e8ecff; --on-primary-container:#28366f;
    --green:#22664e; --green-container:#d9f3e7; --on-green-container:#174a38;
    --amber:#775414; --amber-container:#fff0ce; --error:#a72c39; --error-container:#ffebed;
    --shadow:0 4px 20px #1b233306;
  }
  :root[data-theme="dark"] {
    color-scheme:dark;
    --bg:#10131b; --surface:#1b202c; --surface-low:#222837; --surface-high:#2b3243;
    --text:#e4e8f6; --muted:#b2bbd0; --outline:#505b73; --line:#323b4e;
    --primary:#bac5ff; --on-primary:#1e2d64; --primary-container:#28365f; --on-primary-container:#e0e6ff;
    --green:#a0dfc2; --green-container:#1c4036; --on-green-container:#b4f1d5;
    --amber:#f0cc86; --amber-container:#45391f; --error:#ffb2bc; --error-container:#482630;
    --shadow:none;
  }
  @media (prefers-color-scheme:dark) {
    :root:not([data-theme="light"]) {
      color-scheme:dark;
      --bg:#10131b; --surface:#1b202c; --surface-low:#222837; --surface-high:#2b3243;
      --text:#e4e8f6; --muted:#b2bbd0; --outline:#505b73; --line:#323b4e;
      --primary:#bac5ff; --on-primary:#1e2d64; --primary-container:#28365f; --on-primary-container:#e0e6ff;
      --green:#a0dfc2; --green-container:#1c4036; --on-green-container:#b4f1d5;
      --amber:#f0cc86; --amber-container:#45391f; --error:#ffb2bc; --error-container:#482630;
      --shadow:none;
    }
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif; word-break:keep-all; -webkit-font-smoothing:antialiased; }
  button, input { font:inherit; }
  button { cursor:pointer; }
  button:disabled { cursor:default; opacity:.65; }
  button, input, a, [tabindex] { -webkit-tap-highlight-color:transparent; }
  :focus-visible { outline:3px solid var(--primary); outline-offset:4px; }
  button { min-height:44px; border:0; border-radius:999px; padding:10px 18px; font-size:14px; font-weight:650; }
  button:hover:not(:disabled) { filter:brightness(.94); }
  .button-tonal { background:var(--primary-container); color:var(--on-primary-container); }
  .button-text { background:transparent; color:var(--primary); }
  .button-filled { background:var(--primary); color:var(--on-primary); }
  .button-outline { background:transparent; color:var(--text); border:1px solid var(--outline); }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
  .skip-link { position:fixed; top:12px; left:12px; z-index:10; transform:translateY(-180%); padding:12px 20px; border-radius:16px; background:var(--primary); color:var(--on-primary); }
  .skip-link:focus { transform:none; }
  .workspace { max-width:1800px; min-height:100vh; margin:0 auto; }
  .app-shell { min-width:0; padding:32px 36px 24px; }
  .app-header { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:26px; padding-bottom:22px; border-bottom:1px solid var(--line); }
  .brand { display:flex; align-items:center; gap:14px; }
  .eyebrow { margin:0; color:var(--muted); font-size:11px; font-weight:750; letter-spacing:.13em; }
  h1 { margin:5px 0 0; font-size:29px; font-weight:750; letter-spacing:-.055em; line-height:1.3; }
  .header-actions { display:flex; align-items:center; gap:10px; }
  .clock-block { text-align:right; margin-right:14px; }
  #clock { display:block; font-size:25px; font-weight:650; font-variant-numeric:tabular-nums; letter-spacing:-.03em; line-height:1.3; }
  #date { display:block; color:var(--muted); font-size:12px; }
  main { display:grid; gap:24px; }
  .section-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:20px; }
  h2 { margin:0; font-size:19px; font-weight:700; letter-spacing:-.035em; }
  .section-description { margin:4px 0 0; color:var(--muted); font-size:13px; }
  .panel { min-width:0; background:var(--surface); padding:26px; border:1px solid var(--line); border-radius:24px; box-shadow:var(--shadow); }
  .pill { display:inline-flex; align-items:center; gap:7px; flex-shrink:0; padding:5px 11px; border-radius:999px; background:var(--surface-low); color:var(--muted); font-size:12px; font-weight:650; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .pill-live { background:var(--green-container); color:var(--on-green-container); }
  .pill-warn { background:var(--amber-container); color:var(--amber); }
  .hero { padding:0; overflow:hidden; display:grid; grid-template-columns:250px minmax(0,1fr); background:var(--surface); }
  .occupancy { padding:28px; background:var(--primary-container); color:var(--on-primary-container); display:flex; flex-direction:column; justify-content:space-between; gap:22px; }
  .occupancy h2 { font-size:17px; }
  .occupancy-number { display:flex; align-items:baseline; gap:10px; margin:5px 0 0; }
  #count { font-size:clamp(76px,7vw,112px); line-height:1; letter-spacing:-.07em; font-weight:650; font-variant-numeric:tabular-nums; }
  .occupancy-unit { font-size:24px; font-weight:550; }
  #member-count { margin:10px 0 0; font-size:13px; }
  .occupancy-note { margin:0; font-size:12px; opacity:.85; }
  .present-content { min-width:0; padding:28px; }
  .present-content .section-heading { margin-bottom:18px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
  .person-card { min-width:0; background:var(--green-container); color:var(--on-green-container); border-radius:20px; padding:19px 20px; }
  .person-top { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  .avatar { display:grid; place-items:center; width:34px; height:34px; border:1px solid currentColor; border-radius:50%; font-size:13px; font-weight:700; flex-shrink:0; }
  .person-name { margin:0; overflow-wrap:anywhere; font-size:19px; font-weight:700; }
  .elapsed { display:block; font-size:32px; letter-spacing:-.025em; font-weight:600; line-height:1.25; font-variant-numeric:tabular-nums; }
  .person-card small { display:block; margin-top:5px; font-size:12px; }
  .empty-state { padding:26px 16px; text-align:center; color:var(--muted); }
  .empty-state strong { display:block; color:var(--text); font-size:16px; font-weight:650; }
  .empty-state p { margin:6px 0 0; font-size:13px; }
  .empty-symbol { display:grid; place-items:center; width:44px; height:44px; margin:0 auto 12px; border-radius:16px; background:var(--surface-low); color:var(--primary); font-size:24px; }
  .loading { padding:28px 8px; color:var(--muted); font-size:14px; }
  .loading::before { content:""; display:inline-block; width:8px; height:8px; margin-right:10px; border-radius:50%; background:var(--primary); }
  .summary-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
  .summary-card { padding:22px 24px; border:1px solid var(--line); border-radius:20px; background:var(--surface); }
  .summary-label { margin:0; font-size:13px; font-weight:600; color:var(--muted); }
  .summary-value { margin:8px 0 4px; font-size:28px; line-height:1.3; font-weight:650; letter-spacing:-.04em; font-variant-numeric:tabular-nums; }
  .summary-note { margin:0; font-size:12px; color:var(--muted); }
  .summary-card.attention { background:var(--amber-container); color:var(--amber); }
  .summary-card.attention .summary-label, .summary-card.attention .summary-note { color:inherit; }
  .table-scroll { overflow-x:auto; border-radius:12px; }
  table { width:100%; border-collapse:collapse; text-align:left; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .members-table { min-width:730px; }
  .recent-table { min-width:510px; }
  th, td { padding:15px 14px; border-bottom:1px solid var(--line); }
  thead th { padding-top:12px; padding-bottom:12px; background:var(--surface-low); font-size:12px; font-weight:600; color:var(--muted); }
  thead th:first-child { border-radius:12px 0 0 12px; }
  thead th:last-child { border-radius:0 12px 12px 0; }
  tbody th { font-weight:650; white-space:normal; min-width:110px; max-width:240px; overflow-wrap:anywhere; }
  tbody tr:last-child > * { border-bottom:0; }
  td { font-size:14px; }
  .duration { font-weight:650; color:var(--primary); }
  .muted { color:var(--muted); }
  .warn { color:var(--amber); }
  .table-note { margin:16px 0 0; color:var(--muted); font-size:12px; }
  .bottom-grid { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(320px,1fr); align-items:start; gap:24px; }
  #unknown { display:grid; gap:12px; }
  .enrollment-form { padding:18px; background:var(--surface-low); border-radius:20px; }
  .card-meta { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:6px 12px; margin-bottom:16px; }
  .card-meta code { font-size:14px; font-weight:650; overflow-wrap:anywhere; }
  .card-meta small { color:var(--muted); font-size:11px; }
  .field-label { display:block; margin:0 0 6px 2px; font-size:12px; font-weight:650; }
  .field-row { display:flex; align-items:start; gap:10px; }
  input { width:100%; min-width:0; min-height:48px; padding:11px 13px; background:var(--surface); border:1px solid var(--outline); border-radius:12px; color:var(--text); }
  input::placeholder { color:var(--muted); }
  .field-row button { min-height:48px; flex-shrink:0; }
  .form-message { margin:10px 0 0; font-size:12px; overflow-wrap:anywhere; }
  .form-message:empty { display:none; }
  .success { color:var(--green); }
  .error-banner { display:flex; justify-content:space-between; align-items:center; gap:16px; background:var(--error-container); color:var(--error); border-radius:20px; padding:16px 22px; }
  .error-banner p { margin:0; font-size:14px; }
  .error-banner button { color:inherit; flex-shrink:0; }
  .sync-row { display:flex; align-items:center; flex-wrap:wrap; justify-content:space-between; gap:10px; padding:0 4px; }
  #sync-status { display:inline-flex; align-items:center; gap:8px; color:var(--muted); font-size:12px; }
  #sync-status[data-state="ready"] { color:var(--green); }
  #sync-status[data-state="error"] { color:var(--error); }
  .sync-note { margin:0; color:var(--muted); font-size:12px; }
  footer { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:24px 4px 0; color:var(--muted); font-size:11px; }
  footer p { margin:0; }
  @media (min-width:1600px) {
    .app-shell { max-width:1600px; }
    .hero { grid-template-columns:300px minmax(0,1fr); }
    .person-name { font-size:22px; }
    .elapsed { font-size:38px; }
  }
  @media (max-width:1050px) {
    .app-shell { padding:24px; }
    .hero { grid-template-columns:220px minmax(0,1fr); }
    .occupancy, .present-content { padding:24px; }
    .bottom-grid { grid-template-columns:minmax(0,1fr); }
    #unknown { grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
    .clock-block { margin-right:0; }
  }
  @media (max-width:700px) {
    h1 { font-size:26px; }
    .app-shell { padding:20px 16px; }
    .app-header { flex-wrap:wrap; gap:18px; margin-bottom:20px; }
    .header-actions { width:100%; justify-content:flex-end; gap:6px; }
    .clock-block { margin-right:auto; text-align:left; }
    #clock { font-size:21px; }
    .header-actions button { padding:10px 13px; font-size:12px; }
    main { gap:18px; }
    .hero { grid-template-columns:minmax(0,1fr); }
    .occupancy { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"heading count" "note note"; align-items:center; gap:16px; padding:24px; }
    .occupancy > div:first-child { grid-area:heading; }
    .occupancy-number { grid-area:count; margin:0; }
    #count { font-size:76px; }
    #member-count { margin:6px 0 0; }
    .occupancy-note { grid-area:note; padding-top:14px; border-top:1px solid currentColor; }
    .present-content, .panel { padding:22px 18px; }
    .hero.panel { padding:0; }
    .cards { grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); }
    .person-card { padding:16px; }
    .elapsed { font-size:29px; }
    .summary-grid { gap:10px; }
    .summary-card { padding:17px 14px; border-radius:20px; }
    .summary-value { font-size:22px; }
    .summary-note { font-size:11px; }
    h2 { font-size:17px; }
    .section-heading { gap:10px; }
    .error-banner { padding:16px; }
    .error-banner button { padding:8px; }
    #unknown { grid-template-columns:minmax(0,1fr); }
  }
  @media (max-width:420px) {
    .summary-grid { grid-template-columns:minmax(0,1fr); gap:8px; }
    .summary-card { display:grid; grid-template-columns:1fr auto; align-items:center; column-gap:12px; }
    .summary-value { grid-column:2; grid-row:1 / 3; margin:0; }
    .summary-note { grid-column:1; }
    .cards { grid-template-columns:minmax(0,1fr); }
    .occupancy { padding:22px 18px; }
    .occupancy-note { max-width:none; font-size:11px; }
  }
  .pager { display:flex; align-items:center; justify-content:flex-end; gap:5px; flex-shrink:0; min-height:26px; margin-left:auto; color:var(--muted); font-size:10px; }
  .pager button { min-width:25px; min-height:26px; padding:3px 7px; font-size:13px; }
  @media (min-width:1000px) and (min-aspect-ratio:3/2) {
    html, body { height:100%; overflow:hidden; }
    .workspace { height:100dvh; min-height:0; max-width:none; }
    .app-shell { display:flex; flex-direction:column; height:100%; width:100%; max-width:none; padding:20px 24px 12px; overflow:hidden; }
    .app-header { flex-shrink:0; padding-bottom:12px; margin-bottom:12px; gap:16px; }
    h1 { font-size:clamp(25px,3vh,52px); margin-top:2px; }
    .eyebrow { font-size:9px; }
    .clock-block { margin-right:6px; }
    #clock { font-size:clamp(22px,2.6vh,44px); }
    #date { font-size:10px; }
    .header-actions { gap:7px; }
    .header-actions button { min-height:36px; padding:8px 12px; font-size:11px; }
    main { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1.8fr) minmax(290px,1fr); grid-template-rows:auto minmax(0,.9fr) minmax(0,1.2fr) minmax(0,1fr) 18px; grid-template-areas:"error error" "hero summary" "members unknown" "recent unknown" "sync sync"; gap:10px 12px; }
    #error { grid-area:error; padding:8px 12px; border-radius:12px; }
    #error p { font-size:11px; }
    .hero { grid-area:hero; grid-template-columns:clamp(180px,13vw,340px) minmax(0,1fr); grid-template-rows:minmax(0,1fr); }
    .summary-grid { grid-area:summary; grid-template-columns:minmax(0,1fr); grid-template-rows:repeat(3,minmax(0,1fr)); gap:6px; }
    #members-overview { grid-area:members; }
    #recent-section { grid-area:recent; }
    #unknown-section { grid-area:unknown; }
    .bottom-grid { display:contents; }
    .sync-row { grid-area:sync; }
    .panel { min-height:0; border-radius:18px; padding:14px 16px; overflow:hidden; }
    .panel:not(.hero), .present-content { display:flex; flex-direction:column; min-height:0; }
    .hero.panel { padding:0; }
    .occupancy { min-height:0; padding:14px; gap:6px; }
    .occupancy h2 { font-size:clamp(13px,1.5vh,26px); }
    #count { font-size:clamp(46px,7vh,136px); }
    .occupancy-unit { font-size:clamp(19px,2.1vh,36px); }
    .occupancy-number { margin:0; }
    #member-count { margin-top:4px; font-size:10px; }
    .occupancy-note { font-size:10px; }
    .present-content { padding:14px 16px; overflow:hidden; }
    .section-heading, .present-content .section-heading { flex-shrink:0; gap:8px; margin-bottom:8px; }
    h2 { font-size:clamp(14px,1.8vh,30px); }
    .section-description { margin-top:2px; font-size:10px; }
    .pill { padding:3px 8px; gap:5px; font-size:10px; }
    .cards { flex:1; min-height:0; grid-template-columns:repeat(auto-fit,minmax(145px,1fr)); align-content:start; gap:7px; overflow:hidden; }
    .cards:empty, #unknown:empty { display:none; }
    .person-card { padding:10px 12px; border-radius:14px; }
    .person-top { gap:7px; margin-bottom:5px; }
    .avatar { width:24px; height:24px; font-size:10px; }
    .person-name { font-size:clamp(13px,1.5vh,24px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .elapsed { font-size:clamp(24px,2.8vh,46px); }
    .person-card small { margin-top:3px; font-size:9px; }
    .empty-state { flex:1; display:grid; align-content:center; padding:8px; }
    .empty-state strong { font-size:clamp(12px,1.5vh,24px); }
    .empty-state p { margin-top:4px; font-size:clamp(10px,1.2vh,20px); }
    .empty-symbol { width:28px; height:28px; margin-bottom:7px; border-radius:10px; font-size:17px; }
    .summary-card { display:grid; grid-template-columns:minmax(0,1fr) auto; align-content:center; align-items:center; column-gap:8px; padding:6px 14px; border-radius:14px; }
    .summary-label { font-size:clamp(11px,1.3vh,22px); }
    .summary-value { grid-column:2; grid-row:1 / 3; margin:0; font-size:clamp(23px,2.7vh,46px); }
    .summary-note { grid-column:1; font-size:9px; line-height:1.4; }
    .table-scroll { flex:1; min-height:0; overflow:hidden; }
    table { table-layout:fixed; }
    .members-table, .recent-table { min-width:0; }
    th, td { padding:5px 7px; font-size:clamp(11px,1.3vh,22px); line-height:1.5; overflow:hidden; text-overflow:ellipsis; }
    thead th { padding:5px 7px; font-size:clamp(10px,1.1vh,18px); }
    tbody th { min-width:0; max-width:none; white-space:nowrap; }
    .members-table th:first-child { width:20%; }
    .table-note { flex-shrink:0; margin-top:7px; font-size:9px; line-height:1.5; }
    #unknown { flex:1; min-height:0; display:block; overflow:hidden; }
    .enrollment-form { padding:12px; border-radius:14px; }
    .card-meta { margin-bottom:10px; gap:5px; }
    .card-meta code { font-size:12px; }
    .card-meta small { font-size:9px; }
    .field-label { font-size:10px; }
    input, .field-row button { min-height:36px; padding:7px 10px; font-size:12px; }
    .form-message { font-size:10px; margin-top:7px; line-height:1.5; }
    #sync-status, .sync-note { font-size:9px; }
    footer { flex-shrink:0; padding:8px 2px 0; font-size:8px; }
  }
  @media (prefers-reduced-motion:no-preference) {
    button { transition:background-color .15s, filter .15s; }
  }
</style>
</head>
<body>
<a class="skip-link" href="#main">본문으로 건너뛰기</a>
<div class="workspace">
<div class="app-shell">
  <header class="app-header">
    <div class="brand">
      <div><p class="eyebrow">CLUBROOM / ATTENDANCE</p><h1>출입 현황</h1></div>
    </div>
    <div class="header-actions">
      <div class="clock-block"><time id="clock"></time><span id="date">한국 표준시 · KST</span></div>
      <button class="button-outline" id="theme" type="button" aria-label="화면 테마 변경, 현재 자동">테마 · 자동</button>
      <button class="button-tonal" id="refresh" type="button">새로고침</button>
    </div>
  </header>
  <main id="main" tabindex="-1">
    <div class="error-banner" id="error" hidden>
      <p id="error-message" role="alert"></p>
      <button class="button-text" id="retry" type="button">다시 시도</button>
    </div>
    <section class="hero panel" aria-labelledby="occupancy-heading">
      <div class="occupancy">
        <div><h2 id="occupancy-heading">지금 동아리방에는</h2><p id="member-count">등록 회원 확인 중</p></div>
        <div class="occupancy-number"><span id="count">—</span><span class="occupancy-unit">명</span></div>
        <p class="occupancy-note">함께 몰입하는 시간, 이곳에서.</p>
      </div>
      <div class="present-content" id="present-region" aria-busy="true">
        <div class="section-heading"><h2 id="present-heading">지금 있는 사람</h2><span class="pill pill-live"><span class="dot" aria-hidden="true"></span>입실 현황</span></div>
        <p class="loading" id="present-loading">동아리방 현황을 불러오고 있습니다.</p>
        <div class="cards" id="present" role="list" aria-labelledby="present-heading"></div>
        <div class="empty-state" id="present-empty" hidden><span class="empty-symbol" aria-hidden="true">↗</span><strong>첫 입실을 기다리고 있어요</strong><p>리더에 등록된 카드를 태그하면 여기에 표시됩니다.</p></div>
      </div>
    </section>
    <section class="summary-grid" aria-label="체류 시간 요약">
      <div class="summary-card"><h2 class="summary-label">오늘 함께한 시간</h2><p class="summary-value" id="today-total">—</p><p class="summary-note">전체 회원 체류 시간 합계</p></div>
      <div class="summary-card"><h2 class="summary-label">이번 주 함께한 시간</h2><p class="summary-value" id="week-total">—</p><p class="summary-note">월요일부터 지금까지 · KST</p></div>
      <div class="summary-card" id="unrecorded-summary"><h2 class="summary-label">이번 주 퇴근 미기록</h2><p class="summary-value" id="unrecorded-total">—</p><p class="summary-note">미기록 세션은 시간 합계에서 제외</p></div>
    </section>
    <section class="panel" id="members-overview" aria-labelledby="members-heading">
      <div class="section-heading"><div><h2 id="members-heading">이번 주의 발자취</h2><p class="section-description">회원별 입실 현황과 오늘 · 이번 주 체류 시간</p></div><span class="pill" id="members-badge">확인 중</span></div>
      <p class="loading" id="members-loading">회원별 기록을 불러오고 있습니다.</p>
      <div class="table-scroll" id="members-table" role="region" aria-label="회원별 체류 시간, 가로 스크롤 가능" tabindex="0" hidden>
        <table class="members-table"><caption class="sr-only">회원별 현재 상태, 오늘 첫 입실 시각, 오늘과 이번 주 체류 시간, 퇴근 미기록 건수</caption>
          <thead><tr><th scope="col">이름</th><th scope="col">현재 상태</th><th scope="col">오늘 첫 입실</th><th scope="col">오늘</th><th scope="col">이번 주</th><th scope="col">퇴근 미기록</th></tr></thead>
          <tbody id="members"></tbody>
        </table>
      </div>
      <div class="empty-state" id="members-empty" hidden><strong>아직 등록된 회원이 없어요</strong><p>카드를 태그한 뒤 아래 미등록 카드에서 이름을 등록해 주세요.</p></div>
      <p class="table-note">퇴실 태그 없이 6시간이 지난 세션은 ‘퇴근 미기록’으로 표시하며 체류 시간에서 제외합니다.</p>
    </section>
    <div class="bottom-grid">
      <section class="panel" id="recent-section" aria-labelledby="recent-heading">
        <div class="section-heading"><div><h2 id="recent-heading">최근 기록</h2><p class="section-description">이번 주 기록 중 최근 입실 순 · 최대 15건</p></div><span class="pill" id="recent-badge">확인 중</span></div>
        <p class="loading" id="recent-loading">최근 입실 · 퇴실 기록을 불러오고 있습니다.</p>
        <div class="table-scroll" id="recent-table" role="region" aria-label="최근 입실과 퇴실 기록, 가로 스크롤 가능" tabindex="0" hidden>
          <table class="recent-table"><caption class="sr-only">최근 세션의 회원 이름, 입실과 퇴실 시각, 체류 시간</caption><thead><tr><th scope="col">이름</th><th scope="col">입실</th><th scope="col">퇴실</th><th scope="col">체류</th></tr></thead><tbody id="recent"></tbody></table>
        </div>
        <div class="empty-state" id="recent-empty" hidden><strong>이번 주 기록을 기다리고 있어요</strong><p>등록된 카드로 입실하면 기록이 시작됩니다.</p></div>
      </section>
      <section class="panel" id="unknown-section" aria-labelledby="unknown-heading">
        <div class="section-heading"><div><h2 id="unknown-heading">미등록 카드</h2><p class="section-description">카드의 주인을 연결해 주세요.</p></div><span class="pill" id="unknown-badge">확인 중</span></div>
        <p class="loading" id="unknown-loading">새로 태그한 카드를 확인하고 있습니다.</p>
        <div id="unknown"></div>
        <div class="empty-state" id="unknown-empty" hidden><span class="empty-symbol" aria-hidden="true">✓</span><strong>등록을 기다리는 카드가 없어요</strong><p>새 카드를 리더에 태그하면 여기에 나타납니다.</p></div>
        <p class="table-note">이름은 최대 30자입니다. 등록 후 카드를 다시 태그하면 입실이 기록됩니다. 미등록 카드는 7일 뒤 자동 삭제됩니다.</p>
      </section>
    </div>
    <div class="sync-row"><span id="sync-status" role="status" data-state="loading"><span class="dot" aria-hidden="true"></span><span id="sync-label">첫 데이터를 불러오는 중</span></span><p class="sync-note"><span id="last-updated">아직 동기화되지 않음</span> · 10초마다 갱신</p></div>
    <p id="enrollment-status" class="sr-only" role="status"></p>
  </main>
  <footer><p>BCSD LAB · 작은 태그 하나로 이어지는 우리의 하루</p><p>모든 시각은 KST · 저장소 반영에 최대 약 60초 소요될 수 있습니다.</p></footer>
</div>
</div>
<noscript><p>출근부를 보거나 카드를 등록하려면 브라우저에서 JavaScript를 활성화해 주세요.</p></noscript>
<script>
  var POLL_MS = 10000;
  var timeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  var dateTimeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  var clockFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  var dateFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'full' });
  var serverOffset = 0;
  var hasState = false;
  var lastStateAt = 0;
  var refreshing = false;
  var unknownForms = new Map();
  var theme = 'auto';

  var wallQuery = window.matchMedia('(min-width:1000px) and (min-aspect-ratio:3/2)');
  var pagePositions = new Map();
  var fitFrame = 0;

  function fitSection(id, kind) {
    var container = document.getElementById(id);
    var items = Array.from(container.children);
    var viewport = kind === 'table' ? container.closest('.table-scroll') : container;
    var pager = document.getElementById(id + '-pager');
    items.forEach(function (item) { item.hidden = false; });
    if (!wallQuery.matches || items.length === 0) {
      if (pager) pager.hidden = true;
      return;
    }
    if (!pager) {
      pager = el('div', 'pager');
      pager.id = id + '-pager';
      pager.setAttribute('role', 'group');
      var names = { present: '현재 입실자', members: '회원 기록', recent: '최근 활동', unknown: '미등록 카드' };
      pager.setAttribute('aria-label', names[id] + ' 페이지');
      var previous = el('button', 'button-tonal', '‹');
      var range = el('span');
      var next = el('button', 'button-tonal', '›');
      previous.type = next.type = 'button';
      previous.setAttribute('aria-label', names[id] + ' 이전 페이지');
      next.setAttribute('aria-label', names[id] + ' 다음 페이지');
      previous.addEventListener('click', function () { pagePositions.set(id, (pagePositions.get(id) || 0) - 1); fitSection(id, kind); });
      next.addEventListener('click', function () { pagePositions.set(id, (pagePositions.get(id) || 0) + 1); fitSection(id, kind); });
      pager.append(previous, range, next);
      var panel = viewport.closest('.present-content') || viewport.closest('section');
      panel.querySelector('.section-heading').appendChild(pager);
    }
    var limit = 1;
    if (kind === 'table') {
      var header = viewport.querySelector('thead');
      var rowHeight = items[0].getBoundingClientRect().height || 28;
      limit = Math.max(1, Math.floor((viewport.clientHeight - header.getBoundingClientRect().height) / rowHeight));
    } else if (kind === 'cards') {
      var styles = getComputedStyle(container);
      var columns = styles.gridTemplateColumns.split(' ').length;
      var gap = parseFloat(styles.rowGap) || 0;
      var cardHeight = items[0].getBoundingClientRect().height || 90;
      limit = Math.max(1, Math.floor((viewport.clientHeight + gap) / (cardHeight + gap))) * columns;
    }
    var lastPage = Math.max(0, Math.ceil(items.length / limit) - 1);
    var page = Math.max(0, Math.min(pagePositions.get(id) || 0, lastPage));
    pagePositions.set(id, page);
    var start = page * limit;
    items.forEach(function (item, index) { item.hidden = index < start || index >= start + limit; });
    pager.hidden = lastPage === 0;
    pager.children[0].disabled = page === 0;
    pager.children[1].textContent = (start + 1) + '–' + Math.min(start + limit, items.length) + ' / ' + items.length;
    pager.children[2].disabled = page === lastPage;
  }

  function fitWall() {
    fitSection('present', 'cards');
    fitSection('members', 'table');
    fitSection('recent', 'table');
    fitSection('unknown', 'forms');
  }

  function scheduleFit() {
    if (!fitFrame) fitFrame = requestAnimationFrame(function () { fitFrame = 0; fitWall(); });
  }
  window.addEventListener('resize', scheduleFit);
  wallQuery.addEventListener('change', scheduleFit);
  if (typeof ResizeObserver !== 'undefined') {
    var wallResizeObserver = new ResizeObserver(scheduleFit);
    ['present', 'members-table', 'recent-table', 'unknown'].forEach(function (id) { wallResizeObserver.observe(document.getElementById(id)); });
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    var label = theme === 'auto' ? '자동' : theme === 'light' ? '라이트' : '다크';
    document.getElementById('theme').textContent = '테마 · ' + label;
    document.getElementById('theme').setAttribute('aria-label', '화면 테마 변경, 현재 ' + label + '. 자동, 라이트, 다크 순으로 전환');
  }
  try {
    var savedTheme = localStorage.getItem('attendance-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') theme = savedTheme;
  } catch (error) { /* 저장소가 차단되어도 테마 전환은 동작합니다. */ }
  applyTheme();
  document.getElementById('theme').addEventListener('click', function () {
    theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
    applyTheme();
    try { localStorage.setItem('attendance-theme', theme); } catch (error) { /* 현재 화면에만 적용합니다. */ }
  });

  function formatDuration(ms) {
    var minutes = Math.floor(Math.max(0, ms) / 60000);
    var hours = Math.floor(minutes / 60);
    return hours > 0 ? hours + '시간 ' + (minutes % 60) + '분' : minutes + '분';
  }

  function formatClockDuration(ms) {
    var seconds = Math.floor(Math.max(0, ms) / 1000);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(Math.floor(seconds / 3600)) + ':' + pad(Math.floor(seconds / 60) % 60) + ':' + pad(seconds % 60);
  }

  function serverNow() { return Date.now() + serverOffset; }

  function renderPresent(members) {
    var present = members.filter(function (m) { return m.present; });
    var container = document.getElementById('present');
    container.replaceChildren();
    present.forEach(function (m) {
      var card = el('div', 'person-card');
      card.setAttribute('role', 'listitem');
      var top = el('div', 'person-top');
      var avatar = el('span', 'avatar', Array.from(m.name)[0] || '·');
      avatar.setAttribute('aria-hidden', 'true');
      top.append(avatar, el('h3', 'person-name', m.name));
      var elapsed = el('span', 'elapsed', formatClockDuration(serverNow() - m.since));
      elapsed.dataset.since = String(m.since);
      card.append(top, elapsed, el('small', '', timeFormat.format(m.since) + ' 입실 · 체류 시간'));
      container.appendChild(card);
    });
    document.getElementById('present-empty').hidden = present.length > 0;
    document.getElementById('count').textContent = String(present.length);
    document.getElementById('member-count').textContent = '전체 등록 회원 ' + members.length + '명';
  }

  function renderSummary(members) {
    var today = 0;
    var week = 0;
    var unrecorded = 0;
    members.forEach(function (m) { today += m.todayMs; week += m.weekMs; unrecorded += m.unrecordedWeek; });
    document.getElementById('today-total').textContent = formatDuration(today);
    document.getElementById('week-total').textContent = formatDuration(week);
    document.getElementById('unrecorded-total').textContent = unrecorded + '건';
    document.getElementById('unrecorded-summary').classList.toggle('attention', unrecorded > 0);
  }

  function renderMembers(members) {
    var body = document.getElementById('members');
    body.replaceChildren();
    members.forEach(function (m) {
      var row = el('tr');
      var name = el('th', '', m.name);
      name.scope = 'row';
      var status = el('td');
      status.appendChild(el('span', m.present ? 'pill pill-live' : 'pill', m.present ? '입실 중' : '퇴실'));
      row.append(name, status);
      row.appendChild(el('td', 'muted', m.firstInToday === null ? '—' : timeFormat.format(m.firstInToday)));
      row.appendChild(el('td', '', formatDuration(m.todayMs)));
      row.appendChild(el('td', 'duration', formatDuration(m.weekMs)));
      row.appendChild(el('td', m.unrecordedWeek > 0 ? 'warn' : 'muted', m.unrecordedWeek > 0 ? m.unrecordedWeek + '건 · 시간 제외' : '—'));
      body.appendChild(row);
    });
    document.getElementById('members-table').hidden = members.length === 0;
    document.getElementById('members-empty').hidden = members.length > 0;
    document.getElementById('members-badge').textContent = members.length + '명';
  }

  function renderRecent(recent) {
    var body = document.getElementById('recent');
    body.replaceChildren();
    recent.forEach(function (r) {
      var row = el('tr');
      var name = el('th', '', r.name);
      name.scope = 'row';
      row.appendChild(name);
      row.appendChild(el('td', 'muted', dateTimeFormat.format(r.checkIn)));
      if (r.unrecorded) {
        row.appendChild(el('td', 'warn', '퇴근 미기록'));
        row.appendChild(el('td', 'muted', '시간 제외'));
      } else if (r.checkOut === null) {
        row.appendChild(el('td', 'success', '입실 중'));
        row.appendChild(el('td', 'duration', formatDuration(serverNow() - r.checkIn)));
      } else {
        row.appendChild(el('td', 'muted', dateTimeFormat.format(r.checkOut)));
        row.appendChild(el('td', 'duration', formatDuration(r.checkOut - r.checkIn)));
      }
      body.appendChild(row);
    });
    document.getElementById('recent-table').hidden = recent.length === 0;
    document.getElementById('recent-empty').hidden = recent.length > 0;
    document.getElementById('recent-badge').textContent = recent.length + '건';
  }

  function createEnrollment(card) {
    var form = el('form', 'enrollment-form');
    var meta = el('div', 'card-meta');
    var seen = el('small');
    meta.append(el('code', '', card.uid), seen);
    var input = el('input');
    input.id = 'member-name-' + card.uid;
    input.name = 'name';
    input.placeholder = '카드 주인의 이름';
    input.maxLength = 30;
    input.required = true;
    input.autocomplete = 'off';
    var label = el('label', 'field-label', '등록할 이름');
    label.htmlFor = input.id;
    var button = el('button', 'button-filled', '등록');
    button.type = 'submit';
    button.setAttribute('aria-label', card.uid + ' 카드 등록');
    var field = el('div', 'field-row');
    field.append(input, button);
    var message = el('p', 'form-message');
    message.id = 'member-message-' + card.uid;
    message.setAttribute('role', 'status');
    input.setAttribute('aria-describedby', message.id);
    form.append(meta, label, field, message);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      register(card.uid, input, button, message, form);
    });
    return { form: form, seen: seen };
  }

  function renderUnknown(cards) {
    var container = document.getElementById('unknown');
    var active = new Set(cards.map(function (card) { return card.uid; }));
    unknownForms.forEach(function (entry, uid) {
      if (!active.has(uid)) { entry.form.remove(); unknownForms.delete(uid); }
    });
    cards.forEach(function (card) {
      var entry = unknownForms.get(card.uid);
      if (!entry) {
        entry = createEnrollment(card);
        unknownForms.set(card.uid, entry);
        container.appendChild(entry.form);
      }
      // 폴링 중에도 폼과 포커스를 유지하고 카드 메타데이터만 갱신합니다.
      entry.seen.textContent = card.count + '회 태그 · ' + dateTimeFormat.format(card.lastSeen);
    });
    document.getElementById('unknown-empty').hidden = cards.length > 0;
    document.getElementById('unknown-badge').textContent = cards.length + '건';
    document.getElementById('unknown-badge').classList.toggle('pill-warn', cards.length > 0);
  }

  function showError(message) {
    document.getElementById('error').hidden = message === null;
    var node = document.getElementById('error-message');
    var text = message === null ? '' : message;
    if (node.textContent !== text) node.textContent = text;
    scheduleFit();
  }

  function setSync(state, label) {
    document.getElementById('sync-status').dataset.state = state;
    var node = document.getElementById('sync-label');
    if (node.textContent !== label) node.textContent = label;
  }

  async function register(uid, input, button, message, form) {
    var name = input.value.trim();
    if (!name) {
      input.setCustomValidity('공백이 아닌 이름을 입력해 주세요.');
      input.reportValidity();
      input.addEventListener('input', function clearValidity() {
        input.setCustomValidity('');
        input.removeEventListener('input', clearValidity);
      });
      return;
    }
    button.disabled = true;
    input.disabled = true;
    button.textContent = '등록 중';
    form.setAttribute('aria-busy', 'true');
    message.className = 'form-message';
    message.textContent = '카드를 등록하고 있습니다.';
    try {
      var response = await fetch('/api/members', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid: uid, name: name }),
      });
      if (!response.ok) {
        message.className = 'form-message warn';
        message.textContent = response.status === 401
          ? '인증이 만료되었습니다. 페이지를 다시 열고 로그인해 주세요.'
          : '등록하지 못했습니다 (' + response.status + '). 이름을 확인하고 다시 시도해 주세요.';
        button.disabled = false;
        input.disabled = false;
        button.textContent = '다시 등록';
        return;
      }
      button.textContent = '등록 완료';
      message.className = 'form-message success';
      message.textContent = '등록했습니다. 목록에 반영되기까지 최대 약 60초 걸릴 수 있습니다. 카드를 다시 태그해 주세요.';
      document.getElementById('enrollment-status').textContent = name + '님의 카드를 등록했습니다. 입실하려면 카드를 다시 태그해 주세요.';
      refresh();
    } catch (error) {
      message.className = 'form-message warn';
      message.textContent = '연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 등록해 주세요.';
      button.disabled = false;
      input.disabled = false;
      button.textContent = '다시 등록';
    } finally {
      form.setAttribute('aria-busy', 'false');
    }
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    document.getElementById('refresh').disabled = true;
    document.getElementById('retry').disabled = true;
    document.getElementById('refresh').textContent = '갱신 중';
    try {
      var response = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(String(response.status));
      var state = await response.json();
      serverOffset = state.now - Date.now();
      renderPresent(state.members);
      renderSummary(state.members);
      renderMembers(state.members);
      renderRecent(state.recent);
      renderUnknown(state.unknownCards);
      hasState = true;
      lastStateAt = state.now;
      document.querySelectorAll('.loading').forEach(function (node) { node.hidden = true; });
      document.getElementById('present-region').setAttribute('aria-busy', 'false');
      document.getElementById('last-updated').textContent = '마지막 동기화 ' + clockFormat.format(state.now);
      showError(null);
      setSync('ready', '동기화 정상');
      scheduleFit();
      tick();
    } catch (error) {
      document.querySelectorAll('.loading').forEach(function (node) {
        node.hidden = true;
      });
      document.getElementById('present-region').setAttribute('aria-busy', 'false');
      var authenticationError = error instanceof Error && error.message === '401';
      showError(authenticationError
        ? '인증할 수 없습니다. 페이지를 다시 열고 대시보드 비밀번호를 확인해 주세요.'
        : hasState ? '갱신하지 못했습니다. 마지막으로 받은 데이터를 표시하고 있습니다. 10초마다 다시 시도합니다.'
        : '데이터를 불러오지 못했습니다. 연결 상태를 확인해 주세요. 10초마다 다시 시도합니다.');
      setSync('error', hasState ? '연결 끊김 · 이전 데이터' : '연결 대기 · 데이터 없음');
      if (!hasState) {
        document.getElementById('member-count').textContent = '등록 회원 정보 없음';
        ['members-badge', 'recent-badge', 'unknown-badge'].forEach(function (id) {
          document.getElementById(id).textContent = '데이터 없음';
        });
      }
      tick();
    } finally {
      refreshing = false;
      document.getElementById('refresh').disabled = false;
      document.getElementById('retry').disabled = false;
      document.getElementById('refresh').textContent = '새로고침';
    }
  }

  function tick() {
    var now = serverNow();
    var elapsedNow = document.getElementById('sync-status').dataset.state === 'error' ? lastStateAt : now;
    document.getElementById('clock').textContent = clockFormat.format(now);
    document.getElementById('clock').dateTime = new Date(now).toISOString();
    document.getElementById('date').textContent = dateFormat.format(now) + ' · KST';
    document.querySelectorAll('.elapsed').forEach(function (node) {
      node.textContent = formatClockDuration(elapsedNow - Number(node.dataset.since));
    });
  }
  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('retry').addEventListener('click', refresh);
  tick();
  setInterval(tick, 1000);
  setInterval(refresh, POLL_MS);
  refresh();
</script>
</body>
</html>
`;
