import { setTimeout as delay } from 'node:timers/promises';

/** Network/load events can finish before React renders; an empty document is not application evidence. */
export async function waitForRenderedApplication(read, { attempts = 60, intervalMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await read();
    const value = snapshot?.result?.value;
    if (snapshot?.exceptionDetails || (value?.elements >= 3 && typeof value.text === 'string' && value.text.trim()))
      return snapshot;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  throw new Error('Browser application render timed out');
}
