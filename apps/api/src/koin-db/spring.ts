import { fail } from '@api/domains/dining/protocol';
import { ApiError, type FieldError } from '@api/errors';

// Spring MVC 인자 변환·Jackson 역직렬화·Bean Validation을 Java 컨트롤러와 같은 오류로 재현한다.

// Character.isWhitespace(StringUtils.trimAllWhitespace). NBSP 계열은 Java에서 공백이 아니다.
const javaWhitespace = new RegExp(
  String.raw`[\t\n\v\f\r${String.fromCharCode(0x1c, 0x1d, 0x1e, 0x1f)} \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]`,
  'g',
);

/** StringUtils.hasText: Character.isWhitespace가 아닌 문자가 하나라도 있는지. */
export const hasText = (value: string | null | undefined): value is string =>
  !!value && value.replace(javaWhitespace, '') !== '';

/** Spring NumberUtils.parseNumber(Integer): 공백 제거, 16진수(0x·#) 허용, 범위 밖·형식 오류는 ILLEGAL_ARGUMENT. */
export function javaInteger(source: string): number {
  const text = source.replace(javaWhitespace, '');
  const hex = /^(-?)(?:0x|0X|#)([0-9a-fA-F]+)$/.exec(text);
  const value = hex ? Number.parseInt(`${hex[1]}${hex[2]}`, 16) : /^[+-]?\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) fail('ILLEGAL_ARGUMENT');
  return value;
}

function missing(name: string, type: string, converted: boolean): never {
  const state = converted ? 'present but converted to null' : 'not present';
  throw new ApiError(400, '', `Required request parameter '${name}' for method parameter type ${type} is ${state}`);
}

/** `@RequestParam Integer name`(defaultValue는 값이 없거나 빈 문자열일 때). 여러 값이면 첫 값. */
export function intParam(url: URL, name: string, fallback?: number): number {
  const [source] = url.searchParams.getAll(name);
  if (source === undefined || source === '') return fallback ?? missing(name, 'Integer', source === '');
  return javaInteger(source);
}

/** `@RequestParam(defaultValue = ...) Boolean/boolean`: StringToBooleanConverter(true/on/yes/1, false/off/no/0). */
export function boolParam(url: URL, name: string, fallback: boolean): boolean {
  const [source] = url.searchParams.getAll(name);
  if (source === undefined || source === '') return fallback;
  const text = source.trim().toLowerCase();
  if (['true', 'on', 'yes', '1'].includes(text)) return true;
  if (['false', 'off', 'no', '0'].includes(text)) return false;
  return text === '' ? fallback : fail('ILLEGAL_ARGUMENT');
}

/** 필수 `@RequestParam String`. 값이 여럿이면 Spring처럼 쉼표로 잇는다. */
export function stringParam(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (!values.length) missing(name, 'String', false);
  return values.join(',');
}

/** 필수 `@RequestParam @DateTimeFormat(iso = DATE) LocalDate`(ISO_DATE: 선택적 오프셋 허용, 엄격한 날짜). */
export function dateParam(url: URL, name: string): string {
  const [source] = url.searchParams.getAll(name);
  if (source === undefined) missing(name, 'LocalDate', false);
  if (!hasText(source)) missing(name, 'LocalDate', true);
  const match = /^(\d{4}-\d{2}-\d{2})(?:Z|[+-]\d{2}:\d{2}(?::\d{2})?)?$/.exec(source);
  const date = match?.[1];
  if (
    !date ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    fail('ILLEGAL_ARGUMENT');
  }
  return date;
}

/**
 * `@RequestBody`: MappingJackson2HttpMessageConverter가 읽는 JSON만 받는다(그 외 415). 빈 본문·JSON 오류는
 * NOT_READABLE_HTTP_MESSAGE다.
 */
export async function jsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type') ?? 'application/octet-stream';
  const media = contentType.split(';')[0]!.trim().toLowerCase();
  if (media !== 'application/json' && !/^application\/[^/\s]+\+json$/.test(media)) {
    throw new ApiError(415, '', `Content-Type '${contentType}' is not supported`);
  }
  try {
    return JSON.parse(await request.text()) as unknown;
  } catch {
    return fail('NOT_READABLE_HTTP_MESSAGE');
  }
}

/** record 요청 본문: JSON 객체만 받는다(null·배열·스칼라는 NOT_READABLE_HTTP_MESSAGE). */
export async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const value = await jsonBody(request);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('NOT_READABLE_HTTP_MESSAGE');
  return value as Record<string, unknown>;
}

const INT_MIN = -2_147_483_648;
const INT_MAX = 2_147_483_647;

/** Jackson Integer: 실수는 버림(ACCEPT_FLOAT_AS_INT), 문자열 숫자 허용, 빈 문자열은 null. */
export function jacksonInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  let number: number;
  if (typeof value === 'number') number = Math.trunc(value);
  else if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    if (!/^[+-]?\d+$/.test(text)) fail('NOT_READABLE_HTTP_MESSAGE');
    number = Number(text);
  } else fail('NOT_READABLE_HTTP_MESSAGE');
  if (!(number >= INT_MIN && number <= INT_MAX)) fail('NOT_READABLE_HTTP_MESSAGE');
  return number;
}

/** Jackson Boolean: true/false, 정수(0=false), "true"/"false"(대소문자 3형태), 빈 문자열은 null. */
export function jacksonBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    if (['true', 'True', 'TRUE'].includes(text)) return true;
    if (['false', 'False', 'FALSE'].includes(text)) return false;
  }
  return fail('NOT_READABLE_HTTP_MESSAGE');
}

/** Jackson String: 숫자·불리언 스칼라는 문자열로 바꾸고 객체·배열은 거부한다. */
export function jacksonString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fail('NOT_READABLE_HTTP_MESSAGE');
}

/** MethodArgumentNotValidException → INVALID_REQUEST_BODY, message = 첫 필드 오류 메시지. */
export function invalidBody(violations: Required<FieldError>[]): void {
  if (violations.length) throw new ApiError(400, 'INVALID_REQUEST_BODY', violations[0]!.message, violations);
}

/** Hibernate Validator 기본 메시지. Spring은 요청 Accept-Language로 고른다(ko 외에는 영어). */
export function constraintMessage(request: Request, constraint: 'NotNull' | 'NotBlank' | 'Size', max = 0): string {
  const korean = /^\s*ko\b/i.test(request.headers.get('Accept-Language') ?? '');
  switch (constraint) {
    case 'NotNull':
      return korean ? '널이어서는 안됩니다' : 'must not be null';
    case 'NotBlank':
      return korean ? '공백일 수 없습니다' : 'must not be blank';
    case 'Size':
      return korean ? `크기가 0에서 ${max} 사이여야 합니다` : `size must be between 0 and ${max}`;
  }
}
