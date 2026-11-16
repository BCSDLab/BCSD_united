import { createFileRoute, Link } from '@tanstack/react-router';

import ChevronRightIcon from 'assets/svg/Team/chevron-right-icon.svg';
import AuthenticateUserModal from 'components/AuthenticateUserModal';
import Layout from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { LANGUAGE_NATIVE_NAMES } from 'static/language';
import ROUTES from 'static/routes';
import useBooleanState from 'utils/hooks/state/useBooleanState';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import { useLanguage } from 'utils/language/useLanguage';

import styles from 'pages/setting/SettingPage.module.scss';

// 프로필과 비밀번호 변경은 웹에서 한 화면(정보 수정)이라 둘 다 비밀번호 확인 후 그 화면으로 보낸다
function AccountRow({ title, onAuthenticate }: { title: string; onAuthenticate: () => void }) {
  const isLoggedIn = useIsLoggedIn();

  if (!isLoggedIn) {
    return (
      <li>
        <Link to={ROUTES.Auth()} className={styles.row}>
          <span className={styles.row__title}>{title}</span>
          <ChevronRightIcon className={styles.row__icon} aria-hidden />
        </Link>
      </li>
    );
  }

  return (
    <li>
      <button type="button" className={styles.row} onClick={onAuthenticate}>
        <span className={styles.row__title}>{title}</span>
        <ChevronRightIcon className={styles.row__icon} aria-hidden />
      </button>
    </li>
  );
}

function LinkRow({ title, href }: { title: string; href: string }) {
  return (
    <li>
      <Link to={href} className={styles.row}>
        <span className={styles.row__title}>{title}</span>
      </Link>
    </li>
  );
}

function SettingPage() {
  const { language } = useLanguage();
  const [isAuthModalOpen, openAuthModal, closeAuthModal] = useBooleanState(false);

  return (
    <>
      <MobilePageHeader title="설정" />
      <main className={styles.page}>
        <section aria-labelledby="setting-general">
          <h2 id="setting-general" className={styles.section}>
            일반
          </h2>
          <ul className={styles.list}>
            <AccountRow title="프로필" onAuthenticate={openAuthModal} />
            <AccountRow title="비밀번호 변경" onAuthenticate={openAuthModal} />
            <li>
              <Link to={ROUTES.SettingLanguage()} className={styles.row}>
                <span className={styles.row__title}>언어 설정</span>
                <span className={styles.row__value}>{LANGUAGE_NATIVE_NAMES[language]}</span>
                <ChevronRightIcon className={styles.row__icon} aria-hidden />
              </Link>
            </li>
          </ul>
        </section>
        <section aria-labelledby="setting-service">
          <h2 id="setting-service" className={styles.section}>
            서비스
          </h2>
          <ul className={styles.list}>
            <LinkRow title="개인정보 처리방침" href={ROUTES.SettingPolicy({ type: 'privacy' })} />
            <LinkRow title="코인 이용약관" href={ROUTES.SettingPolicy({ type: 'terms' })} />
            <LinkRow title="마케팅 수신 동의 약관" href={ROUTES.SettingPolicy({ type: 'marketing' })} />
            <li>
              <a href={ROUTES.Inquiry()} target="_blank" rel="noreferrer" className={styles.row}>
                <span className={styles.row__title}>문의하기</span>
              </a>
            </li>
          </ul>
        </section>
      </main>
      {isAuthModalOpen && <AuthenticateUserModal onClose={closeAuthModal} />}
    </>
  );
}

export const Route = createFileRoute('/setting/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { title: '설정 | KOIN' },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <Layout mobileHeader="page">
      <SettingPage />
    </Layout>
  );
}
