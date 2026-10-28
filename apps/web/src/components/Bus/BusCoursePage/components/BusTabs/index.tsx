import { useRouter, useLocation } from '@tanstack/react-router';

import { cn } from '@bcsdlab/utils';
import BusNotice from 'components/Bus/BusNotice';
import { BUS_TYPES } from 'static/bus';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';

import styles from './BusTabs.module.scss';

const BUS_TAB_ROUTES: Record<(typeof BUS_TYPES)[number]['key'], string> = {
  shuttle: ROUTES.BusCourseShuttle(),
  express: ROUTES.BusCourseExpress(),
  city: ROUTES.BusCourseCity(),
};

export default function BusTabs() {
  const router = useRouter();
  const routeLocation = useLocation();
  const logger = useLogger();

  const pathParts = routeLocation.pathname.split('/');
  const selectedTab = pathParts[2] ?? 'shuttle';

  const onClickBusTab = (type: (typeof BUS_TYPES)[number]) => {
    logger.actionEventClick({
      team: 'CAMPUS',
      event_label: 'timetable_bus_type_tab',
      value: type.tabValue,
    });
    router.navigate({ href: BUS_TAB_ROUTES[type.key], replace: true });
  };

  return (
    <section className={styles.template}>
      <BusNotice loggingLocation={selectedTab} variant="timetable" />
      <ul className={styles.tabs} role="tablist">
        {BUS_TYPES.map((type) => (
          <li key={type.key} role="tab" aria-selected={selectedTab === type.key}>
            <button
              type="button"
              onClick={() => onClickBusTab(type)}
              onMouseEnter={() => {
                if (selectedTab !== type.key) {
                  router.preloadRoute({ to: BUS_TAB_ROUTES[type.key] });
                }
              }}
              className={cn({
                [styles.tabs__tab]: true,
                [styles['tabs__tab--selected']]: selectedTab === type.key,
              })}
            >
              {type.tabName}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
