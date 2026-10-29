import type { Bindings } from '@api/runtime';
import { deleteFiles, publicFileUrl } from '@api/integrations/storage';
import { IntegrationError, jsonResponse, request, required } from '@api/integrations/http';

const PURGE_BATCH = 30;

/**
 * 퍼지에 보내는 URL은 키의 경로 세그먼트를 각각 URL 인코딩한 형태다.
 * `publicFileUrl`은 반환값을 쓰지 않고 키 형식과 `R2_FILES_PUBLIC_URL` 설정 검증(예외)만을 위해 호출한다.
 */
function purgeUrl(env: Bindings, key: string): string {
  publicFileUrl(env, key);
  const prefix = required(env.R2_FILES_PUBLIC_URL, 'R2_FILES_PUBLIC_URL').replace(/\/?$/, '/');
  return `${prefix}${key.split('/').map(encodeURIComponent).join('/')}`;
}

export async function purgeFiles(env: Bindings, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const zone = required(env.CLOUDFLARE_FILES_ZONE_ID, 'CLOUDFLARE_FILES_ZONE_ID');
  const token = required(env.CLOUDFLARE_CACHE_PURGE_TOKEN, 'CLOUDFLARE_CACHE_PURGE_TOKEN');
  const files = [...new Set(keys)].map((key) => purgeUrl(env, key));
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone)}/purge_cache`;
  for (let offset = 0; offset < files.length; offset += PURGE_BATCH) {
    const response = await request('Cloudflare Cache', endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files: files.slice(offset, offset + PURGE_BATCH) }),
    });
    const result = await jsonResponse<{ success?: boolean; errors?: { code?: number }[] }>(
      'Cloudflare Cache',
      response,
    );
    if (!result.success) {
      throw new IntegrationError(
        'Cloudflare Cache',
        String(result.errors?.[0]?.code ?? 'PURGE_FAILED'),
        response.status,
        true,
      );
    }
  }
}

/** 퍼지 설정이 없으면 삭제도 하지 않는다. 캐시에 남은 민감 파일이 계속 서빙되는 상태를 막기 위해서다. */
export async function deleteSensitiveFiles(env: Bindings, keys: string[]): Promise<void> {
  required(env.CLOUDFLARE_FILES_ZONE_ID, 'CLOUDFLARE_FILES_ZONE_ID');
  required(env.CLOUDFLARE_CACHE_PURGE_TOKEN, 'CLOUDFLARE_CACHE_PURGE_TOKEN');
  await deleteFiles(env, keys);
  await purgeFiles(env, keys);
}
