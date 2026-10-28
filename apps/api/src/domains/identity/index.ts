import type { Hono } from 'hono';
import { registerAdmins } from '@api/domains/identity/admins';
import { registerOwners } from '@api/domains/identity/owners';
import { registerStudents } from '@api/domains/identity/students';
import { registerUsers } from '@api/domains/identity/users';
import { registerVerification } from '@api/domains/identity/verification';
import { registerWebAuth } from '@api/domains/identity/web';
import type { ApiEnv } from '@api/runtime';

export { handleIdentityJob, runIdentityCron } from '@api/domains/identity/events';

export function registerIdentity(app: Hono<ApiEnv>): void {
  registerWebAuth(app);
  registerVerification(app);
  registerUsers(app);
  registerStudents(app);
  registerOwners(app);
  registerAdmins(app);
}
