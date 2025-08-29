// src/ui.js
// Small UI helpers for Telegram MarkdownV2 formatting

export const escapeMd = (s = '') =>
  s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export const pct = (n) => {
  const v = Number(n || 0);
  const sign = v > 0 ? '+' : v < 0 ? '' : ''; // keep + for positives
  return `${sign}${v.toFixed(2)}%`;
};

export const money = (n, d = 2) =>
  '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: d });

export const num = (n, d = 2) =>
  Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: d });

export const trendBadge = (p) => {
  const v = Number(p || 0);
  if (v > 0.01) return '🟢 ⬆️';
  if (v < -0.01) return '🔴 ⬇️';
  return '🟡 ➖';
};
