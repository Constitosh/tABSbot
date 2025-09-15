import chains from '../../chains.js';

const BASE_URL = 'https://api.etherscan.io/v2/api';
const API_KEY = process.env.ETHERSCAN_API_KEY;

if (!API_KEY) {
  throw new Error('Missing ETHERSCAN_API_KEY');
}

async function getContractCreator(contractAddress, chain) {
  const config = chains[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);

  const url = `${BASE_URL}?module=contract&action=getcontractcreation&contractaddresses=${contractAddress}&chainid=${config.chainId}&apikey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== '1') throw new Error(data.message || `V2 API error for chain ${chain}`);

  const result = data.result[0];
  return { address: result.contractcreator, tx: result.tx_hash };
}

async function getTokenHolders(contractAddress, chain, page = 1, offset = 100) {
  const config = chains[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);

  const url = `${BASE_URL}?module=token&action=tokenholderlist&contractaddress=${contractAddress}&page=${page}&offset=${offset}&chainid=${config.chainId}&apikey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== '1') throw new Error(data.message || `V2 API error for chain ${chain}`);

  return data.result.map(h => ({
    address: h.TokenHolderAddress.toLowerCase(),
    quantity: BigInt(h.TokenHolderQuantity),
    percent: parseFloat(h.TokenHolderPercent)
  }));
}

async function getTokenTransfers(contractAddress, chain, startBlock = 0, endBlock = 99999999, page = 1, offset = 1000) {
  const config = chains[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);

  const url = `${BASE_URL}?module=account&action=tokentx&contractaddress=${contractAddress}&startblock=${startBlock}&endblock=${endBlock}&page=${page}&offset=${offset}&sort=asc&chainid=${config.chainId}&apikey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== '1') throw new Error(data.message || `V2 API error for chain ${chain}`);

  return data.result
    .map(t => ({
      from: t.from.toLowerCase(),
      to: t.to.toLowerCase(),
      value: BigInt(t.value),
      txHash: t.hash,
      blockNumber: parseInt(t.blockNumber)
    }))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.txHash.localeCompare(b.txHash));
}

export { getContractCreator, getTokenHolders, getTokenTransfers };