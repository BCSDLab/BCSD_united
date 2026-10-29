import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  integerParameter,
  kstTimestamp,
  pagination,
  parseExperimentRequest,
  selectAssignmentVariable,
  validateExperimentUpdate,
  validateVariables,
  type ExperimentRequest,
  type ExperimentVariable,
} from '@api/domains/experiments/algorithms';
import { matchAdminActivity } from '@api/domains/experiments/audit';
import { runExperimentsCron } from '@api/domains/experiments/service';
import { parseDeviceMetadata } from '@api/domains/experiments/user-agent';
import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';

function variables(rates: number[], counts: number[] = rates.map(() => 0)): ExperimentVariable[] {
  return rates.map((rate, index) => ({
    id: index + 1,
    name: String.fromCharCode(65 + index),
    display_name: `실험군 ${index + 1}`,
    rate,
    count: counts[index]!,
  }));
}

function assignmentSequence(rates: number[], length: number): string[] {
  const groups = variables(rates);
  const pending = new Map<number, number>();
  return Array.from({ length }, () => {
    const group = selectAssignmentVariable(groups, pending);
    pending.set(group.id, (pending.get(group.id) ?? 0) + 1);
    return group.name;
  });
}

const request: ExperimentRequest = {
  display_title: '식단 UI 실험',
  title: 'dining_ui_test',
  creator: null,
  team: null,
  description: null,
  variables: variables([50, 50]).map(({ name, display_name, rate }) => ({ name, display_name, rate })),
};

function legacyFailure(status: number, message: string) {
  return (error: unknown) =>
    error instanceof ApiError && error.status === status && error.code === '' && error.message === message;
}

test('zero participants always select the first group, including a zero-weight first group', () => {
  assert.equal(selectAssignmentVariable(variables([50, 50])).name, 'A');
  assert.equal(selectAssignmentVariable(variables([0, 100])).name, 'A');
});

test('weighted allocation is deterministic and uses pending durable participants', () => {
  assert.deepEqual(assignmentSequence([50, 50], 8), ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
  assert.deepEqual(assignmentSequence([33, 33, 34], 7), ['A', 'C', 'B', 'C', 'A', 'B', 'C']);
  const groups = variables([20, 80], [1, 3]);
  assert.equal(selectAssignmentVariable(groups, new Map([[2, 1]])).name, 'A');
  assert.deepEqual(
    groups.map(({ count }) => count),
    [1, 3],
  );
});

test('integer truncation and a tied deficit retain source list order', () => {
  assert.equal(selectAssignmentVariable(variables([29, 15, 56], [2, 1, 4])).name, 'A');
  assert.equal(selectAssignmentVariable(variables([50, 50], [5, 5])).name, 'A');
  assert.equal(selectAssignmentVariable(variables([50, 50], [-1, 2])).name, 'A');
});

test('pending negative deltas and source 32-bit total overflow preserve zero-total boundary', () => {
  assert.equal(selectAssignmentVariable(variables([0, 100], [1, 0]), new Map([[1, -1]])).name, 'A');
  assert.equal(selectAssignmentVariable(variables([0, 100], [-2147483648, -2147483648])).name, 'A');
  assert.throws(
    () => selectAssignmentVariable([], new Map(), 'empty'),
    legacyFailure(500, 'AB테스트 편입 중 오류가 발생했습니다. abtest name: empty'),
  );
});

test('folding pending counts into persistent counts does not change the next assignment', () => {
  const groups = variables([33, 33, 34], [10, 9, 12]);
  const pending = new Map([
    [1, 2],
    [2, 3],
    [3, -1],
  ]);
  const before = selectAssignmentVariable(groups, pending);
  const after = selectAssignmentVariable(
    groups.map((group) => ({ ...group, count: group.count + (pending.get(group.id) ?? 0) })),
  );
  assert.equal(before.id, after.id);
});

test('rate changes retain existing group identities and redistribute only future assignments', () => {
  const groups = variables([50, 50], [5, 5]);
  const changed = {
    ...request,
    variables: request.variables.map((group, index) => ({ ...group, rate: index ? 80 : 20 })),
  };
  assert.doesNotThrow(() => validateExperimentUpdate(request.title, groups, changed));
  assert.equal(
    selectAssignmentVariable(groups.map((group, index) => ({ ...group, rate: changed.variables[index]!.rate }))).name,
    'B',
  );
  assert.deepEqual(
    groups.map(({ count }) => count),
    [5, 5],
  );
});

test('experiment title, group set, duplicate names, and weight sum use original errors', () => {
  assert.throws(
    () => validateExperimentUpdate(request.title, variables([50, 50]), { ...request, title: 'renamed' }),
    legacyFailure(400, '실험 이름이 잘못되었습니다. 실험 title은 변경할 수 없습니다.'),
  );
  assert.throws(
    () => validateVariables([{ name: 'A', display_name: 'A', rate: 99 }]),
    legacyFailure(400, '실험군이 잘못되었습니다. 실험군 비율 합이 100이 아닙니다. rate sum: 99'),
  );
  assert.throws(
    () =>
      validateVariables([
        { name: 'A', display_name: 'A', rate: 50 },
        { name: 'A', display_name: 'B', rate: 50 },
      ]),
    legacyFailure(400, '실험군이 잘못되었습니다. 실험군 간의 변수명(name)이 중복됩니다.'),
  );
  assert.throws(
    () => validateExperimentUpdate(request.title, variables([100]), request),
    legacyFailure(400, '실험군이 잘못되었습니다. 실험군 개수는 수정될 수 없습니다.'),
  );
  assert.throws(
    () =>
      validateExperimentUpdate(request.title, variables([50, 50]), {
        ...request,
        variables: [{ ...request.variables[0]!, name: 'C' }, request.variables[1]!],
      }),
    legacyFailure(400, '실험군이 잘못되었습니다. abtest name: dining_ui_test, variable name: C'),
  );
});

test('request DTOs retain optional null fields and integer parameter limits', () => {
  assert.deepEqual(parseExperimentRequest(request), request);
  assert.throws(
    () => parseExperimentRequest({ ...request, display_title: ' ' }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'INVALID_REQUEST_BODY' &&
      error.fieldErrors[0]?.field === 'display_title',
  );
  assert.equal(integerParameter('-2147483648', 'id'), -2147483648);
  assert.equal(integerParameter('2147483647', 'id'), 2147483647);
  assert.throws(() => integerParameter('2147483648', 'id'));
  assert.throws(() => integerParameter('1.5', 'id'));
});

test('pagination clamps invalid limits and page requests using unfiltered total', () => {
  assert.deepEqual(pagination(undefined, undefined, 0), { limit: 10, offset: 0, current_page: 1 });
  assert.deepEqual(pagination(99, 8, 10), { limit: 8, offset: 8, current_page: 2 });
  assert.deepEqual(pagination(-1, 0, 10), { limit: 1, offset: 0, current_page: 1 });
  assert.deepEqual(pagination(3, 100, 101), { limit: 50, offset: 100, current_page: 3 });
});

test('audit logging maps annotated routes and correct nested entity IDs, not unrelated admin mutations', () => {
  assert.deepEqual(matchAdminActivity('POST', '/abtest'), { domain: 'ABTEST', domainId: null });
  assert.deepEqual(matchAdminActivity('POST', '/abtest/close/12'), { domain: 'ABTEST', domainId: 12 });
  assert.deepEqual(matchAdminActivity('DELETE', '/admin/shops/10/menus/20'), { domain: 'MENUS', domainId: 20 });
  assert.deepEqual(matchAdminActivity('DELETE', '/admin/shops/10/menus/categories/30'), {
    domain: 'MENUSCATEGORIES',
    domainId: 30,
  });
  assert.deepEqual(matchAdminActivity('POST', '/admin/shops/10/menus'), { domain: 'MENUS', domainId: null });
  assert.deepEqual(matchAdminActivity('PUT', '/admin/shops/categories/order'), {
    domain: 'SHOPSCATEGORIES',
    domainId: null,
  });
  assert.deepEqual(matchAdminActivity('POST', '/admin/version/android'), { domain: 'VERSION', domainId: null });
  assert.equal(matchAdminActivity('PUT', '/admin/version/android'), null);
  assert.equal(matchAdminActivity('PUT', '/admin/password'), null);
  assert.equal(matchAdminActivity('POST', '/admin'), null);
  assert.equal(matchAdminActivity('POST', '/abtest/assign'), null);
  assert.equal(matchAdminActivity('GET', '/abtest/12'), null);
});

test('pinned device parser retains source model and tablet/mobile precedence', () => {
  assert.deepEqual(
    parseDeviceMetadata('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'),
    { model: 'iPhone', type: 'Mobile' },
  );
  assert.deepEqual(
    parseDeviceMetadata('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'),
    { model: 'iPad', type: 'Tablet' },
  );
  assert.deepEqual(parseDeviceMetadata('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), { model: 'Other', type: 'PC' });
  assert.equal(parseDeviceMetadata(undefined), null);
});

test('KST history dates preserve midnight boundaries and subsecond truncation', () => {
  assert.equal(kstTimestamp('2026-10-28 14:59:59.999'), '2026-10-28 23:59:59');
  assert.equal(kstTimestamp('2026-10-28 15:00:00'), '2026-10-29 00:00:00');
  assert.equal(kstTimestamp(null), null);
});

test('non-hourly cron ticks return without touching database bindings', async () => {
  // 비실행 시각에는 DB 바인딩에 접근하면 안 된다.
  const env = Object.defineProperty({}, 'DB', {
    get() {
      throw new Error('Unexpected database scan');
    },
  }) as Bindings;
  await runExperimentsCron(env, Date.parse('2026-10-28T00:01:00Z'));
  await runExperimentsCron(env, Date.parse('2026-10-28T00:59:00Z'));
});
