import { configuration, identityKey, validateIdentity } from './index';
import { trustedDiagnostics } from './diagnostics';
import { baseRepository, branch, existingPull, installationToken } from './github';
import type { Diagnostic, Env, Identity, PreparedJob } from './types';

export async function prepare(
  env: Env,
  identity: Identity,
  key: string,
): Promise<{ job: PreparedJob | null; prUrl: string | null }> {
  const config = configuration(env);
  const validated = validateIdentity(identity, config);
  if (identityKey(validated) !== key || JSON.stringify(validated) !== JSON.stringify(identity))
    throw new Error('Queued identity mismatch');
  if (
    `${config.owner}/${config.repository}`.toLowerCase() !== 'bcsdlab/bcsd_united' ||
    env.GITHUB_DISPATCH_APP_ID !== '5522353' ||
    env.GITHUB_DISPATCH_INSTALLATION_ID !== '176455083'
  )
    throw new Error('Unexpected GitHub App or repository');
  const domains = JSON.parse(env.ERROR_PROJECT_DOMAINS) as Record<string, string>;
  const domain = domains[`${identity.source}:${identity.project}`];
  if (!['캠퍼스', '비즈니스', '유저', '공통'].includes(domain)) throw new Error('Missing allowlisted project domain');
  const baseBranch = config.sourceBranches[`${identity.source}:${identity.project}`];
  const response = await env.ERROR_ISSUES.get(env.ERROR_ISSUES.idFromName(key)).fetch(
    'https://error-dispatch.internal/diagnostics',
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Stored authenticated diagnostic unavailable');
  }
  const stored = (await response.json()) as Diagnostic;
  if (stored.version !== 1 || JSON.stringify(stored.identity) !== JSON.stringify(identity))
    throw new Error('Persisted diagnostic identity mismatch');
  // No GitHub token before real provider route and source-frame evidence has passed trusted verification.
  const evidence = await trustedDiagnostics(env, identity, stored);
  const token = await installationToken(env, 'read');
  const base = await baseRepository(env, token, baseBranch);
  const proposedBranch = await branch(identity);
  const prior = await existingPull(env, token, { branch: proposedBranch });
  if (prior) return { job: null, prUrl: prior.html_url };
  return {
    prUrl: null,
    job: {
      identity,
      owner: config.owner,
      repository: config.repository,
      baseBranch: base.baseBranch,
      targetBranch: 'develop',
      baseSha: base.baseSha,
      branch: proposedBranch,
      domain,
      diagnostics: evidence.data,
      context: { app: identity.app, route: evidence.route, requestMethod: evidence.requestMethod },
    },
  };
}
