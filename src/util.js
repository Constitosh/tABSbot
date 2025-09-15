function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'N/A';
}

function num(n) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function escapeMarkdownV2(text) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function isKnownContract(addr) {
  // Expand with chain-specific routers/LPs
  const known = [
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45'  // Uniswap V3 Router
  ];
  return known.some(k => k.toLowerCase() === addr.toLowerCase());
}

function now() {
  return Date.now();
}

module.exports = { sleep, isAddress, shortAddr, num, escapeMarkdownV2, isKnownContract, now };
