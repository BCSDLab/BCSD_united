// 클라우드 변환에만 삽입한다. LAN 렌더러와 인증 API의 권한 판정은 바꾸지 않는다.
export const INTERNAL_LOGIN_STYLES = `
body:not([data-internal-auth="authenticated"]) #main,
body:not([data-internal-auth="authenticated"]) #monitor-view,
body:not([data-internal-auth="authenticated"]) #spotify-now,
body:not([data-internal-auth="authenticated"]) #cloud-snapshot,
body:not([data-internal-auth="authenticated"]) .automation-monitor,
body:not([data-internal-auth="authenticated"]) #am-dialog,
body:not([data-internal-auth="authenticated"]) #greeting-dialog,
body:not([data-internal-auth="authenticated"]) #viewer-name,
body:not([data-internal-auth="authenticated"]) #refresh,
body:not([data-internal-auth="authenticated"]) #logout:not([data-internal-logout-retry]) { display:none !important; }
body:not([data-internal-auth="authenticated"]) #login-panel { display:block !important; }
#login-panel { width:min(100%,520px); padding:clamp(24px,4vw,40px); border-radius:28px; }
#login-panel h2 { font-size:clamp(28px,3vw,36px); line-height:1.25; }
#login-panel p { font-size:18px; line-height:1.6; }
#login-panel label, #login-panel input, #login-panel button, #viewer-name { font-size:18px; }
body[data-internal-auth="authenticated"] #viewer-name { display:inline; }
#login-panel input, #login-panel button { min-height:52px; }
#login-panel .internal-session-check { margin-top:12px; }
#login-panel [aria-busy="true"] { cursor:progress; }
`;

// 콜백은 동기적으로 실행한다. 중단·메모리 초기화는 기존 Pi/자동화 수명주기가 맡는다.
// 직렬화 후에도 동작하도록 모듈 바깥의 변수나 import를 참조하지 않는다.
export function createInternalLogin({ onAuthorized, onUnauthorized, clearPrivateState }) {
  if (
    typeof onAuthorized !== 'function' ||
    typeof onUnauthorized !== 'function' ||
    typeof clearPrivateState !== 'function'
  ) {
    throw new Error('Internal login requires activity and private-state callbacks');
  }
  const node = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error('Internal login markup missing: ' + id);
    return element;
  };
  const panel = node('login-panel');
  const form = node('login-form');
  const student = node('login-student');
  const password = node('login-password');
  const submit = node('login-submit');
  const message = node('login-error');
  const logoutButton = node('logout');
  const viewerName = node('viewer-name');
  const main = node('main');
  const refreshButton = node('refresh');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button-tonal internal-session-check';
  retry.textContent = '세션 다시 확인';
  form.appendChild(retry);
  node('login-heading').textContent = 'Internal 계정 로그인';
  const description = panel.querySelector('p');
  if (description && description !== message) {
    description.textContent =
      'BCSDLab Internal 계정으로 원격 현황을 확인하세요. 로그인과 로그아웃은 출퇴근 기록을 변경하지 않습니다.';
  }
  student.setAttribute('inputmode', 'numeric');
  student.setAttribute('pattern', '[0-9]{8,10}');
  student.setAttribute('autocomplete', 'username');
  password.setAttribute('autocomplete', 'current-password');
  password.type = 'password';
  student.required = password.required = true;
  let running = false;
  let pageHidden = false;
  let session = null;
  let deadline = 0;
  let revision = 0;
  let pending = null;
  let expiryTimer = null;
  let checkTimer = null;
  let logoutRequired = false;
  const visible = () => !pageHidden && !document.hidden && navigator.onLine !== false;

  function paintBusy() {
    const busy = pending !== null;
    form.setAttribute('aria-busy', String(busy));
    submit.disabled = busy || !running || !visible();
    retry.disabled = busy || !running || !visible() || logoutRequired;
    student.disabled = password.disabled = busy;
    logoutButton.disabled = busy || !running || !visible();
  }
  function clearPrivateDom() {
    for (const id of ['present', 'members', 'monitor-cards', 'koin-services', 'am-recent']) {
      const element = document.getElementById(id);
      if (element) element.replaceChildren();
      if (element && (id === 'monitor-cards' || id === 'koin-services')) {
        const placeholder = document.createElement('p');
        placeholder.className = 'monitor-waiting';
        placeholder.textContent = '인증 후 확인';
        element.appendChild(placeholder);
      }
    }
    for (const id of ['count', 'today-total', 'week-total', 'unrecorded-total', 'members-badge']) {
      const element = document.getElementById(id);
      if (element) element.textContent = '—';
    }
    for (const id of [
      'member-count',
      'last-updated',
      'spotify-title',
      'spotify-artists',
      'am-note',
      'greeting-message',
    ]) {
      const element = document.getElementById(id);
      if (element) element.textContent = '';
    }
    for (const selector of ['#main img', '#monitor-view img', '#spotify-now img', '#greeting-dialog img']) {
      for (const image of document.querySelectorAll(selector)) {
        image.removeAttribute('src');
        image.removeAttribute('srcset');
        image.hidden = true;
      }
    }
    for (const id of [
      'am-ingress-state',
      'am-rocky-state',
      'am-ingress-time',
      'am-rocky-time',
      'am-sentry',
      'am-cloudflare',
      'am-cpu',
      'am-memory',
      'am-executor',
      'am-broker',
      'monitor-timestamp',
      'monitor-status',
    ]) {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = '인증 후 확인';
        element.dataset.state = 'unknown';
      }
    }
    for (const id of ['am-dialog', 'greeting-dialog']) {
      const dialog = document.getElementById(id);
      if (dialog && dialog.open && typeof dialog.close === 'function') dialog.close();
    }
    for (const selector of ['#main [data-since]', '#main [data-member-id]']) {
      for (const element of document.querySelectorAll(selector)) {
        element.removeAttribute('data-since');
        element.removeAttribute('data-member-id');
      }
    }
    const monitor = document.getElementById('monitor-view');
    if (monitor) monitor.hidden = true;
  }
  function lockView(text) {
    document.body.dataset.internalAuth = logoutRequired ? 'logout-required' : 'signed-out';
    main.hidden = true;
    panel.hidden = false;
    viewerName.hidden = refreshButton.hidden = true;
    viewerName.textContent = '';
    logoutButton.hidden = !logoutRequired;
    logoutButton.toggleAttribute('data-internal-logout-retry', logoutRequired);
    logoutButton.textContent = logoutRequired ? '로그아웃 다시 시도' : '로그아웃';
    password.value = '';
    message.textContent = text || '';
  }
  function cancelRequest() {
    const request = pending;
    pending = null;
    if (request) {
      clearTimeout(request.timer);
      request.controller.abort();
    }
  }
  function deny(text) {
    revision += 1;
    session = null;
    deadline = 0;
    clearTimeout(expiryTimer);
    clearTimeout(checkTimer);
    expiryTimer = checkTimer = null;
    cancelRequest();
    lockView(text);
    try {
      onUnauthorized();
    } finally {
      clearPrivateDom();
      clearPrivateState();
      paintBusy();
    }
  }
  function isAuthorized() {
    if (!session) return false;
    if (!running || !visible() || performance.now() >= deadline) {
      deny(visible() ? '세션이 만료됐습니다. 다시 로그인해 주세요.' : '화면으로 돌아오면 계정을 다시 확인합니다.');
      return false;
    }
    return true;
  }
  function handleUnauthorized(responseOrStatus) {
    const status =
      typeof responseOrStatus === 'number' ? responseOrStatus : responseOrStatus && responseOrStatus.status;
    if (status !== 401 && status !== 403) return false;
    deny(status === 403 ? '이 계정의 접근 권한을 확인할 수 없습니다.' : '세션이 만료됐습니다. 다시 로그인해 주세요.');
    return true;
  }
  function scheduleChecks() {
    clearTimeout(expiryTimer);
    clearTimeout(checkTimer);
    expiryTimer = setTimeout(
      () => {
        if (session && performance.now() < deadline) scheduleChecks();
        else deny('세션이 만료됐습니다. 다시 로그인해 주세요.');
      },
      Math.max(0, deadline - performance.now()),
    );
    checkTimer = setTimeout(checkSession, Math.min(60000, Math.max(0, deadline - performance.now())));
  }
  function accept(data, startedAt) {
    if (
      !data ||
      data.authenticated !== true ||
      typeof data.memberId !== 'string' ||
      !data.memberId.trim() ||
      typeof data.name !== 'string' ||
      !data.name.trim() ||
      !Number.isSafeInteger(data.servedAt) ||
      data.servedAt <= 0 ||
      !Number.isSafeInteger(data.expiresAt) ||
      data.expiresAt <= data.servedAt ||
      data.expiresAt - data.servedAt > 900000
    ) {
      deny('계정 유효기간을 확인할 수 없습니다. 다시 로그인해 주세요.');
      return false;
    }
    // 응답 본문을 받는 데 걸린 시간도 세션 잔여 시간에서 차감한다.
    const nextDeadline = startedAt + data.expiresAt - data.servedAt;
    if (!running || !visible() || performance.now() >= nextDeadline) {
      deny('세션을 다시 확인해 주세요.');
      return false;
    }
    const resume = session === null;
    if (session && session.memberId !== data.memberId) {
      deny('계정이 변경됐습니다. 다시 로그인해 주세요.');
      return false;
    }
    session = {
      authenticated: true,
      memberId: data.memberId,
      name: data.name,
      expiresAt: data.expiresAt,
      servedAt: data.servedAt,
    };
    deadline = nextDeadline;
    logoutRequired = false;
    document.body.dataset.internalAuth = 'authenticated';
    panel.hidden = true;
    main.hidden = false;
    viewerName.textContent = data.name;
    viewerName.hidden = logoutButton.hidden = refreshButton.hidden = false;
    logoutButton.removeAttribute('data-internal-logout-retry');
    logoutButton.textContent = '로그아웃';
    message.textContent = '';
    scheduleChecks();
    if (resume) {
      try {
        onAuthorized({ ...session });
      } catch {
        deny('화면을 시작할 수 없습니다. 세션을 다시 확인해 주세요.');
        return false;
      }
    }
    return true;
  }
  async function requestAuth(kind, body) {
    const paths = { session: '/api/me', login: '/api/login', logout: '/api/logout' };
    const controller = new AbortController();
    const request = { controller, timer: null };
    const currentRevision = revision;
    const startedAt = performance.now();
    pending = request;
    request.timer = setTimeout(() => controller.abort(), 8000);
    paintBusy();
    try {
      const response = await fetch(paths[kind], {
        method: kind === 'session' ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers:
          kind === 'session'
            ? { accept: 'application/json' }
            : { 'content-type': 'application/json', accept: 'application/json' },
        body: kind === 'logout' ? '{}' : body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (pending !== request || revision !== currentRevision || !running) return null;
      if (controller.signal.aborted) throw new Error('Authentication request timed out');
      return { status: response.status, data: response.ok && kind !== 'logout' ? JSON.parse(text) : null, startedAt };
    } catch (error) {
      if (pending !== request || revision !== currentRevision || !running) return null;
      throw error;
    } finally {
      clearTimeout(request.timer);
      if (pending === request) pending = null;
      paintBusy();
    }
  }
  async function checkSession() {
    if (!running || pending || logoutRequired) return false;
    if (!visible()) {
      deny(
        navigator.onLine === false
          ? '오프라인입니다. 연결 후 계정을 다시 확인합니다.'
          : '화면으로 돌아오면 계정을 다시 확인합니다.',
      );
      return false;
    }
    try {
      const result = await requestAuth('session');
      if (!result) return false;
      if (result.status === 401) {
        deny('');
        return false;
      }
      if (result.status !== 200) {
        deny(
          result.status === 403
            ? '이 계정의 접근 권한을 확인할 수 없습니다.'
            : '인증 서비스를 사용할 수 없습니다. 세션을 다시 확인해 주세요.',
        );
        return false;
      }
      return accept(result.data, result.startedAt);
    } catch {
      if (!pending && running && visible()) deny('계정 확인에 실패했습니다. 연결 후 세션을 다시 확인해 주세요.');
      return false;
    }
  }
  async function login(event) {
    event.preventDefault();
    if (!running || pending || session || !visible()) {
      password.value = '';
      return;
    }
    if (!/^[0-9]{8,10}$/.test(student.value.trim()) || !password.value.trim()) {
      password.value = '';
      message.textContent = '8~10자리 학번과 비밀번호를 입력해 주세요.';
      return;
    }
    message.textContent = '로그인 확인 중입니다.';
    try {
      // 비밀번호는 이 요청 본문 외에는 보관하지 않으며 자동 재전송하지 않는다.
      const resultPromise = requestAuth(
        'login',
        JSON.stringify({ studentNumber: student.value.trim(), password: password.value }),
      );
      password.value = '';
      const result = await resultPromise;
      if (!result) return;
      if (result.status === 401) {
        deny('학번 또는 비밀번호를 확인해 주세요.');
      } else if (result.status === 403) {
        deny('이 계정의 접근 권한을 확인할 수 없습니다.');
      } else if (result.status !== 200) {
        deny('로그인 서비스를 사용할 수 없습니다. 잠시 뒤 직접 다시 시도해 주세요.');
      } else {
        accept(result.data, result.startedAt);
      }
    } catch {
      if (!pending && running && visible())
        deny('로그인 응답을 확인할 수 없습니다. 연결 후 세션을 확인하거나 직접 다시 로그인해 주세요.');
    } finally {
      password.value = '';
    }
  }
  async function logout() {
    if (!running) return false;
    logoutRequired = true;
    deny('로그아웃 요청 중입니다.');
    student.value = '';
    try {
      const result = await requestAuth('logout');
      if (!result) return false;
      if (result.status < 200 || result.status >= 300) throw new Error('Logout unavailable');
      logoutRequired = false;
      deny('로그아웃했습니다. 출퇴근 기록은 변경되지 않습니다.');
      return true;
    } catch {
      if (!pending && running) deny('로그아웃을 완료하지 못했습니다. 연결 후 로그아웃을 다시 시도해 주세요.');
      return false;
    }
  }
  function suspend() {
    deny(
      logoutRequired
        ? '로그아웃을 완료하려면 연결 후 로그아웃을 다시 시도해 주세요.'
        : navigator.onLine === false
          ? '오프라인입니다. 연결 후 계정을 다시 확인합니다.'
          : '화면으로 돌아오면 계정을 다시 확인합니다.',
    );
  }
  function resume() {
    if (!running) return;
    if (!visible()) suspend();
    else {
      paintBusy();
      checkSession();
    }
  }
  function pagehide() {
    pageHidden = true;
    suspend();
  }
  function pageshow() {
    pageHidden = false;
    resume();
  }
  function start() {
    if (running) return;
    running = true;
    form.addEventListener('submit', login);
    retry.addEventListener('click', checkSession);
    logoutButton.addEventListener('click', logout);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('offline', suspend);
    window.addEventListener('online', resume);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    deny('계정 확인 중입니다.');
    checkSession();
  }
  function stop() {
    running = false;
    form.removeEventListener('submit', login);
    retry.removeEventListener('click', checkSession);
    logoutButton.removeEventListener('click', logout);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('offline', suspend);
    window.removeEventListener('online', resume);
    window.removeEventListener('pagehide', pagehide);
    window.removeEventListener('pageshow', pageshow);
    deny('');
  }
  lockView('');
  clearPrivateDom();
  paintBusy();
  return { start, stop, isAuthorized, handleUnauthorized, checkSession, logout };
}
