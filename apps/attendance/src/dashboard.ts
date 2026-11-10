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
<title>BCSD 출근부</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#181b22; --line:#2a2f3a; --fg:#e8eaf0; --muted:#8b93a7; --on:#3ddc97; --warn:#f5b84b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif; }
  main { max-width:1280px; margin:0 auto; padding:24px; display:grid; gap:20px; }
  header { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px; }
  h1 { margin:0; font-size:28px; }
  h2 { margin:0 0 12px; font-size:18px; color:var(--muted); font-weight:600; }
  #clock { font-size:28px; font-variant-numeric:tabular-nums; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:20px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; }
  .card { border:1px solid var(--on); border-radius:10px; padding:14px 16px; background:rgba(61,220,151,.07); }
  .card b { display:block; font-size:20px; }
  .card .elapsed { font-size:26px; font-variant-numeric:tabular-nums; color:var(--on); }
  .card small, .muted { color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; font-size:14px; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:var(--line); margin-right:8px; }
  .dot.on { background:var(--on); }
  .warn { color:var(--warn); }
  form { display:flex; gap:8px; align-items:center; margin:6px 0; flex-wrap:wrap; }
  input { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
  button { background:var(--on); color:#08130e; border:0; border-radius:6px; padding:6px 14px; font:inherit; font-weight:600; cursor:pointer; }
  #error { color:#ff6b6b; }
  [hidden] { display:none; }
</style>
</head>
<body>
<main>
  <header>
    <h1>BCSD 출근부 <span class="muted" id="count"></span></h1>
    <div id="clock"></div>
  </header>
  <p id="error" hidden></p>
  <section>
    <h2>지금 있는 사람</h2>
    <div class="cards" id="present"></div>
    <p class="muted" id="present-empty" hidden>아무도 없습니다.</p>
  </section>
  <section>
    <h2>이번 주 체류 시간 (월요일 시작, KST)</h2>
    <table>
      <thead><tr><th>이름</th><th>상태</th><th>오늘 첫 입실</th><th>오늘</th><th>이번 주</th></tr></thead>
      <tbody id="members"></tbody>
    </table>
  </section>
  <section id="unknown-section" hidden>
    <h2>미등록 카드 — 이름을 입력해 등록하세요</h2>
    <div id="unknown"></div>
  </section>
  <section>
    <h2>최근 기록</h2>
    <table>
      <thead><tr><th>이름</th><th>입실</th><th>퇴실</th><th>체류</th></tr></thead>
      <tbody id="recent"></tbody>
    </table>
  </section>
</main>
<script>
  var POLL_MS = 10000;
  var timeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  var dateTimeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  var clockFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'full', timeStyle: 'medium', hour12: false });
  var serverOffset = 0;
  var unknownSignature = '';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

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
      var card = el('div', 'card');
      card.appendChild(el('b', '', m.name));
      var elapsed = el('span', 'elapsed', formatClockDuration(serverNow() - m.since));
      elapsed.dataset.since = String(m.since);
      card.appendChild(elapsed);
      card.appendChild(el('small', '', ' · ' + timeFormat.format(m.since) + ' 입실'));
      container.appendChild(card);
    });
    document.getElementById('present-empty').hidden = present.length > 0;
    document.getElementById('count').textContent = present.length + '명 / ' + members.length + '명';
  }

  function renderMembers(members) {
    var body = document.getElementById('members');
    body.replaceChildren();
    members.forEach(function (m) {
      var row = el('tr');
      var name = el('td');
      name.appendChild(el('span', m.present ? 'dot on' : 'dot'));
      name.appendChild(document.createTextNode(m.name));
      row.appendChild(name);
      row.appendChild(el('td', m.present ? '' : 'muted', m.present ? '입실 중' : '퇴실'));
      row.appendChild(el('td', '', m.firstInToday === null ? '-' : timeFormat.format(m.firstInToday)));
      row.appendChild(el('td', '', formatDuration(m.todayMs)));
      row.appendChild(el('td', '', formatDuration(m.weekMs)));
      body.appendChild(row);
    });
  }

  function renderRecent(recent) {
    var body = document.getElementById('recent');
    body.replaceChildren();
    recent.forEach(function (r) {
      var row = el('tr');
      row.appendChild(el('td', '', r.name));
      row.appendChild(el('td', '', dateTimeFormat.format(r.checkIn)));
      if (r.checkOut === null) {
        row.appendChild(el('td', 'muted', '-'));
        row.appendChild(el('td', '', formatDuration(serverNow() - r.checkIn)));
      } else {
        row.appendChild(el('td', r.autoClosed ? 'warn' : '', dateTimeFormat.format(r.checkOut) + (r.autoClosed ? ' (자동 종료)' : '')));
        row.appendChild(el('td', '', formatDuration(r.checkOut - r.checkIn)));
      }
      body.appendChild(row);
    });
  }

  function renderUnknown(cards) {
    var signature = cards.map(function (c) { return c.uid; }).join(',');
    document.getElementById('unknown-section').hidden = cards.length === 0;
    // 입력 중인 이름이 갱신으로 지워지지 않도록 카드 목록이 바뀔 때만 다시 그립니다.
    if (signature === unknownSignature) return;
    unknownSignature = signature;
    var container = document.getElementById('unknown');
    container.replaceChildren();
    cards.forEach(function (card) {
      var form = el('form');
      form.appendChild(el('code', '', card.uid));
      form.appendChild(el('span', 'muted', card.count + '회 · ' + dateTimeFormat.format(card.lastSeen)));
      var input = el('input');
      input.placeholder = '이름';
      input.maxLength = 30;
      input.required = true;
      form.appendChild(input);
      form.appendChild(el('button', '', '등록'));
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        register(card.uid, input.value);
      });
      container.appendChild(form);
    });
  }

  function showError(message) {
    var node = document.getElementById('error');
    node.hidden = message === null;
    node.textContent = message === null ? '' : message;
  }

  async function register(uid, name) {
    var response = await fetch('/api/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: uid, name: name }),
    });
    showError(response.ok ? null : '등록하지 못했습니다 (' + response.status + ')');
    if (response.ok) refresh();
  }

  async function refresh() {
    try {
      var response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      var state = await response.json();
      serverOffset = state.now - Date.now();
      renderPresent(state.members);
      renderMembers(state.members);
      renderRecent(state.recent);
      renderUnknown(state.unknownCards);
      showError(null);
    } catch (error) {
      showError('데이터를 불러오지 못했습니다. 다시 시도합니다.');
    }
  }

  setInterval(function () {
    var now = serverNow();
    document.getElementById('clock').textContent = clockFormat.format(now);
    document.querySelectorAll('.elapsed').forEach(function (node) {
      node.textContent = formatClockDuration(now - Number(node.dataset.since));
    });
  }, 1000);
  setInterval(refresh, POLL_MS);
  refresh();
</script>
</body>
</html>
`;
