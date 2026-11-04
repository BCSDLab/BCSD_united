import { DurableObject } from 'cloudflare:workers';
import { apiDisabledResponse, isApiEnabled } from '@api/api-gate';
import app from '@api/app';
import type { Bindings } from '@api/runtime';

export class Coordinator extends DurableObject<Bindings> {
  fetch(request: Request): Promise<Response> {
    // 비활성: app 게이트와 동일하게 503. 직렬화 대기(blockConcurrencyWhile)조차 시작하지 않는다.
    if (!isApiEnabled(this.env)) return Promise.resolve(apiDisabledResponse());
    return this.ctx.blockConcurrencyWhile(async () => {
      const response = await app.fetch(
        request,
        { ...this.env, SERIALIZED: true },
        {
          props: this.ctx.props,
          waitUntil: (promise) => this.ctx.waitUntil(promise),
          passThroughOnException: () => {
            throw new Error('Durable Objects do not support origin pass-through.');
          },
        },
      );
      return response;
    });
  }
}
