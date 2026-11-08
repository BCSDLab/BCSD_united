import { useQuery } from '@tanstack/react-query';

import { coopshopQueries } from 'api/coopshop/queries';
import InformationIcon from 'assets/svg/common/information/information-icon-grey.svg';
import useCafeteriaInfoParam from 'components/cafeteria/hooks/useCafeteriaInfoParam';
import HeaderIconButton from 'components/ui/PageHeader/HeaderIconButton';
import useLogger from 'utils/hooks/analytics/useLogger';

export default function CafeteriaInfoButton() {
  const { data: cafeteriaInfo } = useQuery(coopshopQueries.cafeteriaInfo());
  const { open } = useCafeteriaInfoParam();
  const logger = useLogger();

  // 운영 정보를 못 받으면 안내 패널이 그려지지 않으므로 버튼도 숨긴다
  if (!cafeteriaInfo) return null;

  return (
    <HeaderIconButton
      aria-label="학생식당 운영 정보 안내"
      onClick={() => {
        // 식단 3-7 학생식당정보 (모바일은 우측 상단 i 아이콘)
        logger.actionEventClick({
          event_name: 'DA1',
          event_label: 'cafeteria__cafeteria__cafeteria_info__entry__click',
          value: '학생식당정보',
        });
        open();
      }}
    >
      <InformationIcon />
    </HeaderIconButton>
  );
}
