import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';
import { base64, hmac, IntegrationError, jsonResponse, request, required, retryAfter, retryableStatus } from '@api/integrations/http';

export interface EmailInput { to: string; subject: string; html: string }

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const RETRYABLE_EMAIL_CODES = ['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR', 'DELIVERY_ERROR'];

function notConfigured(message: string): ApiError {
  return new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', message);
}

export async function sendEmail(env: Bindings, input: EmailInput): Promise<void> {
  if (!env.EMAIL) throw notConfigured('Cloudflare EMAIL sending binding 설정이 필요합니다.');
  if (!EMAIL_PATTERN.test(input.to) || /[\r\n]/.test(input.subject)) {
    throw new ApiError(400, 'INVALID_EMAIL', '이메일 주소 또는 제목이 올바르지 않습니다.');
  }
  try {
    const result = await env.EMAIL.send({ ...input, from: env.EMAIL_FROM || 'no-reply@bcsdlab.com' });
    if (!result?.messageId) throw new IntegrationError('Cloudflare Email', 'INVALID_RESPONSE', null, true);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DELIVERY_ERROR';
    throw new IntegrationError('Cloudflare Email', code, null, RETRYABLE_EMAIL_CODES.includes(code));
  }
}

export async function naverSignature(secret: string, path: string, timestamp: string, accessKey: string): Promise<string> {
  return base64(new Uint8Array(await hmac(secret, `POST ${path}\n${timestamp}\n${accessKey}`)));
}

export async function sendSms(env: Bindings, input: { to: string; content: string }): Promise<void> {
  const serviceId = required(env.NAVER_SMS_SERVICE_ID, 'NAVER_SMS_SERVICE_ID');
  const from = required(env.NAVER_SMS_FROM, 'NAVER_SMS_FROM');
  const accessKey = required(env.NAVER_ACCESS_KEY, 'NAVER_ACCESS_KEY');
  const secretKey = required(env.NAVER_SECRET_KEY, 'NAVER_SECRET_KEY');
  if (!/^\d{8,15}$/.test(input.to) || !input.content.trim()) {
    throw new ApiError(400, 'INVALID_SMS_REQUEST', '문자 발송 정보가 올바르지 않습니다.');
  }
  if (!/^[A-Za-z0-9_:-]+$/.test(serviceId)) throw notConfigured('NAVER_SMS_SERVICE_ID 설정이 올바르지 않습니다.');
  const path = `/sms/v2/services/${serviceId}/messages`;
  const timestamp = String(Date.now());
  const response = await request('Naver SMS', `https://sens.apigw.ntruss.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ncp-apigw-timestamp': timestamp,
      'x-ncp-iam-access-key': accessKey,
      'x-ncp-apigw-signature-v2': await naverSignature(secretKey, path, timestamp, accessKey),
    },
    body: JSON.stringify({ type: 'SMS', from, contentType: 'COMM', content: input.content, messages: [{ to: input.to }] }),
  }, 5000);
  const result = await jsonResponse<{ statusCode?: string }>('Naver SMS', response);
  if (result.statusCode !== '202') throw new IntegrationError('Naver SMS', 'SMS_REJECTED', response.status, true);
}

function slackWebhookUrl(webhook: string): URL {
  const invalidWebhook = notConfigured('Slack webhook 설정이 올바르지 않습니다.');
  let url: URL;
  try {
    url = new URL(required(webhook, 'SLACK_WEBHOOK'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidWebhook;
  }
  const trusted = url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.pathname.startsWith('/services/');
  if (!trusted || url.username || url.password || url.search || url.hash) throw invalidWebhook;
  return url;
}

export async function sendSlack(_env: Bindings, input: { webhook: string; message: string }): Promise<void> {
  const url = slackWebhookUrl(input.webhook);
  const response = await request('Slack', url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: input.message, attachments: [{ color: 'good' }] }),
  }, 5000);
  if (!response.ok || (await response.text()).trim() !== 'ok') {
    throw new IntegrationError('Slack', `HTTP_${response.status}`, response.status, retryableStatus(response.status), retryAfter(response));
  }
}
