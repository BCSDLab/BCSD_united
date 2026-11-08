import { useSuspenseQuery } from '@tanstack/react-query';

import { coopshopQueries } from 'api/coopshop/queries';
import InformationIcon from 'assets/svg/common/information/information-icon-grey.svg';
import CafeteriaInfo from 'components/cafeteria/components/CafeteriaInfo';
import useLogger from 'utils/hooks/analytics/useLogger';
import useModalPortal from 'utils/hooks/layout/useModalPortal';

import styles from 'components/cafeteria/PCCafeteriaPage/components/DateNavigator/DateNavigator.module.scss';

export default function CafeteriaInfoTrigger() {
  const portalManager = useModalPortal();
  const logger = useLogger();
  const { data: cafeteriaInfo } = useSuspenseQuery(coopshopQueries.cafeteriaInfo());

  const handleInformationClick = () => {
    // 식단 3-7 학생식당정보
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'cafeteria__cafeteria__cafeteria_info__entry__click',
      value: '학생식당정보',
    });
    portalManager.open(() => <CafeteriaInfo cafeteriaInfo={cafeteriaInfo} closeInfo={portalManager.close} />);
  };

  return (
    <button type="button" className={styles.information} onClick={handleInformationClick}>
      <InformationIcon />
      학생식당정보
    </button>
  );
}
