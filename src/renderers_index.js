// src/renderers_index.js

// Tiny 10-slot bar based on percentage
function bar10(pct) {
  if (!Number.isFinite(pct)) return '[░░░░░░░░░░]';
  const p = Math.max(0, Math.min(100, pct));
  const fill = Math.round(p / 10);
  return `[${'█'.repeat(fill)}${'░'.repeat(10 - fill)}]`;
}

// HTML escape minimal (numbers and ASCII are safe, but labels can have $ or symbols)
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;');
}

export function renderIndexView(snapshot) {
  // Accept either the snapshot directly or { snapshot }
  const s = snapshot?.snapshot ? snapshot.snapshot : snapshot || {};

  const holders   = Number(s.holdersCount ?? 0);
  const top10     = Number(s.top10CombinedPct ?? 0);
  const gini      = Number(s.gini ?? 0);
  const pctBuckets = Array.isArray(s.pctBuckets) ? s.pctBuckets : [];
  const valBuckets = Array.isArray(s.valueBuckets) ? s.valueBuckets : [];
  const ca        = s.tokenAddress || '';
  const updated   = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '–';

  const lines = [];

  lines.push('📈 <b>Index</b>', '');
  lines.push(`Holders: <b>${holders.toLocaleString()}</b>`);
  lines.push(`Top-10 combined: <b>+${top10.toFixed(2)}%</b>`);
  lines.push(`Inequality (Gini): <b>${gini.toFixed(4)}</b> <i>(0=fair • 1=concentrated)</i>`, '');

  if (pctBuckets.length) {
    lines.push('Distribution by % of supply');
    for (const b of pctBuckets) {
      const label = esc(b.label ?? '');
      const count = Number(b.count ?? 0);
      const pct   = Number(b.pct ?? 0);
      lines.push(`• ${label} — ${count} ${bar10(pct)}`);
    }
    lines.push('');
  }

  if (valBuckets.length) {
    lines.push('Distribution by estimated value');
    for (const b of valBuckets) {
      const label = esc(b.label ?? '');
      const count = Number(b.count ?? 0);
      const pct   = Number(b.pct ?? 0);
      lines.push(`• ${label} — ${count} ${bar10(pct)}`);
    }
    lines.push('');
  }

  lines.push('<i>Snapshot excludes LP/CA pools and burn addresses.</i>');
  lines.push('<i>Cached ~6h.</i>');

  const text = lines.join('\n');

  const extra = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: '🏠 Overview',  callback_data: `stats:${ca}` },
        { text: '🧑‍🤝‍🧑 Buyers', callback_data: `buyers:${ca}:1` },
        { text: '📊 Holders',   callback_data: `holders:${ca}:1` },
      ]]
    }
  };

  return { text, extra };
}