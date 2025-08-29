export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const isAddress = (s='') => /^0x[a-fA-F0-9]{40}$/.test(s);
export const shortAddr = a => a ? a.slice(0,6)+'…'+a.slice(-4) : '';
export const pct = n => (n ?? 0).toFixed(2) + '%';
export const num = (n, d=2) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: d });
export const now = () => Math.floor(Date.now()/1000);
