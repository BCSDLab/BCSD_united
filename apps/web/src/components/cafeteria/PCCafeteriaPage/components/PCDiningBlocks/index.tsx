import type { Dining, DiningType } from 'api/dinings/entity';
import { useCafeteriaParams } from 'components/cafeteria/hooks/useCafeteriaParams';
import useDinings from 'components/cafeteria/hooks/useDinings';
import DetailModal from 'components/cafeteria/PCCafeteriaPage/components/DetailModal';
import PCMealImage from 'components/cafeteria/PCCafeteriaPage/components/PCMealImage';
import { filterDinings } from 'components/cafeteria/utils/filter';
import type { Portal } from 'components/modal/Modal/PortalProvider';
import { DINING_TYPE_MAP } from 'static/cafeteria';
import useLogger from 'utils/hooks/analytics/useLogger';
import useModalPortal from 'utils/hooks/layout/useModalPortal';
import useServerMessage from 'utils/language/useServerMessage';

import styles from './PCDiningBlocks.module.css';

interface PCDiningBlocksProps {
  diningType: DiningType;
  isThisWeek: boolean;
}

export default function PCDiningBlocks({ diningType, isThisWeek }: PCDiningBlocksProps) {
  const message = useServerMessage();
  const logger = useLogger();
  const portalManager = useModalPortal();
  const { date } = useCafeteriaParams();
  const { dinings } = useDinings(date.current());
  const filteredDinings = filterDinings(dinings, diningType);

  const handleImageClick = (dining: Dining) => {
    if (!dining.image_url) return;

    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'cafeteria__cafeteria__photo_view__open__click',
      value: `${DINING_TYPE_MAP[dining.type]}_${dining.place}`,
    });

    portalManager.open((portalOption: Portal) => <DetailModal dining={dining} closeModal={portalOption.close} />);
  };

  return (
    <div className={styles.grid}>
      {filteredDinings.map((dining) => (
        <div className={styles.block} key={dining.id}>
          <div className={styles.header}>
            <div className={styles.header__place}>{dining.display_place ?? dining.place}</div>
            <div className={styles.header__detail}>
              {!!dining.kcal && `${dining.kcal}kcal`}
              {!!dining.kcal && !!dining.price_card && !!dining.price_cash && '•'}
              {!!dining.price_card && !!dining.price_cash && `${dining.price_card}원/${dining.price_cash}원`}
            </div>
            {dining.soldout_at && (
              <span className={`${styles.header__chip} ${styles['header__chip--sold-out']}`}>
                {message('status', 'SOLD_OUT', '품절')}
              </span>
            )}
            {!dining.soldout_at && dining.changed_at && (
              <span className={`${styles.header__chip} ${styles['header__chip--changed']}`}>변경됨</span>
            )}
          </div>

          <div className={styles.content}>
            <PCMealImage dining={dining} isThisWeek={isThisWeek} handleImageClick={handleImageClick} />
            <div className={styles.content__menu}>
              {dining.menu.map((menuItem) => (
                <div key={menuItem.id}>{menuItem.name}</div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
