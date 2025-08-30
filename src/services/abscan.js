import axios from 'axios';

const BASE = 'https://abscan.org/api';
const KEY  = process.env.ABSCAN_API_KEY || null;

const qs = (o) =>
  Object.entries(o).filter(([,v])=>v!==undefined&&v!==null&&v!=='')
  .map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

async function callApi(params,{timeout=15000}={}) {
  const url = `${BASE}?${qs({ ...params, apikey: KEY || undefined })}`;
  const { data } = await axios.get(url, { timeout });
  if (!data) throw new Error('Abscan: empty response');
  if (data.status === '0' && data.result === 'Max rate limit reached') {
    throw new Error('Abscan: rate limited');
  }
  return data.result ?? data;
}

export async function getTokenHolders(contractAddress, page=1, offset=100) {
  const result = await callApi({
    module:'token', action:'tokenholderlist',
    contractaddress: contractAddress, page, offset, sort:'desc'
  });

  const rows = Array.isArray(result) ? result : (result?.holders || result?.result || []);
  const totalSupply = num(result?.TokenTotalSupply ?? result?.totalSupply ?? result?.supply);
  const holderCount = toInt(
    result?.HolderCount ?? result?.holderCount ?? result?.total ?? result?.pagination?.total ??
    (Array.isArray(rows) ? rows.length : null)
  );

  const holders = (rows||[]).map(r=>{
    const address = r.HolderAddress || r.TokenHolderAddress || r.Address || r.address || null;
    const balance = num(r.TokenHolderQuantity ?? r.Balance ?? r.balance ?? r.Value ?? 0);
    let percent = r.Percentage != null ? num(r.Percentage) : null;
    if ((percent == null || !isFinite(percent)) && totalSupply > 0) percent = (balance/totalSupply)*100;
    return { address, balance, percent: num(percent) };
  });

  return { holders, totalSupply, holderCount };
}

export async function getTokenTransfers(contractAddress, startblock=0, endblock=999999999, page=1, offset=1000) {
  const result = await callApi({
    module:'account', action:'tokentx',
    contractaddress: contractAddress, page, offset, startblock, endblock, sort:'asc'
  });
  const list = Array.isArray(result) ? result : (result?.result || []);
  return list.map(t=>({
    blockNumber: toInt(t.blockNumber),
    timeStamp: toInt(t.timeStamp),
    hash: t.hash,
    from: (t.from||'').toLowerCase(),
    to: (t.to||'').toLowerCase(),
    value: t.value,
    tokenDecimal: toInt(t.tokenDecimal),
  }));
}

export async function getContractCreator(contractAddress) {
  const result = await callApi({
    module:'contract', action:'getcontractcreation', contractaddresses: contractAddress
  });
  const row = Array.isArray(result) ? result[0] : result;
  return {
    contractAddress: row?.contractAddress || contractAddress,
    creatorAddress: (row?.contractCreator || row?.creator || '').toLowerCase() || null,
    txHash: row?.txHash || null,
  };
}

function num(v){ const n=Number(v); return Number.isFinite(n)?n:0; }
function toInt(v){ const n=parseInt(v,10); return Number.isFinite(n)?n:0; }