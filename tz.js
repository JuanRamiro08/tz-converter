// SPDX-License-Identifier: GPL-2.0-or-later
// Time zone math and parsing for the Time Zones extension.
//
// Nothing here touches St, Clutter or Shell, so the whole conversion layer is
// testable with plain gjs: `gjs -m tz.test.js`.
//
// An instant is a Unix timestamp in seconds. Every wall-clock view of it is
// computed through GLib.TimeZone, which reads the system tzdata, so DST rules
// are whatever Fedora ships and nothing is hardcoded.

import GLib from 'gi://GLib';

const ZONEINFO = '/usr/share/zoneinfo';

const _tzCache = new Map();

export function tzFor(zone) {
    let tz = _tzCache.get(zone);
    if (!tz) {
        tz = GLib.TimeZone.new_identifier(zone);
        if (!tz)
            return null;
        _tzCache.set(zone, tz);
    }
    return tz;
}

export function zoneValid(zone) {
    return typeof zone === 'string' && zone.length > 0 && tzFor(zone) !== null;
}

export function localZone() {
    return GLib.TimeZone.new_local().get_identifier() || 'UTC';
}

export function nowUnix() {
    return Math.floor(GLib.get_real_time() / 1e6);
}

/** Wall-clock parts of `unix` in `zone`. */
export function partsAt(unix, zone) {
    const dt = GLib.DateTime.new_from_unix_utc(unix).to_timezone(tzFor(zone));
    return {
        y: dt.get_year(),
        mo: dt.get_month(),
        d: dt.get_day_of_month(),
        h: dt.get_hour(),
        mi: dt.get_minute(),
        dow: dt.get_day_of_week(), // 1 = Monday … 7 = Sunday
        offset: Math.round(dt.get_utc_offset() / 1e6), // seconds east of UTC
        abbr: dt.format('%Z'),
    };
}

/**
 * The instant at a wall-clock time in `zone`. The day may overflow the month
 * (d = 32, d = 0) and it rolls over. A time that falls in a DST gap is moved
 * forward by GLib (02:30 on a spring-forward night becomes 03:00).
 */
export function instantAt(zone, y, mo, d, h, mi) {
    const first = GLib.DateTime.new(tzFor(zone), y, mo, 1, h, mi, 0);
    if (!first)
        return null;
    return first.add_days(d - 1).to_unix();
}

/** Same wall-clock time in `zone`, `days` calendar days later. */
export function shiftDays(unix, zone, days) {
    const p = partsAt(unix, zone);
    return instantAt(zone, p.y, p.mo, p.d + days, p.h, p.mi);
}

// ── formatting ──────────────────────────────────────────────────────────────

export const DOW = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = n => String(n).padStart(2, '0');

export function fmtTime(p, hour12) {
    if (!hour12)
        return `${pad(p.h)}:${pad(p.mi)}`;
    const h = p.h % 12 === 0 ? 12 : p.h % 12;
    return `${h}:${pad(p.mi)} ${p.h < 12 ? 'am' : 'pm'}`;
}

export function fmtDate(p) {
    return `${DOW[p.dow]} ${p.d} ${MON[p.mo]} ${p.y}`;
}

export function fmtIsoDate(p) {
    return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** "UTC−6", "UTC+5:30", "UTC". */
export function fmtUtcOffset(sec) {
    if (sec === 0)
        return 'UTC';
    return `UTC${fmtSigned(sec)}`;
}

function fmtSigned(sec) {
    const sign = sec < 0 ? '−' : '+';
    const a = Math.abs(sec);
    const h = Math.floor(a / 3600);
    const m = Math.floor((a % 3600) / 60);
    return m ? `${sign}${h}:${pad(m)}` : `${sign}${h}`;
}

/** How far `sec` (other − home offset) puts a city ahead or behind home. */
export function fmtRelative(sec) {
    if (sec === 0)
        return 'same time';
    return `${fmtSigned(sec)}h`;
}

/**
 * The abbreviation tzdata gives, unless it is only a numeric stand-in like
 * "+09" or "-03" (zones with no real abbreviation), in which case null.
 */
export function realAbbr(abbr) {
    return /^[+-]\d+$/.test(abbr) ? null : abbr;
}

/** Calendar-day difference between two parts objects (b − a). */
export function dayDiff(a, b) {
    const ja = GLib.Date.new_dmy(a.d, a.mo, a.y).get_julian();
    const jb = GLib.Date.new_dmy(b.d, b.mo, b.y).get_julian();
    return jb - ja;
}

// ── how civil an hour is ────────────────────────────────────────────────────

export const WORK = 2;
export const AWAKE = 1;
export const NIGHT = 0;

export function hourKind(h) {
    if (h >= 9 && h < 18)
        return WORK;
    if (h >= 7 && h < 22)
        return AWAKE;
    return NIGHT;
}

/**
 * For each hour of the home day, the worst kind across all zones: WORK when
 * every city is in office hours, NIGHT when anyone is asleep. Slot i starts at
 * home-local i:00, so a 23- or 25-hour DST day still maps onto 24 slots.
 */
export function dayStrip(unix, home, zones) {
    const p = partsAt(unix, home);
    const out = [];
    for (let i = 0; i < 24; i++) {
        const t = instantAt(home, p.y, p.mo, p.d, i, 0);
        let worst = WORK;
        for (const z of zones)
            worst = Math.min(worst, hourKind(partsAt(t, z).h));
        out.push(worst);
    }
    return out;
}

// ── parsing what gets typed into the popup ──────────────────────────────────

/**
 * "17", "17:30", "1730", "17.30", "5pm", "5:30 pm", "12am", "noon",
 * "midnight". Returns {h, mi} or null.
 */
export function parseTime(raw) {
    const s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
    if (s === 'noon' || s === 'mediodia' || s === 'mediodía')
        return {h: 12, mi: 0};
    if (s === 'midnight' || s === 'medianoche')
        return {h: 0, mi: 0};

    const m = s.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p|a\.m\.|p\.m\.)?$/);
    if (!m)
        return null;
    let h = Number(m[1]);
    const mi = m[2] === undefined ? 0 : Number(m[2]);
    const ap = m[3] ? m[3][0] : null;
    if (mi > 59)
        return null;
    if (ap) {
        if (h < 1 || h > 12)
            return null;
        h = (h % 12) + (ap === 'p' ? 12 : 0);
    } else if (h > 24 || (h === 24 && mi !== 0)) {
        return null;
    } else if (h === 24) {
        h = 0;
    }
    return {h, mi};
}

const MONTHS = {
    jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7,
    aug: 8, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dec: 12, dic: 12,
};

function monthOf(word) {
    return MONTHS[word.slice(0, 3)] ?? null;
}

function validDay(y, mo, d) {
    return mo >= 1 && mo <= 12 && d >= 1 &&
        d <= GLib.Date.get_days_in_month(mo, y);
}

/**
 * A date typed relative to `base` (parts of the date being shown):
 * "2026-11-20", "20/11/2026", "20/11", "20 nov", "nov 20", "20 nov 2027",
 * "today", "tomorrow", "yesterday", "hoy", "mañana", "+3", "-1".
 * Day-first for slashes (Mexican convention). Returns {y, mo, d} or a
 * relative {days} for the +N forms, or null.
 */
export function parseDate(raw, base) {
    const s = String(raw).trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
    const today = partsAt(nowUnix(), base.zone);

    if (s === 'today' || s === 'hoy' || s === 'now')
        return {y: today.y, mo: today.mo, d: today.d};
    if (s === 'tomorrow' || s === 'mañana' || s === 'manana')
        return {days: dayDiff(base, today) + 1};
    if (s === 'yesterday' || s === 'ayer')
        return {days: dayDiff(base, today) - 1};

    let m = s.match(/^([+-])\s*(\d{1,3})d?$/);
    if (m)
        return {days: (m[1] === '-' ? -1 : 1) * Number(m[2])};

    let y, mo, d;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
        [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/))) {
        d = Number(m[1]);
        mo = Number(m[2]);
        y = m[3] ? Number(m[3]) : base.y;
    } else if ((m = s.match(/^(?:[a-zé]+ )?(\d{1,2}) (?:de )?([a-zé]+)(?: (?:de )?(\d{4}))?$/))) {
        d = Number(m[1]);
        mo = monthOf(m[2]);
        y = m[3] ? Number(m[3]) : base.y;
    } else if ((m = s.match(/^(?:[a-zé]+ )?([a-zé]+) (\d{1,2})(?: (\d{4}))?$/))) {
        mo = monthOf(m[1]);
        d = Number(m[2]);
        y = m[3] ? Number(m[3]) : base.y;
    } else {
        return null;
    }
    if (y < 100)
        y += 2000;
    if (!mo || !validDay(y, mo, d))
        return null;
    return {y, mo, d};
}

// ── cities ──────────────────────────────────────────────────────────────────

// Places people search for that are not tzdata zone names. Keep this short:
// it only exists so "Guadalajara" finds Mexico City time.
const ALIASES = [
    ['Guadalajara', 'America/Mexico_City', 'MX'],
    ['CDMX', 'America/Mexico_City', 'MX'],
    ['Querétaro', 'America/Mexico_City', 'MX'],
    ['Puebla', 'America/Mexico_City', 'MX'],
    ['Saltillo', 'America/Monterrey', 'MX'],
    ['San Pedro Garza García', 'America/Monterrey', 'MX'],
    ['San Antonio', 'America/Chicago', 'US'],
    ['Houston', 'America/Chicago', 'US'],
    ['Dallas', 'America/Chicago', 'US'],
    ['Austin', 'America/Chicago', 'US'],
    ['Miami', 'America/New_York', 'US'],
    ['Washington DC', 'America/New_York', 'US'],
    ['Boston', 'America/New_York', 'US'],
    ['Atlanta', 'America/New_York', 'US'],
    ['San Francisco', 'America/Los_Angeles', 'US'],
    ['Seattle', 'America/Los_Angeles', 'US'],
    ['Las Vegas', 'America/Los_Angeles', 'US'],
    ['San Diego', 'America/Los_Angeles', 'US'],
    ['Montreal', 'America/Toronto', 'CA'],
    ['Barcelona', 'Europe/Madrid', 'ES'],
    ['Munich', 'Europe/Berlin', 'DE'],
    ['Frankfurt', 'Europe/Berlin', 'DE'],
    ['Geneva', 'Europe/Zurich', 'CH'],
    ['Milan', 'Europe/Rome', 'IT'],
    ['Abu Dhabi', 'Asia/Dubai', 'AE'],
    ['Mumbai', 'Asia/Kolkata', 'IN'],
    ['New Delhi', 'Asia/Kolkata', 'IN'],
    ['Bangalore', 'Asia/Kolkata', 'IN'],
    ['Beijing', 'Asia/Shanghai', 'CN'],
    ['Shenzhen', 'Asia/Shanghai', 'CN'],
    ['Busan', 'Asia/Seoul', 'KR'],
    ['Incheon', 'Asia/Seoul', 'KR'],
    ['Osaka', 'Asia/Tokyo', 'JP'],
    ['Kyoto', 'Asia/Tokyo', 'JP'],
    ['Phuket', 'Asia/Bangkok', 'TH'],
    ['Chiang Mai', 'Asia/Bangkok', 'TH'],
    ['Pattaya', 'Asia/Bangkok', 'TH'],
    ['Hanoi', 'Asia/Bangkok', 'VN'],
    ['Bali', 'Asia/Makassar', 'ID'],
    ['Rio de Janeiro', 'America/Sao_Paulo', 'BR'],
    ['Medellín', 'America/Bogota', 'CO'],
];

export function cityFromZone(zone) {
    if (zone === 'UTC' || zone === 'Etc/UTC')
        return 'UTC';
    const last = zone.split('/').pop();
    return last.replace(/_/g, ' ');
}

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch {
        return '';
    }
}

const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Every searchable place: tzdata's zone1970.tab plus the aliases above. */
export function loadPlaces(dir = ZONEINFO) {
    const countries = {};
    for (const line of readText(`${dir}/iso3166.tab`).split('\n')) {
        if (!line || line.startsWith('#'))
            continue;
        const [cc, name] = line.split('\t');
        countries[cc] = name;
    }

    const places = [{label: 'UTC', zone: 'UTC', country: 'Coordinated Universal Time', keys: ['utc', 'gmt', 'zulu']}];
    for (const line of readText(`${dir}/zone1970.tab`).split('\n')) {
        if (!line || line.startsWith('#'))
            continue;
        const [codes, , zone] = line.split('\t');
        if (!zone)
            continue;
        const ccs = codes.split(',');
        const names = ccs.map(c => countries[c] ?? c);
        places.push({
            label: cityFromZone(zone),
            zone,
            country: names[0],
            keys: [zone.replace(/_/g, ' '), ...names],
        });
    }
    for (const [label, zone, cc] of ALIASES) {
        places.push({label, zone, country: countries[cc] ?? cc, keys: [label]});
    }
    for (const p of places) {
        p._label = fold(p.label);
        p._keys = p.keys.map(fold);
    }
    return places;
}

/** Best matches for `query`: city-name prefix first, then word prefix, then country. */
export function searchPlaces(places, query, limit = 8) {
    const q = fold(query.trim());
    if (!q)
        return [];
    const scored = [];
    for (const p of places) {
        let score = 0;
        if (p._label === q)
            score = 100;
        else if (p._label.startsWith(q))
            score = 80;
        else if (p._label.split(/[\s-]/).some(w => w.startsWith(q)))
            score = 60;
        else if (p._keys.some(k => k.startsWith(q)))
            score = 40;
        else if (q.length >= 3 && (p._label.includes(q) || p._keys.some(k => k.includes(q))))
            score = 20;
        if (score)
            scored.push([score, p]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].label.localeCompare(b[1].label));

    // An IANA identifier typed in full (e.g. "Etc/GMT+5") is always allowed.
    const out = scored.slice(0, limit).map(([, p]) => p);
    const raw = query.trim();
    if (raw.includes('/') && zoneValid(raw) && !out.some(p => p.zone === raw))
        out.unshift({label: cityFromZone(raw), zone: raw, country: raw});
    return out.slice(0, limit);
}

// ── persisted city list: "Zone|Label" strings ───────────────────────────────

export function decodeCity(s) {
    const i = s.indexOf('|');
    const zone = i < 0 ? s : s.slice(0, i);
    const label = i < 0 ? '' : s.slice(i + 1);
    return {zone, label: label || cityFromZone(zone)};
}

export function encodeCity(c) {
    return c.label && c.label !== cityFromZone(c.zone) ? `${c.zone}|${c.label}` : c.zone;
}

// ── clipboard text ──────────────────────────────────────────────────────────

export function summary(unix, cities, hour12) {
    const rows = cities.map(c => {
        const p = partsAt(unix, c.zone);
        const ab = realAbbr(p.abbr);
        const zoneTag = c.zone === 'UTC' ? '' : ` (${ab ? `${ab}, ` : ''}${fmtUtcOffset(p.offset)})`;
        return `${fmtDate(p)}  ${fmtTime(p, hour12).padStart(hour12 ? 8 : 5)}  ${c.label}${zoneTag}`;
    });
    return rows.join('\n');
}
