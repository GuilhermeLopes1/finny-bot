const TIME_ZONE = 'America/Sao_Paulo';

function partsInSaoPaulo(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Data inválida');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function dateKey(value = new Date()) {
  const { year, month, day } = partsInSaoPaulo(value);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthKey(value = new Date()) {
  const { year, month } = partsInSaoPaulo(value);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function previousMonthKey(value = new Date()) {
  const { year, month } = partsInSaoPaulo(value);
  const previous = new Date(Date.UTC(year, month - 2, 15, 12));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(year, monthOneBased) {
  return new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
}

function clampDateKey(year, monthOneBased, day) {
  const safeDay = Math.min(Math.max(1, Number(day) || 1), daysInMonth(year, monthOneBased));
  return `${year}-${String(monthOneBased).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

function extendExpiry(currentValue, days, now = new Date()) {
  const current = new Date(currentValue || 0);
  const base = Number.isNaN(current.getTime()) || current <= now ? now : current;
  return new Date(base.getTime() + Number(days || 0) * 86400000).toISOString();
}

module.exports = {
  TIME_ZONE,
  partsInSaoPaulo,
  dateKey,
  monthKey,
  previousMonthKey,
  daysInMonth,
  clampDateKey,
  extendExpiry,
};
