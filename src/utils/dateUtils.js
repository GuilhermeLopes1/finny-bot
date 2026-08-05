/**
 * Utilitários de data civil no fuso oficial do aplicativo.
 * Datas financeiras são interpretadas em America/Sao_Paulo para que um
 * lançamento feito à noite não seja deslocado para o dia seguinte por UTC.
 */
const { dateKey, partsInSaoPaulo, daysInMonth } = require('./saoPaulo');

function keyFromParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDateKey(key, days) {
  const [year, month, day] = String(key).split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days, 12));
  return keyFromParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

// O Brasil não usa horário de verão desde 2019; a base do aplicativo é atual.
function civilRange(key) {
  return {
    start: new Date(`${key}T00:00:00.000-03:00`),
    end: new Date(`${key}T23:59:59.999-03:00`),
  };
}

function getTodayRange(now = new Date()) {
  return civilRange(dateKey(now));
}

function getWeekRange(now = new Date()) {
  const today = dateKey(now);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  const startKey = shiftDateKey(today, diffToMonday);
  return { start: civilRange(startKey).start, end: civilRange(today).end };
}

function getMonthRange(now = new Date()) {
  const { year, month } = partsInSaoPaulo(now);
  const startKey = keyFromParts(year, month, 1);
  const endKey = keyFromParts(year, month, daysInMonth(year, month));
  return { start: civilRange(startKey).start, end: civilRange(endKey).end };
}

function getLastMonthRange(now = new Date()) {
  const { year, month } = partsInSaoPaulo(now);
  const anchor = new Date(Date.UTC(year, month - 2, 15, 12));
  const previousYear = anchor.getUTCFullYear();
  const previousMonth = anchor.getUTCMonth() + 1;
  const startKey = keyFromParts(previousYear, previousMonth, 1);
  const endKey = keyFromParts(previousYear, previousMonth, daysInMonth(previousYear, previousMonth));
  return { start: civilRange(startKey).start, end: civilRange(endKey).end };
}

function parseDateReference(text) {
  const t = String(text || '').toLowerCase();
  if (/hoje|agora/.test(t)) return getTodayRange();
  if (/essa semana|esta semana|semana/.test(t)) return getWeekRange();
  if (/mês passado|último mês/.test(t)) return getLastMonthRange();
  if (/esse mês|este mês|mês/.test(t)) return getMonthRange();
  if (/ontem/.test(t)) return civilRange(shiftDateKey(dateKey(), -1));
  return getMonthRange();
}

function formatDateBR(date) {
  const d = date instanceof Date ? date : date?.toDate?.() ?? new Date(date);
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo',
  }).format(d);
}

function formatCurrencyBR(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function getCurrentMonthNameBR() {
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date());
}

module.exports = {
  getTodayRange, getWeekRange, getMonthRange, getLastMonthRange, parseDateReference,
  formatDateBR, formatCurrencyBR, getCurrentMonthNameBR, civilRange, shiftDateKey,
};
