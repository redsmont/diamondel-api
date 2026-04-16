const {kv}=require('@vercel/kv');
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;

function setCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
}

function isAdmin(req){
  return !!ADMIN_PASSWORD && (req.headers['x-admin-token']||'')===ADMIN_PASSWORD;
}

function kvAvailable(){
  return !!(process.env.KV_REST_API_URL||process.env.KV_URL||process.env.REDIS_URL);
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
  const k=h.toLowerCase().replace(/[\s()_\-\/]+/g,'');
  if(k==='partno'||k==='pn'||k==='part')return 'partNumber';
  if(k==='mfg'||k==='mfr'||k==='manufacturer'||k==='brand')return 'manufacturer';
  if(k==='dc'||k==='datecode')return 'dateCode';
  if(k==='qty'||k==='quantity'||k==='stock')return 'quantity';
  if(/^cost/.test(k))return 'cost';
  if(k.startsWith('date')&&k!=='datecode')return 'dateLogged';
  if(k.startsWith('descrip'))return 'description';
  if(k==='supply'||k==='supplier'||k==='vendor')return 'supplier';
  if(h.trim()==='料號'||k==='internalpn'||k==='pnalt')return 'internalPn';
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
  if(!kvAvailable())return res.status(503).json({error:'KV not configured. Set up Vercel KV/Redis storage for this project.'});

  try{
    if(req.method==='GET'){
      const items=(await kv.get('inventory:items'))||[];
      const updatedAt=(await kv.get('inventory:updatedAt'))||null;
      return res.json({count:items.length,items,updatedAt});
    }

    if(req.method==='POST'){
      // Body is raw CSV text (Content-Type: text/csv or text/plain)
      const body=req.body&&typeof req.body==='string'?req.body:await readBody(req);
      const items=parseCsv(body);
      if(items.length===0)return res.status(400).json({error:'CSV is empty, headers not recognised, or no valid rows'});
      await kv.set('inventory:items',items);
      const now=new Date().toISOString();
      await kv.set('inventory:updatedAt',now);
      return res.json({success:true,count:items.length,updatedAt:now});
    }

    if(req.method==='DELETE'){
      await kv.del('inventory:items');
      await kv.del('inventory:updatedAt');
      return res.json({success:true});
    }

    res.status(405).json({error:'Method not allowed'});
  }catch(err){
    res.status(500).json({error:err.message});
  }
};
