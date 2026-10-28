import sanitize from 'sanitize-html';

const BLOCKED_CSS_PROPERTIES = ['position'];

// url()로 스크립트를 실행하거나 외부 스타일시트를 불러오는 벡터
// css 인젝션 방지
const DANGEROUS_CSS_PATTERNS = [/javascript\s*:/i, /@import/i];

const filterDangerousCss = (styleValue: string): string =>
  styleValue
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      if (!declaration) return false;
      const [rawProperty] = declaration.split(':');
      if (!rawProperty) return false;
      const property = rawProperty.trim().toLowerCase();
      if (BLOCKED_CSS_PROPERTIES.includes(property)) return false;

      return !DANGEROUS_CSS_PATTERNS.some((pattern) => pattern.test(declaration));
    })
    .join('; ');

const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'div',
  'span',
  'b',
  'i',
  'u',
  'strong',
  'em',
  'del',
  'strike',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'img',
];

const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'style'];

// 서버와 브라우저가 같은 파서와 정책을 사용해야 정제 결과가 하이드레이션 중 바뀌지 않는다.
const SANITIZE_OPTIONS: sanitize.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: { '*': ALLOWED_ATTR },
  allowedSchemes: ['http', 'https', 'ftp', 'ftps', 'mailto', 'tel', 'callto', 'sms', 'cid', 'xmpp', 'matrix'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'ftp', 'ftps', 'data'],
  },
  transformTags: {
    '*': (tagName, attributes) => {
      if (attributes.style !== undefined) {
        attributes.style = filterDangerousCss(attributes.style);
      }

      return { tagName, attribs: attributes };
    },
  },
};

export function sanitizeHtml(content: string): string {
  return sanitize(content, SANITIZE_OPTIONS);
}
