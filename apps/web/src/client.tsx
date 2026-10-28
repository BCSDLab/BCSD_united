import 'instrumentation-client';

import { startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';

import { captureException } from '@sentry/core';
import { StartClient } from '@tanstack/react-start/client';

if (typeof document !== 'undefined') {
  startTransition(() => {
    hydrateRoot(document, <StartClient />, {
      onRecoverableError: (error) => captureException(error),
      onUncaughtError: (error) => captureException(error),
    });
  });
}
