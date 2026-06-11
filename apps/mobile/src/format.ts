export function money(cents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol"
  }).format(cents / 100);
}

export function amountToCents(value: string) {
  const sanitized = sanitizeAmountInput(value);
  const decimalIndex = Math.max(sanitized.lastIndexOf("."), sanitized.lastIndexOf(","));

  if (decimalIndex === -1) {
    const whole = sanitized.replace(/[.,]/g, "");
    return Number(whole || "0") * 100;
  }

  const whole = sanitized.slice(0, decimalIndex).replace(/[.,]/g, "");
  const fraction = sanitized.slice(decimalIndex + 1).replace(/[.,]/g, "").slice(0, 2);
  return Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
}

export function sanitizeAmountInput(value: string) {
  return value.replace(/[^\d.,]/g, "");
}

export function currencySymbol(currency: string) {
  const parts = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol"
  }).formatToParts(0);
  return parts.find((part) => part.type === "currency")?.value ?? currency;
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

export function formatRelativeExpenseDate(value: string) {
  const date = new Date(value);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;

  if (!Number.isFinite(date.getTime()) || diffMs < 0) return formatDate(value);
  if (diffMs < minute) return "just now";
  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute);
    return `${minutes} min ago`;
  }
  if (diffMs < 2 * hour) return "an hour ago";
  if (isSameDay(date, now)) {
    const hours = Math.floor(diffMs / hour);
    return `${hours} hours ago`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return "yesterday";

  return formatDate(value);
}

function isSameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong";
}

export function paymentDescription(toName?: string) {
  return `Payment to ${toName || "Someone"}`;
}
