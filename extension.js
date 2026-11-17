// SPDX-License-Identifier: GPL-2.0-or-later
// Time Converter — a time zone converter inside the GNOME date menu.
//
// It adds a "Time Converter" card under World Clocks. Every city in it shows
// the same instant. Type a time into any city's box, drag the slider, scroll
// on a row, or pick a day in the calendar above, and every other city
// follows. The strip above the slider colours each hour of the reference
// city's day by the worst case across all cities, so an hour that is office
// time everywhere is green.
//
// The date is shared with the date menu's own calendar: selecting a day there
// moves the converter to it, and ◀ ▶ or a typed date move the calendar's
// selection (and its events list) along.
//
// All time zone math lives in tz.js (plain gjs, tested by tz.test.js); this
// file is only widgets and the hook into the date menu.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import * as tz from './tz.js';

const TICK_SECONDS = 15;
const STEP_MINUTES = 15;

const KIND_CLASS = ['tzc-night', 'tzc-awake', 'tzc-work'];

// St.BoxLayout took `orientation` in Shell 48 and deprecated `vertical`.
function vbox(props = {}) {
    const box = new St.BoxLayout(props);
    if (box.set_orientation)
        box.set_orientation(Clutter.Orientation.VERTICAL);
    else
        box.vertical = true;
    return box;
}

function iconButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'tzc-icon-btn',
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: iconName, icon_size: 14}),
    });
}

function setKind(actor, kind) {
    for (const c of KIND_CLASS)
        actor.remove_style_class_name(c);
    actor.add_style_class_name(KIND_CLASS[kind]);
}

function focused(entry) {
    return global.stage.get_key_focus() === entry.clutter_text;
}

const TzSection = GObject.registerClass(
class TzSection extends St.BoxLayout {
    _init(settings, dateMenu) {
        super._init({
            // Borrow the World Clocks card style so it sits in the column
            // like a native section.
            style_class: 'world-clocks-button tzc-section',
            x_expand: true,
        });
        if (this.set_orientation)
            this.set_orientation(Clutter.Orientation.VERTICAL);
        else
            this.vertical = true;

        this._settings = settings;
        this._dateMenu = dateMenu;
        this._calendar = dateMenu._calendar;
        this._places = null;
        this._unix = tz.nowUnix();
        this._live = true;
        this._rows = [];
        this._results = [];
        this._syncing = false;
        this._timeouts = new Set();

        this._seedCities();
        this._build();
        this._rebuildRows();

        // connectObject ties each handler to this actor's lifetime, so
        // nothing is left dangling whichever side the Shell destroys first.
        settings.connectObject(
            'changed::cities', () => this._rebuildRows(),
            'changed::hour12', () => this._render(),
            this);
        // The date menu selects today itself whenever it opens; that reaches
        // us first through selected-date-changed, then this.
        dateMenu.menu.connectObject('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._live = true;
            this._unix = tz.nowUnix();
            this._searchEntry.text = '';
            this._render();
        }, this);
        this._calendar.connectObject('selected-date-changed',
            (_c, datetime) => this._onCalendarDate(datetime), this);

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            if (this._live && this._dateMenu.menu.isOpen) {
                this._unix = tz.nowUnix();
                this._render();
            }
            return GLib.SOURCE_CONTINUE;
        });

        this.connect('destroy', () => this._onDestroy());
        this._render();
    }

    // ── state ───────────────────────────────────────────────────────────────

    get _cities() {
        return this._settings.get_strv('cities')
            .map(tz.decodeCity)
            .filter(c => tz.zoneValid(c.zone));
    }

    _saveCities(cities) {
        this._settings.set_strv('cities', cities.map(tz.encodeCity));
    }

    // First run: this machine's zone, then whatever GNOME World Clocks
    // already lists, else UTC.
    _seedCities() {
        if (this._settings.get_strv('cities').length > 0)
            return;
        const local = tz.localZone();
        const cities = [{zone: local, label: tz.cityFromZone(local)}];
        try {
            for (const {location} of this._dateMenu._clocksItem?._locations ?? []) {
                const zone = location.get_timezone()?.get_identifier();
                if (!zone || !tz.zoneValid(zone) || cities.some(c => c.zone === zone))
                    continue;
                const label = zone === 'UTC' || zone === 'Etc/UTC' ? 'UTC'
                    : location.get_city_name() || location.get_name() || tz.cityFromZone(zone);
                cities.push({zone, label});
            }
        } catch (e) {
            console.warn(`tz-converter: could not read World Clocks: ${e.message}`);
        }
        if (cities.length === 1 && local !== 'UTC')
            cities.push({zone: 'UTC', label: 'UTC'});
        this._saveCities(cities);
    }

    _setInstant(unix) {
        if (unix === null || unix === undefined)
            return;
        this._unix = unix;
        this._live = false;
        this._render();
        this._pushDateToCalendar();
    }

    // Keep the calendar's selected day on the converter's date (the
    // reference city's calendar day).
    _pushDateToCalendar() {
        const home = this._cities[0];
        if (!home || !this._calendar)
            return;
        const p = tz.partsAt(this._unix, home.zone);
        this._syncing = true;
        try {
            this._calendar.setDate(new Date(p.y, p.mo - 1, p.d));
        } finally {
            this._syncing = false;
        }
    }

    _onCalendarDate(datetime) {
        if (this._syncing)
            return;
        const home = this._cities[0];
        if (!home)
            return;
        const hp = tz.partsAt(this._unix, home.zone);
        const [y, mo, d] = [datetime.get_year(), datetime.get_month(), datetime.get_day_of_month()];
        if (y === hp.y && mo === hp.mo && d === hp.d)
            return;
        this._unix = tz.instantAt(home.zone, y, mo, d, hp.h, hp.mi);
        this._live = false;
        this._render();
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _selectAllOnFocus(entry) {
        entry.clutter_text.connect('key-focus-in', () => {
            this._later(0, () => entry.clutter_text.set_selection(0, entry.clutter_text.text.length));
        });
    }

    _flashError(entry) {
        entry.add_style_class_name('tzc-error');
        this._later(900, () => entry.remove_style_class_name('tzc-error'));
    }

    // ── widgets ─────────────────────────────────────────────────────────────

    _build() {
        // Title + Now
        const titleRow = new St.BoxLayout({x_expand: true});
        titleRow.add_child(new St.Label({
            text: 'Time Converter',
            style_class: 'world-clocks-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._fmtBtn = new St.Button({style_class: 'tzc-btn', can_focus: true});
        this._fmtBtn.connect('clicked', () =>
            this._settings.set_boolean('hour12', !this._settings.get_boolean('hour12')));
        titleRow.add_child(this._fmtBtn);
        this._nowBtn = new St.Button({style_class: 'tzc-btn', label: 'Now', can_focus: true});
        this._nowBtn.connect('clicked', () => {
            this._live = true;
            this._unix = tz.nowUnix();
            this._render();
            this._pushDateToCalendar();
        });
        titleRow.add_child(this._nowBtn);
        this.add_child(titleRow);

        // ◀ date ▶
        const dateRow = new St.BoxLayout({style_class: 'tzc-date-row', x_expand: true});
        const prev = iconButton('go-previous-symbolic', 'Previous day');
        prev.connect('clicked', () => this._shiftDay(-1));
        this._dateEntry = new St.Entry({
            style_class: 'tzc-date',
            can_focus: true,
            x_expand: true,
        });
        this._dateEntry.clutter_text.x_align = Clutter.ActorAlign.CENTER;
        this._selectAllOnFocus(this._dateEntry);
        this._dateEntry.clutter_text.connect('activate', () => this._onDateTyped());
        this._dateEntry.clutter_text.connect('key-focus-out', () => this._render());
        const next = iconButton('go-next-symbolic', 'Next day');
        next.connect('clicked', () => this._shiftDay(1));
        dateRow.add_child(prev);
        dateRow.add_child(this._dateEntry);
        dateRow.add_child(next);
        this.add_child(dateRow);

        // City rows
        this._rowsBox = vbox({style_class: 'tzc-rows', x_expand: true});
        this.add_child(this._rowsBox);

        // Meeting strip + slider over the reference city's day
        this._strip = new St.BoxLayout({style_class: 'tzc-strip', x_expand: true});
        this._cells = [];
        for (let i = 0; i < 24; i++) {
            const cell = new St.Widget({style_class: 'tzc-cell', x_expand: true});
            this._cells.push(cell);
            this._strip.add_child(cell);
        }
        this.add_child(this._strip);

        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.add_style_class_name('tzc-slider');
        this._slider.accessible_name = 'Time of day in the first city';
        this._slider.connect('notify::value', () => this._onSlider());
        this.add_child(this._slider);

        this._legend = new St.Label({style_class: 'tzc-legend', x_expand: true});
        this._legend.clutter_text.line_wrap = true;
        this.add_child(this._legend);

        // Add city
        this._searchEntry = new St.Entry({
            style_class: 'tzc-search',
            can_focus: true,
            x_expand: true,
            hint_text: 'Add city, country or zone…',
            primary_icon: new St.Icon({icon_name: 'list-add-symbolic', icon_size: 14}),
        });
        this._searchEntry.clutter_text.connect('text-changed', () => this._onSearch());
        this._searchEntry.clutter_text.connect('activate', () => {
            if (this._results[0])
                this._addCity(this._results[0]);
        });
        this.add_child(this._searchEntry);
        this._resultsBox = vbox({style_class: 'tzc-results', x_expand: true});
        this.add_child(this._resultsBox);

        // Copy
        const footer = new St.BoxLayout({x_expand: true});
        footer.add_child(new St.Label({
            text: 'scroll a row = ±15 min',
            style_class: 'tzc-hint',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._copyBtn = new St.Button({style_class: 'tzc-btn', label: 'Copy', can_focus: true});
        this._copyBtn.connect('clicked', () => this._copy());
        footer.add_child(this._copyBtn);
        this.add_child(footer);
    }

    _rebuildRows() {
        this._rowsBox.destroy_all_children();
        this._rows = [];
        const cities = this._cities;
        cities.forEach((city, idx) => {
            const row = new St.BoxLayout({
                style_class: 'tzc-row',
                reactive: true,
                track_hover: true,
                x_expand: true,
            });

            const dot = new St.Widget({style_class: 'tzc-dot', y_align: Clutter.ActorAlign.CENTER});
            row.add_child(dot);

            const names = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const name = new St.Label({text: city.label, style_class: 'tzc-city'});
            name.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
            names.add_child(name);
            const sub = new St.Label({style_class: 'tzc-sub'});
            names.add_child(sub);
            row.add_child(names);

            // Row tools only while hovering, so the narrow column stays tidy.
            const tools = new St.BoxLayout({
                style_class: 'tzc-tools',
                y_align: Clutter.ActorAlign.CENTER,
                opacity: 0,
            });
            if (idx > 0) {
                const top = iconButton('go-top-symbolic', `Make ${city.label} the reference city`);
                top.connect('clicked', () => this._moveToTop(idx));
                tools.add_child(top);
            }
            if (cities.length > 1) {
                const rm = iconButton('window-close-symbolic', `Remove ${city.label}`);
                rm.connect('clicked', () => this._removeCity(idx));
                tools.add_child(rm);
            }
            row.add_child(tools);
            row.connect('notify::hover', () => {
                tools.opacity = row.hover ? 255 : 0;
            });

            const right = vbox({y_align: Clutter.ActorAlign.CENTER});
            const entry = new St.Entry({style_class: 'tzc-time', can_focus: true});
            entry.clutter_text.x_align = Clutter.ActorAlign.END;
            this._selectAllOnFocus(entry);
            entry.clutter_text.connect('activate', () => this._onTimeTyped(city, entry));
            entry.clutter_text.connect('key-focus-out', () => this._render());
            right.add_child(entry);
            const day = new St.Label({style_class: 'tzc-dayname', x_align: Clutter.ActorAlign.END});
            right.add_child(day);
            row.add_child(right);

            row.connect('scroll-event', (_a, event) => this._onScroll(event));

            this._rowsBox.add_child(row);
            this._rows.push({city, dot, sub, day, entry});
        });
        this._render();
    }

    // ── rendering ───────────────────────────────────────────────────────────

    _render() {
        const cities = this._cities;
        if (!cities.length || !this._rows.length)
            return;
        const hour12 = this._settings.get_boolean('hour12');
        const home = cities[0];
        const hp = tz.partsAt(this._unix, home.zone);

        if (!focused(this._dateEntry))
            this._dateEntry.text = tz.fmtDate(hp);

        for (const [i, r] of this._rows.entries()) {
            const p = tz.partsAt(this._unix, r.city.zone);
            setKind(r.dot, tz.hourKind(p.h));

            const bits = [];
            const ab = tz.realAbbr(p.abbr);
            if (r.city.zone !== 'UTC') {
                if (ab)
                    bits.push(ab);
                bits.push(tz.fmtUtcOffset(p.offset));
            }
            if (i > 0)
                bits.push(tz.fmtRelative(p.offset - hp.offset));
            r.sub.text = bits.join(' · ') || 'reference';

            const dd = tz.dayDiff(hp, p);
            r.day.text = dd === 0 ? '' : `${tz.DOW[p.dow]} ${p.d} ${tz.MON[p.mo]}`;
            r.day.visible = dd !== 0;
            r.day.style_class = dd > 0 ? 'tzc-dayname tzc-ahead'
                : dd < 0 ? 'tzc-dayname tzc-behind' : 'tzc-dayname';

            if (!focused(r.entry))
                r.entry.text = tz.fmtTime(p, hour12);
        }

        const strip = tz.dayStrip(this._unix, home.zone, cities.map(c => c.zone));
        strip.forEach((k, i) => setKind(this._cells[i], k));
        const good = strip.filter(k => k === tz.WORK).length;
        this._legend.visible = cities.length > 1;
        this._legend.text = good
            ? `Office hours (9–18) in every city: ${good} h this day`
            : 'No hour this day is office hours everywhere';

        this._syncing = true;
        this._slider.value = (hp.h * 60 + hp.mi) / 1440;
        this._syncing = false;

        if (this._live)
            this._nowBtn.add_style_pseudo_class('checked');
        else
            this._nowBtn.remove_style_pseudo_class('checked');
        this._fmtBtn.label = hour12 ? '12h' : '24h';
    }

    // ── input ───────────────────────────────────────────────────────────────

    _shiftDay(n) {
        this._setInstant(tz.shiftDays(this._unix, this._cities[0].zone, n));
    }

    _onDateTyped() {
        const home = this._cities[0];
        const hp = tz.partsAt(this._unix, home.zone);
        const r = tz.parseDate(this._dateEntry.text, {...hp, zone: home.zone});
        if (!r) {
            this._flashError(this._dateEntry);
            return;
        }
        this._setInstant(r.days !== undefined
            ? tz.shiftDays(this._unix, home.zone, r.days)
            : tz.instantAt(home.zone, r.y, r.mo, r.d, hp.h, hp.mi));
        this._dateEntry.text = tz.fmtDate(tz.partsAt(this._unix, home.zone));
    }

    _onTimeTyped(city, entry) {
        const t = tz.parseTime(entry.text);
        if (!t) {
            this._flashError(entry);
            return;
        }
        // Keep that city's own calendar day and set its wall clock.
        const p = tz.partsAt(this._unix, city.zone);
        this._setInstant(tz.instantAt(city.zone, p.y, p.mo, p.d, t.h, t.mi));
        entry.text = tz.fmtTime(tz.partsAt(this._unix, city.zone), this._settings.get_boolean('hour12'));
    }

    _onSlider() {
        if (this._syncing)
            return;
        const home = this._cities[0];
        const hp = tz.partsAt(this._unix, home.zone);
        let m = Math.round(this._slider.value * 1440 / STEP_MINUTES) * STEP_MINUTES;
        m = Math.min(m, 1440 - STEP_MINUTES);
        if (m === hp.h * 60 + hp.mi)
            return;
        this._setInstant(tz.instantAt(home.zone, hp.y, hp.mo, hp.d, Math.floor(m / 60), m % 60));
    }

    _onScroll(event) {
        let dir = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            dir = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
            dir = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            this._scrollAcc = (this._scrollAcc ?? 0) - dy;
            if (Math.abs(this._scrollAcc) >= 1) {
                dir = Math.sign(this._scrollAcc);
                this._scrollAcc = 0;
            }
            break;
        }
        }
        if (dir) {
            const step = STEP_MINUTES * 60;
            this._setInstant(Math.round(this._unix / step) * step + dir * step);
        }
        return Clutter.EVENT_STOP;
    }

    _onSearch() {
        this._resultsBox.destroy_all_children();
        const q = this._searchEntry.text;
        if (!q.trim()) {
            this._results = [];
            return;
        }
        this._places ??= tz.loadPlaces();
        this._results = tz.searchPlaces(this._places, q, 6);
        const hour12 = this._settings.get_boolean('hour12');
        for (const place of this._results) {
            const p = tz.partsAt(this._unix, place.zone);
            const btn = new St.Button({style_class: 'tzc-result', can_focus: true, x_expand: true});
            const line = new St.BoxLayout({x_expand: true});
            const names = vbox({x_expand: true});
            names.add_child(new St.Label({text: place.label, style_class: 'tzc-city'}));
            names.add_child(new St.Label({text: place.country, style_class: 'tzc-sub'}));
            line.add_child(names);
            line.add_child(new St.Label({
                text: tz.fmtTime(p, hour12),
                style_class: 'tzc-result-time',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            btn.set_child(line);
            btn.connect('clicked', () => this._addCity(place));
            this._resultsBox.add_child(btn);
        }
        if (!this._results.length)
            this._resultsBox.add_child(new St.Label({text: 'No match', style_class: 'tzc-sub'}));
    }

    _addCity(place) {
        const cities = this._cities;
        if (!cities.some(c => c.zone === place.zone && c.label === place.label))
            this._saveCities([...cities, {zone: place.zone, label: place.label}]);
        this._searchEntry.text = '';
    }

    _removeCity(idx) {
        const cities = this._cities;
        cities.splice(idx, 1);
        this._saveCities(cities);
    }

    _moveToTop(idx) {
        const cities = this._cities;
        const [c] = cities.splice(idx, 1);
        this._saveCities([c, ...cities]);
        this._pushDateToCalendar();
    }

    _copy() {
        const text = tz.summary(this._unix, this._cities, this._settings.get_boolean('hour12'));
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._copyBtn.label = 'Copied';
        this._later(1500, () => {
            this._copyBtn.label = 'Copy';
        });
    }

    _onDestroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
    }
});

export default class TzConverterExtension extends Extension {
    enable() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        const clocks = dateMenu?._clocksItem;
        const box = clocks?.get_parent();
        if (!box || !dateMenu._calendar) {
            console.error('tz-converter: date menu layout not recognised; not adding the converter');
            return;
        }
        this._section = new TzSection(this.getSettings(), dateMenu);
        box.insert_child_above(this._section, clocks);
    }

    disable() {
        this._section?.destroy();
        this._section = null;
    }
}
