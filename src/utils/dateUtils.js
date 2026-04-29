/**
 * Date utilities with Brazilian Portuguese support
 */

/**
 * Get start and end of today in Brazil timezone
 */
function getTodayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Get start and end of current week (Mon–Sun)
 */
function getWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Mon
  const start = new Date(now.setDate(diff));
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Get start and end of current month
 */
function getMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

/**
 * Get start and end of last month
 */
function getLastMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  return { start, end };
}

/**
 * Parse date references from Brazilian Portuguese text
 * Returns a Date range object { start, end }
 */
function parseDateReference(text) {
  const t = text.toLowerCase();

  if (/hoje|agora/.test(t)) return getTodayRange();
  if (/essa semana|esta semana|semana/.test(t)) return getWeekRange();
  if (/esse mês|este mês|mês/.test(t)) return getMonthRange();
  if (/mês passado|último mês/.test(t)) return getLastMonthRange();
  if (/ontem/.test(t)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const start = new Date(yesterday);
    start.setHours(0, 0, 0, 0);
    const end = new Date(yesterday);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  // Default: current month
  return getMonthRange();
}

/**
 * Format a date to Brazilian Portuguese string
 */
function formatDateBR(date) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date instanceof Date ? date : date.toDate());
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
  return new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(new Date());
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
