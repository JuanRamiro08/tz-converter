// SPDX-License-Identifier: GPL-2.0-or-later
// gjs -m tz.test.js
import System from 'system';
import * as tz from './tz.js';

let failed = 0;
let passed = 0;
function eq(name, got, want) {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) {
        passed++;
    } else {
        failed++;
        print(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
    }
}

// The screenshot case: Mon 16 Nov 2026 17:00 in Monterrey is 23:00 UTC.
const t = tz.instantAt('America/Monterrey', 2026, 11, 16, 17, 0);
const utc = tz.partsAt(t, 'UTC');
eq('monterrey→utc', [utc.d, utc.h, utc.mi], [16, 23, 0]);
const seoul = tz.partsAt(t, 'Asia/Seoul');
eq('monterrey→seoul next day', [seoul.dow, seoul.d, seoul.h], [2, 17, 8]);
eq('seoul day diff', tz.dayDiff(tz.partsAt(t, 'America/Monterrey'), seoul), 1);
eq('relative', tz.fmtRelative(utc.offset - tz.partsAt(t, 'America/Monterrey').offset), '+6h');
eq('half-hour zone', tz.fmtUtcOffset(tz.partsAt(t, 'Asia/Kolkata').offset), 'UTC+5:30');
eq('negative offset', tz.fmtUtcOffset(-6 * 3600), 'UTC−6');
eq('abbr kept', tz.realAbbr('CST'), 'CST');
eq('numeric abbr dropped', tz.realAbbr('+07'), null);

// DST: New York springs forward 8 Mar 2026; the same wall time a day later
// is 23 h of real time away, and the gap time 02:30 lands at 03:00.
const ny1 = tz.instantAt('America/New_York', 2026, 3, 7, 12, 0);
const ny2 = tz.shiftDays(ny1, 'America/New_York', 1);
eq('shift keeps wall time across DST', tz.fmtTime(tz.partsAt(ny2, 'America/New_York'), false), '12:00');
eq('DST day is 23h', (ny2 - ny1) / 3600, 23);
const gap = tz.partsAt(tz.instantAt('America/New_York', 2026, 3, 8, 2, 30), 'America/New_York');
eq('gap moves forward', [gap.h, gap.mi], [3, 0]);

// Day overflow rolls over months and years.
const nye = tz.partsAt(tz.instantAt('UTC', 2026, 12, 32, 9, 0), 'UTC');
eq('overflow', [nye.y, nye.mo, nye.d], [2027, 1, 1]);
const back = tz.partsAt(tz.instantAt('UTC', 2026, 3, 0, 9, 0), 'UTC');
eq('underflow', [back.mo, back.d], [2, 28]);

eq('fmt 12h pm', tz.fmtTime({h: 17, mi: 5}, true), '5:05 pm');
eq('fmt 12h midnight', tz.fmtTime({h: 0, mi: 0}, true), '12:00 am');
eq('fmt date', tz.fmtDate(tz.partsAt(t, 'America/Monterrey')), 'Mon 16 Nov 2026');

// parseTime
eq('t 17', tz.parseTime('17'), {h: 17, mi: 0});
eq('t 17:30', tz.parseTime('17:30'), {h: 17, mi: 30});
eq('t 1730', tz.parseTime('1730'), {h: 17, mi: 30});
eq('t 5pm', tz.parseTime('5pm'), {h: 17, mi: 0});
eq('t 5:30 PM', tz.parseTime('5:30 PM'), {h: 17, mi: 30});
eq('t 12am', tz.parseTime('12am'), {h: 0, mi: 0});
eq('t 12pm', tz.parseTime('12pm'), {h: 12, mi: 0});
eq('t 9.15', tz.parseTime('9.15'), {h: 9, mi: 15});
eq('t 24', tz.parseTime('24'), {h: 0, mi: 0});
eq('t noon', tz.parseTime('noon'), {h: 12, mi: 0});
eq('t bad 25', tz.parseTime('25'), null);
eq('t bad 13pm', tz.parseTime('13pm'), null);
eq('t bad 9:75', tz.parseTime('9:75'), null);
eq('t bad text', tz.parseTime('soon'), null);

// parseDate (base = the date being shown)
const base = {...tz.partsAt(t, 'America/Monterrey'), zone: 'America/Monterrey'};
eq('d iso', tz.parseDate('2026-11-20', base), {y: 2026, mo: 11, d: 20});
eq('d slash dmy', tz.parseDate('20/11/2026', base), {y: 2026, mo: 11, d: 20});
eq('d slash dm', tz.parseDate('3/12', base), {y: 2026, mo: 12, d: 3});
eq('d 2-digit year', tz.parseDate('3/12/27', base), {y: 2027, mo: 12, d: 3});
eq('d "20 nov"', tz.parseDate('20 nov', base), {y: 2026, mo: 11, d: 20});
eq('d "nov 20"', tz.parseDate('Nov 20', base), {y: 2026, mo: 11, d: 20});
eq('d "Fri 20 Nov 2026"', tz.parseDate('Fri 20 Nov 2026', base), {y: 2026, mo: 11, d: 20});
eq('d "5 de enero"', tz.parseDate('5 de enero', base), {y: 2026, mo: 1, d: 5});
eq('d "dic 24"', tz.parseDate('dic 24', base), {y: 2026, mo: 12, d: 24});
eq('d +3', tz.parseDate('+3', base), {days: 3});
eq('d -1', tz.parseDate('-1', base), {days: -1});
eq('d bad 31/2', tz.parseDate('31/2', base), null);
eq('d bad words', tz.parseDate('someday', base), null);

// hour kinds and the meeting strip
eq('kinds', [3, 7, 9, 17, 18, 21, 22].map(tz.hourKind), [0, 1, 2, 2, 1, 1, 0]);
const strip = tz.dayStrip(t, 'America/Monterrey', ['America/Monterrey', 'UTC']);
eq('strip length', strip.length, 24);
// 09:00 Monterrey = 15:00 UTC: both working. 13:00 = 19:00 UTC: UTC just awake.
eq('strip 9h', strip[9], tz.WORK);
eq('strip 13h', strip[13], tz.AWAKE);
eq('strip 17h', strip[17], tz.NIGHT);

// city search
const places = tz.loadPlaces();
eq('places loaded', places.length > 300, true);
const first = q => tz.searchPlaces(places, q)[0];
eq('search monterrey', first('monter').zone, 'America/Monterrey');
eq('search seoul', first('seoul').zone, 'Asia/Seoul');
eq('search accent-insensitive', first('queretaro').zone, 'America/Mexico_City');
eq('search alias', first('guadalajara').zone, 'America/Mexico_City');
eq('search country', tz.searchPlaces(places, 'thailand').some(p => p.zone === 'Asia/Bangkok'), true);
eq('search utc', first('utc').zone, 'UTC');
eq('search raw iana', first('Etc/GMT+5').zone, 'Etc/GMT+5');
eq('search empty', tz.searchPlaces(places, '  '), []);

// persistence
eq('decode bare', tz.decodeCity('Asia/Seoul'), {zone: 'Asia/Seoul', label: 'Seoul'});
eq('decode labelled', tz.decodeCity('America/Mexico_City|Guadalajara'), {zone: 'America/Mexico_City', label: 'Guadalajara'});
eq('encode default label', tz.encodeCity({zone: 'Asia/Seoul', label: 'Seoul'}), 'Asia/Seoul');
eq('encode custom label', tz.encodeCity({zone: 'America/Mexico_City', label: 'Guadalajara'}), 'America/Mexico_City|Guadalajara');

eq('summary', tz.summary(t, [{zone: 'America/Monterrey', label: 'Monterrey'}, {zone: 'UTC', label: 'UTC'}], false),
    'Mon 16 Nov 2026  17:00  Monterrey (CST, UTC−6)\nMon 16 Nov 2026  23:00  UTC');

eq('zone valid', [tz.zoneValid('Asia/Bangkok'), tz.zoneValid('Nope/Nope'), tz.zoneValid('')], [true, false, false]);

print(`${passed} passed, ${failed} failed`);
if (failed)
    System.exit(1);
