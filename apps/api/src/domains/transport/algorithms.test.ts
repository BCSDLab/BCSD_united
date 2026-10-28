import assert from 'node:assert/strict';
import test from 'node:test';
import { utils, write } from 'xlsx';
import { addMinutes, cityOffset, expressCacheTimes, expressRouteTimes, mergePartial, runningDays, selectOccurrences, shuttleSchedule, time, type Shuttle } from '@api/domains/transport/algorithms';
import { parseCommutingWorkbook, parseShuttleWorkbook } from '@api/domains/transport/excel';
import { forecastKey, forecastRequest, mapForecast, weatherCondition } from '@api/domains/transport/weather';

const table: Shuttle = {
  id:'012345678901234567890123',semester_type:'정규학기',region:'CHEONAN_ASAN',route_type:'SHUTTLE',route_name:'천안 셔틀',sub_name:null,
  node_info:[{name:'터미널',detail:'승차장'},{name:'한기대',detail:null}],
  route_info:[{name:'1회',detail:'등교',running_days:['SAT'],arrival_time:['14:25','도착']},{name:'2회',detail:null,running_days:['SAT'],arrival_time:['15:00','도착']}],
};

test('route selection retains repeated stop occurrences and stops at terminal markers', () => {
  const names = ['한기대','터미널','천안역','한기대','터미널','한기대'];
  const times = ['14:00','14:25','14:30','15:00','15:25','종점'];
  assert.deepEqual(selectOccurrences(names,times,'SHUTTLE',null,'TERMINAL','KOREATECH'),[
    {departureIndex:1,arrivalIndex:3,departureTime:'14:25'},
    {departureIndex:4,arrivalIndex:5,departureTime:'15:25'},
  ]);
  assert.equal(times[0],'14:00');
  assert.deepEqual(selectOccurrences(['터미널','천안역','한기대'],['14:00','종점','14:30'],'SHUTTLE',null,'TERMINAL','KOREATECH'),[]);
});

test('invalid times, mismatched arrays and same station are excluded', () => {
  for (const value of [null,'정차','24:00','9:00','09:60']) assert.deepEqual(selectOccurrences(['터미널','한기대'],[value,'도착'],'SHUTTLE',null,'TERMINAL','KOREATECH'),[]);
  assert.deepEqual(selectOccurrences(['터미널','한기대'],['09:00'],'SHUTTLE',null,'TERMINAL','KOREATECH'),[]);
  assert.deepEqual(selectOccurrences(['한기대','한기대'],['09:00','10:00'],'SHUTTLE',null,'KOREATECH','KOREATECH'),[]);
  assert.deepEqual(selectOccurrences(['터미널','한기대'],['09:00','09:00'],'SHUTTLE',null,'TERMINAL','KOREATECH'),[]);
});

test('weekday direction reverses only a timed campus endpoint and recognizes station A/B', () => {
  assert.deepEqual(selectOccurrences(['천안역A','한기대'],['09:30','09:00'],'WEEKDAYS','하교','KOREATECH','STATION'),[{departureIndex:1,arrivalIndex:0,departureTime:'09:00'}]);
  assert.deepEqual(selectOccurrences(['한기대','천안역B'],['09:30','09:00'],'WEEKDAYS','등교','STATION','KOREATECH'),[{departureIndex:1,arrivalIndex:0,departureTime:'09:00'}]);
  assert.deepEqual(selectOccurrences(['천안역','한기대'],['09:30','09:00'],'WEEKEND','하교','KOREATECH','STATION'),[]);
});

test('shuttle date filtering uses requested weekday without timezone-dependent conversion', () => {
  assert.equal(shuttleSchedule([table],'2026-09-05','TERMINAL','KOREATECH').length,2);
  assert.equal(shuttleSchedule([table],'2026-09-06','TERMINAL','KOREATECH').length,0);
  assert.equal(shuttleSchedule([{...table,route_name:'미운행'}],'2026-09-05','TERMINAL','KOREATECH').length,0);
  assert.equal(shuttleSchedule([{...table,region:'SEOUL'}],'2026-09-05','TERMINAL','KOREATECH').length,0);
});

test('city offsets preserve source origin-specific minute additions and midnight wrapping', () => {
  assert.equal(cityOffset(400,'KOREATECH'),6);
  assert.equal(cityOffset(402,'KOREATECH'),13);
  assert.equal(cityOffset(405,'KOREATECH'),7);
  assert.equal(cityOffset(400,'STATION'),7);
  assert.equal(cityOffset(400,'TERMINAL'),0);
  assert.equal(time(1435+13),'00:08');
});

test('express route and legacy cache schedules deliberately remain distinct source schedules', () => {
  assert.ok(expressCacheTimes.KOREATECH.includes('09:35'));
  assert.ok(!expressRouteTimes.KOREATECH.includes('09:35'));
  assert.ok(expressRouteTimes.TERMINAL.includes('12:30'));
  assert.ok(!expressCacheTimes.TERMINAL.includes('12:30'));
});

test('partial update preserves omitted runs, details and running days without mutating input', () => {
  const merged = mergePartial(table,[{name:'터미널',detail:null},{name:'한기대',detail:null}],[{name:'1회',detail:null,running_days:[],arrival_time:['16:00','도착']}]);
  assert.equal(merged.node_info[0]!.detail,'승차장');
  assert.equal(merged.route_info[0]!.detail,'등교');
  assert.deepEqual(merged.route_info[0]!.running_days,['SAT']);
  assert.deepEqual(merged.route_info[1],table.route_info[1]);
  assert.equal(table.route_info[0]!.arrival_time[0],'14:25');
  assert.throws(() => mergePartial(table,[...table.node_info].reverse(),[table.route_info[0]!]));
  assert.throws(() => mergePartial(table,table.node_info,[{...table.route_info[0]!,name:'3회'}]));
});

test('duplicate run names must be matched by occurrence in full', () => {
  const duplicate = {...table,route_info:table.route_info.map(r => ({...r,name:'1회'}))};
  assert.throws(() => mergePartial(duplicate,table.node_info,[duplicate.route_info[0]!]));
  const merged = mergePartial(duplicate,table.node_info,duplicate.route_info.map((r,i) => ({...r,arrival_time:[`1${i}:00`,'도착']})));
  assert.deepEqual(merged.route_info.map(r => r.arrival_time[0]),['10:00','11:00']);
});

test('running day labels handle Thursday Friday combined tokens and reject conflicting explicit days', () => {
  assert.deepEqual(runningDays('1회','목・금 추가'),['THU','FRI']);
  assert.deepEqual(runningDays('금요일','추가'),['FRI']);
  assert.deepEqual(runningDays('1회',null),['MON','TUE','WED','THU','FRI']);
  assert.throws(() => runningDays('토요일','목금추가'));
  assert.throws(() => runningDays('토요일','일요일'));
});

test('weather publication lag and day rollover keep forecast hour unchanged', () => {
  let request = forecastRequest(Date.parse('2024-01-14T17:05:00Z'));
  assert.equal(forecastKey(request.base),'202401142300');
  assert.equal(forecastKey(request.forecast),'202401150200');
  request = forecastRequest(Date.parse('2024-01-14T15:05:00Z'));
  assert.equal(forecastKey(request.base),'202401142300');
  assert.equal(forecastKey(request.forecast),'202401150000');
  request = forecastRequest(Date.parse('2024-01-14T17:10:00Z'));
  assert.equal(forecastKey(request.base),'202401150200');
});

test('weather maps 24 rolling hours, precipitation priority and last duplicate value', () => {
  const start = new Date('2024-01-15T23:00:00Z');
  const items = ['202401152300','202401160000','202401162300'].flatMap(key => ['TMP','SKY','PTY'].map((category,i) => ({fcstDate:key.slice(0,8),fcstTime:key.slice(8),category,fcstValue:['21','1','0'][i]!})));
  items.push({fcstDate:'20240115',fcstTime:'2300',category:'TMP',fcstValue:'-2'});
  const map = mapForecast(items,start);
  assert.equal(map['202401152300']!.temperature,-2);
  assert.ok(map['202401160000']);
  assert.equal(map['202401162300'],undefined);
  assert.equal(weatherCondition(10,'1','3').weather,'눈');
  assert.equal(weatherCondition(10,'unknown','0').weather,'흐림');
  assert.equal(weatherCondition(10,'1','unknown').weather,'비');
  assert.throws(() => mapForecast([],start));
});

function workbookBytes(rows: (string | number | null)[][], name: string, kind: 'xlsx' | 'xls' = 'xlsx') {
  const book = utils.book_new(); utils.book_append_sheet(book,utils.aoa_to_sheet(rows),name);
  return new Uint8Array(write(book,{bookType:kind,type:'array'}));
}

test('shuttle Excel preview supports xlsx and BIFF xls while retaining null stops and parsed names', () => {
  const rows = [['region','CHEONAN_ASAN'],['type','SHUTTLE'],[],['정거장','1회'],['설명','토요일'],['터미널(승차장)','09:00'],['천안역',null],['한기대','도착']];
  for (const kind of ['xlsx','xls'] as const) {
    const result = parseShuttleWorkbook(workbookBytes(rows,'천안 셔틀(토요일)',kind)).shuttle_bus_timetables[0]!;
    assert.equal(result.route_name,'천안 셔틀'); assert.equal(result.sub_name,'토요일');
    assert.equal(result.node_info[0]!.detail,'승차장');
    assert.deepEqual(result.route_info[0]!.arrival_time,['09:00',null,'도착']);
    assert.deepEqual(result.route_info[0]!.running_days,['SAT']);
  }
});

test('shuttle Excel rejects interior gaps and unheaded data rather than silently dropping them', () => {
  assert.throws(() => parseShuttleWorkbook(workbookBytes([['region','CHEONAN_ASAN'],['type','SHUTTLE'],[],['정거장','1회',null,'2회'],['설명'],['한기대','09:00']], '시간표')));
  assert.throws(() => parseShuttleWorkbook(workbookBytes([['region','CHEONAN_ASAN'],['type','SHUTTLE'],[],['정거장','1회'],['설명'],['한기대','09:00'],[],['터미널','10:00']], '시간표')));
});

test('commuting Excel reverses south rows and includes hidden sheets as source does', () => {
  const rows = [['direction','SOUTH'],['region','CHEONAN_ASAN'],['type','WEEKDAYS'],['name','천안'],['sub',null],['정거장','등교','하교'],['터미널','09:00','18:00'],['대학(본교)','09:30','17:30']];
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook,utils.aoa_to_sheet(rows),'통학');
  workbook.Workbook = {Sheets:[{name:'통학',Hidden:1}]};
  const result = parseCommutingWorkbook(new Uint8Array(write(workbook,{type:'array',bookType:'xlsx'}))).commuting_bus_timetables[0]!;
  assert.deepEqual(result.node_info.map(n => n.name),['대학','터미널']);
  assert.equal(result.route_info.length,1);
  assert.equal(result.route_info[0]!.name,'하교');
  assert.deepEqual(result.route_info[0]!.arrival_time,['17:30','18:00']);
});

test('city offsets preserve seconds and fractional seconds across midnight', () => {
  assert.equal(addMinutes('23:59:30',6),'00:05:30');
  assert.equal(addMinutes('23:59:30.125',6),'00:05:30.125');
  assert.equal(addMinutes('23:59:00',6),'00:05');
});

test('shuttle preview excludes hidden sheets and rejects text masquerading as a spreadsheet', () => {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook,utils.aoa_to_sheet([['unrelated']]),'hidden');
  workbook.Workbook = {Sheets:[{name:'hidden',Hidden:1}]};
  assert.throws(() => parseShuttleWorkbook(new Uint8Array(write(workbook,{type:'array',bookType:'xlsx'}))));
  assert.throws(() => parseShuttleWorkbook(new TextEncoder().encode('region,CHEONAN_ASAN')));
});
