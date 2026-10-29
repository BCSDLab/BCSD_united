import { ARRIVAL_MARKERS, BUS_TARGETS, SEMESTER_TYPES, type BusConversion } from './types';

const time = /^([01]\d|2[0-3]):[0-5]\d$/;
const period = /^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/;
const arrivalMarkers = new Set<string>(ARRIVAL_MARKERS);
export function normalizeTime(value: unknown): unknown {
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60);
    return String(Math.floor(minutes / 60) % 24).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  }
  if (typeof value !== 'string') return value;
  const m = value.trim().match(/^(\d{1,2})[:.]([0-5]\d)$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : value.trim();
}
export function validateConversion(input: unknown): BusConversion {
  const data = input as BusConversion;
  if (!data || !Array.isArray(data.payloads) || data.payloads.length === 0)
    throw new Error('payloads must be a non-empty array');
  const seen = new Set<string>();
  for (const payload of data.payloads) {
    if (!BUS_TARGETS.includes(payload?.target)) throw new Error('invalid target');
    if (!SEMESTER_TYPES.includes(payload.semester_type)) throw new Error('invalid semester_type');
    const expected = payload.target === 'commuting' ? 'commuting_bus_timetables' : 'shuttle_bus_timetables';
    if (
      !payload.body ||
      Object.keys(payload.body).length !== 1 ||
      !Array.isArray(payload.body[expected]) ||
      payload.body[expected].length === 0
    )
      throw new Error(`body must contain non-empty ${expected} only`);
    const key = `${payload.target}:${payload.semester_type}`;
    if (seen.has(key)) throw new Error('duplicate target and semester_type');
    seen.add(key);
    for (const route of payload.body[expected]) {
      if (![route.region, route.route_type, route.route_name].every((v) => typeof v === 'string' && v.trim()))
        throw new Error('route required field is empty');
      if (
        !Array.isArray(route.node_info) ||
        route.node_info.length === 0 ||
        route.node_info.some((n) => !n?.name?.trim())
      )
        throw new Error('node_info is invalid');
      if (!Array.isArray(route.route_info) || route.route_info.length === 0) throw new Error('route_info is invalid');
      for (const trip of route.route_info) {
        if (
          !trip?.name?.trim() ||
          !Array.isArray(trip.arrival_time) ||
          trip.arrival_time.length !== route.node_info.length
        )
          throw new Error('trip is invalid or arrival_time length differs');
        for (const value of trip.arrival_time)
          if (value !== null && !(typeof value === 'string' && (time.test(value) || arrivalMarkers.has(value))))
            throw new Error(`invalid arrival_time: ${String(value)}`);
      }
    }
  }
  const v = data.version_update;
  if (!v || v.type !== 'shuttle_bus_timetable' || !['정규학기', '계절학기', '방학기간'].includes(v.title))
    throw new Error('invalid version_update');
  const matched = v.content?.match(period);
  if (!matched || new Date(`${matched[1]}T00:00:00Z`) > new Date(`${matched[2]}T00:00:00Z`))
    throw new Error('invalid version_update period');
  if (!data.provenance || !Array.isArray(data.warnings)) throw new Error('provenance and warnings are required');
  return data;
}
