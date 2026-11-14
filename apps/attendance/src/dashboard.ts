import { solarThemeScript } from './sun.ts';

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
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif; word-break:keep-all; -webkit-font-smoothing:antialiased; }
  button, input { font:inherit; }
  button { cursor:pointer; }
  button:disabled { cursor:default; opacity:.65; }
  button, input, a, [tabindex] { -webkit-tap-highlight-color:transparent; }
  :focus-visible { outline:3px solid var(--primary); outline-offset:4px; }
  button { min-height:44px; border:0; border-radius:999px; padding:10px 18px; font-size:16px; font-weight:650; }
  button:hover:not(:disabled) { filter:brightness(.94); }
  .button-tonal { background:var(--primary-container); color:var(--on-primary-container); }
  .button-text { background:transparent; color:var(--primary); }
  .button-filled { background:var(--primary); color:var(--on-primary); }
  .button-outline { background:transparent; color:var(--text); border:1px solid var(--outline); }
  .login-panel { width:min(100%,420px); margin:auto; padding:32px; background:var(--surface); border:1px solid var(--line); border-radius:24px; box-shadow:var(--shadow); }
  .login-panel h2 { margin:0 0 8px; font-size:24px; }
  .login-panel p { color:var(--muted); font-size:16px; }
  .login-panel label { display:block; margin:18px 0 6px; font-size:16px; font-weight:650; }
  .login-panel input { width:100%; min-height:48px; padding:11px 13px; border:1px solid var(--outline); border-radius:12px; background:var(--surface); color:var(--text); font:inherit; font-size:16px; }
  .login-panel button { width:100%; margin-top:22px; }
  .login-panel .login-error { min-height:1.5em; color:var(--error); }
  .viewer-name { color:var(--muted); font-size:12px; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
  .skip-link { position:fixed; top:12px; left:12px; z-index:10; transform:translateY(-180%); padding:12px 20px; border-radius:16px; background:var(--primary); color:var(--on-primary); }
  .skip-link:focus { transform:none; }
  .workspace { max-width:1800px; min-height:100vh; margin:0 auto; }
  .app-shell { min-width:0; padding:32px 36px 24px; }
  .app-header { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:26px; padding-bottom:22px; border-bottom:1px solid var(--line); }
  .brand { display:flex; align-items:center; gap:14px; }
  h1 { margin:5px 0 0; font-size:29px; font-weight:750; letter-spacing:-.055em; line-height:1.3; }
  .header-actions { display:flex; align-items:center; gap:10px; }
  .clock-block { text-align:right; margin-right:14px; }
  #clock { display:block; font-size:25px; font-weight:650; font-variant-numeric:tabular-nums; letter-spacing:-.03em; line-height:1.3; }
  #date { display:block; color:var(--muted); font-size:12px; }
  main { display:grid; gap:24px; }
  .section-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:20px; }
  h2 { margin:0; font-size:19px; font-weight:700; letter-spacing:-.035em; }
  .panel { min-width:0; background:var(--surface); padding:26px; border:1px solid var(--line); border-radius:24px; box-shadow:var(--shadow); }
  .pill { display:inline-flex; align-items:center; gap:7px; flex-shrink:0; padding:5px 11px; border-radius:999px; background:var(--surface-low); color:var(--muted); font-size:16px; font-weight:650; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:currentColor; flex-shrink:0; }
  .pill-live { background:var(--green-container); color:var(--on-green-container); }
  .pill-warn { background:var(--amber-container); color:var(--amber); }
  .hero { padding:0; overflow:hidden; display:grid; grid-template-columns:250px minmax(0,1fr); background:var(--surface); }
  .occupancy { padding:28px; background:var(--primary-container); color:var(--on-primary-container); display:flex; flex-direction:column; justify-content:space-between; gap:22px; }
  .occupancy h2 { font-size:17px; }
  .occupancy-number { display:flex; align-items:baseline; gap:10px; margin:5px 0 0; }
  #count { font-size:clamp(76px,7vw,112px); line-height:1; letter-spacing:-.07em; font-weight:650; font-variant-numeric:tabular-nums; }
  .occupancy-unit { font-size:24px; font-weight:550; }
  #member-count { margin:10px 0 0; font-size:16px; }
  .present-content { min-width:0; padding:28px; }
  .present-content .section-heading { margin-bottom:18px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
  .person-card { min-width:0; background:var(--green-container); color:var(--on-green-container); border-radius:20px; padding:19px 20px; }
  .person-name { margin:0 0 12px; overflow-wrap:anywhere; font-size:19px; font-weight:700; }
  .elapsed { display:block; font-size:32px; letter-spacing:-.025em; font-weight:600; line-height:1.25; font-variant-numeric:tabular-nums; }
  .empty-state { padding:26px 16px; text-align:center; color:var(--muted); }
  .empty-state strong { display:block; color:var(--text); font-size:16px; font-weight:650; }
  .empty-state p { margin:6px 0 0; font-size:16px; }
  .empty-symbol { display:grid; place-items:center; width:44px; height:44px; margin:0 auto 12px; border-radius:16px; background:var(--surface-low); color:var(--primary); font-size:24px; }
  .loading { padding:28px 8px; color:var(--muted); font-size:16px; }
  .loading::before { content:""; display:inline-block; width:8px; height:8px; margin-right:10px; border-radius:50%; background:var(--primary); }
  .summary-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
  .summary-card { padding:22px 24px; border:1px solid var(--line); border-radius:20px; background:var(--surface); }
  .summary-label { margin:0; font-size:16px; font-weight:600; color:var(--muted); }
  .summary-value { margin:8px 0 4px; font-size:28px; line-height:1.3; font-weight:650; letter-spacing:-.04em; font-variant-numeric:tabular-nums; }
  .summary-card.attention { background:var(--amber-container); color:var(--amber); }
  .summary-card.attention .summary-label { color:inherit; }
  .table-scroll { overflow-x:auto; border-radius:12px; }
  table { width:100%; border-collapse:collapse; text-align:left; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .members-table { min-width:840px; }
  th, td { padding:15px 14px; border-bottom:1px solid var(--line); }
  thead th { padding-top:12px; padding-bottom:12px; background:var(--surface-low); font-size:16px; font-weight:600; color:var(--muted); }
  thead th:first-child { border-radius:12px 0 0 12px; }
  thead th:last-child { border-radius:0 12px 12px 0; }
  tbody th { font-weight:650; white-space:normal; min-width:110px; max-width:240px; overflow-wrap:anywhere; }
  tbody tr:last-child > * { border-bottom:0; }
  td { font-size:16px; }
  .duration { font-weight:650; color:var(--primary); }
  .muted { color:var(--muted); }
  .warn { color:var(--amber); }
  .wifi-codes { display:flex; justify-content:space-evenly; gap:12px; }
  .wifi-code { min-width:0; margin:0; text-align:center; }
  .wifi-code img { display:block; width:150px; height:150px; max-width:100%; margin:0 auto; object-fit:contain; background:#fff; }
  .wifi-code figcaption { margin-top:4px; font-size:16px; font-weight:650; }
  .wifi-status { margin:8px 0; color:var(--muted); font-size:16px; }
  .error-banner { display:flex; justify-content:space-between; align-items:center; gap:16px; background:var(--error-container); color:var(--error); border-radius:20px; padding:16px 22px; }
  .error-banner p { margin:0; font-size:16px; }
  .error-banner button { color:inherit; flex-shrink:0; }
  .sync-row { display:flex; align-items:center; flex-wrap:wrap; justify-content:space-between; gap:10px; padding:0 4px; }
  #sync-status { display:inline-flex; align-items:center; gap:8px; color:var(--muted); font-size:12px; }
  #sync-status[data-state="ready"] { color:var(--green); }
  #sync-status[data-state="error"] { color:var(--error); }
  .sync-note { margin:0; color:var(--muted); font-size:12px; }
  footer { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:24px 4px 0; color:var(--muted); font-size:11px; }
  footer p { margin:0; }
  .sync-row, footer { display:none !important; }
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
    .clock-block { margin-right:0; }
  }
  @media (max-width:700px) {
    h1 { font-size:26px; }
    .app-shell { padding:20px 16px; }
    .app-header { flex-wrap:wrap; gap:18px; margin-bottom:20px; }
    .header-actions { width:100%; justify-content:flex-end; gap:6px; }
    .clock-block { margin-right:auto; text-align:left; }
    #clock { font-size:21px; }
    .header-actions button { padding:10px 13px; font-size:16px; }
    main { gap:18px; }
    .hero { grid-template-columns:minmax(0,1fr); }
    .occupancy { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"heading count" "note note"; align-items:center; gap:16px; padding:24px; }
    .occupancy > div:first-child { grid-area:heading; }
    .occupancy-number { grid-area:count; margin:0; }
    #count { font-size:76px; }
    #member-count { margin:6px 0 0; }
    .present-content, .panel { padding:22px 18px; }
    .hero.panel { padding:0; }
    .cards { grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); }
    .person-card { padding:16px; }
    .elapsed { font-size:29px; }
    .summary-grid { gap:10px; }
    .summary-card { padding:17px 14px; border-radius:20px; }
    .summary-value { font-size:22px; }
    h2 { font-size:17px; }
    .section-heading { gap:10px; }
    .error-banner { padding:16px; }
    .error-banner button { padding:8px; }
  }
  @media (max-width:420px) {
    .summary-grid { grid-template-columns:minmax(0,1fr); gap:8px; }
    .summary-card { display:grid; grid-template-columns:1fr auto; align-items:center; column-gap:12px; }
    .summary-value { grid-column:2; grid-row:1; margin:0; }
    .cards { grid-template-columns:minmax(0,1fr); }
    .occupancy { padding:22px 18px; }
  }
  .pager { display:flex; align-items:center; justify-content:flex-end; gap:5px; flex-shrink:0; min-height:44px; margin-left:auto; color:var(--muted); font-size:16px; }
  .pager button { min-width:44px; min-height:44px; padding:4px 8px; font-size:16px; }
  @media (min-width:1000px) and (min-aspect-ratio:3/2) {
    html, body { height:100%; overflow:hidden; }
    .workspace { height:100dvh; min-height:0; max-width:none; }
    .app-shell { display:flex; flex-direction:column; height:100%; width:100%; max-width:none; padding:20px 24px 12px; overflow:hidden; }
    .app-header { flex-shrink:0; padding-bottom:12px; margin-bottom:12px; gap:16px; }
    h1 { font-size:clamp(32px,4vh,60px); margin-top:2px; }
    .clock-block { margin-right:6px; }
    #clock { font-size:clamp(28px,3.5vh,50px); }
    #date { font-size:14px; }
    .header-actions { gap:7px; }
    .header-actions button { min-height:44px; padding:10px 14px; font-size:16px; }
    main { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1.8fr) minmax(290px,1fr); grid-template-rows:auto minmax(180px,1.6fr) minmax(140px,1fr) minmax(180px,.7fr) 0; grid-template-areas:"error error" "hero hero" "members summary" "members wifi" "sync sync"; gap:10px 12px; }
    #error { grid-area:error; padding:8px 12px; border-radius:12px; }
    #error p { font-size:16px; }
    .hero { grid-area:hero; grid-template-columns:clamp(180px,13vw,340px) minmax(0,1fr); grid-template-rows:minmax(0,1fr); }
    .summary-grid { grid-area:summary; grid-template-columns:minmax(0,1fr); grid-template-rows:repeat(3,minmax(0,1fr)); gap:6px; }
    #members-overview { grid-area:members; }
    #wifi-section { grid-area:wifi; padding:10px 14px; }
    #wifi-section .section-heading { margin-bottom:4px; }
    #wifi-section .section-heading h2 { font-size:18px; }
    .wifi-codes { flex:1; min-height:0; align-items:center; }
    .wifi-code img { width:auto; height:clamp(96px,11.5vh,128px); max-width:100%; }
    .wifi-code figcaption { margin-top:2px; font-size:16px; line-height:1.3; }
    .wifi-status { margin:4px 0; font-size:16px; }
    .sync-row { grid-area:sync; }
    .panel { min-height:0; border-radius:18px; padding:14px 16px; overflow:hidden; }
    .panel:not(.hero), .present-content { display:flex; flex-direction:column; min-height:0; }
    .hero.panel { padding:0; }
    .occupancy { min-height:0; padding:14px; gap:6px; }
    .occupancy h2 { font-size:clamp(18px,1.8vh,26px); }
    #count { font-size:clamp(64px,9vh,140px); }
    .occupancy-unit { font-size:clamp(24px,2.6vh,40px); }
    .occupancy-number { margin:0; }
    #member-count { margin-top:4px; font-size:clamp(16px,1.6vh,20px); }
    .present-content { padding:14px 16px; overflow:hidden; }
    .section-heading, .present-content .section-heading { flex-shrink:0; gap:8px; margin-bottom:8px; }
    h2 { font-size:clamp(22px,2.6vh,34px); }
    .present-content h2 { font-size:clamp(24px,3.2vh,42px); }
    .pill { padding:3px 8px; gap:5px; font-size:16px; }
    .cards { flex:1; min-height:0; grid-template-columns:repeat(4,minmax(0,1fr)); grid-template-rows:repeat(2,minmax(0,1fr)); gap:10px; overflow:hidden; }
    .cards:empty { display:none; }
    .person-card { min-height:0; display:flex; flex-direction:column; justify-content:center; gap:clamp(2px,.4vh,4px); padding:clamp(4px,.7vh,10px) clamp(10px,1vw,18px); border-radius:18px; }
    .person-name { margin:0; font-size:clamp(18px,2.8vh,30px); line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .elapsed { font-size:clamp(24px,3.6vh,42px); line-height:1.1; white-space:nowrap; }
    .empty-state { flex:1; display:grid; align-content:center; padding:8px; }
    .empty-state strong { font-size:clamp(20px,2.8vh,32px); }
    .empty-state p { margin-top:4px; font-size:clamp(16px,1.7vh,20px); }
    .empty-symbol { width:32px; height:32px; margin-bottom:8px; border-radius:10px; font-size:20px; }
    .summary-card { display:grid; grid-template-columns:minmax(0,1fr) auto; align-content:center; align-items:center; column-gap:8px; padding:6px 14px; border-radius:14px; }
    .summary-label { font-size:clamp(16px,1.8vh,24px); }
    .summary-value { grid-column:2; grid-row:1; margin:0; font-size:clamp(30px,3.8vh,56px); }
    .table-scroll { flex:1; min-height:0; overflow:hidden; }
    table { table-layout:fixed; }
    .members-table { min-width:0; }
    th, td { padding:5px 7px; font-size:clamp(16px,2vh,26px); line-height:1.5; overflow:hidden; text-overflow:ellipsis; }
    thead th { padding:5px 7px; font-size:clamp(16px,1.6vh,20px); }
    tbody th { min-width:0; max-width:none; white-space:nowrap; font-size:clamp(18px,2.2vh,28px); }
    .members-table th:first-child { width:20%; }
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
      <div><h1>출입 현황</h1></div>
    </div>
    <div class="header-actions">
      <div class="clock-block"><time id="clock"></time><span id="date">한국 표준시 · KST</span></div>
      <button class="button-outline" id="theme" type="button" aria-label="화면 테마 변경, 현재 자동">테마 · 자동</button>
      <span class="viewer-name" id="viewer-name" hidden></span>
      <button class="button-outline" id="logout" type="button" hidden>로그아웃</button>
      <button class="button-tonal" id="refresh" type="button" hidden>새로고침</button>
    </div>
  </header>
  <section class="login-panel" id="login-panel" aria-labelledby="login-heading">
    <h2 id="login-heading">Internal 계정 로그인</h2>
    <p>BCSDLab 구성원 계정으로 출근부에 로그인하세요.</p>
    <form id="login-form">
      <label for="login-student">학번</label>
      <input id="login-student" name="studentNumber" inputmode="numeric" pattern="[0-9]{8,10}" autocomplete="username" required>
      <label for="login-password">비밀번호</label>
      <input id="login-password" name="password" type="password" autocomplete="current-password" required>
      <p class="login-error" id="login-error" role="alert"></p>
      <button class="button-filled" id="login-submit" type="submit" disabled>로그인</button>
    </form>
  </section>
  <main id="main" tabindex="-1" hidden>
    <div class="error-banner" id="error" hidden>
      <p id="error-message" role="alert"></p>
      <button class="button-text" id="retry" type="button">다시 시도</button>
    </div>
    <section class="hero panel" aria-labelledby="occupancy-heading">
      <div class="occupancy">
        <div><h2 id="occupancy-heading">지금 동아리방에는</h2><p id="member-count">등록 회원 확인 중</p></div>
        <div class="occupancy-number"><span id="count">—</span><span class="occupancy-unit">명</span></div>
      </div>
      <div class="present-content" id="present-region" aria-busy="true">
        <div class="section-heading"><h2 id="present-heading">지금 있는 사람</h2></div>
        <p class="loading" id="present-loading">동아리방 현황을 불러오고 있습니다.</p>
        <div class="cards" id="present" role="list" aria-labelledby="present-heading"></div>
        <div class="empty-state" id="present-empty" hidden><span class="empty-symbol" aria-hidden="true">↗</span><strong>첫 입실을 기다리고 있어요</strong><p>모바일 학생증을 리더에 태그해 주세요.</p></div>
      </div>
    </section>
    <section class="summary-grid" aria-label="체류 시간 요약">
      <div class="summary-card"><h2 class="summary-label">오늘 체류 시간 중앙값</h2><p class="summary-value" id="today-total">—</p></div>
      <div class="summary-card"><h2 class="summary-label">이번 주 체류 시간 중앙값</h2><p class="summary-value" id="week-total">—</p></div>
      <div class="summary-card" id="unrecorded-summary"><h2 class="summary-label">이번 주 퇴근 미기록</h2><p class="summary-value" id="unrecorded-total">—</p></div>
    </section>
    <section class="panel" id="members-overview" aria-labelledby="members-heading">
      <div class="section-heading"><div><h2 id="members-heading">이번 주의 발자취</h2></div><span class="pill" id="members-badge">확인 중</span></div>
      <p class="loading" id="members-loading">회원별 기록을 불러오고 있습니다.</p>
      <div class="table-scroll" id="members-table" role="region" aria-label="회원별 체류 시간, 가로 스크롤 가능" tabindex="0" hidden>
        <table class="members-table"><caption class="sr-only">회원별 현재 상태, 오늘 첫 입실 시각, 오늘 마지막 퇴실 시각, 오늘과 이번 주 체류 시간, 퇴근 미기록 건수</caption>
          <thead><tr><th scope="col">이름</th><th scope="col">현재 상태</th><th scope="col">오늘 첫 입실</th><th scope="col">오늘 마지막 퇴실</th><th scope="col">오늘</th><th scope="col">이번 주</th><th scope="col">퇴근 미기록</th></tr></thead>
          <tbody id="members"></tbody>
        </table>
      </div>
      <div class="empty-state" id="members-empty" hidden><strong>아직 기록이 없어요</strong><p>Internal에 등록된 회원이 모바일 학생증을 태그하면 표시됩니다.</p></div>
    </section>
    <section class="panel" id="wifi-section" aria-labelledby="wifi-heading">
      <div class="section-heading"><h2 id="wifi-heading">Wi-Fi 연결</h2></div>
      <div class="wifi-codes">
        <figure class="wifi-code">
          <img id="wifi-5" alt="BCSD_5G Wi-Fi 연결 QR 코드" hidden>
          <p class="wifi-status" id="wifi-5-status" role="status">QR 코드를 불러오는 중</p>
          <figcaption>BCSD_5G</figcaption>
        </figure>
        <figure class="wifi-code">
          <img id="wifi-24" alt="BCSD_2.4G Wi-Fi 연결 QR 코드" hidden>
          <p class="wifi-status" id="wifi-24-status" role="status">QR 코드를 불러오는 중</p>
          <figcaption>BCSD_2.4G</figcaption>
        </figure>
      </div>
    </section>
    <div class="sync-row"><span id="sync-status" role="status" data-state="loading"><span class="dot" aria-hidden="true"></span><span id="sync-label">첫 데이터를 불러오는 중</span></span><p class="sync-note"><span id="last-updated">아직 동기화되지 않음</span> · 10초마다 갱신</p></div>
  </main>
  <footer><p>BCSD LAB · 작은 태그 하나로 이어지는 우리의 하루</p><p>모든 시각은 KST · 저장소 반영에 최대 약 60초 소요될 수 있습니다.</p></footer>
</div>
</div>
<noscript><p>출근부를 보려면 브라우저에서 JavaScript를 활성화해 주세요.</p></noscript>
<script>
  ${solarThemeScript}
  var POLL_MS = 10000;
  var timeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  var clockFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  var dateFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'full' });
  var serverOffset = 0;
  var hasState = false;
  var lastStateAt = 0;
  var refreshing = false;
  var theme = 'auto';
  var authActive = false;
  var authRevision = 0;
  var authDeadline = 0;
  var authExpiresAt = 0;
  var authClockOffset = 0;

  function loadWifiImages(enabled) {
    [['wifi-5', '/api/wifi-qr/5'], ['wifi-24', '/api/wifi-qr/2.4']].forEach(function (entry) {
      var image = document.getElementById(entry[0]);
      var status = document.getElementById(entry[0] + '-status');
      image.onload = function () { image.hidden = false; status.hidden = true; };
      image.onerror = function () { image.hidden = true; status.textContent = 'Wi-Fi QR 코드를 사용할 수 없습니다.'; status.hidden = false; };
      image.hidden = true;
      status.hidden = false;
      status.textContent = 'QR 코드를 불러오는 중';
      if (enabled) image.src = entry[1];
      else image.removeAttribute('src');
    });
  }

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
      var names = { present: '현재 입실자', members: '회원 기록' };
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
      limit = 8;
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
  }

  function scheduleFit() {
    if (!fitFrame) fitFrame = requestAnimationFrame(function () { fitFrame = 0; fitWall(); });
  }
  window.addEventListener('resize', scheduleFit);
  wallQuery.addEventListener('change', scheduleFit);
  if (typeof ResizeObserver !== 'undefined') {
    var wallResizeObserver = new ResizeObserver(scheduleFit);
    ['present', 'members-table'].forEach(function (id) { wallResizeObserver.observe(document.getElementById(id)); });
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function applyTheme() {
    var activeTheme = theme === 'auto' ? (isByeongcheonDay(new Date()) ? 'light' : 'dark') : theme;
    document.documentElement.dataset.theme = activeTheme;
    var label = theme === 'auto' ? '자동 (' + (activeTheme === 'light' ? '라이트' : '다크') + ')' : theme === 'light' ? '라이트' : '다크';
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
  function updateAutoTheme() {
    if (theme !== 'auto') return;
    var activeTheme = isByeongcheonDay(new Date()) ? 'light' : 'dark';
    if (document.documentElement.dataset.theme !== activeTheme) applyTheme();
  }
  setInterval(updateAutoTheme, 1000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) updateAutoTheme();
  });

  function formatDuration(ms) {
    var minutes = Math.floor(Math.max(0, ms) / 60000);
    var hours = Math.floor(minutes / 60);
    return hours > 0 ? hours + '시간 ' + (minutes % 60) + '분' : minutes + '분';
  }

  function formatClockDuration(ms) {
    var seconds = Math.max(0, ms) / 1000;
    if (seconds < 60) return Math.floor(seconds) + '초';
    if (seconds < 3600) return Math.floor(seconds / 60) + '분';
    return (seconds / 3600).toFixed(1) + '시간';
  }

  function serverNow() { return Date.now() + serverOffset; }

  function renderPresent(members) {
    var present = members.filter(function (m) { return m.present; });
    var container = document.getElementById('present');
    container.replaceChildren();
    present.forEach(function (m) {
      var card = el('div', 'person-card');
      card.setAttribute('role', 'listitem');
      var name = el('h3', 'person-name', m.name);
      var elapsed = el('span', 'elapsed', formatClockDuration(serverNow() - m.since));
      elapsed.dataset.since = String(m.since);
      card.append(name, elapsed);
      container.appendChild(card);
    });
    document.getElementById('present-empty').hidden = present.length > 0;
    document.getElementById('count').textContent = String(present.length);
    document.getElementById('member-count').textContent = '전체 등록 회원 ' + members.length + '명';
  }

  function formatMedianDuration(values) {
    if (values.length === 0) return '—';
    values.sort(function (a, b) { return a - b; });
    var middle = Math.floor(values.length / 2);
    return formatClockDuration(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
  }

  function renderSummary(members) {
    var today = [];
    var week = [];
    var unrecorded = 0;
    members.forEach(function (m) {
      if (Number.isFinite(m.todayMs) && m.todayMs > 0) today.push(m.todayMs);
      if (Number.isFinite(m.weekMs) && m.weekMs > 0) week.push(m.weekMs);
      unrecorded += m.unrecordedWeek;
    });
    document.getElementById('today-total').textContent = formatMedianDuration(today);
    document.getElementById('week-total').textContent = formatMedianDuration(week);
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
      row.appendChild(el('td', 'muted', m.lastCheckOut === null ? '—' : timeFormat.format(m.lastCheckOut)));
      row.appendChild(el('td', '', formatDuration(m.todayMs)));
      row.appendChild(el('td', 'duration', formatDuration(m.weekMs)));
      row.appendChild(el('td', m.unrecordedWeek > 0 ? 'warn' : 'muted', m.unrecordedWeek > 0 ? m.unrecordedWeek + '건 · 시간 제외' : '—'));
      body.appendChild(row);
    });
    document.getElementById('members-table').hidden = members.length === 0;
    document.getElementById('members-empty').hidden = members.length > 0;
    document.getElementById('members-badge').textContent = members.length + '명';
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


  async function refresh() {
    if (refreshing || !authActive) return;
    var revision = authRevision;
    refreshing = true;
    document.getElementById('refresh').setAttribute('aria-busy', 'true');
    document.getElementById('retry').setAttribute('aria-busy', 'true');
    document.getElementById('refresh').textContent = '갱신 중';
    try {
      var response = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(POLL_MS) });
      if (!response.ok) throw new Error(String(response.status));
      var state = await response.json();
      if (!authActive || revision !== authRevision) return;
      serverOffset = state.now - Date.now();
      renderPresent(state.members);
      renderSummary(state.members);
      renderMembers(state.members);
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
      if (!authActive || revision !== authRevision) return;
      if (error instanceof Error && error.message === '401') {
        setSignedOut('세션이 만료됐어. 다시 로그인해 주세요.');
        return;
      }
      document.querySelectorAll('.loading').forEach(function (node) {
        node.hidden = true;
      });
      document.getElementById('present-region').setAttribute('aria-busy', 'false');
      showError(hasState ? '갱신하지 못했습니다. 마지막으로 받은 데이터를 표시하고 있습니다. 10초마다 다시 시도합니다.'
        : '데이터를 불러오지 못했습니다. 연결 상태를 확인해 주세요. 10초마다 다시 시도합니다.');
      setSync('error', hasState ? '연결 끊김 · 이전 데이터' : '연결 대기 · 데이터 없음');
      if (!hasState) {
        document.getElementById('member-count').textContent = '등록 회원 정보 없음';
        document.getElementById('members-badge').textContent = '데이터 없음';
      }
      tick();
    } finally {
      refreshing = false;
      document.getElementById('refresh').setAttribute('aria-busy', 'false');
      document.getElementById('retry').setAttribute('aria-busy', 'false');
      document.getElementById('refresh').textContent = '새로고침';
    }
  }

  function tick() {
    if (authActive && (performance.now() >= authDeadline || Date.now() + authClockOffset >= authExpiresAt)) {
      setSignedOut('세션이 만료됐습니다. 다시 로그인해 주세요.');
    }
    var now = serverNow();
    var elapsedNow = document.getElementById('sync-status').dataset.state === 'error' ? lastStateAt : now;
    document.getElementById('clock').textContent = clockFormat.format(now);
    document.getElementById('clock').dateTime = new Date(now).toISOString();
    document.getElementById('date').textContent = dateFormat.format(now) + ' · KST';
    document.querySelectorAll('.elapsed').forEach(function (node) {
      node.textContent = formatClockDuration(elapsedNow - Number(node.dataset.since));
    });
  }
  function setSignedOut(message) {
    authActive = false;
    authRevision += 1;
    hasState = false;
    lastStateAt = 0;
    authDeadline = 0;
    authExpiresAt = 0;
    authClockOffset = 0;
    pagePositions.clear();
    document.getElementById('main').hidden = true;
    document.getElementById('login-panel').hidden = false;
    document.getElementById('logout').hidden = true;
    document.getElementById('viewer-name').hidden = true;
    document.getElementById('viewer-name').textContent = '';
    document.getElementById('refresh').hidden = true;
    document.getElementById('login-password').value = '';
    document.getElementById('login-error').textContent = message || '';
    ['present', 'members'].forEach(function (id) { document.getElementById(id).replaceChildren(); });
    ['count', 'today-total', 'week-total', 'unrecorded-total'].forEach(function (id) { document.getElementById(id).textContent = '—'; });
    document.querySelectorAll('.loading').forEach(function (node) { node.hidden = false; });
    loadWifiImages(false);
  }

  async function checkSession() {
    var requestWallStart = Date.now();
    var requestMonoStart = performance.now();
    var response = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) { setSignedOut(''); return false; }
    if (!response.ok) { setSignedOut('계정 확인에 실패했습니다. 잠시 뒤 다시 시도해 주세요.'); return false; }
    var viewer = await response.json();
    if (!Number.isSafeInteger(viewer.expiresAt) || !Number.isSafeInteger(viewer.serverNow) || viewer.expiresAt <= viewer.serverNow) {
      setSignedOut('계정 유효기간을 확인할 수 없습니다. 다시 로그인해 주세요.');
      return false;
    }
    authExpiresAt = viewer.expiresAt;
    authClockOffset = viewer.serverNow - requestWallStart;
    authDeadline = requestMonoStart + Math.min(900000, viewer.expiresAt - viewer.serverNow);
    if (performance.now() >= authDeadline || Date.now() + authClockOffset >= authExpiresAt) {
      setSignedOut('세션이 만료됐습니다. 다시 로그인해 주세요.');
      return false;
    }
    authActive = true;
    authRevision += 1;
    document.getElementById('login-panel').hidden = true;
    document.getElementById('main').hidden = false;
    document.getElementById('logout').hidden = false;
    document.getElementById('refresh').hidden = false;
    document.getElementById('viewer-name').textContent = viewer.name;
    document.getElementById('viewer-name').hidden = false;
    loadWifiImages(true);
    refresh();
    return true;
  }

  document.getElementById('login-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var button = document.getElementById('login-submit');
    var error = document.getElementById('login-error');
    button.disabled = true;
    error.textContent = '';
    try {
      var response = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studentNumber: document.getElementById('login-student').value.trim(), password: document.getElementById('login-password').value }),
      });
      document.getElementById('login-password').value = '';
      if (response.status === 401) { error.textContent = '학번 또는 비밀번호를 확인해 주세요.'; return; }
      if (!response.ok) { error.textContent = '로그인 서비스를 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.'; return; }
      await checkSession();
    } catch (errorValue) {
      document.getElementById('login-password').value = '';
      error.textContent = '연결하지 못했습니다. 네트워크를 확인해 주세요.';
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('logout').addEventListener('click', async function () {
    var button = document.getElementById('logout');
    button.disabled = true;
    try {
      var response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) { showError('로그아웃하지 못했습니다. 다시 시도해 주세요.'); return; }
      setSignedOut('');
    } catch (error) {
      showError('로그아웃하지 못했습니다. 연결 상태를 확인해 주세요.');
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('retry').addEventListener('click', refresh);
  tick();
  setInterval(tick, 1000);
  setInterval(refresh, POLL_MS);
  checkSession().catch(function () { setSignedOut('계정 확인에 실패했습니다. 네트워크를 확인해 주세요.'); }).finally(function () { document.getElementById('login-submit').disabled = false; });
</script>
</body>
</html>
`;
