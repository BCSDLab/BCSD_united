import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

const HOSTS: Record<string, true> = {
  'stage-static.koreatech.in': true,
  'static.koreatech.in': true,
  'bcsdlab.com': true,
  'placehold.co': true,
};
const WIDTHS = new Set([16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const imageEnvironment: { readonly KOIN_ENVIRONMENT?: string } = env;

function allowedSource(url: URL, origin: string): boolean {
  if (url.username || url.password || url.hash) return false;
  if (url.origin === 'https://pub-035732b521844e3b9205d80d8d6efda1.r2.dev') {
    return imageEnvironment.KOIN_ENVIRONMENT === 'preview';
  }
  if (url.origin === origin) return url.pathname.startsWith('/assets/');

  return url.protocol === 'https:' && !url.port && Object.hasOwn(HOSTS, url.hostname);
}

async function fetchImage(source: URL, request: Request): Promise<Response> {
  let url = source;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!allowedSource(url, new URL(request.url).origin)) return new Response(null, { status: 400 });
    const response =
      url.origin === new URL(request.url).origin
        ? await env.ASSETS.fetch(new Request(url))
        : await fetch(url, { redirect: 'manual', headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(10_000) });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) return new Response(null, { status: 502 });
    url = new URL(location, url);
  }

  return new Response(null, { status: 502 });
}

async function optimizeImage(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawSource = url.searchParams.get('url');
  const width = Number(url.searchParams.get('w'));
  const quality = Number(url.searchParams.get('q') ?? '75');
  if (!rawSource || !WIDTHS.has(width) || !Number.isInteger(quality) || quality < 1 || quality > 100) {
    return new Response('Invalid image parameters', { status: 400 });
  }
  let source: URL;
  try {
    source = new URL(rawSource, url.origin);
  } catch {
    return new Response('Invalid image URL', { status: 400 });
  }
  if (!allowedSource(source, url.origin)) return new Response('Image source is not allowed', { status: 400 });

  const accept = request.headers.get('accept') ?? '';
  let format: 'image/avif' | 'image/webp' | 'image/jpeg' = 'image/jpeg';
  if (accept.includes('image/avif')) format = 'image/avif';
  else if (accept.includes('image/webp')) format = 'image/webp';
  const key = new URL(url.origin + url.pathname);
  key.search = new URLSearchParams({ url: source.href, w: String(width), q: String(quality), format }).toString();
  const cacheRequest = new Request(key);
  const cache = await caches.open('images-v1');
  const cached = await cache.match(cacheRequest);
  if (cached) return cached;

  const upstream = await fetchImage(source, request);
  const mime = upstream.headers.get('content-type')?.split(';')[0];
  if (!upstream.ok || !upstream.body || !mime || !/^image\/(jpeg|png|webp|avif|gif)$/.test(mime)) {
    await upstream.body?.cancel();

    return new Response('Image source is unavailable', { status: upstream.status === 404 ? 404 : 502 });
  }
  let received = 0;
  const limited = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_IMAGE_BYTES) throw new RangeError('Image exceeds 20 MiB');
        controller.enqueue(chunk);
      },
    }),
  );
  const output = await env.IMAGES.input(limited).transform({ width, fit: 'scale-down' }).output({ format, quality });
  const response = output.response({
    headers: {
      'Cache-Control': 'public, max-age=2678400',
      Vary: 'Accept',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
  await cache.put(cacheRequest, response.clone());

  return response;
}

export const Route = createFileRoute('/api/image')({
  server: { handlers: { GET: ({ request }) => optimizeImage(request) } },
});
