import type { ComponentType, MouseEvent, SVGProps } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';

import BriefcaseIcon from 'assets/svg/category/briefcase-icon.svg';
import CalendarIcon from 'assets/svg/category/calendar-icon.svg';
import ChatIcon from 'assets/svg/category/chat-icon.svg';
import DeliveryBoxIcon from 'assets/svg/category/delivery-box-icon.svg';
import DishIcon from 'assets/svg/category/dish-icon.svg';
import HomeIcon from 'assets/svg/category/home-icon.svg';
import InfoIcon from 'assets/svg/category/info-icon.svg';
import PermanentJobIcon from 'assets/svg/category/permanent-job-icon.svg';
import StoreIcon from 'assets/svg/category/store-icon.svg';
import TeamIcon from 'assets/svg/category/team-icon.svg';
import UserAddIcon from 'assets/svg/category/user-add-icon.svg';
import ArrowRightIcon from 'assets/svg/common/arrow-right-icon.svg';
import BusTimeIcon from 'assets/svg/common/bus-time-icon.svg';
import RouteIcon from 'assets/svg/common/route-icon.svg';
import HomeLayout from 'components/layout/HomeLayout';
import LoginRequiredModal from 'components/modal/LoginRequiredModal';
import type { Portal } from 'components/modal/Modal/PortalProvider';
import IconBox from 'components/ui/IconBox';
import type { LoggingTarget } from 'lib/gtag';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useModalPortal from 'utils/hooks/layout/useModalPortal';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import { parseSearch } from 'utils/routing/search';

import styles from 'pages/category/CategoryPage.module.scss';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;
// 명세가 있는 항목은 네이밍룰 v1.0(event_name·새 label)으로, 명세가 없는 항목(식단·버스·교통편·코인 for Business)은 기존 team 로그로 보낸다
type CategoryLogging = LoggingTarget & { value: string };

interface CategoryItem {
  title: string;
  description?: string;
  href: string;
  Icon?: IconComponent;
  logging: CategoryLogging;
}

interface CategorySection {
  title: string;
  items: CategoryItem[];
}

const quickMenus: CategoryItem[] = [
  {
    title: '팀원 모집',
    description: '교내 활동 팀원 구하기',
    href: ROUTES.Team(),
    Icon: TeamIcon,
    logging: {
      event_name: 'DA1',
      event_label: 'team_recruit__main_category__team_recruit_entry__category_entry__click',
      value: '팀원 모집',
    },
  },
  {
    title: '분실물',
    description: '분실물 신고 / 조회하기',
    href: ROUTES.LostItems(),
    Icon: DeliveryBoxIcon,
    logging: {
      event_name: 'DA2',
      event_label: 'board__main_category__lost_item_entry__category_entry__click',
      value: '분실물',
    },
  },
];

const sections: CategorySection[] = [
  {
    title: '캠퍼스',
    items: [
      {
        title: '교내 시설물 정보',
        href: ROUTES.CampusInfo(),
        Icon: PermanentJobIcon,
        logging: {
          event_name: 'DA2',
          event_label: 'facility__main_category__category_navigation__facility_entry__click',
          value: '교내 시설물 정보',
        },
      },
      {
        title: '학교 부서 정보',
        href: ROUTES.Department(),
        Icon: InfoIcon,
        logging: {
          event_name: 'DA2',
          event_label: 'department__main_category__category_navigation__department_entry__click',
          value: '학교 부서 정보',
        },
      },
      {
        title: '식단',
        href: ROUTES.Cafeteria(),
        Icon: DishIcon,
        logging: {
          team: 'CAMPUS',
          event_label: 'category_dining',
          value: '식단',
        },
      },
      {
        title: '주변상점',
        href: `${ROUTES.Store()}?category=1`,
        Icon: StoreIcon,
        logging: {
          event_name: 'DA1',
          event_label: 'shop__main_category__shop_entry__category_entry__click',
          value: '주변상점',
        },
      },
      {
        title: '시간표',
        href: ROUTES.Timetable(),
        Icon: CalendarIcon,
        logging: {
          event_name: 'DA1',
          event_label: 'timetable__main_category__timetable_entry__category_entry__click',
          value: '시간표',
        },
      },
    ],
  },
  {
    title: '교통',
    items: [
      {
        title: '버스 시간표',
        href: ROUTES.BusCourseShuttle(),
        Icon: BusTimeIcon,
        logging: {
          team: 'CAMPUS',
          event_label: 'category_bus_timetable',
          value: '버스 시간표',
        },
      },
      {
        title: '교통편 조회하기',
        href: ROUTES.BusRoute(),
        Icon: RouteIcon,
        logging: {
          team: 'CAMPUS',
          event_label: 'category_transportation',
          value: '교통편 조회하기',
        },
      },
      {
        title: '콜밴팟 모집',
        href: ROUTES.Callvan(),
        Icon: UserAddIcon,
        logging: {
          event_name: 'DA2',
          event_label: 'callvan__main_category__category_navigation__callvan_entry__click',
          value: '콜밴팟 모집',
        },
      },
    ],
  },
  {
    title: '기타',
    items: [
      {
        title: '채팅',
        href: ROUTES.LostItemChat(),
        Icon: ChatIcon,
        logging: {
          event_name: 'DA2',
          event_label: 'chat__main_category__category_navigation__chat_entry__click',
          value: '채팅',
        },
      },
      {
        title: '복덕방',
        href: ROUTES.Room(),
        Icon: HomeIcon,
        logging: {
          event_name: 'DA1',
          event_label: 'real_estate__main_category__real_estate_entry__category_entry__click',
          value: '복덕방',
        },
      },
      {
        title: '코인 for Business',
        href: 'https://owner.koreatech.in/',
        Icon: BriefcaseIcon,
        logging: {
          team: 'BUSINESS',
          event_label: 'category_koin_for_business',
          value: '코인 for Business',
        },
      },
    ],
  },
];

function CategoryIconBox({ Icon }: { Icon?: IconComponent }) {
  if (!Icon) return null;

  return (
    <IconBox>
      <Icon />
    </IconBox>
  );
}

function CategoryPage() {
  const logger = useLogger();
  const isLoggedIn = useIsLoggedIn();
  const portalManager = useModalPortal();

  const handleCategoryClick = (logging: CategoryLogging) => {
    logger.actionEventClick(logging);
  };

  const openLoginModal = () => {
    portalManager.open((portalOption: Portal) => (
      <LoginRequiredModal title="쪽지를 사용하기" description="로그인 후 이용해주세요." onClose={portalOption.close} />
    ));
  };

  const handleMenuClick = (e: MouseEvent<HTMLAnchorElement>, item: CategoryItem) => {
    handleCategoryClick(item.logging);
    if (!isLoggedIn && item.href === ROUTES.LostItemChat()) {
      e.preventDefault();
      openLoginModal();
    }
  };

  return (
    <main className={styles.category}>
      <section className={styles.quick} aria-label="주요 서비스">
        {quickMenus.map(({ title, description, href, Icon, logging }) => (
          <Link
            key={title}
            to={href.split('?')[0]}
            search={parseSearch(href.split('?')[1] ?? '')}
            className={styles['quick-card']}
            onClick={() => handleCategoryClick(logging)}
          >
            <CategoryIconBox Icon={Icon} />
            <div>
              <p className={styles['quick-card__title']}>{title}</p>
              <p className={styles['quick-card__description']}>{description}</p>
            </div>
          </Link>
        ))}
      </section>

      {sections.map(({ title, items }) => (
        <section key={title} className={styles.section} aria-labelledby={`category-${title}`}>
          <h2 id={`category-${title}`} className={styles.section__title}>
            {title}
          </h2>
          <ul className={styles.menu}>
            {items.map((item) => {
              const { title: itemTitle, href, Icon } = item;

              return (
                <li key={itemTitle}>
                  <Link
                    to={href.split('?')[0]}
                    search={parseSearch(href.split('?')[1] ?? '')}
                    className={styles.menu__link}
                    onClick={(e) => handleMenuClick(e, item)}
                  >
                    <div className={styles.menu__content}>
                      <CategoryIconBox Icon={Icon} />
                      <span className={styles.menu__title}>{itemTitle}</span>
                    </div>
                    <ArrowRightIcon className={styles.chevron} aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </main>
  );
}

export default CategoryPage;

export const Route = createFileRoute('/category/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <CategoryPage />;

  return <HomeLayout>{page}</HomeLayout>;
}
