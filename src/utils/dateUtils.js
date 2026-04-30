
/**
 * Date utilities with Brazilian Portuguese support
 * âœ… FIX: all ranges use UTC boundaries to match ISO strings saved in Firestore
 * Brazil = UTC-3, so server-side "local time" ranges would miss transactions
 * saved at certain hours. Using UTC month boundaries is consistent and safe.
 */

/**
 * Get start and end of today in UTC
 */
function getTodayRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
}

/**
 * Get start and end of current week (Monâ€“Sun) in UTC
 */
function getWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diffToMonday);

  const start = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate(), 0, 0, 0, 0));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
}

/**
 * Get start and end of current month in UTC
 * âœ… FIX: uses UTC methods â€” avoids UTC vs local timezone mismatch
 */
function getMonthRange() {
  const now = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  // Day 0 of next month = last day of current month
  const end   = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
  return { start, end };
}

/**
 * Get start and end of last month in UTC
 */
function getLastMonthRange() {
  const now = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end };
}

/**
 * Parse date references from Brazilian Portuguese text
 */
function parseDateReference(text) {
  const t = text.toLowerCase();

  if (/hoje|agora/.test(t))                           return getTodayRange();
  if (/essa semana|esta semana|semana/.test(t))        return getWeekRange();
  if (/esse mÃªs|este mÃªs|mÃªs/.test(t))                return getMonthRange();
  if (/mÃªs passado|Ãºltimo mÃªs/.test(t))               return getLastMonthRange();
  if (/ontem/.test(t)) {
    const now = new Date();
    const y   = now.getUTCFullYear();
    const m   = now.getUTCMonth();
    const d   = now.getUTCDate() - 1;
    return {
      start: new Date(Date.UTC(y, m, d, 0, 0, 0, 0)),
      end:   new Date(Date.UTC(y, m, d, 23, 59, 59, 999)),
    };
  }

  // Default: current month
  return getMonthRange();
}

/**
 * Format a date to Brazilian Portuguese string
 */
function formatDateBR(date) {
  const d = date instanceof Date ? date : date.toDate?.() ?? new Date(date);
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(d);
}

/**
 * Format currency to BRL
 */
function formatCurrencyBR(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

/**
 * Get current month name in Portuguese
 */
function getCurrentMonthNameBR() {
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date());
}

module.exports = {
  getTodayRange,
  getWeekRange,
  getMonthRange,
  getLastMonthRange,
  parseDateReference,
  formatDateBR,
  formatCurrencyBR,
  getCurrentMonthNameBR,
};
