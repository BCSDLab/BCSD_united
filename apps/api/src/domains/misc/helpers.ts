import type { Context } from 'hono';
import { z } from 'zod';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';

export function parse<T>(validator: z.ZodType<T>, value: unknown): T {
  const result = validator.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      'INVALID_REQUEST_BODY',
      '잘못된 입력값이 포함되어 있습니다.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    );
  return result.data;
}
export function identifier(c: Context<ApiEnv>, name = 'id'): number {
  return parse(z.coerce.number().int(), c.req.param(name));
}
export function criteria(c: Context<ApiEnv>, total: number) {
  const requestedPage = parse(z.coerce.number().int(), c.req.query('page') ?? '1');
  const requestedLimit = parse(z.coerce.number().int(), c.req.query('limit') ?? '10');
  const limit = Math.min(50, Math.max(1, requestedLimit));
  const totalPage = Math.ceil(total / limit);
  const page = Math.min(Math.max(1, requestedPage), Math.max(1, totalPage));
  return { limit, offset: (page - 1) * limit, total_count: total, total_page: totalPage, current_page: page };
}
export const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
export const kstDate = (time = Date.now()) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
export function kstTimestamp(value: string | null) {
  if (!value) return null;
  return new Date(Date.parse(value.replace(' ', 'T') + 'Z') + 9 * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}
export const nullableText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .nullish()
    .transform((value) => value ?? null);
export function notFound(message: string): never {
  throw new ApiError(404, '', message);
}
