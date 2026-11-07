import InformationIcon from 'assets/svg/Bus/info-gray.svg';
import { BUS_FEEDBACK_FORM } from 'static/bus';
import useLogger from 'utils/hooks/analytics/useLogger';

import styles from './InfoFooter.module.scss';

type BUSTYPE = 'SHUTTLE' | 'EXPRESS' | 'CITY';

// 4-1 정보가 정확하지 않나요?: 시간표 화면에서는 보고 있던 탭을 value로 보낸다
const FEEDBACK_LOG_VALUE: Record<BUSTYPE, string> = {
  SHUTTLE: '셔틀',
  EXPRESS: '대성',
  CITY: '시내',
};

interface InfoFooterProps {
  type: BUSTYPE;
  updated: string;
}

export default function InfoFooter({ type, updated }: InfoFooterProps) {
  const logger = useLogger();

  const handleFeedbackClick = () => {
    window.open(BUS_FEEDBACK_FORM);
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'bus__bus_timetable__bus_feedback__entry__click',
      value: FEEDBACK_LOG_VALUE[type],
    });
  };

  return (
    <div className={styles['info-footer']}>
      <div className={styles['info-footer__date']}>
        <span>업데이트 날짜 :</span>
        {updated}
      </div>
      <button type="button" className={styles['info-footer__icon']} onClick={handleFeedbackClick}>
        <InformationIcon />
        <div className={styles['info-footer__text']}>정보가 정확하지 않나요?</div>
      </button>
    </div>
  );
}
