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

function formatWindow(label: string, start: Date, end: Date): string {
  return `${label} means ${formatDate(start)} through ${formatDate(end)} in Austin time.`;
}

/** Returns an explicit Austin calendar window for relative event questions. */
export function getEventDateScope(question: string, referenceDate = new Date()): string | null {
  const normalized = question.toLowerCase();
  if (!/\b(this|next)\s+(week|weekend)\b/.test(normalized)) return null;

  const today = chicagoCalendarDate(referenceDate);
  const weekday = chicagoWeekday(referenceDate);
  const monday = addDays(today, weekday === 0 ? -6 : 1 - weekday);

  if (/\bnext\s+weekend\b/.test(normalized)) {
    const friday = addDays(monday, 11);
    return formatWindow('“next weekend”', friday, addDays(friday, 2));
  }
  if (/\bthis\s+weekend\b/.test(normalized)) {
    const friday = addDays(monday, 4);
    return formatWindow('“this weekend”', friday, addDays(friday, 2));
  }
  if (/\bnext\s+week\b/.test(normalized)) {
    const nextMonday = addDays(monday, 7);
    return formatWindow('“next week”', nextMonday, addDays(nextMonday, 6));
  }
  return formatWindow('“this week”', monday, addDays(monday, 6));
}
