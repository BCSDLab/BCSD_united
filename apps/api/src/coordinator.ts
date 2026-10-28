import { DurableObject } from 'cloudflare:workers';
import app from '@api/app';
import type { Bindings } from '@api/runtime';

export class Coordinator extends DurableObject<Bindings> {
  fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const response = await app.fetch(request, { ...this.env, SERIALIZED: true }, {
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        passThroughOnException: () => { throw new Error('Durable Objects do not support origin pass-through.'); },
      });
      return response;
    });
  }
}
