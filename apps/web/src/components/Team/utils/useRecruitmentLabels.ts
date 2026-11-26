import type {
  TeamApplicationStatus,
  TeamRecruitmentCategory,
  TeamRecruitmentMeetingType,
  TeamRecruitmentStatus,
} from 'api/team/entity';
import formatApplicationStatus from 'components/Team/utils/formatApplicationStatus';
import formatRecruitmentStatus from 'components/Team/utils/formatRecruitmentStatus';
import { CATEGORY_LABEL, MEETING_TYPE_LABEL } from 'components/Team/utils/recruitmentDisplay';
import useServerMessage from 'utils/language/useServerMessage';

/** 팀원모집 서버 코드(분류·진행 방식·모집 상태·지원 상태)를 화면 언어 문구로 바꾼다. 한국어 화면은 `CATEGORY_LABEL` 등 웹 문구를 그대로 쓴다. */
export default function useRecruitmentLabels() {
  const message = useServerMessage();

  return {
    category: (category: TeamRecruitmentCategory) =>
      message('recruitment.category', category, CATEGORY_LABEL[category]),
    meetingType: (meetingType: TeamRecruitmentMeetingType) =>
      message('recruitment.meeting_type', meetingType, MEETING_TYPE_LABEL[meetingType]),
    // 모집 중인 글의 `D-n` 표시는 날짜라 번역하지 않는다. 상태 문구(모집 중·모집완료)만 사전으로 바꾼다.
    status: (status: TeamRecruitmentStatus, dDay: number | null) => {
      const label = formatRecruitmentStatus(status, dDay);
      if (status === 'RECRUITING' && dDay !== null) return label;

      return message('recruitment.status', status, label);
    },
    applicationStatus: (status: TeamApplicationStatus) =>
      message('recruitment.application_status', status, formatApplicationStatus(status)),
  };
}
