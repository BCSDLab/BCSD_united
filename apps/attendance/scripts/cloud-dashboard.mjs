// 실제 LAN 대시보드의 스크립트 범위로 직렬화한다.
// 표시·전송만 바꾸며 원본 응답의 시각·데이터를 수정하지 않는다.
function createCloudMode() {
  var metadata = null;
  var available = false;
  var stateAt = null;
  var statusTimer = null;
  var ageTimer = null;
  var request = null;
  var requestTimer = null;
  var problem = '관측 시각 확인 중';
  var badge = document.getElementById('cloud-snapshot');
  var timestamp = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function fresh(value) {
    return (
      value &&
      Number.isSafeInteger(value.observedAt) &&
      value.observedAt > 0 &&
      Number.isSafeInteger(value.publishedAt) &&
      value.publishedAt >= value.observedAt &&
      Date.now() - value.observedAt >= -5000 &&
      Date.now() - value.observedAt <= 300000
    );
  }
  function drawBadge() {
    var age = metadata ? Math.max(0, Math.floor((Date.now() - metadata.observedAt) / 1000)) : null;
    var text =
      '원격 스냅샷 · ' +
      (metadata ? timestamp.format(metadata.observedAt) + ' KST · ' + age + '초 전' : '관측 시각 없음');
    text += available ? ' · 관측 시점 기준' : ' · ' + problem + ' · 표시 중단';
    if (badge.textContent !== text) badge.textContent = text;
    badge.dataset.state = available ? 'snapshot' : 'unavailable';
    document.body.dataset.cloudState = available ? 'snapshot' : 'unavailable';
  }
  function suspend(reason) {
    available = false;
    problem = reason;
    stopLanSnapshotActivity();
    setSync('error', '스냅샷 확인 불가');
    drawBadge();
  }
  function updateAge() {
    if (available && !fresh(metadata)) suspend('5분 초과 또는 시계 불일치');
    else drawBadge();
  }
  async function refreshStatus() {
    if (!lanIsVisible() || request) return;
    var controller = new AbortController();
    request = controller;
    requestTimer = setTimeout(function () {
      controller.abort();
    }, 8000);
    try {
      var response = await fetch('/api/view-status', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      var status = await response.json();
      if (request !== controller || !lanIsVisible()) return;
      if (
        status &&
        Number.isSafeInteger(status.observedAt) &&
        status.observedAt > 0 &&
        Number.isSafeInteger(status.publishedAt) &&
        status.publishedAt >= status.observedAt
      ) {
        if (!metadata || metadata.observedAt !== status.observedAt || metadata.publishedAt !== status.publishedAt) {
          // 이전 선택 요청을 중단하고 진행 중인 요청의 스냅샷 버전도 대조한다.
          stopLanSnapshotActivity();
          available = false;
          metadata = { observedAt: status.observedAt, publishedAt: status.publishedAt };
          document.body.dataset.cloudCore = 'pending';
          lanMonitorFailed = true;
          lanKoinFailed = true;
          lanWorkerFailed = true;
          updateLanMonitorStatus();
        }
      }
      if (response.status !== 200 || !status || status.available !== true || !fresh(status)) {
        suspend(status && status.available === false ? '유효한 스냅샷 없음' : '관측 시각 확인 불가');
        return;
      }
      available = true;
      drawBadge();
      startLanSnapshotActivity();
    } catch {
      if (request === controller && lanIsVisible()) suspend('연결 또는 인증 확인 불가');
    } finally {
      if (request === controller) {
        clearTimeout(requestTimer);
        requestTimer = null;
        request = null;
      }
    }
  }
  async function fetchSnapshot(path, options) {
    if (!available || !fresh(metadata)) throw new Error('Snapshot unavailable');
    var expected = metadata;
    var response = await fetch(
      path,
      Object.assign({}, options, {
        credentials: 'same-origin',
        redirect: 'error',
      }),
    );
    if (
      !available ||
      metadata !== expected ||
      !fresh(expected) ||
      Number(response.headers.get('x-bcsd-snapshot-observed-at')) !== expected.observedAt ||
      Number(response.headers.get('x-bcsd-snapshot-published-at')) !== expected.publishedAt ||
      response.status === 401 ||
      response.status === 403
    ) {
      throw new Error('Snapshot identity unavailable');
    }
    return response;
  }
  async function snapshotJson(response) {
    var data = await response.json();
    if (
      !available ||
      !fresh(metadata) ||
      Number(response.headers.get('x-bcsd-snapshot-observed-at')) !== metadata.observedAt ||
      Number(response.headers.get('x-bcsd-snapshot-published-at')) !== metadata.publishedAt
    ) {
      throw new Error('Snapshot changed while reading');
    }
    return data;
  }
  function start() {
    if (!lanIsVisible() || statusTimer !== null) return;
    refreshStatus();
    statusTimer = setInterval(refreshStatus, POLL_MS);
    ageTimer = setInterval(updateAge, 1000);
  }
  function stop() {
    clearInterval(statusTimer);
    clearInterval(ageTimer);
    clearTimeout(requestTimer);
    statusTimer = null;
    ageTimer = null;
    requestTimer = null;
    if (request) {
      var pending = request;
      request = null;
      pending.abort();
    }
    available = false;
    problem = '관측 시각 재확인 필요';
    stopLanSnapshotActivity();
    drawBadge();
  }
  return {
    start: start,
    stop: stop,
    fetch: fetchSnapshot,
    json: snapshotJson,
    stateNow: function () {
      return stateAt === null ? Date.now() : stateAt;
    },
    captureState: function (value) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid state clock');
      stateAt = value;
      document.body.dataset.cloudCore = 'ready';
    },
    observedNow: function () {
      return metadata ? metadata.observedAt : Date.now();
    },
  };
}

export function cloudDashboard(lan) {
  if (!lan.startsWith('<!doctype html>')) throw new Error('Expected the complete LAN dashboard');
  let html = lan;
  function replace(before, after, count = 1) {
    if (html.split(before).length - 1 !== count) {
      throw new Error('LAN dashboard structure changed: ' + before.slice(0, 100));
    }
    html = html.split(before).join(after);
  }
  function replaceSection(start, end, replacement) {
    if (html.split(start).length !== 2 || html.split(end).length !== 2) {
      throw new Error('LAN dashboard lifecycle structure changed');
    }
    const from = html.indexOf(start);
    const to = html.indexOf(end);
    if (from >= to) throw new Error('LAN dashboard lifecycle order changed');
    html = html.slice(0, from) + replacement + html.slice(to);
  }

  replace('<body>', '<body data-cloud-state="unavailable">');
  replace(
    '  <section class="login-panel"',
    '  <aside id="cloud-snapshot" role="status" aria-live="polite" aria-atomic="true" data-state="unavailable">원격 스냅샷 · 관측 시각 확인 중 · 표시 중단</aside>\n  <section class="login-panel"',
  );
  replace(
    '</style>',
    `
#cloud-snapshot { flex-shrink:0; margin:0 0 8px; padding:4px 10px; border:1px solid var(--line); border-radius:10px; color:var(--amber); background:var(--surface-low); font:500 16px/1.35 system-ui,sans-serif; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
#cloud-snapshot[data-state="unavailable"] { color:var(--error); background:var(--error-container); }
body[data-cloud-state="unavailable"] #main, body[data-cloud-state="unavailable"] #monitor-view, body[data-cloud-state="unavailable"] #spotify-now { visibility:hidden; }
body[data-cloud-core="pending"] #main { visibility:hidden; }
</style>`,
  );

  // 체류 시간만 관측 시각에 고정하고 실제 헤더 시계는 계속 갱신한다.
  replace(
    'function serverNow() { return Date.now() + serverOffset; }',
    'function serverNow() { return cloud.stateNow(); }',
  );
  replace('serverOffset = state.now - Date.now();', 'cloud.captureState(state.now);');
  replace('var now = serverNow();', 'var now = Date.now();');
  replace(
    "var elapsedNow = document.getElementById('sync-status').dataset.state === 'error' ? lastStateAt : now;",
    'var elapsedNow = cloud.stateNow();',
  );
  replace("'마지막 동기화 ' + clockFormat.format(state.now)", "'출입 관측 ' + clockFormat.format(state.now)");
  replace("setSync('ready', '동기화 정상');", "setSync('ready', '스냅샷 표시 · 실시간 아님');");

  // 기존 45초·Worker 신선도 창은 관측 당시 기준으로 평가한다.
  // collectedAt·checkedAt·원본 observedAt은 변경하지 않는다.
  for (const name of ['rememberLanMonitor', 'updateLanMonitorStatus']) {
    replace(
      'function ' + name + '() {\n    var now = Date.now();',
      'function ' + name + '() {\n    var now = cloud.observedNow();',
    );
  }
  replace('lanMonitorSucceededAt = Date.now();', 'lanMonitorSucceededAt = cloud.observedNow();');
  replace('updateLanPaths(Date.now());', 'updateLanPaths(cloud.observedNow());', 2);
  replace("internalUp ? '연결 정상' : '연결·인증 확인'", "internalUp ? '관측 시 연결 정상' : '관측 시 확인 불가'");
  replace(
    "'유효한 /api/monitor 응답 수신 기준 · 노드 상태와 별개'",
    "'스냅샷의 /api/monitor 수집 성공 기준 · 현재 연결 상태 아님'",
  );
  replace(
    "node.querySelector('span').textContent = (state === 'up'",
    "node.querySelector('span').textContent = '관측 시 ' + (state === 'up'",
  );
  replace("entry.health.textContent = state === 'up'", "entry.health.textContent = '관측 시 ' + (state === 'up'", 2);
  replace(
    "? '준비됨' : state === 'down' ? '준비 안 됨' : '확인 불가';",
    "? '준비됨' : state === 'down' ? '준비 안 됨' : '확인 불가');",
  );
  replace(
    "? '수집 정상' : state === 'down' ? '수집 실패' : '확인 불가';",
    "? '수집 정상' : state === 'down' ? '수집 실패' : '확인 불가');",
  );
  replace("+ ageSeconds + '초 전'", "+ ageSeconds + '초 전 수집(관측 기준)'");
  replace('>KOIN 시스템 상태</h2>', '>KOIN 관측 시점 상태</h2>');
  replace('lanSpotifyTitle.textContent = title;', "lanSpotifyTitle.textContent = '관측 시 · ' + title;");
  replace(
    "lanSpotifyNode.setAttribute('aria-label', labels[state]);",
    "lanSpotifyNode.setAttribute('aria-label', '관측 시점 · ' + labels[state]);",
  );
  replace('>지금 동아리방에는</h2>', '>관측 시 동아리방에는</h2>');
  replace('>지금 있는 사람</h2>', '>관측 시 입실한 사람</h2>');
  replace("'입실 중' : '퇴실'", "'관측 시 입실' : '관측 시 퇴실'");

  for (const endpoint of ['/api/state', '/api/worker-health', '/api/spotify', '/api/jam']) {
    replace("await fetch('" + endpoint + "',", "await cloud.fetch('" + endpoint + "',");
  }
  replace('await fetch(path,', 'await cloud.fetch(path,');
  replace('var state = await response.json();', 'var state = await cloud.json(response);');
  replace('var data = await response.json();', 'var data = await cloud.json(response);', 4);

  // 원격 스냅샷은 NFC 이벤트 스트림이나 과거 인사 모달을 재생하지 않는다.
  replaceSection(
    '  function stopLanEvents() {',
    '  function stopLanActivity() {',
    `  function recoverLanState() {
    if (lanIsVisible()) refresh();
  }
`,
  );
  replace('  function stopLanActivity() {', '  function stopLanSnapshotActivity() {');
  replace('    stopLanEvents();\n', '');
  replace('  function startLanActivity() {', '  function startLanSnapshotActivity() {');
  replace('    startLanEvents();\n', '');
  replace(
    "  document.addEventListener('visibilitychange', function () {\n    if (document.hidden) stopLanActivity();",
    "  function startLanActivity() { cloud.start(); }\n  function stopLanActivity() { cloud.stop(); }\n  document.addEventListener('visibilitychange', function () {\n    if (document.hidden) stopLanActivity();",
  );
  replace('임시 LAN 운영 · 로그인 없음', '보호된 원격 스냅샷');
  replace('변경 즉시 갱신 · 연결 장애 시 10초마다 재시도', 'KV 반영 지연 있음 · 관측 시점 기준');
  replace('var lanEvents = null;', 'var cloud = (' + createCloudMode.toString() + ')();\n  var lanEvents = null;');
  replace('저장 즉시 화면 갱신 · 연결 장애 시 10초마다 재시도', '관측 시점 데이터 · NFC는 LAN에서 즉시 반영');
  return html;
}
