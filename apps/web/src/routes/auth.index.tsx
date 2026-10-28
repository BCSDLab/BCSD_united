import { createFileRoute } from '@tanstack/react-router';

import AuthLayout from 'components/Auth/AuthPage';
import AdditionalLink from 'components/Auth/LoginPage/components/AdditionalLink';
import Footer from 'components/Auth/LoginPage/components/Footer';
import LoginForm from 'components/Auth/LoginPage/components/LoginForm';

import styles from 'pages/auth/LoginPage.module.scss';

function LoginPage() {
  return (
    <div className={styles.template}>
      <LoginForm />
      <AdditionalLink />
      <Footer />
    </div>
  );
}



export default LoginPage;

export const Route = createFileRoute('/auth/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <LoginPage />;
  return <AuthLayout>{page}</AuthLayout>;
}
