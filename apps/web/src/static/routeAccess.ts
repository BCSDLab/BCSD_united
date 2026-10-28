import ROUTES, { PROTECTED_ROUTES } from 'static/routes';

const PARAM_TOKEN = '__PARAM__';
const paramProxy = new Proxy({}, { get: () => PARAM_TOKEN });
const protectedPatterns = PROTECTED_ROUTES.map((route) => {
  const template = route(paramProxy).split('?')[0];
  const pattern = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(PARAM_TOKEN, '[^/]+');

  return new RegExp(`^${pattern}$`);
});

export function isProtectedPath(pathname: string): boolean {
  return protectedPatterns.some((pattern) => pattern.test(pathname));
}

export function isDisabledOrderPath(pathname: string): boolean {
  const base = ROUTES.OrderHome();

  return process.env.NEXT_PUBLIC_ORDER_ENABLED !== 'true' && (pathname === base || pathname.startsWith(`${base}/`));
}
