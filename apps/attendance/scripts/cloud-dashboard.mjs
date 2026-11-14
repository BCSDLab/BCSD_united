import { createInternalLogin, INTERNAL_LOGIN_STYLES } from './internal-login.mjs';

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
  var transfers = new Set();
  var responses = new WeakMap();
  var wifiUrls = [];
  var jamUrl = null;
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
      Number.isSafeInteger(value.servedAt) &&
      Number.isFinite(value.receivedAt) &&
      value.servedAt - value.observedAt >= -5000 &&
      value.servedAt - value.observedAt + performance.now() - value.receivedAt <= 300000
    );
  }
  function drawBadge() {
    var age = metadata
      ? Math.max(
          0,
          Math.floor((metadata.servedAt - metadata.observedAt + performance.now() - metadata.receivedAt) / 1000),
        )
      : null;
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
      if (request !== controller || !lanIsVisible()) return;
      if (internalLogin.handleUnauthorized(response)) return;
      var status = await response.json();
      if (request !== controller || !lanIsVisible()) return;
      if (status && Number.isSafeInteger(status.servedAt)) status.receivedAt = performance.now();
      if (
        status &&
        Number.isSafeInteger(status.observedAt) &&
        status.observedAt > 0 &&
        Number.isSafeInteger(status.publishedAt) &&
        status.publishedAt >= status.observedAt &&
        Number.isSafeInteger(status.servedAt)
      ) {
        if (!metadata || metadata.observedAt !== status.observedAt || metadata.publishedAt !== status.publishedAt) {
          // 이전 선택 요청을 중단하고 진행 중인 요청의 스냅샷 버전도 대조한다.
          clearWifi();
          stopLanSnapshotActivity();
          available = false;
          metadata = { observedAt: status.observedAt, publishedAt: status.publishedAt };
          document.body.dataset.cloudCore = 'pending';
          lanMonitorFailed = true;
          lanKoinFailed = true;
          lanWorkerFailed = true;
          updateLanMonitorStatus();
        }
        metadata.servedAt = status.servedAt;
        metadata.receivedAt = status.receivedAt;
      }
      if (response.status !== 200 || !status || status.available !== true || !fresh(status)) {
        suspend(status && status.available === false ? '유효한 스냅샷 없음' : '관측 시각 확인 불가');
        return;
      }
      available = true;
      drawBadge();
      if (
        !document.getElementById('wifi-5').hasAttribute('src') ||
        !document.getElementById('wifi-24').hasAttribute('src')
      )
        loadWifi(true);
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
  function release(transfer) {
    clearTimeout(transfer.timer);
    if (transfer.signal) transfer.signal.removeEventListener('abort', transfer.abort);
    transfers.delete(transfer);
  }
  function matches(transfer, response) {
    return (
      lanIsVisible() &&
      transfer.revision === authRevision &&
      available &&
      metadata === transfer.expected &&
      fresh(transfer.expected) &&
      !transfer.controller.signal.aborted &&
      Number(response.headers.get('x-bcsd-snapshot-observed-at')) === transfer.expected.observedAt &&
      Number(response.headers.get('x-bcsd-snapshot-published-at')) === transfer.expected.publishedAt
    );
  }
  async function fetchSnapshot(path, options) {
    if (!lanIsVisible() || !available || !fresh(metadata)) throw new Error('Snapshot unavailable');
    var controller = new AbortController();
    var transfer = {
      controller: controller,
      expected: metadata,
      revision: authRevision,
      signal: options && options.signal,
      timer: null,
      abort: function () {
        controller.abort();
      },
    };
    transfers.add(transfer);
    if (transfer.signal) {
      if (transfer.signal.aborted) controller.abort();
      else transfer.signal.addEventListener('abort', transfer.abort, { once: true });
    }
    transfer.timer = setTimeout(transfer.abort, 8000);
    try {
      var response = await fetch(
        path,
        Object.assign({}, options, {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        }),
      );
      if (!lanIsVisible() || transfer.revision !== authRevision) throw new Error('Session changed');
      if (internalLogin.handleUnauthorized(response)) throw new Error('Session unavailable');
      if (!matches(transfer, response)) throw new Error('Snapshot identity unavailable');
      if (!response.ok) {
        if (response.body) await response.body.cancel();
        release(transfer);
      } else responses.set(response, transfer);
      return response;
    } catch (error) {
      controller.abort();
      release(transfer);
      throw error;
    }
  }
  async function readSnapshot(response, format) {
    var transfer = responses.get(response);
    if (!transfer) throw new Error('Snapshot request unavailable');
    try {
      var data = format === 'blob' ? await response.blob() : await response.json();
      if (!matches(transfer, response)) throw new Error('Snapshot changed while reading');
      return data;
    } finally {
      release(transfer);
      responses.delete(response);
    }
  }
  function snapshotJson(response) {
    return readSnapshot(response, 'json');
  }
  function clearWifi() {
    wifiUrls.forEach(function (url) {
      URL.revokeObjectURL(url);
    });
    wifiUrls = [];
    ['wifi-5', 'wifi-24'].forEach(function (id) {
      var image = document.getElementById(id);
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      image.hidden = true;
    });
  }
  function loadWifi(enabled) {
    clearWifi();
    if (!enabled || !lanIsVisible()) return;
    [
      ['wifi-5', '/api/wifi-qr/5'],
      ['wifi-24', '/api/wifi-qr/2.4'],
    ].forEach(async function (entry) {
      var revision = authRevision;
      var expected = metadata;
      var image = document.getElementById(entry[0]);
      var status = document.getElementById(entry[0] + '-status');
      status.hidden = false;
      status.textContent = 'QR 코드를 확인하고 있습니다';
      try {
        var response = await fetchSnapshot(entry[1]);
        if (!response.ok) throw new Error('QR unavailable');
        var blob = await readSnapshot(response, 'blob');
        if (!lanIsVisible() || revision !== authRevision || expected !== metadata) return;
        var url = URL.createObjectURL(blob);
        wifiUrls.push(url);
        image.onload = function () {
          if (!lanIsVisible() || revision !== authRevision || expected !== metadata) return;
          image.hidden = false;
          status.hidden = true;
        };
        image.onerror = function () {
          image.hidden = true;
          status.textContent = 'QR 코드를 표시할 수 없습니다';
        };
        image.src = url;
      } catch {
        if (!lanIsVisible() || revision !== authRevision) return;
        status.textContent = 'QR 코드를 확인할 수 없습니다';
      }
    });
  }
  async function loadJamImage(image) {
    var revision = authRevision;
    var expected = metadata;
    try {
      var response = await fetchSnapshot('/api/jam-qr');
      if (!response.ok) throw new Error('Jam QR unavailable');
      var blob = await readSnapshot(response, 'blob');
      if (!lanIsVisible() || revision !== authRevision || expected !== metadata || lanJamImage !== image) return;
      var url = URL.createObjectURL(blob);
      if (jamUrl) URL.revokeObjectURL(jamUrl);
      jamUrl = url;
      image.src = url;
    } catch {
      if (lanIsVisible() && revision === authRevision && lanJamImage === image && image.onerror) image.onerror();
    }
  }
  function start() {
    if (!lanIsVisible() || statusTimer !== null) return;
    refreshStatus();
    statusTimer = setInterval(refreshStatus, POLL_MS);
    ageTimer = setInterval(updateAge, 1000);
  }
  function stop() {
    transfers.forEach(function (transfer) {
      transfer.controller.abort();
      release(transfer);
    });
    clearWifi();
    if (jamUrl) URL.revokeObjectURL(jamUrl);
    jamUrl = null;
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
    clear: function () {
      stop();
      metadata = null;
      stateAt = null;
      document.body.dataset.cloudCore = 'pending';
      drawBadge();
    },
    loadJamImage: loadJamImage,
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

// 자동화 관측은 Pi 스냅샷의 시각·가용성과 독립적으로 갱신한다.
function createAutomationMonitor(auth) {
  const parts = {
    ingress: { data: null, ok: false, age: 0, received: 0, reason: '확인 중' },
    rocky: { data: null, ok: false, age: 0, received: 0, reason: '확인 중' },
  };
  const time = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const text = (id, value) => {
    document.getElementById(id).textContent = value;
  };
  let request = null,
    pollTimer = null,
    ageTimer = null,
    pageHidden = false;
  const active = () => auth.isAuthorized() && !pageHidden && !document.hidden && navigator.onLine !== false;
  const fresh = (part) =>
    part.ok && part.data !== null && active() && part.age + performance.now() - part.received < 120000;
  function render() {
    for (const [name, part] of Object.entries(parts)) {
      const current = fresh(part);
      const node = document.getElementById('am-' + name + '-state');
      node.dataset.state = current ? 'ok' : 'unknown';
      node.textContent = current
        ? name === 'ingress'
          ? 'Worker 응답 · 저장소 조회됨'
          : '게이트웨이 응답'
        : part.ok
          ? '확인 시간 초과 · 현재 상태 알 수 없음'
          : part.reason;
      text(
        'am-' + name + '-time',
        part.data ? (current ? '확인 ' : '마지막 확인 ') + time.format(part.data.checkedAt) + ' KST' : '확인 —',
      );
    }
    const ingress = parts.ingress,
      rocky = parts.rocky;
    const prefix = (part) => (fresh(part) ? '' : part.data ? '마지막 확인 값 · ' : '');
    for (const name of ['sentry', 'cloudflare']) {
      const value = ingress.data && ingress.data.sources[name];
      text(
        'am-' + name,
        (name === 'sentry' ? 'Sentry ' : 'Cloudflare ') +
          prefix(ingress) +
          (value
            ? value.count + '건 · 신규 ' + (value.latestAt === null ? '없음' : time.format(value.latestAt) + ' KST')
            : '—'),
      );
    }
    text(
      'am-cpu',
      'CPU ' +
        prefix(rocky) +
        (rocky.data && rocky.data.cpu !== null ? rocky.data.cpu.usagePercent.toFixed(1) + '%' : '미측정'),
    );
    const memory = rocky.data && rocky.data.memory;
    text(
      'am-memory',
      'RAM ' +
        prefix(rocky) +
        (memory
          ? (memory.usedBytes / 1073741824).toFixed(1) +
            ' / ' +
            (memory.totalBytes / 1073741824).toFixed(1) +
            ' GiB 사용'
          : '미측정'),
    );
    for (const name of ['executor', 'broker']) {
      const unit = rocky.data && rocky.data[name];
      const value =
        !unit || unit.checkedAt === null
          ? '미확인'
          : unit.configured === false
            ? '미설치'
            : unit.state === 'failed'
              ? '서비스 실패'
              : unit.process === 'running'
                ? '프로세스 실행'
                : unit.process === 'stopped'
                  ? '프로세스 중지'
                  : '프로세스 미확인';
      text('am-' + name, (name === 'executor' ? '실행기 ' : '브로커 ') + prefix(rocky) + value);
    }
    text(
      'am-note',
      fresh(ingress)
        ? '최근 24시간 고유 오류 등록 기록입니다.'
        : ingress.data
          ? '마지막 정상 조회 당시의 등록 기록입니다. 현재 수신 상태는 미확인입니다.'
          : '최근 정상 조회 기록이 없습니다.',
    );
  }
  async function refresh() {
    if (!active() || request) return;
    const controller = new AbortController();
    request = controller;
    const revision = authRevision;
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch('/api/automation', {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
      if (request !== controller || !active() || revision !== authRevision) return;
      if (auth.handleUnauthorized(response)) return;
      if (!response.ok) throw new Error('조회 실패');
      const result = await response.json();
      if (request !== controller || !active() || revision !== authRevision) return;
      if (!Number.isSafeInteger(result.servedAt)) throw new Error('응답 불일치');
      for (const [name, value] of [
        ['ingress', result],
        ['rocky', result.rocky],
      ]) {
        const part = parts[name];
        if (
          value &&
          value.state === 'ok' &&
          value.data &&
          Number.isSafeInteger(value.checkedAt) &&
          value.checkedAt > 0 &&
          value.checkedAt === value.data.checkedAt &&
          value.checkedAt <= result.servedAt
        ) {
          part.data = value.data;
          part.received = performance.now();
          part.age = result.servedAt - value.checkedAt;
          part.ok = true;
          if (name === 'ingress') {
            const list = document.getElementById('am-recent');
            list.replaceChildren();
            for (const entry of value.data.recent) {
              const row = document.createElement('li');
              row.textContent =
                entry.source +
                ' · ' +
                entry.app +
                ' · ' +
                time.format(entry.registeredAt) +
                ' KST 등록 · ' +
                entry.status;
              list.appendChild(row);
            }
            if (!value.data.recent.length) text('am-recent', '최근 24시간 등록된 오류가 없습니다.');
          }
        } else {
          part.ok = false;
          part.reason =
            value && value.reason === 'not_configured'
              ? '모니터 미설정'
              : value && value.reason === 'stale'
                ? '오래된 응답 · 미확인'
                : '조회 실패 · 미확인';
        }
      }
    } catch {
      if (request === controller) {
        for (const part of Object.values(parts)) {
          part.ok = false;
          part.reason = '연결 실패 · 미확인';
        }
      }
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
      render();
    }
  }
  function stop() {
    clearInterval(pollTimer);
    clearInterval(ageTimer);
    pollTimer = ageTimer = null;
    const pending = request;
    request = null;
    if (pending) pending.abort();
    for (const part of Object.values(parts)) {
      part.ok = false;
      part.reason = navigator.onLine === false ? '오프라인 · 미확인' : '화면 숨김 · 미확인';
    }
    render();
  }
  function start() {
    if (!active()) {
      stop();
      return;
    }
    if (pollTimer !== null) return;
    refresh();
    pollTimer = setInterval(refresh, 60000);
    ageTimer = setInterval(render, 1000);
  }
  document
    .getElementById('am-details')
    .addEventListener('click', () => document.getElementById('am-dialog').showModal());
  document.getElementById('am-close').addEventListener('click', () => document.getElementById('am-dialog').close());
  document.addEventListener('visibilitychange', start);
  window.addEventListener('offline', stop);
  window.addEventListener('online', start);
  window.addEventListener('pagehide', () => {
    pageHidden = true;
    stop();
  });
  window.addEventListener('pageshow', () => {
    pageHidden = false;
    start();
  });
  return {
    start,
    stop,
    clear() {
      stop();
      for (const part of Object.values(parts)) {
        part.data = null;
        part.age = part.received = 0;
        part.ok = false;
        part.reason = '인증 후 확인';
      }
      document.getElementById('am-recent').replaceChildren();
      if (document.getElementById('am-dialog').open) document.getElementById('am-dialog').close();
      render();
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

  replace('<body>', '<body data-cloud-state="unavailable" data-internal-auth="signed-out">');
  replace(
    '  <section class="login-panel"',
    '  <aside id="cloud-snapshot" role="status" aria-live="polite" aria-atomic="true" data-state="unavailable">원격 스냅샷 · 관측 시각 확인 중 · 표시 중단</aside>\n  <section class="login-panel"',
  );
  replace(
    '</style>',
    `
${INTERNAL_LOGIN_STYLES}
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
  replace('변경 즉시 갱신 · 연결 장애 시 10초마다 재시도', 'KV 반영 지연 있음 · 관측 시점 기준');
  replace('var lanEvents = null;', 'var cloud = (' + createCloudMode.toString() + ')();\n  var lanEvents = null;');
  replace('저장 즉시 화면 갱신 · 연결 장애 시 10초마다 재시도', '관측 시점 데이터 · NFC는 LAN에서 즉시 반영');
  // 클라우드만 인증 수명주기로 바꾸고 LAN 원본은 그대로 둔다.
  replace(
    'return authActive && !lanPageHidden && !document.hidden;',
    'return authActive && internalLogin && internalLogin.isAuthorized() && !lanPageHidden && !document.hidden && navigator.onLine !== false;',
  );
  replaceSection('  function loadWifiImages(enabled) {', '  var wallQuery =', '');
  replace('  var authDeadline = 0;\n  var authExpiresAt = 0;\n  var authClockOffset = 0;\n', '');
  replace(" image.src = '/api/jam-qr';", ' cloud.loadJamImage(image);');
  replace(
    ' if (lanSpotifyCover === image && lanSpotifyCoverKey === key) image.hidden = false;',
    ' if (lanIsVisible() && lanSpotifyCover === image && lanSpotifyCoverKey === key) image.hidden = false;',
  );
  replace(
    " lanSpotifyCover.removeAttribute('src');\n if (!url) return;",
    " lanSpotifyCover.removeAttribute('src');\n if (!url || !lanIsVisible()) return;",
  );
  replace(
    "    if (authActive && (performance.now() >= authDeadline || Date.now() + authClockOffset >= authExpiresAt)) {\n      setSignedOut('세션이 만료됐습니다. 다시 로그인해 주세요.');\n    }\n",
    '',
  );
  replace(
    "        setSignedOut('세션이 만료됐어. 다시 로그인해 주세요.');",
    '        internalLogin.handleUnauthorized(401);',
  );
  replaceSection('  function setSignedOut(message) {', 'var cloud = (', '');
  replaceSection(
    '  async function checkSession() {',
    "  document.getElementById('refresh').addEventListener",
    `  var automationMonitor = null;
  var internalLogin = (${createInternalLogin.toString()})({
    onAuthorized: function () {
      authActive = true;
      authRevision += 1;
      cloud.start();
      if (automationMonitor) automationMonitor.start();
    },
    onUnauthorized: function () {
      authActive = false;
      authRevision += 1;
      cloud.stop();
      if (automationMonitor) automationMonitor.stop();
    },
    clearPrivateState: function () {
      cloud.clear();
      if (automationMonitor) automationMonitor.clear();
      hasState = false;
      lastStateAt = 0;
      serverOffset = 0;
      pagePositions.clear();
      lanRefreshPending = false;
      lanMonitorData = lanWorkerData = lanKoinData = null;
      lanMonitorSucceededAt = null;
      lanMonitorFailed = lanWorkerFailed = lanKoinFailed = true;
      lanMonitorCards = [];
      lanKoinRows = [];
      lanMonitorHistory = Object.create(null);
      lanSpotifySignature = lanSpotifyCoverKey = null;
      lanView = 'attendance';
      document.getElementById('error').hidden = true;
      document.getElementById('error-message').textContent = '';
      document.getElementById('refresh').setAttribute('aria-busy', 'false');
      document.getElementById('retry').setAttribute('aria-busy', 'false');
      document.getElementById('refresh').textContent = '새로고침';
      document.querySelectorAll('.loading').forEach(function (element) { element.hidden = false; });
      document.getElementById('members-table').hidden = true;
      document.getElementById('present-region').setAttribute('aria-busy', 'true');
    },
  });
`,
  );
  replace(
    "  checkSession().catch(function () { setSignedOut('계정 확인에 실패했습니다. 네트워크를 확인해 주세요.'); }).finally(function () { document.getElementById('login-submit').disabled = false; });",
    '',
  );
  replace(
    ' <section class="login-panel"',
    `
 <section class="automation-monitor" aria-label="오류 수신과 Rocky 관측">
  <div class="automation-row"><strong>오류 수신 · 최근 24시간</strong>
   <span class="automation-state" id="am-ingress-state" data-state="unknown">확인 중</span>
   <span id="am-sentry">Sentry —</span><span id="am-cloudflare">Cloudflare —</span>
   <small id="am-ingress-time">확인 —</small>
   <button class="button-tonal" id="am-details" type="button">상세</button>
  </div>
  <div class="automation-row"><strong>Rocky</strong>
   <span class="automation-state" id="am-rocky-state" data-state="unknown">확인 중</span>
   <span id="am-cpu">CPU —</span><span id="am-memory">RAM —</span>
   <span id="am-executor">실행기 —</span><span id="am-broker">브로커 —</span>
   <small id="am-rocky-time">확인 —</small><small>HTTP·모델 미확인</small>
  </div>
 </section>
 <section class="login-panel"`,
  );
  replace(
    '</body>',
    `
 <dialog class="automation-dialog" id="am-dialog" aria-labelledby="am-heading">
  <header><h2 id="am-heading">오류 수신 · Rocky 관측</h2>
   <button class="button-text" id="am-close" type="button">닫기</button></header>
  <p>Pi 스냅샷과 독립적인 읽기 전용 관측입니다. CPU는 두 Linux 표본의 차이, RAM은 MemTotal − MemAvailable입니다.
   서비스·프로세스 상태는 브로커 HTTP 응답·모델 인증·작업 완료의 증거가 아닙니다.</p>
  <p id="am-note">최근 정상 조회 기록이 없습니다.</p><ul id="am-recent"></ul>
 </dialog>
 <script>var automationMonitor = (${createAutomationMonitor.toString()})(internalLogin); internalLogin.start();</script>
 </body>`,
  );
  replace(
    '</style>',
    `
 .automation-monitor { flex-shrink:0; display:grid; gap:6px; margin:0 0 8px; padding:8px 12px; border:1px solid var(--line); border-radius:16px; background:var(--surface); }
 .automation-row { display:flex; align-items:center; flex-wrap:wrap; gap:4px 12px; min-width:0; font-size:14px; line-height:1.4; }
 .automation-row strong { font-size:inherit; }
 .automation-row small { color:var(--muted); font-size:inherit; }
 .automation-state { padding:2px 8px; border-radius:999px; color:var(--amber); background:var(--amber-container); }
 .automation-state[data-state="ok"] { color:var(--on-green-container); background:var(--green-container); }
 .automation-row button { min-height:28px; padding:2px 10px; font-size:inherit; margin-left:auto; }
 .automation-dialog { width:min(700px,calc(100% - 32px)); max-height:80vh; overflow:auto; padding:22px; border:1px solid var(--outline); border-radius:24px; background:var(--surface); color:var(--text); }
 .automation-dialog::backdrop { background:#10131b88; }
 .automation-dialog header { display:flex; justify-content:space-between; align-items:center; gap:12px; }
 .automation-dialog ul { padding-left:20px; }
 @media (min-width:1000px) and (min-aspect-ratio:3/2) {
  .automation-monitor { padding:4px 12px; gap:3px; }
  #present .person-name { white-space:normal; overflow:visible; text-overflow:clip; overflow-wrap:anywhere; flex-shrink:0; }
  #present .elapsed { flex-shrink:0; }
 }
 @media (min-width:1000px) and (min-aspect-ratio:3/2) and (max-height:800px) {
  .app-shell { padding:12px 18px; }
  .app-header { padding-bottom:6px; margin-bottom:6px; }
  #cloud-snapshot { margin-bottom:6px; font-size:14px; }
  .automation-monitor { margin-bottom:6px; }
 }
 </style>`,
  );
  return html;
}
