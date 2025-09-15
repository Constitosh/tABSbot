// src/renderers.js
export const renderOverview = (data) => {
  const { market, top10CombinedPct, burnedPct, holdersCount, creator, first20Buyers, holdersTop20, updatedAt } = data;
  let text = `<b>${market?.name || 'Unknown'} (${market?.symbol || '?'})</b>\n`;
  text += `<code>${data.tokenAddress}</code>\n\n`;
  text += market ? `💰 Price: $${market.priceUsd.toFixed(6)}\n` : '💰 Price: N/A\n';
  text += market ? `📊 24h Vol: $${market.volume24h.toLocaleString()}\n` : '📊 24h Vol: N/A\n';
  text += market ? `📈 1h: ${market.priceChange.h1.toFixed(2)}% | 6h: ${market.priceChange.h6.toFixed(2)}% | 24h: ${market.priceChange.h24.toFixed(2)}%\n` : '📈 Price Change: N/A\n';
  text += market ? `💎 FDV: $${market.marketCap.toLocaleString()}\n\n` : '💎 FDV: N/A\n\n';
  text += `<b>Creator:</b> <code>${creator.address.slice(0, 6)}...${creator.address.slice(-4)}</code> (${creator.percent.toFixed(2)}%)\n`;
  text += `<b>Top 10:</b> ${top10CombinedPct.toFixed(2)}%\n`;
  text += `<b>Burned:</b> ${burnedPct.toFixed(2)}%\n`;
  text += `<b>Holders:</b> ${holdersCount || 'N/A'}\n\n`;
  text += `<b>First 20 Buyers:</b>\n${renderFirst20Buyers(first20Buyers || [])}\n\n`;
  text += `<b>Top 20 Holders:</b>\n${renderTop20Holders(holdersTop20 || [])}\n\n`;
  text += `🕐 Updated: ${new Date(updatedAt).toLocaleString()}`;
  return {
    text,
    extra: {
      reply_markup: {
        inline_keyboard: [[
          { text: '🏠 Overview', callback_data: `stats:${data.tokenAddress}` },
          { text: '🧑‍🤝‍🧑 Buyers', callback_data: `buyers:${data.tokenAddress}:1` },
          ...(holdersTop20.length ? [{ text: '📊 Holders', callback_data: `holders:${data.tokenAddress}:1` }] : []),
          { text: '🔄 Refresh', callback_data: `refresh:${data.chain}:${data.tokenAddress}` }
        ]]
      }
    }
  };
};

export const renderBuyers = (data, page = 1) => {
  const text = `<b>First 20 Buyers (Page ${page})</b>\n${renderFirst20Buyers(data.first20Buyers || [])}`;
  return { text, extra: { reply_markup: { inline_keyboard: [[
    { text: '🏠 Overview', callback_data: `stats:${data.tokenAddress}` },
    { text: '🔄 Refresh', callback_data: `refresh:${data.chain}:${data.tokenAddress}` }
  ]] } } };
};

export const renderHolders = (data, page = 1) => {
  const text = `<b>Top 20 Holders (Page ${page})</b>\n${renderTop20Holders(holdersTop20 || [])}`;
  return { text, extra: { reply_markup: { inline_keyboard: [[
    { text: '🏠 Overview', callback_data: `stats:${data.tokenAddress}` },
    { text: '🔄 Refresh', callback_data: `refresh:${data.chain}:${data.tokenAddress}` }
  ]] } } };
};

export const renderAbout = () => ({
  text: 'tABS Tools: Token analytics bot',
  extra: {}
});