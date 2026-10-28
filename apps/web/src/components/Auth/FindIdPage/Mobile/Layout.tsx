import type { ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';

import ChevronLeftIcon from 'assets/svg/Login/chevron-left.svg';
import ROUTES from 'static/routes';

import styles from './Mobile.module.scss';

interface LayoutProps {
  children: ReactNode;
}

function MobileLayout({ children }: LayoutProps) {
  const router = useRouter();
  const navigate = (href: string) => router.navigate({ href });
  const handleBack = () => navigate(ROUTES.Auth());

  return (
    <div className={styles.container}>
      <div className={styles.container__header}>
        <button type="button" className={styles.container__button} onClick={handleBack} aria-label="뒤로가기">
          <ChevronLeftIcon />
        </button>
        <span className={styles.container__title}>아이디 찾기</span>
      </div>

      {children}
    </div>
  );
}

export default MobileLayout;
