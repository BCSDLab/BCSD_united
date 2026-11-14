#!/usr/bin/env node
// Render src/dashboard.ts with the tsx loader; only the generated HTML runs on the Pi.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [modulePath, outputPath] = process.argv.slice(2);
if (!modulePath || !outputPath)
  throw new Error('Usage: node --import tsx lan/render-dashboard.mjs <src/dashboard.ts> <output.html>');
const { DASHBOARD_HTML } = await import(pathToFileURL(resolve(modulePath)).href);
if (typeof DASHBOARD_HTML !== 'string') throw new Error('Expected the real DASHBOARD_HTML export');
const startMarker = 'async function checkSession() {';
const endMarker = "document.getElementById('login-form').addEventListener";
const start = DASHBOARD_HTML.indexOf(startMarker);
const end = DASHBOARD_HTML.indexOf(endMarker, start);
if (start < 0 || end < start || DASHBOARD_HTML.indexOf(startMarker, start + 1) !== -1) {
  throw new Error('Dashboard authentication structure changed; refusing to generate a partial page');
}
const pollMarker = 'setInterval(refresh, POLL_MS);';
if (
  DASHBOARD_HTML.indexOf(pollMarker) < 0 ||
  DASHBOARD_HTML.indexOf(pollMarker) !== DASHBOARD_HTML.lastIndexOf(pollMarker) ||
  !DASHBOARD_HTML.includes('if (refreshing || !authActive) return;')
) {
  throw new Error('Dashboard refresh structure changed; refusing generate partial page');
}
const manualRefreshMarker = "document.getElementById('refresh').addEventListener('click', refresh);";
const headerActionsMarker = '<div class="header-actions">';
const fitMarker = 'function fitWall() {';
for (const marker of [manualRefreshMarker, fitMarker, headerActionsMarker, '</main>']) {
  if (!DASHBOARD_HTML.includes(marker) || DASHBOARD_HTML.indexOf(marker) !== DASHBOARD_HTML.lastIndexOf(marker)) {
    throw new Error('Dashboard view structure changed; refusing to generate a partial page');
  }
}
const spotifyStyles = `
.app-header > .brand, .app-header > .header-actions { flex-shrink:0; }
.app-header > .header-actions { min-width:0; }
.app-header .viewer-name { display:none; }
.spotify-now { flex:1 1 320px; min-width:0; max-width:480px; height:56px; padding:4px 10px; display:flex; align-items:center; gap:10px; border:1px solid var(--line); border-radius:16px; background:var(--surface-low); overflow:hidden; }
.spotify-copy { display:grid; grid-template-rows:22px 20px; align-content:center; flex:1; min-width:0; }
.spotify-cover { flex:0 0 44px; width:44px; height:44px; object-fit:cover; border-radius:7px; }
.spotify-title, .spotify-artists { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.spotify-title { color:var(--text); font-size:clamp(16px,1.8vh,20px); font-weight:650; line-height:20px; }
.spotify-artists { color:var(--muted); font-size:16px; line-height:20px; }
@media (min-width:1000px) and (min-aspect-ratio:3/2) {
 .app-header > .brand, .app-header > .header-actions { height:56px; }
 .app-header h1 { margin-top:2px; font-size:clamp(26px,3vh,32px); line-height:1.2; }
 .app-header #clock { font-size:clamp(26px,3vh,32px); line-height:1.2; }
 .app-header #date { font-size:16px; line-height:1.2; }
}
@media (max-width:999px) {
 .app-header { flex-wrap:wrap; }
 .spotify-now { order:3; flex-basis:100%; max-width:none; }
}
@media (max-width:700px) {
 .app-header > .brand, .app-header > .header-actions { flex-shrink:1; }
}
`;
const spotifyMarkup = `
<div id="spotify-now" class="spotify-now" data-state="unknown" role="status" aria-live="polite" aria-atomic="true">
 <img id="spotify-cover" class="spotify-cover" width="44" height="44" alt="" referrerpolicy="no-referrer" decoding="async" hidden>
 <div class="spotify-copy">
 <span id="spotify-title" class="spotify-title">재생 상태를 확인하고 있습니다</span>
 <span id="spotify-artists" class="spotify-artists">Spotify Connect</span>
 </div>
</div>
`;
const jamStyles = `
.wifi-codes.has-jam { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); align-items:center; gap:6px; }
.wifi-codes.has-jam .wifi-code img { width:clamp(104px,15vh,128px); height:auto; aspect-ratio:1; max-width:100%; }
.wifi-codes.has-jam .wifi-code figcaption { margin-top:2px; font-size:16px; line-height:1.3; white-space:nowrap; }
`;
const monitorStyles = `
.monitor-view { --monitor-cpu:var(--primary); --monitor-ram:var(--amber); display:grid; align-content:start; gap:16px; min-width:0; }
.monitor-heading, .monitor-title, .monitor-section-heading { display:flex; align-items:center; justify-content:space-between; gap:12px 20px; }
.monitor-title { justify-content:flex-start; flex-wrap:wrap; }
.monitor-heading h2 { margin:0; font-size:clamp(28px,3.4vh,40px); line-height:1.2; }
.monitor-description { margin:0; color:var(--muted); font-size:clamp(16px,1.8vh,21px); line-height:1.35; }
.monitor-status { display:flex; align-items:center; gap:12px; flex-shrink:0; margin:0; padding:10px 18px; border-radius:999px; background:var(--amber-container); color:var(--amber); font-size:clamp(20px,2.2vh,28px); line-height:1.3; font-weight:750; }
.monitor-status::before { content:""; width:13px; height:13px; flex-shrink:0; border-radius:50%; background:currentColor; }
.monitor-status[data-state="up"] { color:var(--on-green-container); background:var(--green-container); }
.monitor-status[data-state="down"] { color:var(--error); background:var(--error-container); }
.monitor-paths { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.monitor-path { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0; padding:8px 16px; border:1px solid var(--line); border-radius:999px; color:var(--amber); background:var(--amber-container); line-height:1.2; }
.monitor-path strong { color:var(--text); font-size:clamp(24px,2.5vh,30px); font-weight:750; }
.monitor-path span { display:inline-flex; align-items:center; gap:8px; font-size:clamp(22px,2.2vh,28px); font-weight:750; white-space:nowrap; }
.monitor-path span::before { content:""; width:10px; height:10px; flex-shrink:0; border-radius:50%; background:currentColor; }
.monitor-path[data-health="up"] { color:var(--on-green-container); background:var(--green-container); }
.monitor-path[data-health="down"] { color:var(--error); background:var(--error-container); }
.worker-health { display:flex; align-items:center; justify-content:space-between; gap:8px 12px; min-width:0; margin:0; padding:8px 16px; border:1px solid var(--line); border-radius:24px; background:var(--surface-low); }
.worker-health > strong { color:var(--text); font-size:clamp(22px,2.3vh,28px); line-height:1.2; white-space:nowrap; }
.worker-status { display:inline-flex; align-items:center; gap:6px; color:var(--amber); font-size:clamp(18px,1.9vh,23px); font-weight:750; line-height:1.3; white-space:nowrap; }
.worker-status[data-health="up"] { color:var(--on-green-container); }
.worker-status[data-health="down"] { color:var(--error); }
@media (max-width:1100px) { .worker-health { flex-wrap:wrap; } .worker-health > strong { flex-basis:100%; } }
.koin-services { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.koin-service { display:grid; gap:8px; padding:clamp(10px,1.8vh,22px) clamp(16px,2vw,30px); border:1px solid var(--line); border-left:6px solid var(--amber); border-radius:20px; background:var(--surface); }
.koin-service[data-health="up"] { border-left-color:var(--green); }
.koin-service[data-health="down"] { border-left-color:var(--error); }
.koin-service-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.koin-service-name { margin:0; font-size:clamp(26px,3.1vh,38px); font-weight:750; line-height:1.2; }
.koin-service-detail { display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:2px 14px; color:var(--muted); font-size:clamp(16px,1.85vh,22px); line-height:1.3; }
.koin-service-reason, .koin-service-time { margin:0; }
.monitor-health { display:inline-flex; align-items:center; gap:8px; width:fit-content; flex-shrink:0; padding:5px 12px; border-radius:999px; color:var(--amber); background:var(--amber-container); font-size:clamp(18px,2.1vh,26px); font-weight:750; line-height:1.2; white-space:nowrap; }
.monitor-health::before { content:""; width:9px; height:9px; flex-shrink:0; border-radius:50%; background:currentColor; }
.monitor-health[data-health="up"] { color:var(--on-green-container); background:var(--green-container); }
.monitor-health[data-health="down"] { color:var(--error); background:var(--error-container); }
.monitor-section-heading h3 { margin:0; font-size:clamp(23px,2.5vh,30px); line-height:1.2; }
.monitor-timestamp { margin:0; color:var(--muted); font-size:clamp(16px,1.8vh,21px); line-height:1.3; text-align:right; }
.monitor-timestamp, .monitor-node-time, .koin-service-time { font-variant-numeric:tabular-nums; }
.monitor-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; min-width:0; min-height:0; }
.monitor-node.panel { display:grid; grid-template-rows:auto auto minmax(0,1fr) auto; align-content:start; gap:clamp(8px,1.1vh,16px); padding:clamp(12px,1.8vh,24px); border-radius:22px; min-width:0; }
.monitor-node-heading { min-width:0; }
.monitor-node-title { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px 10px; }
.monitor-node h4 { margin:0; font-size:clamp(24px,3vh,36px); line-height:1.2; font-weight:750; overflow-wrap:anywhere; }
.monitor-node-time { margin:0; padding-top:8px; border-top:1px solid var(--line); color:var(--muted); font-size:clamp(16px,1.85vh,22px); line-height:1.3; }
.monitor-value-note { margin:5px 0 0; color:var(--amber); font-size:clamp(14px,1.7vh,20px); line-height:1.3; }
.monitor-metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.monitor-metric { min-width:0; }
.monitor-metric-label { display:flex; align-items:center; gap:9px; color:var(--monitor-cpu); font-size:clamp(18px,2.2vh,26px); line-height:1.2; font-weight:750; }
.monitor-metric-label::before { content:""; width:27px; border-top:5px solid currentColor; }
.monitor-metric[data-metric="ram"] .monitor-metric-label { color:var(--monitor-ram); }
.monitor-metric[data-metric="ram"] .monitor-metric-label::before { border-top-style:dashed; }
.monitor-value { display:block; margin-top:3px; font-size:clamp(44px,5.4vh,72px); font-weight:750; letter-spacing:-.055em; line-height:1.05; font-variant-numeric:tabular-nums; }
.monitor-metric-detail { display:block; margin-top:4px; color:var(--muted); font-size:clamp(13px,1.5vh,18px); line-height:1.3; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.monitor-plot { display:flex; flex-direction:column; min-height:0; }
.monitor-graph { display:block; flex:1; width:100%; height:clamp(100px,15vh,180px); min-height:100px; overflow:hidden; }
.monitor-graph-grid { fill:none; stroke:var(--outline); stroke-width:1; vector-effect:non-scaling-stroke; }
.monitor-graph-line { fill:none; stroke:var(--monitor-cpu); stroke-width:5; stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
.monitor-graph-line[data-series="ram"] { stroke:var(--monitor-ram); stroke-dasharray:10 7; }
.monitor-graph-dot { fill:var(--monitor-cpu); }
.monitor-graph-dot[data-series="ram"] { fill:var(--monitor-ram); }
.monitor-graph-axis { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--muted); font-size:clamp(14px,1.65vh,19px); line-height:1.25; }
.monitor-waiting { grid-column:1 / -1; margin:0; padding:24px; color:var(--muted); font-size:clamp(22px,2.5vh,30px); border:2px dashed var(--outline); border-radius:20px; }
@media (max-width:999px) {
 .monitor-heading { align-items:start; flex-direction:column; }
 .monitor-cards { grid-template-columns:minmax(0,1fr); }
 .monitor-node.panel { grid-template-rows:auto auto auto auto; padding:22px; }
 .monitor-graph { flex:none; height:170px; }
 .monitor-value { font-size:52px; }
 .monitor-node h4 { font-size:30px; }
 .monitor-health { font-size:20px; }
}
@media (max-width:650px) {
 .monitor-paths { grid-template-columns:minmax(0,1fr); }
 .koin-services { grid-template-columns:minmax(0,1fr); }
 .monitor-section-heading { align-items:start; flex-direction:column; gap:6px; }
 .monitor-timestamp { text-align:left; }
 .koin-service-name { font-size:26px; }
 .monitor-description { font-size:16px; }
 .monitor-title { gap:8px; }
 .monitor-status { font-size:20px; }
}
@media (min-width:1000px) and (min-aspect-ratio:3/2) {
 .monitor-view { flex:1; min-height:0; gap:clamp(8px,1vh,14px); grid-template-rows:auto auto auto auto minmax(0,1fr); }
 .monitor-title { flex-wrap:nowrap; gap:16px; }
 .monitor-heading { gap:12px; }
 .monitor-cards { gap:clamp(12px,1.2vw,24px); }
 .monitor-node.panel { min-height:0; }
 .koin-service-name, .monitor-node h4 { font-size:clamp(32px,3.1vh,38px); }
 .monitor-value { font-size:clamp(58px,5.4vh,72px); }
 .monitor-health { font-size:clamp(22px,2.1vh,26px); }
 .monitor-node.panel { padding:clamp(10px,1.4vh,22px); gap:clamp(6px,.9vh,14px); }
 .monitor-node-time { padding-top:4px; }
 .monitor-graph { height:0; min-height:0; flex:1 1 0; }
 .monitor-graph-axis, .monitor-node-time { flex-shrink:0; }
}
@media (min-width:1000px) and (min-aspect-ratio:3/2) and (max-height:800px) {
 .monitor-view { grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-rows:auto auto auto minmax(0,1fr); gap:6px 12px; }
 .monitor-heading, .monitor-section-heading, .monitor-cards { grid-column:1 / -1; }
 .monitor-paths { grid-template-columns:minmax(0,1fr); gap:4px; align-content:start; }
 .koin-services { gap:8px; }
 .monitor-node.panel { padding:8px 10px; gap:5px; }
 .monitor-node-title { gap:4px 8px; }
 .monitor-node-heading { min-height:0; }
 .monitor-metrics { gap:8px; }
 .monitor-value-note { margin-top:2px; font-size:14px; }
 .monitor-node-time { line-height:1.25; }
 .monitor-heading h2 { font-size:28px; }
 .monitor-description { font-size:16px; }
 .monitor-status { padding:7px 12px; font-size:20px; }
 .monitor-path { padding:6px 12px; }
 .monitor-path strong, .monitor-path span { font-size:22px; }
 .koin-service { padding:10px 16px; gap:4px; }
 .koin-service-name { font-size:26px; }
 .koin-service-detail, .monitor-timestamp, .monitor-node-time { font-size:16px; }
 .monitor-section-heading h3 { font-size:23px; }
 .monitor-health { font-size:18px; }
 .monitor-node h4 { font-size:30px; }
 .monitor-metric-label { font-size:20px; }
 .monitor-value { font-size:54px; }
 .monitor-metric-detail { font-size:16px; }
 .monitor-graph-axis { font-size:16px; }
}
`;
const monitorMarkup = `
<section id="monitor-view" class="monitor-view" tabindex="-1" aria-labelledby="monitor-heading" hidden>
 <div class="monitor-heading">
  <div class="monitor-title"><h2 id="monitor-heading">KOIN 시스템 상태</h2></div>
  <p id="monitor-status" class="monitor-status" role="status" data-state="unknown">상태 확인 중</p>
 </div>
 <div class="monitor-paths" aria-label="독립 상태 확인">
  <div id="worker-health" class="worker-health" data-health="unknown" role="status" aria-live="polite" aria-atomic="true">
   <strong>KOIN Workers</strong>
   <span id="worker-web-status" class="worker-status" data-health="unknown"><b>WEB</b><span>확인 불가</span></span>
  </div>
  <p id="internal-path-status" class="monitor-path" data-health="unknown" role="status"><strong>Internal 수집 경로</strong><span>연결·인증 확인</span></p>
 </div>
 <div id="koin-services" class="koin-services" aria-label="KOIN API 상태"><p class="monitor-waiting">상태 확인 중</p></div>
 <div class="monitor-section-heading"><h3>서버 사용량</h3><p id="monitor-timestamp" class="monitor-timestamp">서버 관측 대기</p></div>
 <div id="monitor-cards" class="monitor-cards"><p class="monitor-waiting">서버 수집 데이터 대기 · 아직 노드 관측 없음</p></div>
</section>
`;
const greetingStyles = `
  .greeting-dialog {
    width:min(560px,calc(100vw - 32px)); max-width:calc(100vw - 32px);
    max-height:calc(100vh - 32px); max-height:calc(100dvh - 32px);
    margin:auto; padding:clamp(24px,4vw,40px); overflow:auto;
    border:1px solid var(--line); border-radius:28px;
    background:var(--surface-high); color:var(--text);
    box-shadow:0 24px 80px #0004; text-align:center;
  }
  .greeting-dialog.is-entering { animation:greeting-enter 220ms cubic-bezier(.2,.8,.2,1) both; }
  .greeting-dialog.is-closing { animation:greeting-exit 160ms ease-in both; }
  @keyframes greeting-enter {
    from { opacity:0; transform:translateY(12px) scale(.97); }
    to { opacity:1; transform:translateY(0) scale(1); }
  }
  @keyframes greeting-exit {
    from { opacity:1; transform:translateY(0) scale(1); }
    to { opacity:0; transform:translateY(8px) scale(.98); }
  }
  @media (prefers-reduced-motion:reduce) {
    .greeting-dialog.is-entering, .greeting-dialog.is-closing { animation:none; }
  }
  .greeting-dialog::backdrop { background:#0006; }
  .greeting-brand {
    display:inline-block; margin:0 0 20px; padding:6px 14px; border-radius:999px;
    background:var(--primary-container); color:var(--on-primary-container);
    font-size:16px; font-weight:750; letter-spacing:.12em;
  }
  .greeting-message {
    margin:0; font-size:clamp(24px,3vw,36px); font-weight:700;
    line-height:1.5; letter-spacing:-.04em; overflow-wrap:anywhere;
  }
  .greeting-description { margin:16px 0 24px; color:var(--muted); font-size:16px; }
  .greeting-close { min-width:96px; }
`;
const greetingMarkup = `
<dialog id="greeting-dialog" class="greeting-dialog" aria-labelledby="greeting-message" aria-describedby="greeting-description">
  <p class="greeting-brand" aria-hidden="true">BCSD LAB</p>
  <h2 id="greeting-message" class="greeting-message" aria-live="polite" aria-atomic="true"></h2>
  <p id="greeting-description" class="greeting-description">5초 후 자동으로 닫힙니다.</p>
  <button id="greeting-close" class="button-filled greeting-close" type="button" autofocus>닫기</button>
</dialog>
`;
// LAN mode has no fabricated session endpoint. Keep the real rendering and
// refresh/auth guards; queue invalidations arriving during an in-flight fetch.
const bootstrap = `var lanEvents = null;
  var lanLastEventAt = 0;
  var lanPageHidden = false;
  var lanRefreshPending = false;
  var lanGreetingTimer = null;
  var lanGreetingAnimationTimer = null;
  var lanGreetingDialog = document.getElementById('greeting-dialog');
  var lanGreetingMessage = document.getElementById('greeting-message');
  var lanView = 'attendance';
  var lanRotationTimer = null;
  var lanMonitorInterval = null;
  var lanMonitorAgeInterval = null;
  var lanRecoveryInterval = null;
  var lanMonitorRequest = null;
  var lanMonitorData = null;
  var lanMonitorFailed = false;
  var lanMonitorSucceededAt = null;
  var lanWorkerData = null;
  var lanWorkerFailed = false;
  var lanWorkerRequest = null;
  var lanWorkerRequestTimer = null;
  var lanWorkerInterval = null;
 var lanSpotifyInterval = null;
 var lanSpotifyRequest = null;
 var lanSpotifyRequestTimer = null;
 var lanSpotifySignature = null;
 var lanSpotifyCover = document.getElementById('spotify-cover');
 var lanSpotifyCoverKey = null;
 var LAN_SPOTIFY_POLL_MS = 2500;
 var lanSpotifyNode = document.getElementById('spotify-now');
 var lanSpotifyTitle = document.getElementById('spotify-title');
 var lanSpotifyArtists = document.getElementById('spotify-artists');
 var lanJamInterval = null;
 var lanJamRequest = null;
 var lanJamRequestTimer = null;
 var lanJamImage = null;
 var lanJamImageTimer = null;
 var lanJamFigure = null;
 var lanJamAvailable = false;
 var lanJamCodes = document.querySelector('#wifi-section .wifi-codes');
 var LAN_JAM_POLL_MS = 60000;
  var LAN_WORKER_POLL_MS = 60000;
  var LAN_WORKER_STALE_MS = 150000;
  var lanMonitorCards = [];
var lanKoinData = null;
var lanKoinFailed = false;
var lanKoinRows = [];
var lanMonitorHistory = Object.create(null);
var LAN_HISTORY_LIMIT = 60;
var LAN_HISTORY_MS = 15 * 60 * 1000;
var LAN_GRAPH_GAP_MS = 22500;
  var LAN_VIEW_MS = 15000;
  var LAN_STALE_MS = 45000;
  var lanTimestampFormat = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });

  function lanIsVisible() {
    return authActive && !lanPageHidden && !document.hidden;
  }
  function showLanView(view) {
if (view === 'monitor' && lanGreetingDialog.open) return;
    lanView = view;
    var attendance = document.getElementById('main');
    var monitor = document.getElementById('monitor-view');
    var previous = view === 'attendance' ? monitor : attendance;
    var moveFocus = previous.contains(document.activeElement);
    attendance.hidden = view !== 'attendance';
    monitor.hidden = view !== 'monitor';
    if (view === 'attendance') scheduleFit();
    else updateLanMonitorStatus();
    if (moveFocus) (view === 'attendance' ? attendance : monitor).focus({ preventScroll: true });
  }
  function resetLanRotation() {
    clearTimeout(lanRotationTimer);
    lanRotationTimer = null;
    if (!lanIsVisible()) return;
    lanRotationTimer = setTimeout(function () {
      lanRotationTimer = null;
      if (!lanIsVisible()) return;
      if (!lanGreetingDialog.open) showLanView(lanView === 'attendance' ? 'monitor' : 'attendance');
      resetLanRotation();
    }, LAN_VIEW_MS);
  }
  function attendLanScreen() {
    showLanView('attendance');
    resetLanRotation();
  }
  function clearLanGreeting() {
    clearTimeout(lanGreetingTimer);
    clearTimeout(lanGreetingAnimationTimer);
    lanGreetingTimer = null;
    lanGreetingAnimationTimer = null;
    lanGreetingDialog.classList.remove('is-entering', 'is-closing');
    lanGreetingMessage.textContent = '';
  }
  function closeLanGreeting(immediate) {
    clearTimeout(lanGreetingTimer);
    clearTimeout(lanGreetingAnimationTimer);
    lanGreetingTimer = null;
    lanGreetingAnimationTimer = null;
    if (!lanGreetingDialog.open) { clearLanGreeting(); return; }
    if (immediate === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      lanGreetingDialog.close();
      clearLanGreeting();
      return;
    }
    lanGreetingDialog.classList.remove('is-entering');
    lanGreetingDialog.classList.add('is-closing');
    lanGreetingAnimationTimer = setTimeout(function () {
      lanGreetingAnimationTimer = null;
      if (lanGreetingDialog.open) lanGreetingDialog.close();
    }, 160);
  }
  function showLanGreeting(data) {
    if (!lanIsVisible() || !data || (data.name !== null && typeof data.name !== 'string')
        || (data.action !== 'check-in' && data.action !== 'check-out')) return;
    attendLanScreen();
    clearTimeout(lanGreetingTimer);
    clearTimeout(lanGreetingAnimationTimer);
    lanGreetingAnimationTimer = null;
    lanGreetingMessage.textContent = data.action === 'check-out'
      ? (data.name === null ? '' : data.name + '님, ') + '안녕히 가세요'
      : data.name === null
        ? '안녕하세요 BCSDLab에 처음이신것 같아요'
        : data.name + '님 안녕하세요';
    if (!lanGreetingDialog.open) lanGreetingDialog.showModal();
    lanGreetingDialog.classList.remove('is-entering', 'is-closing');
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      void lanGreetingDialog.offsetWidth;
      lanGreetingDialog.classList.add('is-entering');
      lanGreetingAnimationTimer = setTimeout(function () {
        lanGreetingAnimationTimer = null;
        lanGreetingDialog.classList.remove('is-entering');
      }, 240);
    }
    lanGreetingTimer = setTimeout(closeLanGreeting, 5000);
  }
  document.getElementById('greeting-close').addEventListener('click', function () { closeLanGreeting(); });
  lanGreetingDialog.addEventListener('close', function () {
    if (!lanGreetingDialog.open) clearLanGreeting();
  });

  function validLanTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  }
  function validLanMonitor(data) {
    if (!data || !validLanTimestamp(data.observedAt)
      || !Array.isArray(data.nodes) || data.nodes.length !== 3) return false;
    var ids = new Set();
    return data.nodes.every(function (node) {
      if (!node || ['prod', 'stage', 'db'].indexOf(node.id) < 0 || ids.has(node.id)
        || typeof node.label !== 'string' || !node.label.trim()
        || ['up', 'down', 'unknown'].indexOf(node.health) < 0
        || (node.collectedAt !== null && !validLanTimestamp(node.collectedAt))
        || (node.cpuPercent !== null && (!Number.isFinite(node.cpuPercent) || node.cpuPercent < 0 || node.cpuPercent > 100))
        || (node.memoryUsedBytes !== null && (!Number.isSafeInteger(node.memoryUsedBytes) || node.memoryUsedBytes < 0))
        || (node.memoryTotalBytes !== null && (!Number.isSafeInteger(node.memoryTotalBytes) || node.memoryTotalBytes <= 0))
        || (node.memoryUsedBytes !== null && node.memoryTotalBytes !== null && node.memoryUsedBytes > node.memoryTotalBytes)) return false;
      ids.add(node.id);
      return true;
    });
  }
  function validLanKoin(data) {
    if (!data || !validLanTimestamp(data.observedAt)
      || !Array.isArray(data.services) || data.services.length !== 2) return false;
    var labels = { 'prod-api': 'KOIN API 운영', 'stage-api': 'KOIN API 개발' };
    var ids = new Set();
    return data.services.every(function (service) {
      if (!service || !Object.prototype.hasOwnProperty.call(labels, service.id) || ids.has(service.id)
        || service.label !== labels[service.id] || !validLanTimestamp(service.checkedAt)
        || ['up', 'down', 'unknown'].indexOf(service.status) < 0
        || ['ready', 'not-ready', 'http', 'tls', 'timeout', 'invalid-response', 'unavailable'].indexOf(service.reason) < 0
        || (service.httpStatus !== null && (!Number.isInteger(service.httpStatus) || service.httpStatus < 100 || service.httpStatus > 599))
        || (service.status === 'up' && (service.reason !== 'ready' || service.httpStatus !== 200))
        || (service.status === 'down' && service.reason !== 'not-ready'
          && !(service.reason === 'http' && service.httpStatus >= 500))
        || (service.status === 'unknown' && service.reason === 'ready')) return false;
      ids.add(service.id);
      return true;
    });
  }
  function lanPublicUrl(value, host, prefix) {
    if (typeof value !== 'string' || value.length > 512 || !value.startsWith('https://' + host + prefix)) return null;
    try {
      var url = new URL(value);
      var id = url.pathname.slice(prefix.length);
      if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password
        || url.port || url.search || url.hash || !url.pathname.startsWith(prefix)
        || !/^[a-zA-Z0-9]{1,128}$/.test(id)) return null;
      return url.href;
    } catch (_error) { return null; }
  }
  function validLanWorkers(data) {
    if (!data || !validLanTimestamp(data.checkedAt)
      || !Array.isArray(data.workers) || data.workers.length !== 1) return false;
    var ids = new Set();
    return data.workers.every(function (worker) {
      if (!worker || worker.id !== 'koin-web' || ids.has(worker.id)
        || typeof worker.label !== 'string' || !worker.label.trim() || worker.label.length > 80
        || ['up', 'down', 'unknown'].indexOf(worker.status) < 0
        || ['http', 'restricted', 'redirect', 'tls', 'timeout', 'unavailable'].indexOf(worker.reason) < 0
        || (worker.httpStatus !== null && (!Number.isInteger(worker.httpStatus)
          || worker.httpStatus < 100 || worker.httpStatus > 599))) return false;
      ids.add(worker.id);
      var code = worker.httpStatus;
      if (code === null) return worker.status === 'unknown'
        && ['tls', 'timeout', 'unavailable'].indexOf(worker.reason) >= 0;
      if (code >= 200 && code < 300) return worker.status === 'up' && worker.reason === 'http';
      if (code >= 500) return worker.status === 'down' && worker.reason === 'http';
      if (worker.status !== 'unknown') return false;
      return worker.reason === (code >= 300 && code < 400 ? 'redirect'
        : code === 401 || code === 403 ? 'restricted' : 'http');
    });
  }
  function lanTimestamp(value) {
    return value === null ? '시각 없음' : lanTimestampFormat.format(value) + ' KST';
  }
  function lanIsFresh(value, now) {
    return value !== null && now - value <= LAN_STALE_MS && now - value >= -5000;
  }
  function lanPercent(value) {
    return value === null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '%';
  }
  function lanMemoryPercent(node) {
    return node.memoryUsedBytes === null || node.memoryTotalBytes === null
      ? null : node.memoryUsedBytes / node.memoryTotalBytes * 100;
  }
  function lanBytes(value) {
    if (value === null) return '—';
    var gib = value >= 10737418240;
    return (value / (gib ? 1073741824 : 1048576)).toLocaleString('ko-KR', { maximumFractionDigits: gib ? 1 : 0 })
      + (gib ? ' GiB' : ' MiB');
  }
  function lanHistoryFor(id) {
    if (!lanMonitorHistory[id]) lanMonitorHistory[id] = { samples: [], lastAt: null, breakNext: false };
    return lanMonitorHistory[id];
  }
  function lanBreakHistory() {
    Object.keys(lanMonitorHistory).forEach(function (id) { lanMonitorHistory[id].breakNext = true; });
  }
  function lanPruneHistory(history, now) {
    while (history.samples.length && (history.samples.length > LAN_HISTORY_LIMIT
      || history.samples[0].at < now - LAN_HISTORY_MS)) history.samples.shift();
  }
  function rememberLanMonitor() {
    var now = Date.now();
    lanMonitorData.nodes.forEach(function (node) {
      var history = lanHistoryFor(node.id);
      lanPruneHistory(history, now);
      if (!lanIsFresh(lanMonitorData.observedAt, now) || !lanIsFresh(node.collectedAt, now)) {
        history.breakNext = true;
        return;
      }
      var cpu = node.health === 'up' ? node.cpuPercent : null;
      var ram = node.health === 'up' ? lanMemoryPercent(node) : null;
      if (history.lastAt !== null && node.collectedAt <= history.lastAt) {
        if (cpu === null || ram === null) history.breakNext = true;
        return;
      }
      if (history.samples.length === LAN_HISTORY_LIMIT) history.samples.shift();
      history.samples.push({
        at: node.collectedAt, cpu: cpu, ram: ram,
        gapBefore: history.breakNext || (history.lastAt !== null && node.collectedAt - history.lastAt > LAN_GRAPH_GAP_MS)
      });
      history.lastAt = node.collectedAt;
      history.breakNext = false;
      lanPruneHistory(history, now);
    });
  }
  function lanSvg(tag, attributes) {
    var element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attributes).forEach(function (name) { element.setAttribute(name, attributes[name]); });
    return element;
  }
  function lanDrawGraph(plot, history, now) {
    if (plot.drawAt !== undefined && now >= plot.drawAt && now - plot.drawAt < LAN_VIEW_MS
      && plot.drawLastAt === history.lastAt && plot.drawCount === history.samples.length) return;
    plot.drawAt = now;
    plot.drawLastAt = history.lastAt;
    plot.drawCount = history.samples.length;
    var svg = plot.graph;
    svg.replaceChildren();
    svg.appendChild(lanSvg('path', { d: 'M8 12H592 M8 88H592 M8 164H592', class: 'monitor-graph-grid' }));
    var firstAt = history.samples.length ? history.samples[0].at : now;
    var lastAt = history.samples.length ? history.samples[history.samples.length - 1].at : now;
    var span = Math.max(0, lastAt - firstAt);
    plot.range.textContent = span >= 60000 ? Math.ceil(span / 60000) + '분 구간'
      : span > 0 ? Math.ceil(span / 1000) + '초 구간' : '관측 시작';
    var counts = { cpu: 0, ram: 0 };
    ['cpu', 'ram'].forEach(function (key) {
      var path = '';
      var connected = false;
      history.samples.forEach(function (sample) {
        var value = sample[key];
        if (value === null) { connected = false; return; }
        var x = span > 0 ? 8 + Math.max(0, Math.min(1, (sample.at - firstAt) / span)) * 584 : 300;
        var y = 164 - value / 100 * 152;
        path += (connected && !sample.gapBefore ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
        svg.appendChild(lanSvg('circle', {
          cx: x.toFixed(2), cy: y.toFixed(2), r: '4', class: 'monitor-graph-dot', 'data-series': key
        }));
        connected = true;
        counts[key] += 1;
      });
      if (path) svg.appendChild(lanSvg('path', { d: path, class: 'monitor-graph-line', 'data-series': key }));
    });
    svg.setAttribute('aria-label', '실제 관측 구간, 최대 15분, 0에서 100퍼센트. CPU 실측 ' + counts.cpu + '개, RAM 실측 ' + counts.ram + '개. 빈 구간은 미관측.');
  }
  function lanMetric(key, label) {
    var block = el('div', 'monitor-metric');
    block.dataset.metric = key;
    var value = el('strong', 'monitor-value', '—');
    var detail = key === 'ram' ? el('span', 'monitor-metric-detail') : null;
    block.append(el('span', 'monitor-metric-label', label), value);
    if (detail) block.appendChild(detail);
    return { block: block, value: value, detail: detail };
  }
  function renderLanMonitor() {
    var container = document.getElementById('monitor-cards');
    container.replaceChildren();
    lanMonitorCards = [];
    ['prod', 'stage', 'db'].forEach(function (id) {
      var node = lanMonitorData.nodes.find(function (entry) { return entry.id === id; });
      var card = el('article', 'panel monitor-node');
      card.dataset.node = id;
      var heading = el('div', 'monitor-node-heading');
      var title = el('div', 'monitor-node-title');
      var health = el('span', 'monitor-health');
      title.append(el('h4', '', node.label), health);
      var note = el('p', 'monitor-value-note');
      heading.append(title, note);
      var metrics = el('div', 'monitor-metrics');
      var cpu = lanMetric('cpu', 'CPU');
      var ram = lanMetric('ram', 'RAM');
      metrics.append(cpu.block, ram.block);
      var plotBlock = el('div', 'monitor-plot');
      var graph = lanSvg('svg', { viewBox: '0 0 600 180', preserveAspectRatio: 'none', class: 'monitor-graph', role: 'img' });
      var graphAxis = el('div', 'monitor-graph-axis');
      var graphRange = el('span', '', '관측 시작');
      graphAxis.append(graphRange, el('span', '', '최근 수집'));
      plotBlock.append(graph, graphAxis);
      var timestamp = el('p', 'monitor-node-time');
      card.append(heading, metrics, plotBlock, timestamp);
      container.appendChild(card);
      lanMonitorCards.push({
        node: node, health: health, note: note, timestamp: timestamp, cpu: cpu, ram: ram,
        plot: { graph: graph, range: graphRange }
      });
    });
  }
  function renderLanKoin() {
    var container = document.getElementById('koin-services');
    container.replaceChildren();
    lanKoinRows = [];
    ['prod-api', 'stage-api'].forEach(function (id) {
      var service = lanKoinData.services.find(function (entry) { return entry.id === id; });
      var row = el('div', 'koin-service');
      row.dataset.service = id;
      var health = el('span', 'monitor-health');
      var detail = el('div', 'koin-service-detail');
      var reason = el('p', 'koin-service-reason');
      var timestamp = el('p', 'koin-service-time');
      detail.append(reason, timestamp);
      var heading = el('div', 'koin-service-heading');
      heading.append(el('h3', 'koin-service-name', service.label), health);
      row.append(heading, detail);
      container.appendChild(row);
      lanKoinRows.push({ row: row, service: service, health: health, reason: reason, timestamp: timestamp });
    });
  }
  function updateLanPaths(now) {
    var internal = document.getElementById('internal-path-status');
    var internalUp = !lanMonitorFailed && lanIsFresh(lanMonitorSucceededAt, now);
    internal.dataset.health = internalUp ? 'up' : 'unknown';
    internal.querySelector('span').textContent = internalUp ? '연결 정상' : '연결·인증 확인';
    internal.title = '유효한 /api/monitor 응답 수신 기준 · 노드 상태와 별개'
      + (lanMonitorSucceededAt === null ? '' : ' · 수신 ' + lanTimestamp(lanMonitorSucceededAt));
    var data = lanWorkerData;
    var age = data ? now - data.checkedAt : Infinity;
    var fresh = !lanWorkerFailed && data && age >= -5000 && age <= LAN_WORKER_STALE_MS;
    var states = ['koin-web'].map(function (id) {
      var worker = fresh ? data.workers.find(function (entry) { return entry.id === id; }) : null;
      var state = worker ? worker.status : 'unknown';
      var node = document.getElementById('worker-web-status');
      node.dataset.health = state;
      node.querySelector('span').textContent = (state === 'up' ? '정상' : state === 'down' ? '장애' : '확인 불가')
        + (worker && worker.httpStatus !== null ? ' · ' + worker.httpStatus : '');
      return state;
    });
    document.getElementById('worker-health').dataset.health = states.indexOf('down') >= 0 ? 'down'
      : states.every(function (state) { return state === 'up'; }) ? 'up' : 'unknown';
  }
  function updateLanMonitorStatus() {
    var now = Date.now();
    updateLanPaths(now);
    var states = [];
    var reasons = {
      ready: 'readiness UP', 'not-ready': 'readiness 준비 안 됨', http: 'HTTP 응답',
      tls: 'TLS 확인 실패', timeout: '응답 시간 초과', 'invalid-response': '응답 형식 확인 불가', unavailable: '연결 확인 불가'
    };
    lanKoinRows.forEach(function (entry) {
      var service = entry.service;
      var fresh = !lanKoinFailed && lanIsFresh(lanKoinData.observedAt, now) && lanIsFresh(service.checkedAt, now);
      var state = fresh ? service.status : 'unknown';
      states.push(state);
      entry.row.dataset.health = state;
      entry.health.dataset.health = state;
      entry.health.textContent = state === 'up' ? '준비됨' : state === 'down' ? '준비 안 됨' : '확인 불가';
      entry.reason.textContent = !fresh ? '최신 상태 확인 불가'
        : reasons[service.reason] + (service.httpStatus === null ? '' : ' · HTTP ' + service.httpStatus);
      entry.reason.hidden = fresh && service.reason === 'ready';
      entry.timestamp.textContent = '확인 ' + lanTimestamp(service.checkedAt);
    });
    if (!lanKoinData) states.push('unknown');
    lanMonitorCards.forEach(function (entry) {
      var node = entry.node;
      var fresh = !lanMonitorFailed && lanIsFresh(lanMonitorData.observedAt, now) && lanIsFresh(node.collectedAt, now);
      var snapshotFresh = !lanMonitorFailed && lanIsFresh(lanMonitorData.observedAt, now);
      var cpu = fresh && node.health === 'up' ? node.cpuPercent : null;
      var ram = fresh && node.health === 'up' ? lanMemoryPercent(node) : null;
      var state = snapshotFresh && node.health === 'down' ? 'down' : !fresh ? 'unknown'
        : node.health === 'up' && cpu !== null && ram !== null ? 'up' : 'unknown';
      states.push(state);
      entry.health.dataset.health = state;
      entry.health.textContent = state === 'up' ? '수집 정상' : state === 'down' ? '수집 실패' : '확인 불가';
      var ageSeconds = node.collectedAt === null ? null : Math.max(0, Math.floor((now - node.collectedAt) / 1000));
      entry.timestamp.textContent = '수집 ' + lanTimestamp(node.collectedAt)
        + (ageSeconds === null ? '' : ' · ' + ageSeconds + '초 전')
        + (fresh ? '' : ' · 최신 아님');
      entry.note.textContent = !fresh ? '최신 수치 확인 불가'
        : cpu === null || ram === null ? '일부 미수집 · —는 확인 불가' : '';
      entry.note.hidden = !entry.note.textContent;
      entry.cpu.value.textContent = lanPercent(cpu);
      entry.ram.value.textContent = lanPercent(ram);
      entry.ram.detail.textContent = ram === null ? '사용 / 전체 확인 불가'
        : lanBytes(node.memoryUsedBytes) + ' / ' + lanBytes(node.memoryTotalBytes);
      entry.ram.value.title = entry.ram.detail.textContent;
      var history = lanHistoryFor(node.id);
      if (!fresh) history.breakNext = true;
      lanPruneHistory(history, now);
      lanDrawGraph(entry.plot, history, now);
    });
    if (!lanMonitorData) states.push('unknown');
    var state = states.indexOf('down') >= 0 ? 'down' : states.indexOf('unknown') >= 0 ? 'unknown' : 'up';
    var status = document.getElementById('monitor-status');
    status.dataset.state = state;
    status.textContent = state === 'up' ? '관측 정상'
      : state === 'down' ? '일부 장애 / 수집 실패' : '일부 상태 확인 불가';
    document.getElementById('monitor-timestamp').textContent = lanMonitorData
      ? '서버 관측 ' + lanTimestamp(lanMonitorData.observedAt) : '서버 관측 대기';
    if (!lanKoinData) document.querySelector('#koin-services .monitor-waiting').textContent = lanKoinFailed
      ? '상태 확인 불가' : '상태 확인 중';
    if (!lanMonitorData) document.querySelector('#monitor-cards .monitor-waiting').textContent = lanMonitorFailed
      ? '서버 조회 실패 · 노드 관측 없음' : '서버 수집 데이터 대기 · 아직 노드 관측 없음';
  }
  async function refreshLanMonitor() {
    if (!lanIsVisible() || lanMonitorRequest) return;
    var controller = new AbortController();
    lanMonitorRequest = controller;
    var timeout = setTimeout(function () { controller.abort(); }, 8000);
    async function collect(path, validate, accept, fail) {
      try {
        var response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (response.status !== 200) throw new Error('Snapshot unavailable');
        var data = await response.json();
        if (!validate(data)) throw new Error('Invalid snapshot');
        if (lanMonitorRequest !== controller || !lanIsVisible()) return;
        accept(data);
      } catch (_error) {
        if (lanMonitorRequest !== controller || !lanIsVisible()) return;
        fail();
      }
      if (lanMonitorRequest === controller && lanIsVisible()) updateLanMonitorStatus();
    }
    try {
      await Promise.all([
        collect('/api/monitor', validLanMonitor, function (data) {
          lanMonitorData = data;
          lanMonitorFailed = false;
          lanMonitorSucceededAt = Date.now();
          rememberLanMonitor();
          renderLanMonitor();
        }, function () { lanMonitorFailed = true; lanBreakHistory(); }),
        collect('/api/koin-health', validLanKoin, function (data) {
          lanKoinData = data;
          lanKoinFailed = false;
          renderLanKoin();
        }, function () { lanKoinFailed = true; })
      ]);
    } finally {
      clearTimeout(timeout);
      if (lanMonitorRequest === controller) lanMonitorRequest = null;
    }
  }
  async function refreshLanWorkers() {
    if (!lanIsVisible() || lanWorkerRequest) return;
    var controller = new AbortController();
    lanWorkerRequest = controller;
    lanWorkerRequestTimer = setTimeout(function () { controller.abort(); }, 8000);
    try {
      var response = await fetch('/api/worker-health', {
        method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal
      });
      if (response.status !== 200) throw new Error('Worker status unavailable');
      var data = await response.json();
      if (!validLanWorkers(data)) throw new Error('Invalid Worker status');
      if (lanWorkerRequest !== controller || !lanIsVisible()) return;
      lanWorkerData = data;
      lanWorkerFailed = false;
    } catch (_error) {
      if (lanWorkerRequest !== controller || !lanIsVisible()) return;
      lanWorkerData = null;
      lanWorkerFailed = true;
    } finally {
      if (lanWorkerRequest === controller) {
        clearTimeout(lanWorkerRequestTimer);
        lanWorkerRequestTimer = null;
        lanWorkerRequest = null;
        if (lanIsVisible()) updateLanPaths(Date.now());
      }
    }
  }
 function renderLanSpotifyCover(key, url) {
 if (key === lanSpotifyCoverKey) return;
 lanSpotifyCoverKey = key;
 lanSpotifyCover.hidden = true;
 lanSpotifyCover.onload = null;
 lanSpotifyCover.onerror = null;
 lanSpotifyCover.removeAttribute('src');
 if (!url) return;
 // A new element isolates stale load/error events when tracks change rapidly.
 var image = new Image(44, 44);
 image.id = 'spotify-cover';
 image.className = 'spotify-cover';
 image.alt = '';
 image.referrerPolicy = 'no-referrer';
 image.decoding = 'async';
 image.hidden = true;
 image.onload = function () {
 if (lanSpotifyCover === image && lanSpotifyCoverKey === key) image.hidden = false;
 };
 image.onerror = function () {
 if (lanSpotifyCover !== image || lanSpotifyCoverKey !== key) return;
 image.hidden = true;
 image.removeAttribute('src');
 };
 lanSpotifyCover.replaceWith(image);
 lanSpotifyCover = image;
 image.src = url;
 }
 function renderLanSpotify(data) {
 var labels = {
 idle: '대기 중', loading: '불러오는 중', playing: '재생 중',
 paused: '일시 정지', error: '연결 오류', unknown: '상태 확인 불가'
 };
 var state = data && Object.prototype.hasOwnProperty.call(labels, data.state) ? data.state : 'unknown';
 var title = '';
 var artists = '';
 if (state === 'playing' || state === 'paused' || state === 'loading') {
 title = typeof data.title === 'string' && data.title.trim()
 ? data.title : (state === 'loading' ? '곡 정보를 불러오고 있습니다' : '제목 정보 없음');
 artists = Array.isArray(data.artists)
 ? data.artists.filter(function (artist) { return typeof artist === 'string' && artist.trim(); }).join(', ') : '';
 if (!artists) artists = '아티스트 정보 없음';
 } else if (state === 'idle') {
 title = '재생 중인 항목 없음';
 artists = '';
 } else if (state === 'error') {
 title = '재생 정보를 가져올 수 없습니다';
 artists = '';
 } else {
 title = '재생 상태를 확인할 수 없습니다';
 artists = '';
 }
 var active = state === 'playing' || state === 'paused' || state === 'loading';
 var cover = active ? lanPublicUrl(data.coverUrl, 'i.scdn.co', '/image/') : null;
 // Timestamps alone must not mutate the live region or repeat announcements.
 var signature = JSON.stringify([state, title, artists, cover]);
 if (signature === lanSpotifySignature) return;
 lanSpotifySignature = signature;
 lanSpotifyNode.dataset.state = state;
 lanSpotifyNode.setAttribute('aria-label', labels[state]);
 lanSpotifyTitle.textContent = title;
 lanSpotifyArtists.textContent = artists;
 renderLanSpotifyCover(active ? JSON.stringify([title, artists, cover]) : null, cover);
 }
 async function refreshLanSpotify() {
 if (!lanIsVisible() || lanSpotifyRequest) return;
 var controller = new AbortController();
 lanSpotifyRequest = controller;
 lanSpotifyRequestTimer = setTimeout(function () {
 if (lanSpotifyRequest === controller) controller.abort();
 }, 5000);
 try {
 var response = await fetch('/api/spotify', {
 cache: 'no-store', credentials: 'same-origin', signal: controller.signal
 });
 if (!response.ok) throw new Error('Spotify status unavailable');
 var data = await response.json();
 if (lanSpotifyRequest !== controller || !lanIsVisible()) return;
 renderLanSpotify(data);
 } catch (_error) {
 if (lanSpotifyRequest !== controller || !lanIsVisible()) return;
 renderLanSpotify({ state: 'error' });
 } finally {
 if (lanSpotifyRequest === controller) {
 clearTimeout(lanSpotifyRequestTimer);
 lanSpotifyRequestTimer = null;
 lanSpotifyRequest = null;
 }
 }
 }
 function clearLanJamImage() {
 clearTimeout(lanJamImageTimer);
 lanJamImageTimer = null;
 if (lanJamImage) {
 var image = lanJamImage;
 lanJamImage = null;
 image.onload = null;
 image.onerror = null;
 image.removeAttribute('src');
 }
 if (lanJamFigure) lanJamFigure.remove();
 lanJamFigure = null;
 lanJamCodes.classList.remove('has-jam');
 }
 function renderLanJam(available) {
 lanJamAvailable = available;
 if (!available) { clearLanJamImage(); return; }
 if (lanJamImage) return;
 var figure = document.createElement('figure');
 figure.id = 'spotify-jam';
 figure.className = 'wifi-code';
 var image = new Image();
 image.id = 'spotify-jam-qr';
 image.alt = 'Spotify Jam 참여 QR 코드';
 image.decoding = 'async';
 var caption = document.createElement('figcaption');
 caption.textContent = 'Spotify Jam';
 figure.append(image, caption);
 lanJamFigure = figure;
 lanJamImage = image;
 image.onload = function () {
 if (lanJamImage !== image || !lanJamAvailable || !lanIsVisible()) return;
 clearTimeout(lanJamImageTimer);
 lanJamImageTimer = null;
 lanJamCodes.appendChild(figure);
 lanJamCodes.classList.add('has-jam');
 };
 image.onerror = function () {
 if (lanJamImage !== image) return;
 clearLanJamImage();
 };
 lanJamImageTimer = setTimeout(function () {
 if (lanJamImage !== image) return;
 clearLanJamImage();
 }, 8000);
 image.src = '/api/jam-qr';
 }
 async function refreshLanJam() {
 if (!lanIsVisible() || lanJamRequest) return;
 var controller = new AbortController();
 lanJamRequest = controller;
 lanJamRequestTimer = setTimeout(function () {
 if (lanJamRequest === controller) controller.abort();
 }, 5000);
 try {
 var response = await fetch('/api/jam', {
 cache: 'no-store', credentials: 'same-origin', signal: controller.signal
 });
 if (response.status !== 200) throw new Error('Jam status unavailable');
 var data = await response.json();
 if (!data || typeof data.available !== 'boolean') throw new Error('Invalid Jam status');
 if (lanJamRequest !== controller || !lanIsVisible()) return;
 renderLanJam(data.available);
 } catch (_error) {
 if (lanJamRequest !== controller || !lanIsVisible()) return;
 renderLanJam(false);
 } finally {
 if (lanJamRequest === controller) {
 clearTimeout(lanJamRequestTimer);
 lanJamRequestTimer = null;
 lanJamRequest = null;
 }
 }
 }
  function refreshLanActiveView() {
 refreshLanSpotify();
 refreshLanJam();
    if (lanView === 'monitor') refreshLanMonitor();
    else refresh();
  }
  var lanOriginalRefresh = refresh;
  refresh = async function () {
    if (!lanIsVisible()) return;
    if (refreshing) { lanRefreshPending = true; return; }
    do {
      lanRefreshPending = false;
      await lanOriginalRefresh();
    } while (lanRefreshPending && lanIsVisible());
  };
  function stopLanEvents() {
    if (lanEvents) { lanEvents.close(); lanEvents = null; }
  }
  function startLanEvents() {
    if (!lanIsVisible() || !window.EventSource) return;
    if (lanEvents && lanEvents.readyState !== EventSource.CLOSED) return;
    stopLanEvents();
    try {
      var source = new EventSource('/api/events');
      lanEvents = source;
      lanLastEventAt = Date.now();
      source.addEventListener('state', function () {
        if (lanEvents !== source) return;
        lanLastEventAt = Date.now();
        refresh();
      });
      source.addEventListener('ping', function () {
        if (lanEvents === source) lanLastEventAt = Date.now();
      });
      source.addEventListener('attention', function () {
        if (lanEvents !== source || !lanIsVisible()) return;
        lanLastEventAt = Date.now();
        attendLanScreen();
      });
      source.addEventListener('greeting', function (event) {
        if (lanEvents !== source || !lanIsVisible()) return;
        lanLastEventAt = Date.now();
        attendLanScreen();
        try { showLanGreeting(JSON.parse(event.data)); }
        catch (_error) { /* Never retain or log event payloads. */ }
      });
    } catch (_error) { stopLanEvents(); }
  }
  function recoverLanState() {
    if (!lanIsVisible()) return;
    var stalled = lanEvents && Date.now() - lanLastEventAt > POLL_MS;
    if (!lanEvents || lanEvents.readyState !== EventSource.OPEN || stalled
      || document.getElementById('sync-status').dataset.state === 'error') {
      if (stalled) stopLanEvents();
      startLanEvents();
      refresh();
    }
  }
  function stopLanActivity() {
    lanBreakHistory();
 clearInterval(lanJamInterval);
 clearTimeout(lanJamRequestTimer);
 lanJamInterval = null;
 lanJamRequestTimer = null;
 if (lanJamRequest) {
 var jamRequest = lanJamRequest;
 lanJamRequest = null;
 jamRequest.abort();
 }
 renderLanJam(false);
    stopLanEvents();
 clearInterval(lanSpotifyInterval);
 clearTimeout(lanSpotifyRequestTimer);
 lanSpotifyInterval = null;
 lanSpotifyRequestTimer = null;
 if (lanSpotifyRequest) {
 var spotifyRequest = lanSpotifyRequest;
 lanSpotifyRequest = null;
 spotifyRequest.abort();
 }
 renderLanSpotify({ state: 'unknown' });
    clearTimeout(lanRotationTimer);
    clearInterval(lanMonitorInterval);
    clearInterval(lanMonitorAgeInterval);
    clearInterval(lanRecoveryInterval);
    clearInterval(lanWorkerInterval);
    clearTimeout(lanWorkerRequestTimer);
    lanWorkerInterval = null;
    lanWorkerRequestTimer = null;
    if (lanWorkerRequest) {
      var workerRequest = lanWorkerRequest;
      lanWorkerRequest = null;
      workerRequest.abort();
    }
    lanWorkerData = null;
    lanWorkerFailed = true;
    updateLanPaths(Date.now());
    lanRotationTimer = null;
    lanMonitorInterval = null;
    lanMonitorAgeInterval = null;
    lanRecoveryInterval = null;
    if (lanMonitorRequest) {
      var request = lanMonitorRequest;
      lanMonitorRequest = null;
      request.abort();
    }
    lanRefreshPending = false;
    closeLanGreeting(true);
    if (fitFrame) { cancelAnimationFrame(fitFrame); fitFrame = 0; }
  }
  function startLanActivity() {
    if (!lanIsVisible() || lanMonitorInterval !== null) return;
    attendLanScreen();
    startLanEvents();
    refresh();
    refreshLanMonitor();
    refreshLanWorkers();
 refreshLanSpotify();
 lanSpotifyInterval = setInterval(refreshLanSpotify, LAN_SPOTIFY_POLL_MS);
 refreshLanJam();
 lanJamInterval = setInterval(refreshLanJam, LAN_JAM_POLL_MS);
    lanWorkerInterval = setInterval(refreshLanWorkers, LAN_WORKER_POLL_MS);
    lanMonitorInterval = setInterval(refreshLanMonitor, LAN_VIEW_MS);
    lanMonitorAgeInterval = setInterval(updateLanMonitorStatus, 1000);
    lanRecoveryInterval = setInterval(recoverLanState, POLL_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLanActivity();
    else startLanActivity();
  });
  window.addEventListener('pagehide', function () {
    lanPageHidden = true;
    stopLanActivity();
  });
  window.addEventListener('pageshow', function () {
    lanPageHidden = false;
    startLanActivity();
  });
  async function checkSession() {
    authActive = true;
    authRevision += 1;
    authDeadline = Infinity;
    authExpiresAt = Infinity;
    authClockOffset = 0;
    document.getElementById('login-panel').hidden = true;
    document.getElementById('main').hidden = false;
    document.getElementById('logout').hidden = true;
    document.getElementById('refresh').hidden = false;
    document.getElementById('viewer-name').textContent = '임시 LAN 운영 · 로그인 없음';
    document.getElementById('viewer-name').hidden = false;
    loadWifiImages(true);
    startLanActivity();
    return true;
  }
  `;
const html = (DASHBOARD_HTML.slice(0, start) + bootstrap + DASHBOARD_HTML.slice(end))
  .replace(pollMarker, '')
  .replace(manualRefreshMarker, "document.getElementById('refresh').addEventListener('click', refreshLanActiveView);")
  .replace(
    fitMarker,
    "function fitWall() {\n    if (typeof lanView !== 'undefined' && (lanView !== 'attendance' || document.hidden || lanPageHidden)) return;",
  )
  .replace(headerActionsMarker, spotifyMarkup + headerActionsMarker)
  .replace('</main>', '</main>' + monitorMarkup)
  .replace('</style>', greetingStyles + monitorStyles + spotifyStyles + jamStyles + '</style>')
  .replace('<script>', greetingMarkup + '<script>')
  .replace(' · 10초마다 갱신', ' · 변경 즉시 갱신 · 연결 장애 시 10초마다 재시도')
  .replace('저장소 반영에 최대 약 60초 소요될 수 있습니다.', '저장 즉시 화면 갱신 · 연결 장애 시 10초마다 재시도');
await writeFile(resolve(outputPath), html, { mode: 0o644 });
