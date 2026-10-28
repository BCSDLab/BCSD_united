import { createFileRoute, useNavigate } from '@tanstack/react-router';
import PageLayout from 'components/layout';


import Error from 'assets/svg/page-not-found-error.svg';
import ROUTES from 'static/routes';

import styles from 'pages/404/PageNotFound.module.scss';

export default function PageNotFound() {
  
  const routeNavigate = useNavigate();
  
  

  return (
    <div className={styles.template}>
      <div className={styles['error-icon']}>
        <Error />
      </div>
      <div className={styles.content}>
        <div className={styles.content__title}>개발 중인 페이지입니다</div>
        <div className={styles.content__description}>
          죄송합니다. 현재 개발 중인 페이지입니다.
          <br />
          최대한 빠르게 오픈하도록 하겠습니다.
        </div>
        <button type="button" className={styles.content__button} onClick={() => routeNavigate({ href: ROUTES.Main() })}>
          메인 화면 바로가기
        </button>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/404/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <PageNotFound />;
  return <PageLayout>{page}</PageLayout>;
}

export { PageNotFound as NotFoundPage };
