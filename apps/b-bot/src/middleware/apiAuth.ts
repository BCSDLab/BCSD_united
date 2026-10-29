import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

export default defineEventHandler((event) => {
  const path = decodeURIComponent(getRequestURL(event).pathname).toLowerCase();
  if (path !== '/api' && !path.startsWith('/api/')) return;

  const secret = process.env.WEBHOOK_SECRET;
  const authorization = getHeader(event, 'authorization');
  if (!secret || !authorization?.startsWith('Bearer ')) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }
  const expected = Buffer.from(secret);
  const received = Buffer.from(authorization.slice(7));
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }
});
