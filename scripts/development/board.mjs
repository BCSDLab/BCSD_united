#!/usr/bin/env node
// 기능 하나의 기획(Notion)·디자인(Figma)·구현(GitHub)·QA(Notion) 상태를 한 문서로 모은다.
// - collect: 기능 목록을 읽어 각 출처를 조회하고 sources.json을 쓴다. 읽기 전용이다.
//   GitHub은 `gh`의 로그인 권한, Notion은 NOTION_TOKEN(내부 통합), Figma는 FIGMA_TOKEN을 쓴다.
//   토큰이 없는 출처는 건너뛰고 "수집 안 됨"으로 남긴다. 빈 결과와 구분한다.
// - render: sources.json을 Markdown 보드로 바꾼다. 네트워크를 쓰지 않는다.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const GH = process.platform === 'win32' ? 'gh.exe' : 'gh';
const NOTION_VERSION = '2022-06-28';
const PLATFORMS = { web: '웹', android: 'Android', ios: 'iOS', api: '서버' };
const usage = `Feature board
  collect FEATURES.json SOURCES.json
  render  SOURCES.json BOARD.md`;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateFeatures(features) {
  requireValue(Array.isArray(features) && features.length > 0, 'features must be a nonempty array');
  for (const feature of features) {
    requireValue(typeof feature.id === 'string' && /^[a-z0-9-]+$/.test(feature.id), 'feature.id must be kebab-case');
    requireValue(typeof feature.name === 'string' && feature.name, `${feature.id}: name is required`);
    requireValue(
      Array.isArray(feature.keywords) &&
        feature.keywords.length > 0 &&
        feature.keywords.every((k) => /^[^"\s]+$/.test(k)),
      `${feature.id}: keywords must be nonempty words without spaces or quotes`,
    );
    requireValue(
      feature.repos && Object.keys(feature.repos).length > 0 && Object.keys(feature.repos).every((p) => p in PLATFORMS),
      `${feature.id}: repos must map web/android/ios/api to OWNER/REPO`,
    );
  }
  return features;
}

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile(GH, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh failed: ${stderr.trim() || error.message}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

export function githubItem(item) {
  const pr = item.pull_request;
  const state = !pr
    ? `issue-${item.state}`
    : pr.merged_at
      ? 'pr-merged'
      : item.state === 'closed'
        ? 'pr-closed'
        : item.draft
          ? 'pr-draft'
          : 'pr-open';
  return {
    number: item.number,
    title: item.title,
    state,
    author: item.user?.login,
    updated: item.updated_at,
    url: item.html_url,
  };
}

async function collectGithub(feature, since) {
  const result = {};
  for (const [platform, repository] of Object.entries(feature.repos)) {
    const terms = feature.keywords.map((keyword) => `"${keyword}"`).join(' OR ');
    const response = await gh([
      'api',
      '-X',
      'GET',
      'search/issues',
      '-f',
      `q=repo:${repository} ${terms} in:title updated:>=${since}`,
      '-f',
      'per_page=100',
    ]);
    result[platform] = { repository, items: response.items.map(githubItem) };
  }
  return result;
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  requireValue(response.ok, `${new URL(url).hostname} returned ${response.status}`);
  return response.json();
}

function plain(richText) {
  return (richText ?? []).map((part) => part.plain_text).join('');
}

export function notionRow(page) {
  const properties = Object.values(page.properties ?? {});
  const status = properties.find((p) => p.type === 'status') ?? properties.find((p) => p.type === 'select');
  return {
    title: plain(properties.find((p) => p.type === 'title')?.title),
    status: status?.[status.type]?.name ?? null,
    updated: page.last_edited_time,
    url: page.url,
  };
}

async function collectNotion(feature, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
  const pages = [];
  for (const { id, role } of feature.notion?.pages ?? []) {
    const page = await getJson(`https://api.notion.com/v1/pages/${id}`, { headers });
    pages.push({ role, ...notionRow(page) });
  }
  const databases = [];
  for (const { id, role } of feature.notion?.databases ?? []) {
    const rows = [];
    let cursor;
    do {
      const body = JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      const page = await getJson(`https://api.notion.com/v1/databases/${id}/query`, { method: 'POST', headers, body });
      rows.push(...page.results.map(notionRow));
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    databases.push({ role, url: `https://www.notion.so/${id.replaceAll('-', '')}`, rows });
  }
  return { pages, databases };
}

export function figmaReference(url) {
  const parsed = new URL(url);
  const [, kind, key] = parsed.pathname.split('/');
  requireValue(
    parsed.hostname.endsWith('figma.com') && ['design', 'file'].includes(kind) && key,
    `Not a Figma file URL: ${url}`,
  );
  return { key, nodeId: parsed.searchParams.get('node-id')?.replace('-', ':') ?? null };
}

async function collectFigma(feature, token) {
  const frames = [];
  for (const { url, role } of feature.figma ?? []) {
    const { key } = figmaReference(url);
    const file = await getJson(`https://api.figma.com/v1/files/${key}?depth=1`, {
      headers: { 'X-Figma-Token': token },
    });
    frames.push({ role, url, file: file.name, version: file.version, updated: file.lastModified });
  }
  return frames;
}

export async function collect(features, env = process.env, now = new Date()) {
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const sources = { collectedAt: now.toISOString(), since, features: [] };
  for (const feature of validateFeatures(features)) {
    sources.features.push({
      id: feature.id,
      name: feature.name,
      github: await collectGithub(feature, since),
      notion: env.NOTION_TOKEN ? await collectNotion(feature, env.NOTION_TOKEN) : null,
      figma: env.FIGMA_TOKEN
        ? await collectFigma(feature, env.FIGMA_TOKEN)
        : (feature.figma ?? []).map(({ url, role }) => ({ role, url })),
    });
  }
  return sources;
}

/** 출처를 건너뛴 것(null)과 조회했지만 비어 있는 것을 구분해 빠진 연결을 찾는다. */
export function gaps(feature) {
  const found = [];
  for (const [platform, { items }] of Object.entries(feature.github)) {
    const open = items.filter((item) => item.state === 'issue-open');
    const prs = items.filter((item) => item.state.startsWith('pr-'));
    if (items.length === 0) found.push(`${PLATFORMS[platform]}: 이슈·PR 없음`);
    else if (open.length > 0 && prs.length === 0)
      found.push(`${PLATFORMS[platform]}: 열린 이슈 ${open.length}건에 PR 없음`);
  }
  if (feature.notion === null) found.push('Notion: 수집 안 됨 (NOTION_TOKEN 없음)');
  else {
    if (!feature.notion.pages.some((page) => page.role === 'plan')) found.push('기획 문서 연결 없음');
    for (const database of feature.notion.databases.filter((d) => d.role === 'qa')) {
      const pending = database.rows.filter((row) => row.status !== '수정 완료');
      if (pending.length > 0)
        found.push(`QA 미완료 ${pending.length}건: ${pending.map((row) => row.title).join(', ')}`);
    }
    if (!feature.notion.databases.some((d) => d.role === 'qa')) found.push('QA 기록 연결 없음');
  }
  if (feature.figma.length === 0) found.push('Figma 프레임 연결 없음');
  return found;
}

const day = (value) => (value ? value.slice(0, 10) : '-');
const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const link = (label, url) => `[${cell(label)}](${url})`;

export function render(sources) {
  const lines = [
    `# KOIN 작업 보드`,
    '',
    `수집: ${sources.collectedAt.slice(0, 16)}Z · GitHub은 ${sources.since} 이후 갱신분`,
    '',
  ];
  for (const feature of sources.features) {
    lines.push(`## ${feature.name}`, '');
    const found = gaps(feature);
    lines.push(...(found.length ? ['빠진 연결:', '', ...found.map((gap) => `- ${gap}`)] : ['빠진 연결 없음']), '');
    lines.push('| 플랫폼 | 열린 이슈 | 열린 PR | 병합된 PR | 마지막 갱신 |', '| --- | --- | --- | --- | --- |');
    for (const [platform, { repository, items }] of Object.entries(feature.github)) {
      const list = (states) =>
        items
          .filter((item) => states.includes(item.state))
          .map((item) => link(`#${item.number}${item.state === 'pr-draft' ? ' (draft)' : ''}`, item.url))
          .join(' ') || '-';
      const last = items
        .map((item) => item.updated)
        .sort()
        .at(-1);
      lines.push(
        `| ${PLATFORMS[platform]} (${repository.split('/')[1]}) | ${list(['issue-open'])} | ${list(['pr-open', 'pr-draft'])} | ${list(['pr-merged'])} | ${day(last)} |`,
      );
    }
    lines.push('');
    if (feature.notion) {
      for (const page of feature.notion.pages) {
        lines.push(`- ${page.role}: ${link(page.title || '(제목 없음)', page.url)} · ${day(page.updated)}`);
      }
      for (const database of feature.notion.databases) {
        const counts = Object.entries(Object.groupBy(database.rows, (row) => row.status ?? '상태 없음'))
          .map(([status, rows]) => `${status} ${rows.length}`)
          .join(', ');
        const last = database.rows
          .map((row) => row.updated)
          .sort()
          .at(-1);
        lines.push(
          `- ${database.role}: ${link(`${database.rows.length}건`, database.url)}${counts ? ` (${counts})` : ''} · ${day(last)}`,
        );
      }
    }
    for (const frame of feature.figma) {
      const version = frame.version
        ? ` · 파일 버전 ${frame.version} · ${day(frame.updated)}`
        : ' · 버전 수집 안 됨 (FIGMA_TOKEN 없음)';
      lines.push(`- figma ${frame.role}: ${link(frame.file ?? 'Figma', frame.url)}${version}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main([command, input, output]) {
  requireValue(['collect', 'render'].includes(command) && input && output, usage);
  const data = JSON.parse(await readFile(input, 'utf8'));
  const result = command === 'collect' ? `${JSON.stringify(await collect(data), null, 2)}\n` : render(data);
  await writeFile(output, result);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
