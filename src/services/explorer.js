import axios from 'axios';
import chains from '../../chains.js';

const BASE_URL = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const API_KEY = process.env.ETHERSCAN_API_KEY;
const CHAIN_ID = process.env.ETHERSCAN_CHAIN_ID || '2741';

if (!API_KEY) {
  throw new Error('Missing ETHERSCAN_API_KEY');
}

const httpES = axios.create({ baseURL: BASE_URL, timeout: 45_000 });

async function getContractCreator(contractAddress, chain) {
  const config = chains[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);
  if (chain !== 'abstract') throw new Error('Etherscan only used for Abstract (2741)');

  const url = `${BASE_URL}?module=contract&action=getcontractcreation&contractaddresses=${contractAddress}&chainid=${CHAIN_ID}&apikey=${API_KEY}`;
  console.log('[ESV2] getContractCreator:', url);
  try {
    const { data } = await httpES.get('', { params: { module: 'contract', action: 'getcontractcreation', contractaddresses: contractAddress, chainid: CHAIN_ID, apikey: API_KEY } });
    if (data.status !== '1') throw new Error(data.message || `V2 API error for chain ${chain}`);
    const result = data.result[0];
    return { address: result.contractcreator.toLowerCase(), tx: result.tx_hash };
  } catch (e) {
    console.warn('[ESV2] getContractCreator failed:', e.message);
    return { address: '0x0', tx: '' };
  }
}

async function getTokenHolders(contractAddress, chain, page = 1, offset = 100) {
  const config = chains[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);
  if (chain !== 'abstract') throw new Error('Etherscan only used for Abstract (2741)');

  const url = `${BASE_URL}?module=token&action=tokenholderlist&contractaddress=${contractAddress}&page=${page}&offset=${offset}&chainid=${CHAIN_ID}&apikey=${API_KEY}`;
  console.log('[ESV2] getTokenHolders:', url);
  try {
    const { data } = await httpES.get('', { params: { module: 'token', action: 'tokenholderlist', contractaddress: contractAddress, page, offset, chainid: CHAIN_ID, apikey: API_KEY } });
    if (data.status !== '1') throw new Error(data.message || `V2 API error for chain ${chain}`);
    return data.result.map(h => ({
      address: h.TokenHolderAddress.toLowerCase(),
      quantity: BigInt(h.TokenHolderQuantity),
      percent: parseFloat(h.TokenHolderPercent)
    }));
  } catch (e) {
    console.warn('[ESV2] getTokenHolders failed:', e.message);
    return [];
  }
}

async function getTokenTransfers(contractAddress, chain, startBlock = 0, endBlock = 99999999, page = 1, offset = 1000) {
  const config = chains[chain];
  if (!config) throw new Error(`Unknown chain: ${chain}`);
  if (chain !== 'abstract') throw new Error('Etherscan only used for Abstract (2741)');

  const url = `${BASE_URL}?module=account&action=tokentx&contractaddress=${contractAddress}&startblock=${startBlock}&endblock=${endBlock}&page=${page}&offset=${offset}&sort=asc&chainid=${CHAIN_ID}&apikey=${API_KEY}`;
  console.log('[ESV2] getTokenTransfers:', url);
  try {
    const { data } = await httpES.get('', { params: { module: 'account', action: 'tokentx', contractaddress: contractAddress, startblock: startBlock, endblock: endBlock, page, offset, sort: 'asc', chainid: CHAIN_ID, apikey: API_KEY } });
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
  } catch (e) {
    console.warn('[ESV2] getTokenTransfers failed:', e.message);
    return [];
  }
}

export { getContractCreator, getTokenHolders, getTokenTransfers };