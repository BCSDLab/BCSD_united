import type { Hono } from 'hono';
import type { ApiEnv } from '@api/runtime';
import { registerAcademicCatalog } from '@api/domains/academic/catalog';
import { registerGraduation } from '@api/domains/academic/graduation';
import { registerTimetable } from '@api/domains/academic/timetable';

export function registerAcademic(app: Hono<ApiEnv>): void {
  registerTimetable(app);
  registerAcademicCatalog(app);
  registerGraduation(app);
}
