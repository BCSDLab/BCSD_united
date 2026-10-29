import { describe, expect, it } from 'vitest';
import { validateConversion } from '~/services/bus/validation';

function conversion(arrivalTime: Array<string | null> = ['08:10', '도착']) {
  return {
    payloads: [
      {
        target: 'commuting',
        semester_type: 'REGULAR',
        body: {
          commuting_bus_timetables: [
            {
              region: '천안',
              route_type: '등교',
              route_name: '천안역',
              node_info: [{ name: '천안역' }, { name: '대학' }],
              route_info: [{ name: '1회', arrival_time: arrivalTime }],
            },
          ],
        },
      },
    ],
    version_update: {
      type: 'shuttle_bus_timetable',
      title: '정규학기',
      content: '2026-03-02~2026-06-20',
    },
    provenance: {},
    warnings: [],
  };
}

describe('버스 API payload 검증', () => {
  it('정상 시간과 운행 표식을 허용한다', () => {
    expect(validateConversion(conversion())).toEqual(conversion());
  });

  it('정류장 수와 도착 시간 수가 다르면 거부한다', () => {
    expect(() => validateConversion(conversion(['08:10']))).toThrow('arrival_time length differs');
  });

  it('허용되지 않은 도착 시간은 거부한다', () => {
    expect(() => validateConversion(conversion(['오전 8시', '도착']))).toThrow('invalid arrival_time');
  });
});
