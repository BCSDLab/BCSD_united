/**
 * 검토 페이지 공통 처리.
 *
 * 강의·버스·생협이 각각 라우트를 갖지만 하는 일은 같다 — 토큰으로 저장된 HTML을
 * 꺼내 그대로 준다. 응답 헤더가 이 페이지의 유일한 보호 장치라, 세 곳에 나눠 두면
 * 한 곳만 빠뜨렸을 때 그 도메인의 검토 링크가 검색엔진에 잡힌다.
 */
export function reviewPageHandler({
  label,
  load,
}: {
  /** 404 문구에 쓸 이름. `생협 검토 페이지` 처럼 그대로 들어간다. */
  label: string;
  load: (token: string) => Promise<{ html: string } | null>;
}) {
  return defineEventHandler(async (event) => {
    const token = getRouterParam(event, 'token') ?? '';
    const stored = await load(token);

    // 토큰이 유일한 접근 수단이라 검색엔진에 잡히지 않게 막는다.
    setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow');
    setResponseHeader(event, 'Cache-Control', 'no-store');
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8');

    if (!stored) {
      // 만료·오타·없는 토큰을 구분해 알려주지 않는다. 어느 쪽이든 사람이 할 일은 같다.
      setResponseStatus(event, 404);
      return `<!doctype html><meta charset="utf-8">
<title>${label}를 찾을 수 없습니다</title>
<body style="font:14px/1.6 -apple-system,sans-serif;padding:40px;max-width:520px;margin:0 auto">
<h1 style="font-size:18px">${label}를 찾을 수 없습니다</h1>
<p>링크가 만료되었거나 잘못된 주소입니다. 검토 링크는 생성 후 7일간 유효합니다.</p>
<p style="color:#6b7280">슬랙에서 다시 변환하면 새 링크가 만들어집니다.</p>
</body>`;
    }

    return stored.html;
  });
}

/**
 * 검토 페이지에 값을 넣기 전에 반드시 거친다.
 *
 * 도메인마다 따로 두면 시그니처가 갈린다(실제로 `string`을 받는 것과 `unknown`을
 * 받는 것이 따로 있었다). 엑셀에서 온 값은 무엇이든 올 수 있어 `unknown`으로 받는다.
 */
export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
