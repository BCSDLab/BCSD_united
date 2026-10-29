/** 코인 API가 저장하는 강의 시간 한 덩어리. start_time/end_time은 요일까지 포함된 값이다. */
export interface LectureInfo {
  day: number;
  start_time: number;
  end_time: number;
}

export interface Lecture {
  code: string;
  name: string;
  lecture_class: string;
  professor: string;
  grades: string;
  regular_number: string;
  department: string;
  target: string;
  design_score: string;
  is_english: string;
  is_elearning: string;
  lecture_infos: LectureInfo[];
  /** 엑셀에 적혀 있던 원본 문자열. 검토 화면에서 파싱 결과와 나란히 보여주려고 남긴다. */
  raw_class_time: string;
}

/**
 * 정규는 `월07A~09B` 같은 교시 표기, 계절은 `09:00~12:00` 같은 시간 범위를 쓴다.
 * 두 표기의 파싱 규칙이 완전히 달라 스펙에서 미리 구분한다.
 */
export type TimeFormat = 'period' | 'range';

/**
 * 엑셀 한 파일을 강의 목록으로 바꾸는 데 필요한 정보 전부.
 * 학기마다 컬럼명·순서·헤더 위치가 바뀌기 때문에 코드가 아니라 데이터로 다룬다.
 * 나중에 이 객체를 LLM이 생성하게 되며, 그때도 변환 코드는 그대로 쓴다.
 */
export interface MappingSpec {
  /** 헤더가 있는 행 번호(1-based). 파일에 따라 1행이기도 2·3행이기도 하다. */
  headerRow: number;
  timeFormat: TimeFormat;
  /**
   * 계절학기는 강의시간에 요일이 없다. 월~금 매일 수업이라 5일로 전개한다.
   * (2025 여름학기 프로덕션 데이터로 확인)
   */
  seasonalDays?: number[];
  /** 컬럼 위치(0-based). 없는 컬럼은 생략하고, 그 필드는 기본값으로 채운다. */
  columns: {
    code: number;
    name: number;
    lectureClass: number;
    professor?: number;
    grades?: number;
    regularNumber?: number;
    department?: number;
    target?: number;
    designScore?: number;
    isEnglish?: number;
    classTime: number;
  };
}

/** 변환 결과. 사람이 봐야 할 것들을 숫자로 남겨 승인 판단에 쓴다. */
export interface ConvertResult {
  lectures: Lecture[];
  issues: ConvertIssue[];
  stats: {
    totalRows: number;
    converted: number;
    skipped: number;
    withoutTime: number;
  };
}

export interface ConvertIssue {
  row: number;
  kind: 'unparsable_time' | 'missing_code' | 'missing_name';
  value: string;
  message: string;
}
