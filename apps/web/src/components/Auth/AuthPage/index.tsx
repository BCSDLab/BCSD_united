import Image from 'components/ui/Image';
import { Link, useLocation, useRouter } from '@tanstack/react-router';

import Logo from 'assets/svg/Login/logo.svg';
import MobileLogo from 'assets/svg/Login/mobile-logo.svg';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

import styles from './Auth.module.scss';

function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const routeLocation = useLocation();
  const isMobile = useMediaQuery();

  return (
    <div className={styles.template}>
      {routeLocation.pathname === ROUTES.Auth() && (
        <button type="button" className={styles['template__go-back']} onClick={() => router.history.back()}>
          <Image
            className={styles['template__left-arrow-image']}
            src="https://static.koreatech.in/assets/ic-room/left-arrow.png"
            alt="go back logo"
            width={30}
            height={30}
          />
        </button>
      )}
      <div className={styles.template__content}>
        {routeLocation.pathname === ROUTES.Auth() && (
          <Link className={styles.template__logo} to={ROUTES.Main()} >
            {!isMobile ? (
              <Logo className={styles.template__image} width={107} height={60} aria-label="main logo" />
            ) : (
              <MobileLogo className={styles.template__image} width={117} height={111} aria-label="main logo" />
            )}
          </Link>
        )}
        {children}
      </div>
    </div>
  );
}

export default AuthLayout;
