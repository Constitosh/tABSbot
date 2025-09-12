// src/renderers_index.js
// Renders the “Index” view (holder distribution) — LP/CA/burn already excluded in worker.

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')  // important for labels like "<0.01%"
    .replace(/>/g, '&gt;');
}

function pct(n, digits = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '+0.00%';
  return (x >= 0 ? '+' : '') + x.toFixed(digits) + '%';
}

function bar(count, total) {
  // 10-slot bar, scaled to filtered population
  const t = Math.max(1, Number(total || 0));
  const filled = Math.max(0, Math.min(10, Math.round((Number(count) / t) * 10)));
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`;
}

export function renderIndexView(data) {
  const holders = Number(data?.holdersCount || 0);
  const top10 = Number(data?.top10CombinedPct || 0);
  const gini  = Number(data?.gini || 0);

  const lines = [];
  lines.push('📈 <b>Index</b>', '');
  lines.push(`Holders: <b>${holders.toLocaleString()}</b>`);
  lines.push(`Top-10 combined: <b>${esc(pct(top10))}</b>`);
  lines.push(`Inequality (Gini): <b>${gini.toFixed(4)}</b> <i>(0=fair • 1=concentrated)</i>`);
  lines.push('');

  // % of supply buckets
  if (Array.isArray(data?.pctBuckets) && data.pctBuckets.length) {
    lines.push('Distribution by % of supply');
    const total = data.pctBuckets.reduce((a, b) => a + Number(b.count || 0), 0);
    for (const b of data.pctBuckets) {
      const label = esc(b.label);
      const cnt   = Number(b.count || 0);
      lines.push(`• ${label} — <b>${cnt}</b> ${bar(cnt, total)}`);
    }
    lines.push('');
  }

  // Value buckets (only if computed)
  if (Array.isArray(data?.valueBuckets) && data.valueBuckets.length) {
    lines.push('Distribution by estimated value');
    const total = data.valueBuckets.reduce((a, b) => a + Number(b.count || 0), 0);
    for (const b of data.valueBuckets) {
      const label = esc(b.label);
      const cnt   = Number(b.count || 0);
      lines.push(`• ${label} — <b>${cnt}</b> ${bar(cnt, total)}`);
    }
    lines.push('');
  }

  // Footer
  if (data?._note) lines.push(`<i>${esc(data._note)}</i>`);
  lines.push('<i>Cached ~6h.</i>');

  const text = lines.join('\n');

  const extra = {
    reply_markup: {
      inline_keyboard: [[
        { text:'🏠 Overview', callback_data:`stats:${esc(data?.token || '')}` },
        { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${esc(data?.token || '')}:1` },
        { text:'📊 Holders', callback_data:`holders:${esc(data?.token || '')}:1` },
      ]]
    },
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  return { text, extra };
}