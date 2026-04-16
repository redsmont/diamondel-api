const Redis=require('ioredis');
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;

// Module-scope client; reused across warm invocations
let client=null;
function getClient(){
  if(client)return client;
  const url=process.env.REDIS_URL||process.env.KV_URL;
  if(!url)return null;
  client=new Redis(url,{
    maxRetriesPerRequest:2,
    connectTimeout:5000,
    enableReadyCheck:false,
    lazyConnect:false,
    tls:/^rediss:/.test(url)?{}:undefined
  });
  client.on('error',e=>{console.error('[redis]',e.message);});
  return client;
}

function redisAvailable(){return !!(process.env.REDIS_URL||process.env.KV_URL);}

function setCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
}

function isAdmin(req){
  return !!ADMIN_PASSWORD && (req.headers['x-admin-token']||'')===ADMIN_PASSWORD;
}

// RFC 4180-ish single line parser (handles quoted values with embedded commas)
function parseCsvLine(line){
  const out=[];let cur='';let inQ=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){
      if(inQ&&line[i+1]==='"'){cur+='"';i++;}
      else inQ=!inQ;
    } else if(c===','&&!inQ){
      out.push(cur);cur='';
    } else {
      cur+=c;
    }
  }
  out.push(cur);
  return out.map(s=>s.trim());
}

// Normalize header name to a canonical internal key
function canonicalHeader(h){
  const raw=h.trim();
  const k=raw.toLowerCase().replace(/[\s()_\-\/]+/g,'');
  if(k==='partno'||k==='pn'||k==='part')return 'partNumber';
  if(k==='mfg'||k==='mfr'||k==='manufacturer'||k==='brand')return 'manufacturer';
  if(k==='dc'||k==='datecode')return 'dateCode';
  if(k==='qty'||k==='quantity'||k==='stock')return 'quantity';
  if(/^cost/.test(k))return 'cost';
  if(k.startsWith('date')&&k!=='datecode')return 'dateLogged';
  if(k.startsWith('descrip'))return 'description';
  if(k==='supply'||k==='supplier'||k==='vendor')return 'supplier';
  if(raw==='料號'||k==='internalpn'||k==='pnalt')return 'internalPn';
  return null; // unknown, ignore
}

function parseCsv(text){
  const lines=text.split(/\r?\n/).map(l=>l.replace(/^\uFEFF/,'')).filter(l=>l.trim().length>0);
  if(lines.length<2)return [];
  const headers=parseCsvLine(lines[0]).map(canonicalHeader);
  const items=[];
  for(let i=1;i<lines.length;i++){
    const cols=parseCsvLine(lines[i]);
    const row={source:'inventory'};
    headers.forEach((h,idx)=>{
      if(!h)return;
      row[h]=cols[idx]||'';
    });
    if(!row.partNumber)continue;
    row.quantity=parseInt(String(row.quantity||'0').replace(/[^\d]/g,''),10)||0;
    row.cost=parseFloat(String(row.cost||'0').replace(/[^\d.]/g,''))||0;
    row.currency='USD';
    row.moq=1;
    items.push(row);
  }
  return items;
}

async function readBody(req){
  return new Promise((resolve,reject)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
    req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error',reject);
  });
}

module.exports=async(req,res)=>{
  setCors(res);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(!isAdmin(req))return res.status(401).json({error:'Unauthorized'});
  if(!redisAvailable())return res.status(503).json({error:'Redis not configured. Set REDIS_URL on Vercel and redeploy.'});

  const r=getClient();
  if(!r)return res.status(503).json({error:'Redis client init failed'});

  try{
    if(req.method==='GET'){
      const [itemsRaw,updatedAt]=await Promise.all([
        r.get('inventory:items'),
        r.get('inventory:updatedAt')
      ]);
      const items=itemsRaw?JSON.parse(itemsRaw):[];
      return res.json({count:items.length,items,updatedAt:updatedAt||null});
    }

    if(req.method==='POST'){
      const body=req.body&&typeof req.body==='string'?req.body:await readBody(req);
      const items=parseCsv(body);
      if(items.length===0)return res.status(400).json({error:'CSV is empty, headers not recognised, or no valid rows'});
      const now=new Date().toISOString();
      await Promise.all([
        r.set('inventory:items',JSON.stringify(items)),
        r.set('inventory:updatedAt',now)
      ]);
      return res.json({success:true,count:items.length,updatedAt:now});
    }

    if(req.method==='DELETE'){
      await Promise.all([
        r.del('inventory:items'),
        r.del('inventory:updatedAt')
      ]);
      return res.json({success:true});
    }

    res.status(405).json({error:'Method not allowed'});
  }catch(err){
    res.status(500).json({error:err.message});
  }
};
