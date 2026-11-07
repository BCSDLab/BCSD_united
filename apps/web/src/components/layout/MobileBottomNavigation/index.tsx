import { Link, useLocation } from '@tanstack/react-router';

import CategoryIcon from 'assets/svg/common/category-icon.svg';
import ClipBoardIcon from 'assets/svg/common/clipboard-icon.svg';
import HomeIcon from 'assets/svg/common/home-icon.svg';
import UserIcon from 'assets/svg/common/user-icon.svg';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';

import styles from './MobileBottomNavigation.module.scss';

const NAVIGATION_ITEMS = [
  {
    key: 'home',
    event_label: 'main__main__navigation__main_entry__click' as const,
    label: '홈',
    href: ROUTES.Main(),
    Icon: HomeIcon,
  },
  {
    key: 'category',
    event_label: 'main__main__navigation__category_menu_entry__click' as const,
    label: '카테고리',
    href: ROUTES.Category(),
    Icon: CategoryIcon,
  },
  {
    key: 'board',
    event_label: 'main__main__notice_entry__navigation_entry__click' as const,
    label: '게시판',
    href: ROUTES.Articles(),
    Icon: ClipBoardIcon,
  },
  {
    key: 'profile',
    event_label: 'main__main__navigation__profile_entry__click' as const,
    label: '프로필',
    href: ROUTES.Profile(),
    Icon: UserIcon,
  },
];

const isNavigationActive = (pathname: string, key: string, href: string) => {
  if (key === 'home') return pathname === href;
  if (key === 'profile') return pathname === ROUTES.Profile() || pathname === ROUTES.Auth();

  return pathname === href || pathname.startsWith(`${href}/`);
};

function MobileBottomNavigation() {
  const { pathname } = useLocation();
  const logger = useLogger();

  return (
    <nav className={styles.navigation} aria-label="하단 메뉴">
      <ul className={styles['navigation__list']}>
        {NAVIGATION_ITEMS.map(({ key, event_label, label, href, Icon }) => {
          const isActive = isNavigationActive(pathname, key, href);

          return (
            <li
              key={key}
              className={`${styles.navigation__item} ${isActive ? styles['navigation__item--active'] : ''}`}
            >
              <Link
                to={href}
                className={styles.navigation__link}
                aria-current={isActive ? 'page' : undefined}
                onClick={() =>
                  logger.actionEventClick({
                    event_name: 'DA2',
                    event_label,
                    // 명세 2-3: 게시판 버튼은 공지사항 진입으로 기록한다
                    value: key === 'board' ? '공지사항' : label,
                  })
                }
              >
                <Icon className={styles.navigation__icon} />
                <span className={styles.navigation__label}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default MobileBottomNavigation;
