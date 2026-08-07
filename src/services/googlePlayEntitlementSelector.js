'use strict';

function toMillis(value) {
  if (!value) return 0;
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function activePurchaseRecord(records = [], now = new Date()) {
  return records
    .filter(record => record?.entitled === true
      && !record?.supersededByPurchaseTokenHash
      && toMillis(record.expiryTime) > now.getTime())
    .sort((a, b) => toMillis(b.expiryTime) - toMillis(a.expiryTime))[0] || null;
}

function latestPurchaseRecord(records = []) {
  return [...records].sort((a, b) => {
    const aTime = toMillis(a?.updatedAt) || toMillis(a?.expiryTime);
    const bTime = toMillis(b?.updatedAt) || toMillis(b?.expiryTime);
    return bTime - aTime;
  })[0] || null;
}

module.exports = { activePurchaseRecord, latestPurchaseRecord };
