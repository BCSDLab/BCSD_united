import type { AnalysedCell, AnalysedSheet, AnalysedWorkbook } from './excelAnalyzer';
import type { ArrivalTime, BusRoute, BusTarget } from './types';
import { normalizeTime } from './validation';
import { sourceDays, WEEKDAYS, type Day } from './days';
import { clean, sourceRegion } from './text';

const KOREAN_DAY: Record<Day, string> = {
  MON: '월요일',
  TUE: '화요일',
  WED: '수요일',
  THU: '목요일',
  FRI: '금요일',
  SAT: '토요일',
  SUN: '일요일',
};

const DAY_ORDER = Object.keys(KOREAN_DAY) as Day[];

/**
 * 서울의 매일 도는 기본(주중) 통학 배차가 붙는 route_name. 등교("서울
 * 교대역")와 하교가 이 이름을 공유해야 admin API 전송 직전
 * mergeCommutingDirections가 정류장 합집합으로 한 문서에 합친다(프로덕션
 * 실제 데이터 `_id: 69a5a710...`도 등교/하교가 "서울 교대역" 한 문서에
 * 있었다) — 서울은 실제로 도는 정규 노선이 교대역 기준 하나뿐이라 하드코딩
 * 해도 된다(동천역은 항상 월요일 전용 추가편일 뿐 기본 배차가 없다).
 */
const SEOUL_BASE_ROUTE_NAME = '서울 교대역';

/**
 * 요일 목록을 표시용 이름으로 정리한다. 특정 하루뿐이면 그 요일명("월요일")을,
 * 여러 날에 걸치면(기본 운행) "주중"을 쓴다.
 */
function dayLabelFromDays(days: Day[] | undefined): string {
  return days?.length === 1 ? KOREAN_DAY[days[0]] : '주중';
}

/** 회차 라벨("월(1호차)", "화~금")을 표시용 요일 이름으로 정리한다. */
function dayGroupLabel(label: string): string {
  return dayLabelFromDays(sourceDays(label));
}

/**
 * "월(2호차)"(월요일)와 "화~금"(화~금)처럼 도착시각이 완전히 같은 회차는 요일
 * 표기만 다를 뿐 같은 물리적 배차다(예: 07:20 버스가 월요일엔 "2호차"로,
 * 나머지 평일엔 "화~금"으로 각각 표에 적혀 있을 뿐). 이런 회차를 각자 요일로
 * 따로 문서화하면 "서울 등교 추가 교대역 2(월요일)"처럼 매일 도는 배차가
 * 마치 월요일 전용 추가편인 것처럼 잘못 보인다. 도착시각이 같은 회차는 요일을
 * 합쳐 하나로 묶는다 — 합친 요일이 평일 전체면 "주중"(기본 배차)이 된다.
 */
function mergeIdenticalTrips(
  trips: Array<{ label: string; arrival_time: ArrivalTime[] }>,
): Array<{ days: Day[] | undefined; arrival_time: ArrivalTime[] }> {
  const merged: Array<{ key: string; days: Set<Day>; arrival_time: ArrivalTime[] }> = [];
  for (const trip of trips) {
    const key = JSON.stringify(trip.arrival_time);
    const days = sourceDays(trip.label) ?? [];
    const existing = merged.find((entry) => entry.key === key);
    if (existing) {
      for (const day of days) existing.days.add(day);
    } else {
      merged.push({ key, days: new Set(days), arrival_time: trip.arrival_time });
    }
  }
  return merged.map(({ days, arrival_time }) => ({
    days: days.size ? DAY_ORDER.filter((day) => days.has(day)) : undefined,
    arrival_time,
  }));
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MARKERS = new Set(['도착', '정차', '미정차', '하차', '미하차', '승하차', '종점']);

const key = (row: number, column: number) => `${row}:${column}`;
const isMaster = (cell: AnalysedCell) => !cell.merged_from;
const isBlank = (value: unknown) => value == null || value === '' || /^[xX-]$/.test(clean(value));

function arrival(value: unknown): ArrivalTime | undefined {
  if (isBlank(value)) return undefined;
  const normalized = normalizeTime(value);
  if (typeof normalized !== 'string') return undefined;
  if (TIME.test(normalized) || MARKERS.has(normalized)) return normalized;
  if (normalized.includes('하차')) return '하차';
  if (normalized.includes('도착')) return '도착';
  return undefined;
}

function arrivalList(value: unknown): ArrivalTime | undefined {
  if (typeof value !== 'string' || !value.includes('/')) return arrival(value);
  const parts = value.split('/').map((part) => arrival(part.trim()));
  return parts.every((part) => part !== undefined) ? parts.join('/') : undefined;
}

function sourceDirection(text: string): string {
  if (/등교/.test(text)) return '등교';
  if (/하교/.test(text)) return '하교';
  return '셔틀';
}

function values(sheet: AnalysedSheet) {
  return new Map(sheet.cells.map((cell) => [key(cell.row, cell.column), cell.value]));
}

function seoulWeekdayBaseName(originStation: string | undefined): string {
  if (originStation === '교대역') return SEOUL_BASE_ROUTE_NAME;
  return originStation ? `서울 ${originStation}` : '서울';
}

/** 한 칸에 여러 회차가 `/`로 들어 있으면 회차마다 이름을 따로 붙인다. */
function splitTripName(name: string, count: number, index: number): string {
  if (count === 1) return name;
  if (/추가/.test(name)) return `목·금 추가${index + 1}`;
  return `${name.replace(/\s*\(\d+대\)\s*$/, '')} ${index + 1}회`;
}

function splitColumnTrip(
  name: string,
  columnValues: Array<ArrivalTime | undefined>,
  heading: string,
): BusRoute['route_info'] {
  const parts = columnValues.map((value) =>
    typeof value === 'string' && value.includes('/')
      ? value.split('/').map((part) => arrival(part.trim()) ?? null)
      : [value ?? null],
  );
  const count = Math.max(...parts.map((part) => part.length));
  const days = sourceDays(`${heading} ${name}`);
  return Array.from({ length: count }, (_, index) => ({
    name: splitTripName(name, count, index),
    ...(days ? { running_days: days } : {}),
    arrival_time: parts.map((part) => part[index] ?? null),
  }));
}

function regionalMatrices(sheet: AnalysedSheet): Array<{ target: BusTarget; route: BusRoute }> {
  const at = values(sheet);
  const masters = sheet.cells.filter(isMaster);
  const sections = masters
    .filter((cell) => /(?:천안|청주|서울|세종|대전|아산)\s*지역.*등교/.test(clean(cell.value)))
    .sort((left, right) => left.row - right.row);
  const routes: Array<{ target: BusTarget; route: BusRoute }> = [];

  for (const [sectionIndex, headingCell] of sections.entries()) {
    const sectionEnd = sections[sectionIndex + 1]?.row ?? Math.max(...sheet.cells.map((cell) => cell.row)) + 1;
    const stopHeader = masters.find(
      (cell) =>
        cell.row > headingCell.row &&
        cell.row <= headingCell.row + 4 &&
        cell.column === headingCell.column &&
        clean(cell.value) === '정류장',
    );
    if (!stopHeader) continue;
    const nextBlock = masters
      .filter(
        (cell) =>
          cell.row === headingCell.row &&
          cell.column > headingCell.column &&
          /통학.*버스|대학원.*버스/.test(clean(cell.value)),
      )
      .sort((left, right) => left.column - right.column)[0];
    const endColumn = (nextBlock?.column ?? 40) - 1;
    const stopRows = sheet.cells
      .filter(
        (cell) =>
          cell.column === stopHeader.column &&
          cell.row > stopHeader.row &&
          cell.row < sectionEnd &&
          isMaster(cell) &&
          clean(cell.value) &&
          !clean(cell.value).startsWith('운행기간'),
      )
      .map((cell) => ({ row: cell.row, name: clean(cell.value) }));

    const columns: Array<{
      column: number;
      label: string;
      heading: string;
      target: BusTarget;
      rowValues: Array<ArrivalTime | undefined>;
    }> = [];
    for (let column = stopHeader.column + 1; column <= endColumn; column += 1) {
      const label = clean(at.get(key(stopHeader.row, column)));
      const rowValues = stopRows.map((row) => arrivalList(at.get(key(row.row, column))));
      if (
        !label ||
        // "운행기간 : ..." 같은 안내 문구가 옆 칸까지 넓게 병합돼 있으면, 그
        // 병합 범위의 각 열이 마치 회차 헤더처럼 보인다. 실제로는 다른
        // 표(예: 세종 노선)의 값이 같은 행 번호에 우연히 걸쳐 회차로 잘못
        // 잡히니 이런 안내문 라벨은 열 헤더로 쓰지 않는다.
        label.startsWith('운행기간') ||
        !rowValues.some((value) => value !== undefined)
      )
        continue;
      const localHeading = clean(
        masters
          .filter(
            (cell) => cell.row === headingCell.row && cell.column <= column && /지역|셔틀|순환/.test(clean(cell.value)),
          )
          .sort((left, right) => right.column - left.column)[0]?.value ?? headingCell.value,
      );
      const target: BusTarget = /셔틀|순환/.test(localHeading) ? 'shuttle' : 'commuting';
      columns.push({ column, label, heading: localHeading, target, rowValues });
    }

    for (const column of columns.filter((item) => item.target === 'commuting')) {
      const selected = stopRows
        .map((row, index) => ({ ...row, value: column.rowValues[index] }))
        .filter((row): row is typeof row & { value: ArrivalTime } => row.value !== undefined);
      if (!selected.length) continue;
      const values = selected.map((row) => row.value);
      const hasJoined = values.some((value) => typeof value === 'string' && value.includes('/'));
      // KOIN 사이트는 route_type이 WEEKDAYS(통학)인 노선의 등교/하교를
      // route_info[].name이 정확히 "등교"/"하교"인지로 구분한다(백엔드
      // ShuttleBusService.setDirection). "1회"처럼 다르게 적으면 전부
      // "등교"로 잘못 분류돼 하교 쪽이 조회에서 통째로 빠진다.
      const routeInfo: BusRoute['route_info'] = hasJoined
        ? splitColumnTrip(column.label, values, column.heading).map((trip) => ({
            name: '등교',
            running_days: [...WEEKDAYS] as BusRoute['route_info'][number]['running_days'],
            arrival_time: trip.arrival_time,
          }))
        : [
            {
              name: '등교',
              running_days: [...WEEKDAYS] as BusRoute['route_info'][number]['running_days'],
              arrival_time: values,
            },
          ];
      routes.push({
        target: 'commuting',
        route: {
          region: sourceRegion(clean(headingCell.value)) ?? column.label,
          route_type: '등교',
          // KOIN Admin API는 route_info[].running_days를 받지 않는다. 이
          // 표의 통학 노선은 전부 평일(주중) 운행이 기본값이라(위
          // running_days: [...WEEKDAYS]), 프로덕션 실제 표기(`_id:
          // 69a5a710...` sub_name "주중")대로 sub_name에 남겨 둔다.
          route_name: `${column.label}(주중)`,
          node_info: selected.map((row) => ({ name: row.name })),
          route_info: routeInfo,
        },
      });
    }

    const shuttleGroups = new Map<string, typeof columns>();
    for (const column of columns.filter((item) => item.target === 'shuttle')) {
      shuttleGroups.set(column.heading, [...(shuttleGroups.get(column.heading) ?? []), column]);
    }
    for (const [heading, group] of shuttleGroups) {
      const usedRows = stopRows.filter((_, index) => group.some((column) => column.rowValues[index] !== undefined));
      if (!usedRows.length) continue;
      const indexes = usedRows.map((row) => stopRows.findIndex((item) => item.row === row.row));
      const routeInfo = group.flatMap((column) =>
        splitColumnTrip(
          column.label,
          indexes.map((index) => column.rowValues[index]),
          heading,
        ),
      );
      // 프로덕션 실제 표기(`_id: 675ab5eb...` "천안 셔틀" sub_name "주중")를
      // 따른다 — 요일 제한 없이 매일 도는 순환 셔틀도 sub_name "주중"을 쓴다.
      const shuttleHeadingDays = sourceDays(heading);
      const shuttleHeadingDaySuffix = shuttleHeadingDays?.length === 1 ? KOREAN_DAY[shuttleHeadingDays[0]] : '주중';
      routes.push({
        target: 'shuttle',
        route: {
          region: sourceRegion(heading) ?? sourceRegion(clean(headingCell.value)) ?? '천안',
          route_type: '셔틀',
          route_name: `${heading.replace(/\s*\(.*/, '').trim()}(${shuttleHeadingDaySuffix})`,
          node_info: usedRows.map((row) => ({ name: row.name })),
          route_info: routeInfo,
        },
      });
    }
  }
  return routes;
}

/**
 * "(천안시내) 토요일 통학 셔틀버스"처럼 표 제목이 지역만 괄호로 담고,
 * 소속(예: 일학습병행대학)은 그 위 상위 제목("2026학년도 학기 중
 * 일학습병행대학 주말통학버스 운행시간표")에만 있는 경우 그 소속을 찾아
 * 합친다. 상위 제목이 없으면(예: "전문대학원 토요일 통학 셔틀버스"처럼
 * 소속이 이미 제목 앞에 있는 경우) "요일 통학 셔틀버스" 군더더기만 뗀다.
 * route_name은 이렇게 만들고, 방향·요일 판별에는 원래 title을 그대로 쓴다.
 */
function shuttleRouteName(sheet: AnalysedSheet, header: AnalysedCell, title: string): string {
  const region = title.match(/^\(([^)]+)\)/)?.[1];
  if (region) {
    const outer = sheet.cells
      .filter(
        (cell) =>
          isMaster(cell) &&
          cell.row < header.row &&
          cell.row >= header.row - 25 &&
          /주말\s*통학\s*버스|주말\s*셔틀버스/.test(clean(cell.value)),
      )
      .sort((left, right) => right.row - left.row)[0];
    const affiliation = clean(outer?.value ?? '').match(/학기\s*중\s*(.+?)\s*주말/)?.[1];
    return affiliation ? `${affiliation} ${region}` : region;
  }
  return title.replace(/\s*(?:토요일|일요일|주중|주말)?\s*통학\s*셔틀버스\s*$/, '');
}

function nearestTitle(sheet: AnalysedSheet, header: AnalysedCell): string {
  return clean(
    sheet.cells
      .filter(
        (cell) =>
          isMaster(cell) &&
          cell.row < header.row &&
          cell.row >= header.row - 6 &&
          Math.abs(cell.column - header.column) <= 3 &&
          /셔틀버스|등교|하교|세종/.test(clean(cell.value)) &&
          !clean(cell.value).startsWith('운행기간'),
      )
      .sort(
        (left, right) =>
          right.row - left.row || Math.abs(left.column - header.column) - Math.abs(right.column - header.column),
      )[0]?.value,
  );
}

function standaloneTables(sheet: AnalysedSheet): Array<{ target: BusTarget; route: BusRoute }> {
  const at = values(sheet);
  const masters = sheet.cells.filter(isMaster);
  const regionalHeaderKeys = new Set(
    masters
      .filter((cell) => /지역.*등교/.test(clean(cell.value)))
      .flatMap((heading) =>
        masters
          .filter(
            (cell) =>
              cell.column === heading.column &&
              cell.row > heading.row &&
              cell.row <= heading.row + 4 &&
              clean(cell.value) === '정류장',
          )
          .map((cell) => key(cell.row, cell.column)),
      ),
  );
  const routes: Array<{ target: BusTarget; route: BusRoute }> = [];
  for (const header of masters.filter(
    (cell) => /^(정류장|승차장소)$/.test(clean(cell.value)) && !regionalHeaderKeys.has(key(cell.row, cell.column)),
  )) {
    const title = nearestTitle(sheet, header);
    if (!title) continue;
    if (clean(header.value) === '승차장소' && !/통학.*셔틀버스/.test(title)) continue;
    const tripColumns: Array<{ column: number; label: string }> = [];
    const tripHeaders = masters
      .filter((cell) => cell.row === header.row && cell.column > header.column && cell.column <= header.column + 8)
      .sort((left, right) => left.column - right.column);
    for (const tripHeader of tripHeaders) {
      const sourceLabel = clean(tripHeader.value);
      const declaredCount = Number(sourceLabel.match(/(?:등교|하교)\s*(\d+)회/)?.[1] ?? 1);
      for (let offset = 0; offset < declaredCount; offset += 1) {
        const column = tripHeader.column + offset;
        const hasValue = Array.from({ length: 30 }, (_, rowOffset) =>
          arrival(at.get(key(header.row + 1 + rowOffset, column))),
        ).some(Boolean);
        if (!hasValue) continue;
        const label = declaredCount > 1 ? sourceLabel.replace(/\d+회/, `${offset + 1}회`) : sourceLabel;
        tripColumns.push({ column, label });
      }
    }
    if (!tripColumns.length) continue;
    // "등교 1회"/"하교 2회"처럼 방향이 라벨에 섞여 있으면 "N회(방향)"로
    // 바꾸고, 방향과 무관하게 표에 나온 순서대로 번호를 새로 매긴다(등교
    // 1·2회 다음 하교가 3·4회로 이어짐) — KOIN Admin API가 회차명 끝의
    // "(...)"만 방향(detail)으로 떼어내므로 이 포맷이어야 방향이 산다.
    for (const [index, trip] of tripColumns.entries()) {
      const direction = trip.label.match(/(등교|하교)/)?.[1];
      trip.label = `${index + 1}회${direction ? `(${direction})` : ''}`;
    }
    const rowCandidates: Array<{ row: number; name: string }> = [];
    let empty = 0;
    for (let row = header.row + 1; row < header.row + 35; row += 1) {
      const name = clean(at.get(key(row, header.column)));
      const hasArrival = tripColumns.some((trip) => arrival(at.get(key(row, trip.column))) !== undefined);
      if (!name && !hasArrival) {
        if (++empty >= 2 && rowCandidates.length) break;
        continue;
      }
      empty = 0;
      if (/^(운행기간|.*시간표|.*셔틀버스)$/.test(name) && rowCandidates.length) break;
      if (name) rowCandidates.push({ row, name });
    }
    const target: BusTarget = /셔틀|통학버스|대학원/.test(title) ? 'shuttle' : 'commuting';
    // "등교 1회"/"하교 2회"처럼 방향이 라벨에 섞여 있어도 회차마다 별도
    // 노선으로 쪼개지 않는다. "천안 셔틀"의 "토요일 오후"/"일요일 야간"
    // 회차들처럼, 한 제목 아래 여러 회차(왕복 포함)를 route_info 배열
    // 하나에 순서대로 담는 게 이 시트의 원래 표기 방식이다.
    const usedRows = rowCandidates.filter((row) =>
      tripColumns.some((trip) => arrival(at.get(key(row.row, trip.column))) !== undefined),
    );
    if (usedRows.length) {
      // 통학(commuting) 표는 요일 표기가 원문에 없으면 평일 운행이 기본값이다
      // (regionalMatrices의 통학 노선도 같은 기본값을 쓴다). 셔틀 표는 표 자체가
      // 특정 요일 전용(토요일 등)일 때만 이 표를 타므로 강제하지 않는다.
      const defaultDays = target === 'commuting' ? [...WEEKDAYS] : undefined;
      const direction = target === 'shuttle' ? '셔틀' : sourceDirection(title);
      // KOIN 사이트는 route_type이 WEEKDAYS(통학)인 노선의 등교/하교를
      // route_info[].name이 정확히 "등교"/"하교"인지로 구분한다. 셔틀은
      // 이 규칙 대상이 아니라 원래 라벨(trip.label)을 그대로 쓴다.
      const routeInfo = tripColumns
        .map((trip) => ({
          name: target === 'commuting' ? direction : trip.label,
          ...((sourceDays(title) ?? defaultDays) ? { running_days: sourceDays(title) ?? defaultDays } : {}),
          arrival_time: usedRows.map((row) => arrival(at.get(key(row.row, trip.column))) ?? null),
        }))
        .filter((info) => info.arrival_time.some((value) => value !== null));
      if (routeInfo.length) {
        const region = sourceRegion(`${title} ${usedRows.map((row) => row.name).join(' ')}`) ?? '천안';
        // KOIN Admin API는 route_info[].running_days를 받지 않는다. 셔틀
        // 노선이 특정 요일(예: 토요일) 전용이면 그 제한이 route_name 뒤
        // 괄호(→ sub_name)로만 살아남는다 — 안 붙이면 조용히 사라진다(프로덕션
        // 실제 데이터 `_id: 675ab70cff5ec5aab5eaee3e` "일학습병행대학 시내"
        // sub_name "토요일" 확인됨). 표 전체가 하루로만 도는 게 확실할 때만
        // 붙이고, 요일이 여럿 섞여 있으면(예: 평일 순환) 잘못 단정하지 않는다.
        const shuttleDays = target === 'shuttle' ? sourceDays(title) : undefined;
        const shuttleDaySuffix = shuttleDays?.length === 1 ? `(${KOREAN_DAY[shuttleDays[0]]})` : '';
        routes.push({
          target,
          route: {
            region,
            route_type: direction,
            // 통학(commuting) 노선은 등교/하교 방향이 route_info[].name과
            // route_type에 이미 담기니, route_name엔 지역명만 남긴다
            // (프로덕션 실제 표기: "세종 등교/하교"가 아니라 "세종").
            // KOIN Admin API는 route_info[].running_days를 받지 않으므로,
            // 통학 노선의 평일 운행 기본값도 sub_name "주중"으로 남긴다
            // (프로덕션 실제 표기 `_id: 69a5a710...` "세종" sub_name "주중").
            route_name:
              target === 'commuting'
                ? `${region}(주중)`
                : `${shuttleRouteName(sheet, header, title)}${shuttleDaySuffix}`,
            node_info: usedRows.map((row) => ({ name: row.name })),
            route_info: routeInfo,
          },
        });
      }
    }
  }
  return routes;
}

function seoulGrids(sheet: AnalysedSheet): Array<{ target: BusTarget; route: BusRoute }> {
  const at = values(sheet);
  const routes: Array<{ target: BusTarget; route: BusRoute }> = [];
  for (const header of sheet.cells.filter((cell) => isMaster(cell) && clean(cell.value) === '노선')) {
    const title = clean(
      sheet.cells
        .filter((cell) => cell.row < header.row && cell.row >= header.row - 5 && /서울/.test(clean(cell.value)))
        .sort((left, right) => right.row - left.row)[0]?.value,
    );
    if (!title) continue;
    const tripColumns = Array.from({ length: 8 }, (_, index) => header.column + 1 + index).filter((column) =>
      /호차|월|화|수|목|금/.test(clean(at.get(key(header.row, column)))),
    );
    let tableEnd = header.row + 12;
    for (let row = header.row + 1; row < header.row + 12; row += 1) {
      const unsupported = tripColumns.some((column) => {
        const raw = at.get(key(row, column));
        return !isBlank(raw) && arrival(raw) === undefined;
      });
      if (unsupported) {
        tableEnd = row;
        break;
      }
    }
    // "교대 출발"/"동천 출발"처럼 회차 헤더 한 줄 위에 출발지가 따로 있으면
    // 그 출발지별로 노선을 가른다 — 프로덕션 데이터의 실제 표기("서울 등교
    // 추가 교대역"/"서울 등교 추가 동천역")가 이렇게 나뉘어 있다. 출발지
    // 표기가 없으면 컬럼별로 서로 다른 그룹 키를 줘서 갈라둔다.
    const originRow = header.row - 1;
    const groups = new Map<string, { origin: string | null; columns: number[] }>();
    for (const column of tripColumns) {
      const origin = clean(at.get(key(originRow, column))) || null;
      const groupKey = origin ?? `column:${column}`;
      const group = groups.get(groupKey) ?? { origin, columns: [] };
      group.columns.push(column);
      groups.set(groupKey, group);
    }
    for (const { origin, columns } of groups.values()) {
      const nodeRows: Array<{ row: number; name: string }> = [];
      for (let row = header.row + 1; row < tableEnd; row += 1) {
        const name = clean(at.get(key(row, header.column)));
        if (!name) continue;
        const hasAny = columns.some((column) => arrival(at.get(key(row, column))) !== undefined);
        if (hasAny) nodeRows.push({ row, name });
      }
      if (!nodeRows.length) continue;
      const originStation = origin ? origin.replace(/\s*출발\s*$/, '').replace(/(?<!역)$/, '역') : undefined;
      const rawTrips = columns
        .map((column) => ({
          label: clean(at.get(key(header.row, column))),
          arrival_time: nodeRows.map((row) => arrival(at.get(key(row.row, column))) ?? null),
        }))
        .filter((trip) => trip.arrival_time.some((value) => value !== null));
      if (!rawTrips.length) continue;
      // 프로덕션 표기(예: `_id: 69a5a710...` "서울 교대역" sub_name "주중" vs
      // `_id: 675ab6d6...` "서울 등교 추가 교대역" sub_name "월요일")는 매일
      // 도는 기본 배차와 특정 요일에만 도는 추가 배차의 route_name 자체가
      // 다르다 — "등교 추가"는 추가 배차에만 붙는다. 도착시각이 같은 회차는
      // 같은 물리적 배차이므로 요일을 합쳐 하나로 묶고(mergeIdenticalTrips),
      // 합친 요일이 남으면(같은 요일 그룹 안에 1호차/2호차 등) 회차마다
      // 별도 문서로 나눈다 — 한 route_name 아래 sub_name만 다르게 묶으면
      // 앱에서 같은 이름 노선이 두 번 뜨는 문제가 있었다. 요일은 KOIN Admin
      // API가 route_info[].running_days를 받지 않으므로(name/detail/
      // arrival_time만 있다) route_name 뒤 괄호(→ sub_name)로 담는다.
      const trips = mergeIdenticalTrips(rawTrips);
      const weekdayBase = seoulWeekdayBaseName(originStation);
      const additionalBase = originStation ? `서울 등교 추가 ${originStation}` : '서울 등교 추가';
      const dayGroups = new Map<string, typeof trips>();
      for (const trip of trips) {
        const day = dayLabelFromDays(trip.days);
        dayGroups.set(day, [...(dayGroups.get(day) ?? []), trip]);
      }
      for (const [day, dayTrips] of dayGroups) {
        const base = day === '주중' ? weekdayBase : additionalBase;
        dayTrips.forEach((trip, index) => {
          const name = dayTrips.length > 1 ? `${base} ${index + 1}` : base;
          routes.push({
            target: 'commuting',
            route: {
              region: '서울',
              route_type: '등교',
              route_name: `${name}(${day})`,
              node_info: nodeRows.map((row) => ({ name: row.name })),
              route_info: [
                {
                  name: '등교',
                  ...(trip.days ? { running_days: trip.days } : {}),
                  arrival_time: trip.arrival_time,
                },
              ],
            },
          });
        });
      }
    }
  }
  return routes;
}

const MULTI_DEPARTURE = /(\d{1,2}:\d{2})\(([^)]+)\)/g;

/**
 * 서울 하교처럼 "노선"/"정류장" 헤더 없이, 출발 정류장 한 칸에 요일별 출발
 * 여러 회차가 "14:10(금), 16:10(금), 18:10(월~금)"처럼 쉼표로 뭉쳐 있고
 * 그 아래 정류장들은 전부 "하차"만 적힌 표를 읽는다. 뒤 정류장들은 회차별
 * 도착시각이 원문에 따로 없으니 모든 회차가 같은 "하차" 값을 공유한다.
 */
function seoulReturnRoutes(sheet: AnalysedSheet): Array<{ target: BusTarget; route: BusRoute }> {
  const at = values(sheet);
  const routes: Array<{ target: BusTarget; route: BusRoute }> = [];
  for (const anchor of sheet.cells.filter(
    (cell) => isMaster(cell) && typeof cell.value === 'string' && [...cell.value.matchAll(MULTI_DEPARTURE)].length >= 2,
  )) {
    const nearbySeoul = sheet.cells.some(
      (cell) => cell.row < anchor.row && cell.row >= anchor.row - 15 && /서울/.test(clean(cell.value)),
    );
    if (!nearbySeoul) continue;
    const originCell = sheet.cells
      .filter((cell) => cell.row === anchor.row && cell.column < anchor.column)
      .sort((left, right) => right.column - left.column)[0];
    if (!originCell) continue;
    const nameColumn = originCell.column;
    const nodes: Array<{ row: number; name: string }> = [{ row: anchor.row, name: clean(originCell.value) }];
    for (let row = anchor.row + 1; row < anchor.row + 15; row += 1) {
      const name = clean(at.get(key(row, nameColumn)));
      if (!name || /^(운행기간|★|.*시간표|.*셔틀버스)/.test(name)) break;
      nodes.push({ row, name });
    }
    if (nodes.length < 2) continue;
    const dispatches = [...String(anchor.value).matchAll(MULTI_DEPARTURE)];
    // 매일 도는 기본 배차(주중)는 등교 쪽 기본 배차와 같은 route_name(=
    // SEOUL_BASE_ROUTE_NAME)을 써야 admin API 전송 직전 mergeCommutingDirections가
    // 같은 문서로 합친다(프로덕션 실제 데이터 `_id: 69a5a710...`도 등교/하교가
    // 함께 "서울 교대역" 한 문서에 있다). 특정 요일에만 도는 추가 배차만
    // "서울 하교 추가"로 나눈다.
    const dayGroups = new Map<string, RegExpMatchArray[]>();
    for (const match of dispatches) {
      const day = dayGroupLabel(match[2]);
      dayGroups.set(day, [...(dayGroups.get(day) ?? []), match]);
    }
    for (const [day, dayDispatches] of dayGroups) {
      const base = day === '주중' ? SEOUL_BASE_ROUTE_NAME : '서울 하교 추가';
      dayDispatches.forEach((match, index) => {
        const name = dayDispatches.length > 1 ? `${base} ${index + 1}` : base;
        routes.push({
          target: 'commuting',
          route: {
            region: '서울',
            route_type: '하교',
            route_name: `${name}(${day})`,
            node_info: nodes.map((node) => ({ name: node.name })),
            route_info: [
              {
                name: '하교',
                ...(sourceDays(match[2]) ? { running_days: sourceDays(match[2]) } : {}),
                arrival_time: [
                  match[1],
                  ...nodes.slice(1).map((node) => arrival(at.get(key(node.row, anchor.column))) ?? null),
                ],
              },
            ],
          },
        });
      });
    }
  }
  return routes;
}

function timeParts(text: string): string[] {
  return [...text.matchAll(/(?<!\d)([0-2]?\d)(?:시|:)([0-5]\d)?/g)].map(
    (match) => `${match[1].padStart(2, '0')}:${(match[2] ?? '00').padStart(2, '0')}`,
  );
}

function arrowTextRoutes(sheet: AnalysedSheet): Array<{ target: BusTarget; route: BusRoute }> {
  const routes: Array<{ target: BusTarget; route: BusRoute }> = [];
  for (const pathCell of sheet.cells.filter(
    (cell) => isMaster(cell) && typeof cell.value === 'string' && cell.value.includes('→'),
  )) {
    const label = clean(pathCell.value);
    const path = label.replace(/^\([^)]*\)/, '');
    if (/^\d/.test(path)) continue;
    const nodes = path.split('→').map(clean).filter(Boolean);
    if (nodes.length < 2) continue;
    const timeText = clean(
      sheet.cells.find(
        (cell) =>
          cell.row === pathCell.row &&
          cell.column > pathCell.column &&
          cell.column <= pathCell.column + 5 &&
          /\d{1,2}(?:시|:)/.test(clean(cell.value)),
      )?.value,
    );
    if (!timeText) continue;
    const perNode = timeText.includes('→')
      ? timeText.split('→').map(timeParts)
      : [timeParts(timeText), ...nodes.slice(1).map(() => [])];
    const tripCount = Math.max(...perNode.map((times) => times.length));
    const region = sourceRegion(`${label} ${nodes.join(' ')}`);
    if (!region || !tripCount) continue;
    const days = sourceDays(label);
    // KOIN Admin API의 통학(commuting) route_type은 "주중" 고정이고
    // running_days는 API로 보내지도 않는다(검수 전용). "일요일에만 등교",
    // "금요일에만 하교"처럼 특정 요일 하나로만 도는 노선은 이 요일 제한이
    // sub_name(=route_name 끝 괄호)으로만 살아남는다 — 안 붙이면 조용히
    // 사라진다.
    const dayLabel = days?.length === 1 ? KOREAN_DAY[days[0]] : undefined;
    const direction = /대학|본교/.test(nodes[0]) ? '하교' : '등교';
    // 프로덕션 표기(예: "대전 등교 1"/"대전 등교 2")는 배차가 여러 개면
    // 노선 자체를 회차마다 별도 문서로 나눈다 — 한 문서에 route_info를
    // 여러 개 넣지 않는다. 배차가 하나뿐이면 번호 없이 지역명만 쓴다.
    for (let index = 0; index < tripCount; index += 1) {
      const suffix = tripCount > 1 ? ` ${direction} ${index + 1}` : '';
      routes.push({
        target: 'commuting',
        route: {
          region,
          route_type: direction,
          route_name: `${region}${suffix}${dayLabel ? `(${dayLabel})` : ''}`,
          node_info: nodes.map((name) => ({ name })),
          // KOIN 사이트는 route_type이 WEEKDAYS(통학)인 노선의 등교/하교를
          // route_info[].name이 정확히 "등교"/"하교"인지로 구분한다.
          route_info: [
            {
              name: direction,
              ...(days ? { running_days: days } : {}),
              arrival_time: nodes.map((_, nodeIndex) => perNode[nodeIndex]?.[index] ?? null),
            },
          ],
        },
      });
    }
  }
  return routes;
}

/**
 * 정류장 이름 셀 하나에 쉼표/마침표로 여러 정류장이 함께 적힌 경우
 * (예: "동우@,신계초,운전리.연춘리") 각각을 별개 정류장으로 나눈다.
 * 괄호 안 쉼표(예: "삼룡교(유니클로, 구 한방병원)")는 정류장 이름의 일부이므로
 * 나누지 않는다.
 */
function splitCombinedStopName(name: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of name) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if ((char === ',' || char === '.') && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 1 && parts.every(Boolean) ? parts : [name];
}

/**
 * 위 정류장 분리를 노선 전체(node_info + route_info)에 적용한다. 분리된
 * 정류장들은 원래 한 칸이었으므로 같은 회차 도착시각을 그대로 나눠 갖는다.
 */
function splitCombinedStops(route: BusRoute): BusRoute {
  const expandedCounts: number[] = [];
  const node_info: BusRoute['node_info'] = [];
  let changed = false;
  for (const node of route.node_info) {
    const parts = splitCombinedStopName(node.name);
    if (parts.length > 1) changed = true;
    expandedCounts.push(parts.length);
    for (const name of parts) node_info.push({ ...node, name });
  }
  if (!changed) return route;
  return {
    ...route,
    node_info,
    route_info: route.route_info.map((trip) => ({
      ...trip,
      arrival_time: trip.arrival_time.flatMap((time, index) => Array(expandedCounts[index]).fill(time)),
    })),
  };
}

function unique(routes: Array<{ target: BusTarget; route: BusRoute }>) {
  const seen = new Set<string>();
  return routes.filter(({ target, route }) => {
    const signature = JSON.stringify([
      target,
      route.region,
      route.route_type,
      route.route_name,
      route.node_info,
      route.route_info,
    ]);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/** Parses layouts by semantic headings, merged ranges and time-bearing columns; no fixed row numbers. */
export function parseStructuredWorkbook(workbook: AnalysedWorkbook) {
  return unique(
    workbook.sheets
      .flatMap((sheet) => [
        ...regionalMatrices(sheet),
        ...standaloneTables(sheet),
        ...seoulGrids(sheet),
        ...seoulReturnRoutes(sheet),
        ...arrowTextRoutes(sheet),
      ])
      .map(({ target, route }) => ({ target, route: splitCombinedStops(route) })),
  );
}
