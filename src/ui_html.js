// src/ui_html.js
// Tiny helpers for HTML-safe Telegram messages

export const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const shortAddr = (a) => (a ? `${a.slice(0,6)}…${a.slice(-4)}` : '');

export const pct = (n) => {
  const v = Number(n || 0);
  const sign = v > 0 ? '+' : v < 0 ? '' : '';
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
