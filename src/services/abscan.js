import axios from 'axios';
import 'dotenv/config';

const V2 = !!process.env.ETHERSCAN_V2_BASE;
const BASE = process.env.ETHERSCAN_V2_BASE || process.env.ABSCAN_BASE;
const APIKEY = process.env.ETHERSCAN_API_KEY || process.env.ABSCAN_API_KEY;

// V2 style uses chainid=2741; V1 uses a dedicated subdomain base.
const CHAIN_PARAMS = V2 ? { chainid: 2741 } : {}; // Abstract mainnet chain id. Docs: https://docs.etherscan.io/etherscan-v2/supported-chains . :contentReference[oaicite:7]{index=7}

// GET helper
async function get(params) {
  const url = BASE;
  const query = new URLSearchParams({ ...params, apikey: APIKEY, ...CHAIN_PARAMS });
  const { data } = await axios.get(url + (V2 ? '' : ''), { params: Object.fromEntries(query), timeout: 15000 });
  if (data?.status === '0' && data?.message && data?.result) {
    // Etherscan sometimes returns status 0 with message but still a result; handle loosely
  }
  return data?.result;
}

// 1) Contract creator (deployer)
export async function getContractCreator(contractAddress) {
  // module=contract&action=getcontractcreation
  // Docs: https://docs.etherscan.io/api-endpoints/contracts#get-contract-creator-and-creation-tx-hash . :contentReference[oaicite:8]{index=8}
  const res = await get({
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: contractAddress
  });
  const item = Array.isArray(res) ? res[0] : null;
  return item ? { creatorAddress: item.contractCreator, txHash: item.txHash } : null;
}

// 2) Token holders (top N)
export async function getTokenHolders(contractAddress, page=1, offset=100) {
  // module=token&action=tokenholderlist
  // Docs (Etherscan/Optimism examples): https://docs.etherscan.io/api-endpoints/tokens#get-token-holder-list-by-contract-address . :contentReference[oaicite:9]{index=9}
  const res = await get({
    module: 'token',
    action: 'tokenholderlist',
    contractaddress: contractAddress,
    page, offset
  });
  // Returns array with fields: TokenHolderAddress, TokenHolderQuantity, Percentage
  return Array.isArray(res) ? res : [];
}

// 3) Token transfers (chronological)
export async function getTokenTransfers(contractAddress, startBlock=0, endBlock=999999999, page=1, offset=1000) {
  // module=account&action=tokentx
  // Docs: Accounts endpoints (tx lists) are standard across Etherscan explorers. :contentReference[oaicite:10]{index=10}
  const res = await get({
    module: 'account',
    action: 'tokentx',
    contractaddress: contractAddress,
    startblock: startBlock,
    endblock: endBlock,
    page, offset,
    sort: 'asc'
  });
  return Array.isArray(res) ? res : [];
}
