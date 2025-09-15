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

function pct(p) {
  return (p * 100).toFixed(2) + '%';
}

function escapeMarkdownV2(text) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function now() {
  return Date.now();
}

export { sleep, isAddress, shortAddr, num, pct, escapeMarkdownV2, now };