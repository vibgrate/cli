import {
  format,
  formatDistanceToNow,
  parseISO,
  isValid,
  isBefore,
  isAfter,
  addDays as dateFnsAddDays,
  subDays,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
} from "date-fns";

export type DateInput = Date | string | number;

/**
 * Parse a date from various input formats
 */
export function parseDate(date: DateInput): Date {
  if (date instanceof Date) return date;
  if (typeof date === "number") return new Date(date);
  return parseISO(date);
}

/**
 * Format a date to a readable string
 */
export function formatDate(
  date: DateInput,
  formatStr: string = "MMM d, yyyy"
): string {
  const parsed = parseDate(date);
  if (!isValid(parsed)) return "Invalid date";
  return format(parsed, formatStr);
}

/**
 * Format a date with time
 */
export function formatDateTime(
  date: DateInput,
  formatStr: string = "MMM d, yyyy h:mm a"
): string {
  return formatDate(date, formatStr);
}

/**
 * Format a date as relative time (e.g., "2 hours ago")
 */
export function formatRelative(
  date: DateInput,
  options?: { addSuffix?: boolean }
): string {
  const parsed = parseDate(date);
  if (!isValid(parsed)) return "Invalid date";
  return formatDistanceToNow(parsed, { addSuffix: options?.addSuffix ?? true });
}

/**
 * Check if a date is in the past
 */
export function isDateInPast(date: DateInput): boolean {
  const parsed = parseDate(date);
  return isValid(parsed) && isBefore(parsed, new Date());
}

/**
 * Check if a date is in the future
 */
export function isDateInFuture(date: DateInput): boolean {
  const parsed = parseDate(date);
  return isValid(parsed) && isAfter(parsed, new Date());
}

/**
 * Add days to a date
 */
export function addDays(date: DateInput, days: number): Date {
  return dateFnsAddDays(parseDate(date), days);
}

/**
 * Subtract days from a date
 */
export function subtractDays(date: DateInput, days: number): Date {
  return subDays(parseDate(date), days);
}

/**
 * Get date range for common periods
 */
export function getDateRange(
  period: "today" | "thisWeek" | "thisMonth" | "last7Days" | "last30Days"
): { start: Date; end: Date } {
  const now = new Date();

  switch (period) {
    case "today":
      return {
        start: startOfDay(now),
        end: endOfDay(now),
      };
    case "thisWeek":
      return {
        start: startOfWeek(now, { weekStartsOn: 1 }),
        end: endOfWeek(now, { weekStartsOn: 1 }),
      };
    case "thisMonth":
      return {
        start: startOfMonth(now),
        end: endOfMonth(now),
      };
    case "last7Days":
      return {
        start: startOfDay(subDays(now, 6)),
        end: endOfDay(now),
      };
    case "last30Days":
      return {
        start: startOfDay(subDays(now, 29)),
        end: endOfDay(now),
      };
  }
}

/**
 * Check if two dates are the same day
 */
export function isSameDay(date1: DateInput, date2: DateInput): boolean {
  const d1 = parseDate(date1);
  const d2 = parseDate(date2);
  return formatDate(d1, "yyyy-MM-dd") === formatDate(d2, "yyyy-MM-dd");
}

/**
 * Get the start of day
 */
export function getStartOfDay(date: DateInput): Date {
  return startOfDay(parseDate(date));
}

/**
 * Get the end of day
 */
export function getEndOfDay(date: DateInput): Date {
  return endOfDay(parseDate(date));
}
