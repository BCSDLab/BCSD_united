import { ApiError, type FieldError } from '@api/errors';

export interface ExperimentVariable {
  id: number;
  name: string;
  display_name: string;
  rate: number;
  count: number;
}

export interface VariableRequest {
  rate: number;
  display_name: string;
  name: string;
}

export interface ExperimentRequest {
  display_title: string;
  creator: string | null;
  team: string | null;
  title: string;
  description: string | null;
  variables: VariableRequest[];
}

export function legacyError(status: number, message: string, detail: string): ApiError {
  return new ApiError(status, '', `${message} ${detail}`);
}

export function selectAssignmentVariable<T extends Pick<ExperimentVariable, 'id' | 'rate' | 'count'>>(
  variables: readonly T[],
  pending: ReadonlyMap<number, number> = new Map(),
  title = '',
): T {
  const first = variables[0];
  if (!first) throw legacyError(500, 'AB테스트 편입 중 오류가 발생했습니다.', `abtest name: ${title}`);
  let total = 0;
  for (const variable of variables) total = (total + ((variable.count + (pending.get(variable.id) ?? 0)) | 0)) | 0;
  if (total === 0) return first;
  let selected = first;
  let largestDifference = -Infinity;
  for (const variable of variables) {
    const count = (variable.count + (pending.get(variable.id) ?? 0)) | 0;
    // Java 정수 나눗셈과 동률 시 첫 실험군 선택을 유지한다.
    const currentRate = Math.trunc(Math.imul(count, 100) / total) | 0;
    const difference = (variable.rate - currentRate) | 0;
    if (difference > largestDifference) {
      largestDifference = difference;
      selected = variable;
    }
  }
  return selected;
}

export function validateVariables(variables: readonly VariableRequest[]): void {
  const sum = variables.reduce((total, variable) => (total + variable.rate) | 0, 0);
  if (sum !== 100)
    throw legacyError(400, '실험군이 잘못되었습니다.', `실험군 비율 합이 100이 아닙니다. rate sum: ${sum}`);
  if (new Set(variables.map((variable) => variable.name)).size !== variables.length) {
    throw legacyError(400, '실험군이 잘못되었습니다.', '실험군 간의 변수명(name)이 중복됩니다.');
  }
}

export function validateExperimentUpdate(
  title: string,
  current: readonly Pick<ExperimentVariable, 'name'>[],
  request: ExperimentRequest,
): void {
  if (title !== request.title)
    throw legacyError(400, '실험 이름이 잘못되었습니다.', '실험 title은 변경할 수 없습니다.');
  validateVariables(request.variables);
  if (current.length !== request.variables.length) {
    throw legacyError(400, '실험군이 잘못되었습니다.', '실험군 개수는 수정될 수 없습니다.');
  }
  for (const variable of request.variables) {
    if (!current.some((existing) => existing.name === variable.name)) {
      throw legacyError(400, '실험군이 잘못되었습니다.', `abtest name: ${title}, variable name: ${variable.name}`);
    }
  }
}

export function pagination(page: number | undefined, limit: number | undefined, total: number) {
  const size = Math.max(1, Math.min(50, limit ?? 10));
  const current = Math.max(1, Math.min(page ?? 1, Math.max(1, Math.ceil(total / size))));
  return { limit: size, offset: (current - 1) * size, current_page: current };
}

export function integerParameter(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const result = Number(value);
  if (!/^[+-]?\d+$/.test(value) || !Number.isInteger(result) || result < -2147483648 || result > 2147483647) {
    throw new ApiError(
      400,
      'ILLEGAL_ARGUMENT',
      `Failed to convert value '${value}' for parameter '${name}' to Integer`,
    );
  }
  return result;
}

export function requiredInteger(value: string | undefined, name: string): number {
  const result = integerParameter(value, name);
  if (result === undefined)
    throw new ApiError(400, 'MISSING_REQUEST_PARAMETER', `Required request parameter '${name}' is not present`);
  return result;
}

export function requestObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'NOT_READABLE_HTTP_MESSAGE', 'JSON 요청 본문을 읽을 수 없습니다.');
  }
  return value as Record<string, unknown>;
}

export function requestString(
  object: Record<string, unknown>,
  field: string,
  requiredMessage: string,
  sizeMessage: string,
  max = 255,
  notBlank = false,
): string {
  const value = object[field];
  const errors: FieldError[] = [];
  if (value === undefined || value === null || (notBlank && typeof value === 'string' && value.trim() === '')) {
    errors.push({ field, message: requiredMessage, constraint: notBlank ? 'NotBlank' : 'NotNull' });
  } else if (typeof value !== 'string') {
    throw new ApiError(400, 'NOT_READABLE_HTTP_MESSAGE', `Cannot deserialize String field '${field}'`);
  }
  if (typeof value === 'string' && (value.length < 1 || value.length > max)) {
    errors.push({ field, message: sizeMessage, constraint: 'Size' });
  }
  if (errors.length) throw new ApiError(400, 'INVALID_REQUEST_BODY', errors[0]!.message, errors);
  return value as string;
}

export function parseExperimentRequest(value: unknown): ExperimentRequest {
  const object = requestObject(value);
  const display_title = requestString(
    object,
    'display_title',
    '실험명은 필수입니다.',
    '실험명은 1자 이상 255자 이하로 입력해주세요.',
    255,
    true,
  );
  const title = requestString(
    object,
    'title',
    '실험명(변수명)은 필수입니다.',
    '실험명(변수명)은 1자 이상 255자 이하로 입력해주세요.',
    255,
    true,
  );
  function optionalString(field: string, max: number, min: number, message: string): string | null {
    const entry = object[field];
    if (entry === undefined || entry === null) return null;
    if (typeof entry !== 'string')
      throw new ApiError(400, 'NOT_READABLE_HTTP_MESSAGE', `Cannot deserialize String field '${field}'`);
    if (entry.length < min || entry.length > max)
      throw new ApiError(400, 'INVALID_REQUEST_BODY', message, [{ field, message, constraint: 'Size' }]);
    return entry;
  }
  const creator = optionalString('creator', 50, 1, '실험 생성자 이름은 1자 이상 50자 이하로 입력해주세요.');
  const team = optionalString('team', 50, 1, '팀명은 1자 이상 50자 이하로 입력해주세요.');
  const description = optionalString('description', 255, 0, '실험 내용은 255자 이하로 입력해주세요.');
  if (!Array.isArray(object.variables))
    throw new ApiError(400, 'NOT_READABLE_HTTP_MESSAGE', '실험군 목록을 읽을 수 없습니다.');
  const variables = object.variables.map((entry): VariableRequest => {
    const variable = requestObject(entry);
    if (!Number.isInteger(variable.rate) || Number(variable.rate) < -2147483648 || Number(variable.rate) > 2147483647) {
      throw new ApiError(400, 'NOT_READABLE_HTTP_MESSAGE', '실험군 편입 비율은 정수여야 합니다.');
    }
    return {
      rate: Number(variable.rate),
      display_name: requestString(
        variable,
        'display_name',
        '실험군 이름은 필수입니다.',
        '실험군 이름은 1자 이상 255자 이하로 입력해주세요.',
        255,
        true,
      ),
      name: requestString(
        variable,
        'name',
        '실험군 이름(변수명)은 필수입니다.',
        '실험군 이름(변수명)은 1자 이상 255자 이하로 입력해주세요.',
        255,
        true,
      ),
    };
  });
  return { display_title, title, creator, team, description, variables };
}

export function kstTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(new Date(utc).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
