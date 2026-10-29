// 마크다운/텍스트를 ~350자 청크로(헤딩 경계 + 긴 단락은 오버랩 분할).
// 각 청크 앞에 소속 헤딩 경로(breadcrumb)를 붙여, 표·목록의 항목이 그 맥락
// (예: "Team Members › Active Members")과 함께 검색되도록 한다 — RAG recall 핵심.

// 마크다운 노이즈 제거: 이미지·HTML 태그·링크 URL·표 구분선 → 텍스트만 남김.
// (README가 뱃지/아바타 이미지·HTML 표를 많이 써서, 정제 없이는 이름·기술명이 노이즈에 묻힘)
export function cleanMarkdown(md: string): string {
  return (
    md
      // HTML 헤딩/<summary>는 마크다운 헤딩으로 변환해 breadcrumb 추적 대상으로 보존
      .replace(/<summary[^>]*>\s*<h([1-6])[^>]*>([\s\S]*?)<\/h\1>\s*<\/summary>/gi, '\n### $2\n')
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, '\n### $2\n')
      .replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, '\n### $1\n')
      // ![alt](url): 의미 있는 alt(예: 뱃지의 'Java')는 남기고 'Image' 같은 일반 alt는 제거
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
        /^(image|img|screenshot|배너|이미지)?$/i.test((alt || '').trim()) ? ' ' : ` ${alt} `,
      )
      .replace(/<img[^>]*>/gi, ' ') // <img ...>
      .replace(/<\/?[a-zA-Z][^>]*>/g, ' ') // 기타 HTML 태그(<details>,<br/> 등)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [텍스트](url) → 텍스트(이름·링크명 보존)
      .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '') // 표 구분선 | :--: |
      .replace(/\|/g, ' ') // 남은 표 파이프 → 공백
      .replace(/^\s*>+\s?/gm, '') // blockquote 마커
      .replace(/`{1,3}/g, '') // 코드 펜스/인라인 백틱
      .replace(/[ \t]{2,}/g, ' ') // 연속 공백 축소
      .replace(/\n{3,}/g, '\n\n')
  ); // 연속 빈 줄 축소
}

function windows(s: string, size: number, overlap: number): string[] {
  if (s.length <= size) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size - overlap) out.push(s.slice(i, i + size));
  return out;
}

// 헤딩 경로를 추적하며 본문을 청크로. 각 청크 앞에 "h1 › h2 › h3" breadcrumb를 붙인다.
export function chunk(text: string, size = 350, overlap = 80): string[] {
  const lines = cleanMarkdown(text).split('\n');
  const out: string[] = [];
  const crumb: string[] = []; // 레벨별 현재 헤딩
  let buf: string[] = []; // 누적 본문 라인
  let head = ''; // buf가 속한 breadcrumb

  const breadcrumb = () => crumb.filter(Boolean).join(' › ');
  const flush = () => {
    const body = buf.join('\n').trim();
    buf = [];
    if (!body) return;
    const prefix = head ? head + '\n' : '';
    let cur = '';
    for (const seg of body
      .split(/\n\s*\n/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      for (const piece of windows(seg, size, overlap)) {
        if (cur && (cur + '\n' + piece).length > size) {
          out.push(prefix + cur);
          cur = piece;
        } else cur = cur ? cur + '\n' + piece : piece;
      }
    }
    if (cur) out.push(prefix + cur);
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (m) {
      flush();
      const lvl = m[1].length;
      crumb.length = lvl - 1; // 더 깊은 레벨 헤딩 폐기
      crumb[lvl - 1] = m[2].trim();
      head = breadcrumb();
      continue;
    }
    if (buf.length === 0) head = breadcrumb();
    buf.push(line);
  }
  flush();
  return out.map((c) => c.trim()).filter((c) => c.length > 15);
}
