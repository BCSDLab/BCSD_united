import { sql, type SQL } from 'drizzle-orm';
import { createDatabase, executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import {
  kstTimestamp, legacyError, selectAssignmentVariable, validateExperimentUpdate, validateVariables,
  type ExperimentRequest, type ExperimentVariable,
} from '@api/domains/experiments/algorithms';
import type { DeviceMetadata } from '@api/domains/experiments/user-agent';
import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';

type Experiment = typeof schema.abtest.$inferSelect;
interface AccessHistory {
  id: number;
  device_id: number | null;
  user_id: number | null;
  model: string | null;
  type: string | null;
}
interface Assignment extends ExperimentVariable { mapping_id: number; abtest_id: number }
const assignmentTtl = 3 * 24 * 60 * 60 * 1000;
const databaseNow = sql`strftime('%Y-%m-%d %H:%M:%f', 'now')`;

export async function getExperiment(db: Database, identifier: number | string): Promise<Experiment> {
  const filter = typeof identifier === 'number' ? sql`id = ${identifier}` : sql`title = ${identifier}`;
  const row = await db.get<Experiment>(sql`SELECT * FROM ${schema.abtest} WHERE ${filter}`);
  if (!row) throw legacyError(404, '존재하지 않는 Abtest입니다.', typeof identifier === 'number' ? `AbtestId: ${identifier}` : `Abtest Title: ${identifier}`);
  return row;
}

export async function getVariables(db: Database, experimentId: number): Promise<ExperimentVariable[]> {
  return db.all<ExperimentVariable>(sql`SELECT id, name, display_name, rate, count FROM ${schema.abtest_variable} WHERE abtest_id = ${experimentId} ORDER BY id`);
}

function inProgress(experiment: Experiment): void {
  if (experiment.status !== 'IN_PROGRESS') throw legacyError(400, '진행중이지 않은 AB테스트입니다.', `abtestId: ${experiment.id}`);
}

function findVariable(experiment: Experiment, variables: readonly ExperimentVariable[], name: string): ExperimentVariable {
  const variable = variables.find((entry) => entry.name === name);
  if (!variable) throw legacyError(400, '요청된 AB테스트 내에 실험군이 존재하지 않습니다.', `abtest name: ${experiment.title}, winner name: ${name}`);
  return variable;
}

export async function experimentResponse(db: Database, experiment: Experiment, detailed = true) {
  const variables = detailed ? await getVariables(db, experiment.id) : [];
  const winner = detailed ? variables.find((variable) => variable.id === experiment.winner_id)
    : experiment.winner_id === null ? undefined : await db.get<{ name: string }>(
      sql`SELECT name FROM ${schema.abtest_variable} WHERE id = ${experiment.winner_id}`,
    );
  const base = {
    id: experiment.id, status: experiment.status, winner_name: winner?.name ?? null,
    creator: experiment.creator, team: experiment.team, display_title: experiment.display_title,
    title: experiment.title, created_at: kstTimestamp(experiment.created_at), updated_at: kstTimestamp(experiment.updated_at),
  };
  return detailed ? { ...base, description: experiment.description,
    variables: variables.map(({ rate, display_name, name }) => ({ rate, display_name, name })) } : base;
}

export async function createExperiment(db: Database, request: ExperimentRequest) {
  const existing = await db.get<{ id: number }>(sql`SELECT id FROM ${schema.abtest} WHERE title = ${request.title}`);
  if (existing) throw legacyError(409, '이미 존재하는 AB테스트입니다.', `title: ${request.title}`);
  validateVariables(request.variables);
  const statements: SQL[] = [sql`INSERT INTO ${schema.abtest} (title, display_title, description, creator, team, status)
    VALUES (${request.title}, ${request.display_title}, ${request.description}, ${request.creator}, ${request.team}, 'IN_PROGRESS')`];
  for (const variable of request.variables) statements.push(sql`INSERT INTO ${schema.abtest_variable} (abtest_id, name, display_name, rate)
    SELECT id, ${variable.name}, ${variable.display_name}, ${variable.rate} FROM ${schema.abtest} WHERE title = ${request.title}`);
  await executeAtomic(db, statements);
  return experimentResponse(db, await getExperiment(db, request.title));
}

export async function updateExperiment(db: Database, id: number, request: ExperimentRequest) {
  const experiment = await getExperiment(db, id);
  inProgress(experiment);
  const variables = await getVariables(db, id);
  validateExperimentUpdate(experiment.title, variables, request);
  const statements: SQL[] = [sql`UPDATE ${schema.abtest} SET display_title = ${request.display_title},
    creator = ${request.creator}, team = ${request.team}, description = ${request.description}, updated_at = ${databaseNow}
    WHERE id = ${id} AND status = 'IN_PROGRESS'`];
  for (const variable of request.variables) statements.push(sql`UPDATE ${schema.abtest_variable}
    SET display_name = ${variable.display_name}, rate = ${variable.rate}, updated_at = ${databaseNow}
    WHERE abtest_id = ${id} AND name = ${variable.name}`);
  await executeAtomic(db, statements);
  return experimentResponse(db, await getExperiment(db, id));
}

function syncCountStatements(experimentId?: number): SQL[] {
  const variableFilter = experimentId === undefined ? sql`1 = 1` : sql`abtest_id = ${experimentId}`;
  const pendingFilter = experimentId === undefined ? sql`1 = 1`
    : sql`variable_id IN (SELECT id FROM ${schema.abtest_variable} WHERE abtest_id = ${experimentId})`;
  return [
    sql`UPDATE ${schema.abtest_variable} SET count = ((count + COALESCE(
      (SELECT count FROM ${schema.abtest_variable_count} WHERE variable_id = ${schema.abtest_variable.id}), 0) + 2147483648) & 4294967295) - 2147483648,
      updated_at = CASE WHEN COALESCE((SELECT count FROM ${schema.abtest_variable_count}
        WHERE variable_id = ${schema.abtest_variable.id}), 0) <> 0 THEN ${databaseNow} ELSE updated_at END
      WHERE ${variableFilter}`,
    sql`UPDATE ${schema.abtest_variable_count} SET count = 0 WHERE ${pendingFilter}`,
    sql`DELETE FROM ${schema.abtest_variable_count} WHERE variable_id NOT IN (SELECT id FROM ${schema.abtest_variable})`,
  ];
}

export async function closeExperiment(db: Database, id: number, winnerName: string): Promise<void> {
  const experiment = await getExperiment(db, id);
  inProgress(experiment);
  const winner = findVariable(experiment, await getVariables(db, id), winnerName);
  const ids = sql`SELECT id FROM ${schema.abtest_variable} WHERE abtest_id = ${id}`;
  await executeAtomic(db, [
    ...syncCountStatements(id),
    sql`UPDATE ${schema.abtest} SET status = 'CLOSED', winner_id = ${winner.id}, updated_at = ${databaseNow} WHERE id = ${id} AND status = 'IN_PROGRESS'`,
    sql`DELETE FROM ${schema.access_history_abtest_variable} WHERE variable_id IN (${ids})`,
    sql`DELETE FROM ${schema.abtest_variable_assign} WHERE variable_id IN (${ids})`,
    sql`DELETE FROM ${schema.abtest_variable_count} WHERE variable_id IN (${ids})`,
  ]);
}

export async function deleteExperiment(db: Database, id: number): Promise<void> {
  const ids = sql`SELECT id FROM ${schema.abtest_variable} WHERE abtest_id = ${id}`;
  await executeAtomic(db, [
    ...syncCountStatements(id),
    sql`UPDATE ${schema.abtest} SET winner_id = NULL WHERE id = ${id}`,
    sql`DELETE FROM ${schema.access_history_abtest_variable} WHERE variable_id IN (${ids})`,
    sql`DELETE FROM ${schema.abtest_variable_assign} WHERE variable_id IN (${ids})`,
    sql`DELETE FROM ${schema.abtest_variable_count} WHERE variable_id IN (${ids})`,
    sql`DELETE FROM ${schema.abtest_variable} WHERE abtest_id = ${id}`,
    sql`DELETE FROM ${schema.abtest} WHERE id = ${id}`,
  ]);
}

async function getHistory(db: Database, id: number, byDevice = false): Promise<AccessHistory> {
  const row = await db.get<AccessHistory>(sql`SELECT a.id, a.device_id, d.user_id, d.model, d.type
    FROM ${schema.access_history} a LEFT JOIN ${schema.device} d ON a.device_id = d.id
    WHERE ${byDevice ? sql`a.device_id = ${id}` : sql`a.id = ${id}`}`);
  if (!row) throw legacyError(404, '존재하지 않는 접속 이력입니다.', `${byDevice ? 'deviceId' : 'accessHistoryId'}: ${id}`);
  return row;
}

export async function requireExistingUser(db: Database, userId: number): Promise<void> {
  const user = await db.get<{ id: number }>(sql`SELECT id FROM ${schema.users} WHERE id = ${userId}`);
  if (!user) throw new ApiError(404, 'NOT_FOUND_USER', '사용자가 존재하지 않습니다.');
}

async function prepareDevice(
  db: Database, history: AccessHistory | null, userId: number | null, metadata: DeviceMetadata | null,
): Promise<SQL[]> {
  if (userId === null) return [];
  await requireExistingUser(db, userId);
  if (history?.device_id == null) {
    if (!metadata) throw new ApiError(500, 'INTERNAL_SERVER_ERROR', '서버에서 오류가 발생했습니다.');
    const statements = [sql`INSERT INTO ${schema.device} (user_id, model, type) VALUES (${userId}, ${metadata.model}, ${metadata.type})`];
    if (history) statements.push(sql`UPDATE ${schema.access_history} SET device_id = last_insert_rowid(), updated_at = ${databaseNow} WHERE id = ${history.id} AND device_id IS NULL`);
    return statements;
  }
  const statements: SQL[] = [];
  if (history.model === null || history.type === null) {
    if (!metadata) throw new ApiError(500, 'INTERNAL_SERVER_ERROR', '서버에서 오류가 발생했습니다.');
    statements.push(sql`UPDATE ${schema.device} SET model = ${metadata.model}, type = ${metadata.type}, updated_at = ${databaseNow} WHERE id = ${history.device_id}`);
  }
  if (history.user_id !== userId) statements.push(sql`UPDATE ${schema.device} SET user_id = ${userId}, updated_at = ${databaseNow} WHERE id = ${history.device_id}`);
  return statements;
}

function insertHistory(userId: number | null): SQL {
  return userId === null ? sql`INSERT INTO ${schema.access_history} DEFAULT VALUES`
    : sql`INSERT INTO ${schema.access_history} (device_id) VALUES (last_insert_rowid())`;
}

export async function issueAccessHistory(db: Database, userId: number | null, metadata: DeviceMetadata | null): Promise<number> {
  const results = await executeAtomic(db, [...await prepareDevice(db, null, userId, metadata), insertHistory(userId),
    sql`SELECT max(id) AS id FROM ${schema.access_history}`]);
  const row = results[results.length - 1]?.results[0];
  if (typeof row?.id !== 'number') throw new TypeError('Access history insert did not return an integer ID');
  return row.id;
}

function changePending(variableId: number, delta: number): SQL {
  return sql`INSERT INTO ${schema.abtest_variable_count} (variable_id, count) VALUES (${variableId}, ${delta})
    ON CONFLICT(variable_id) DO UPDATE SET count = ((count + excluded.count + 2147483648) & 4294967295) - 2147483648`;
}

function cacheAssignment(variableId: number, historyId: number | SQL, now: number): SQL {
  return sql`INSERT INTO ${schema.abtest_variable_assign} (variable_id, access_history_id, expires_at)
    VALUES (${variableId}, ${historyId}, ${now + assignmentTtl}) ON CONFLICT(variable_id, access_history_id)
    DO UPDATE SET expires_at = excluded.expires_at`;
}

export async function assignExperiment(
  db: Database, title: string, accessHistoryId: number | undefined,
  userId: number | null, metadata: DeviceMetadata | null, now = Date.now(),
) {
  const experiment = await getExperiment(db, title);
  const history = accessHistoryId === undefined ? null : await getHistory(db, accessHistoryId);
  const variables = await getVariables(db, experiment.id);
  if (experiment.status === 'CLOSED') {
    const winner = variables.find((variable) => variable.id === experiment.winner_id);
    if (!winner) throw legacyError(500, '종료되었으나 우승자가 결정되지 않은 AB테스트입니다.', `abtestId: ${experiment.id}`);
    // 종료 실험 조회는 로그인 상태와 무관하게 기기를 연결하지 않는다.
    const id = history?.id ?? await issueAccessHistory(db, null, null);
    return { variable_name: winner.name, access_history_id: id };
  }
  const mappings = history ? await db.all<Assignment>(sql`SELECT v.id, v.name, v.display_name, v.rate, v.count, v.abtest_id, m.id AS mapping_id
    FROM ${schema.access_history_abtest_variable} m JOIN ${schema.abtest_variable} v ON m.variable_id = v.id
    WHERE m.access_history_id = ${history.id} AND v.abtest_id = ${experiment.id} ORDER BY m.id`) : [];
  const changedUser = userId !== null && history?.device_id != null && history.user_id !== userId;
  const deviceStatements = await prepareDevice(db, history, userId, metadata);
  if (!changedUser && mappings.length && history) {
    const cached = await db.all<{ variable_id: number }>(sql`SELECT variable_id FROM ${schema.abtest_variable_assign}
      WHERE access_history_id = ${history.id} AND expires_at > ${now}`);
    const cachedIds = new Set(cached.map((entry) => entry.variable_id));
    const variable = variables.find((entry) => cachedIds.has(entry.id)) ?? mappings[0]!;
    const statements = [...syncCountStatements(experiment.id), ...deviceStatements];
    if (!cachedIds.has(variable.id)) statements.push(cacheAssignment(variable.id, history.id, now));
    await executeAtomic(db, statements);
    return { variable_name: variable.name, access_history_id: history.id };
  }
  const pending = await db.all<{ variable_id: number; count: number }>(sql`SELECT variable_id, count FROM ${schema.abtest_variable_count}
    WHERE variable_id IN (SELECT id FROM ${schema.abtest_variable} WHERE abtest_id = ${experiment.id})`);
  const variable = selectAssignmentVariable(variables, new Map(pending.map((row) => [row.variable_id, row.count])), title);
  const statements = [...deviceStatements];
  if (!history) statements.push(insertHistory(userId));
  // 새 이력은 같은 원자적 쓰기 묶음에서 마지막으로 생성한 이력이다.
  const historyId = history?.id ?? sql`(SELECT max(id) FROM ${schema.access_history})`;
  if (changedUser) {
    for (const previous of mappings) statements.push(
      sql`DELETE FROM ${schema.abtest_variable_assign} WHERE variable_id = ${previous.id} AND access_history_id = ${historyId}`,
      changePending(previous.id, -1),
    );
  }
  statements.push(
    sql`DELETE FROM ${schema.access_history_abtest_variable} WHERE access_history_id = ${historyId}
      AND variable_id IN (SELECT id FROM ${schema.abtest_variable} WHERE abtest_id = ${experiment.id})`,
    sql`INSERT INTO ${schema.access_history_abtest_variable} (access_history_id, variable_id) VALUES (${historyId}, ${variable.id})`,
    changePending(variable.id, 1), cacheAssignment(variable.id, historyId, now),
    sql`SELECT ${historyId} AS id`,
  );
  const results = await executeAtomic(db, statements);
  const row = results[results.length - 1]?.results[0];
  if (typeof row?.id !== 'number') throw new TypeError('Experiment assignment did not return an integer history ID');
  const id = row.id;
  return { variable_name: variable.name, access_history_id: id };
}

export async function moveExperiment(db: Database, experimentId: number, deviceId: number, name: string, now = Date.now()): Promise<void> {
  const experiment = await getExperiment(db, experimentId);
  inProgress(experiment);
  const history = await getHistory(db, deviceId, true);
  // 수동 편입은 접속 이력의 첫 배정을 교체하고 나머지 배정은 유지한다.
  const before = await db.get<Assignment>(sql`SELECT v.id, v.name, v.display_name, v.rate, v.count, v.abtest_id, m.id AS mapping_id
    FROM ${schema.access_history_abtest_variable} m JOIN ${schema.abtest_variable} v ON m.variable_id = v.id
    WHERE m.access_history_id = ${history.id} ORDER BY m.id LIMIT 1`);
  const after = findVariable(experiment, await getVariables(db, experimentId), name);
  if (before?.id === after.id) throw legacyError(409, '실험군이 중복됩니다.', `beforeVariable id: ${before.id}, afterVariable id: ${after.id}`);
  const statements: SQL[] = [];
  if (before) statements.push(
    sql`UPDATE ${schema.abtest_variable} SET count = ((count - 1 + 2147483648) & 4294967295) - 2147483648, updated_at = ${databaseNow} WHERE id = ${before.id}`,
    sql`DELETE FROM ${schema.access_history_abtest_variable} WHERE access_history_id = ${history.id} AND variable_id = ${before.id}`,
    sql`DELETE FROM ${schema.abtest_variable_assign} WHERE access_history_id = ${history.id} AND variable_id = ${before.id}`,
  );
  statements.push(
    sql`INSERT INTO ${schema.access_history_abtest_variable} (access_history_id, variable_id) VALUES (${history.id}, ${after.id})`,
    sql`UPDATE ${schema.abtest_variable} SET count = ((count + 1 + 2147483648) & 4294967295) - 2147483648, updated_at = ${databaseNow} WHERE id = ${after.id}`,
    cacheAssignment(after.id, history.id, now),
  );
  await executeAtomic(db, statements);
}

export async function runExperimentsCron(env: Bindings, scheduledTime: number): Promise<void> {
  if (new Date(scheduledTime).getUTCMinutes() !== 0) return;
  const db = createDatabase(env.DB);
  await executeAtomic(db, [...syncCountStatements(),
    sql`DELETE FROM ${schema.abtest_variable_assign} WHERE expires_at <= ${scheduledTime}`,
  ]);
}
