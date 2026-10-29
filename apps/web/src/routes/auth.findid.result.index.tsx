import { createFileRoute, useNavigate } from '@tanstack/react-router';

import FindIdLayout from 'components/Auth/FindIdPage/Mobile';
import { STORAGE_KEY } from 'static/auth';
import ROUTES from 'static/routes';
import { useSessionStorage } from 'utils/hooks/state/useWebStorage';

import styles from 'pages/auth/findid/result/ResultPage.module.scss';

function ResultPage() {
  const routeNavigate = useNavigate();

  const [userId] = useSessionStorage<string | null>(STORAGE_KEY.FOUND_LOGIN_ID, null);
  const onClickLogin = () => {
    routeNavigate({ href: ROUTES.Auth() });
  };
  const onClickPassword = () => {
    routeNavigate({ href: ROUTES.AuthFindPW({ step: '계정인증' }) });
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>아이디 조회 결과</h1>
      <span className={styles.description}>
        아이디는 <strong>{userId}</strong> 입니다.
      </span>
      <div className={styles['button-wrapper']}>
        <button type="button" className={styles['button-wrapper__login-button']} onClick={onClickLogin}>
          로그인 바로가기
        </button>
        <button type="button" className={styles['button-wrapper__password-button']} onClick={onClickPassword}>
          비밀번호 찾기
        </button>
      </div>
    </div>
  );
}

export default ResultPage;

export const Route = createFileRoute('/auth/findid/result/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <ResultPage />;

  return <FindIdLayout>{page}</FindIdLayout>;
}
