const origin = process.env.ERROR_AUTOMATION_ORIGIN;
const secret = process.env.CLOUDFLARE_WEBHOOK_SECRET;
if (!secret || secret.length < 32)
  throw new Error('Provide local CLOUDFLARE_WEBHOOK_SECRET (>=32 chars) in the process environment');
if (!origin) throw new Error('Set ERROR_AUTOMATION_ORIGIN to an exact HTTPS Worker origin');
const url = new URL(origin);
if (
  url.protocol !== 'https:' ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash ||
  url.port
)
  throw new Error('Smoke origin must be an exact HTTPS origin');
url.pathname = '/webhooks/cloudflare';
const text =
  'Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly.';
const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'cf-webhook-auth': secret },
  body: JSON.stringify({ text }),
  redirect: 'error',
  signal: AbortSignal.timeout(15000),
});
await response.body?.cancel();
if (response.status !== 204) throw new Error(`Authenticated provisioning probe failed: ${response.status}`);
console.log('Authenticated no-dispatch provisioning probe: 204');
