import { describe, expect, it } from 'vitest';
import { parsePeriodFormat, parseRangeFormat } from '~/services/lecture/classTime';
import { describeClassTime } from '~/services/lecture/describeTime';
import { applyPatches, planPatches, resolveAmbiguities } from '~/services/lecture/patch';
import type { Lecture } from '~/services/lecture/types';

const lecture = (over: Partial<Lecture> = {}): Lecture => ({
  code: 'MEB321',
  name: '동역학',
  lecture_class: '01',
  professor: '신동호',
  grades: '3',
  regular_number: '40',
  department: '기계공학부',
  target: '기계전체',
  design_score: '0',
  is_english: 'N',
  is_elearning: '0',
  lecture_infos: [{ day: 0, start_time: 10, end_time: 11 }],
  raw_class_time: '월06A~06B',
  ...over,
});

describe('수정 적용', () => {
  it('원본을 건드리지 않는다', () => {
    // 미리보기와 실제 적용이 갈라지면 사람이 승인한 것과 다른 게 들어간다.
    const original = lecture();
    const before = structuredClone(original);

    applyPatches(
      [original],
      [
        {
          lecture: original,
          field: 'professor',
          label: '담당교수',
          before: '신동호',
          after: '유승한',
          rawValue: '유승한',
        },
      ],
    );

    expect(original).toEqual(before);
  });

  it('바뀐 값만 갈아끼운다', () => {
    const target = lecture();
    const other = lecture({ code: 'MEB341', name: '유체역학' });

    const [patchedTarget, untouched] = applyPatches(
      [target, other],
      [
        {
          lecture: target,
          field: 'professor',
          label: '담당교수',
          before: '신동호',
          after: '유승한',
          rawValue: '유승한',
        },
      ],
    );

    expect(patchedTarget.professor).toBe('유승한');
    expect(patchedTarget.name).toBe('동역학');
    expect(untouched).toEqual(other);
  });

  it('한 강의에 여러 건을 한 번에 적용한다', () => {
    const target = lecture();

    const [patched] = applyPatches(
      [target],
      [
        {
          lecture: target,
          field: 'professor',
          label: '담당교수',
          before: '신동호',
          after: '유승한',
          rawValue: '유승한',
        },
        { lecture: target, field: 'regular_number', label: '정원', before: '40', after: '45', rawValue: '45' },
      ],
    );

    expect(patched.professor).toBe('유승한');
    expect(patched.regular_number).toBe('45');
  });

  it('강의시간은 해석 결과와 원본 문자열을 함께 바꾼다', () => {
    // 검토 화면이 원본과 해석을 나란히 보여주므로 둘이 어긋나면 안 된다.
    const target = lecture();
    const parsed = [{ day: 2, start_time: 200, end_time: 203 }];

    const [patched] = applyPatches(
      [target],
      [
        {
          lecture: target,
          field: 'class_time',
          label: '강의시간',
          before: '월 14:00~15:00',
          after: '수 09:00~11:00',
          parsed,
          rawValue: '수01A~02B',
        },
      ],
    );

    expect(patched.lecture_infos).toEqual(parsed);
    expect(patched.raw_class_time).toBe('수01A~02B');
  });
});

const liveAiEnabled =
  process.env.RUN_AI_LIVE_TESTS === '1' &&
  Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

describe.skipIf(!liveAiEnabled)('수정 요청 해석', () => {
  const lectures = [
    lecture(),
    lecture({ lecture_class: '02', professor: '유승한' }),
    lecture({ code: 'MEB341', name: '유체역학', professor: '박승경' }),
  ];

  it('분반까지 지정한 요청을 한 건으로 만든다', async () => {
    const plan = await planPatches('MEB321 01 담당교수를 조병관으로 바꿔줘', lectures, 'period');

    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].lecture.lecture_class).toBe('01');
    expect(plan.patches[0].field).toBe('professor');
    expect(plan.patches[0].after).toBe('조병관');
  });

  it('여러 건을 한 번에 받는다', async () => {
    const plan = await planPatches(
      '유체역학 담당교수 우창규로 바꾸고, MEB321 01 정원을 45로 올려줘',
      lectures,
      'period',
    );

    expect(plan.patches.length).toBeGreaterThanOrEqual(2);
    expect(plan.patches.map((p) => p.field)).toContain('professor');
    expect(plan.patches.map((p) => p.field)).toContain('regular_number');
  });

  it('분반이 여러 개면 고르라고 한다', async () => {
    // 추측해서 바꾸면 되돌릴 방법이 없다.
    const plan = await planPatches('MEB321 담당교수를 조병관으로 바꿔줘', lectures, 'period');

    expect(plan.patches).toHaveLength(0);
    expect(plan.problems.join(' ')).toMatch(/분반/);
  });

  it('해석 못 하는 강의시간은 반영하지 않는다', async () => {
    const plan = await planPatches('MEB321 01 강의시간을 월요일 아무때나로 바꿔줘', lectures, 'period');

    expect(plan.patches.filter((p) => p.field === 'class_time')).toHaveLength(0);
    expect(plan.problems.length).toBeGreaterThan(0);
  });

  it('없는 강의는 찾지 못했다고 알린다', async () => {
    const plan = await planPatches('ZZZ999 담당교수를 홍길동으로 바꿔줘', lectures, 'period');

    expect(plan.patches).toHaveLength(0);
    expect(plan.problems.join(' ')).toMatch(/찾지 못/);
  });
});

describe.skipIf(!liveAiEnabled)('교시·시각 구분', () => {
  const lectures = [lecture({ raw_class_time: '수03A~04B' })];

  it('`교시`라고 하면 그대로 받는다', async () => {
    const plan = await planPatches('MEB321 01 강의시간을 9교시~10교시로 바꿔줘', lectures, 'period');

    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].after).toContain('17:00~19:00');
  });

  it('시각으로 적으면 시각으로 읽는다', async () => {
    const plan = await planPatches('MEB321 01 강의시간을 수요일 09:00~10:00으로 바꿔줘', lectures, 'period');

    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].after).toContain('09:00~10:00');
  });
});

describe.skipIf(!liveAiEnabled)('교시·시각 선택', () => {
  const lectures = [lecture({ raw_class_time: '수03A~04B' })];

  it('애매한 표기를 임의로 한쪽으로 정하지 않는다', async () => {
    const plan = await planPatches('MEB321 01 강의시간을 09~10으로 바꿔줘', lectures, 'period');

    // 교시·시각 신호가 없는 값을 그대로 적용해버리면 절반은 틀린다.
    const guessed = plan.patches.filter((p) => p.field === 'class_time' && !/[:]|교시|[AB]/.test(p.rawValue));
    expect(guessed).toHaveLength(0);

    // 되물을 땐 두 해석을 실제 시각으로 다 계산해둬야 고를 수 있다.
    for (const item of plan.ambiguities) {
      expect(describeClassTime(item.asPeriod.infos)).toContain('17:00~19:00');
      expect(describeClassTime(item.asClock.infos)).toContain('09:00~10:00');
    }
  });
});

describe('고른 쪽으로 확정', () => {
  // 선택을 확정하는 단계엔 LLM이 끼지 않는다. 그래서 이 테스트도 부르지 않는다.
  const target = lecture({ raw_class_time: '수03A~04B' });
  const ambiguity = {
    lecture: target,
    rawValue: '09~10',
    asPeriod: { normalized: '수09A~10B', infos: parsePeriodFormat('수09A~10B') },
    asClock: { normalized: '09:00~10:00', infos: parseRangeFormat('09:00~10:00', [2]) },
  };

  it('교시를 고르면 교시로 확정한다', () => {
    const [patch] = resolveAmbiguities([ambiguity], 'period');

    expect(patch.after).toContain('17:00~19:00');
    expect(patch.parsed).toEqual(ambiguity.asPeriod.infos);
    // 검토 화면의 원본 열에 들어갈 값도 고른 쪽을 따라야 한다.
    expect(patch.rawValue).toBe('수09A~10B');
  });

  it('시각을 고르면 시각으로 확정한다', () => {
    const [patch] = resolveAmbiguities([ambiguity], 'clock');

    expect(patch.after).toContain('09:00~10:00');
    expect(patch.parsed).toEqual(ambiguity.asClock.infos);
    expect(patch.rawValue).toBe('09:00~10:00');
  });

  it('여러 건이면 전부 같은 쪽으로 확정한다', () => {
    const patches = resolveAmbiguities([ambiguity, ambiguity], 'clock');

    expect(patches).toHaveLength(2);
    expect(patches.every((p) => p.after.includes('09:00~10:00'))).toBe(true);
  });
});
