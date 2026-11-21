const CHICAGO_TIME_ZONE = 'America/Chicago';
const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const MONTH_NUMBERS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

export interface EventDateWindow {
  description: string;
  start: Date;
  end: Date;
}

function chicagoCalendarDate(referenceDate: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(referenceDate);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
}

function chicagoWeekday(referenceDate: Date): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TIME_ZONE,
    weekday: 'short',
  }).format(referenceDate);
  return WEEKDAYS[weekday] ?? 0;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function createWindow(label: string, start: Date, end: Date): EventDateWindow {
  return { description: `${label} means ${formatDate(start)} through ${formatDate(end)} in Austin time.`, start, end };
}

/** Returns a concrete Austin calendar window for relative event questions. */
export function getEventDateWindow(question: string, referenceDate = new Date()): EventDateWindow | null {
  const normalized = question.toLowerCase();
  if (!/\b(this|next)\s+(week|weekend)\b/.test(normalized)) return null;

  const today = chicagoCalendarDate(referenceDate);
  const weekday = chicagoWeekday(referenceDate);
  const monday = addDays(today, weekday === 0 ? -6 : 1 - weekday);

  if (/\bnext\s+weekend\b/.test(normalized)) {
    const friday = addDays(monday, 11);
    return createWindow('“next weekend”', friday, addDays(friday, 2));
  }
  if (/\bthis\s+weekend\b/.test(normalized)) {
    const friday = addDays(monday, 4);
    return createWindow('“this weekend”', friday, addDays(friday, 2));
  }
  if (/\bnext\s+week\b/.test(normalized)) {
    const nextMonday = addDays(monday, 7);
    return createWindow('“next week”', nextMonday, addDays(nextMonday, 6));
  }
  return createWindow('“this week”', monday, addDays(monday, 6));
}

export function getEventDateScope(question: string, referenceDate = new Date()): string | null {
  return getEventDateWindow(question, referenceDate)?.description ?? null;
}

/** True when text contains at least one month/day date within the requested window. */
export function hasDateInEventWindow(text: string, window: EventDateWindow): boolean {
  const monthPattern = Object.keys(MONTH_NUMBERS).join('|');
  const dates = text.matchAll(new RegExp(`\\b(${monthPattern})\\.?\\s*(\\d{1,2})\\b`, 'gi'));
  for (const match of dates) {
    const month = MONTH_NUMBERS[match[1].toLowerCase()];
    const day = Number(match[2]);
    if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) continue;
    let date = new Date(Date.UTC(window.start.getUTCFullYear(), month, day));
    // A window spanning New Year can contain January dates in the following year.
    if (date < addDays(window.start, -180)) date = new Date(Date.UTC(date.getUTCFullYear() + 1, month, day));
    if (date >= window.start && date <= window.end) return true;
  }
  return false;
}
