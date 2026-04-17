const Redis=require('ioredis');
const crypto=require('crypto');

const LINE_SECRET=process.env.LINE_CHANNEL_SECRET;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;

let _r=null;
function getRedis(){
  if(_r)return _r;
  const url=process.env.REDIS_URL||process.env.KV_URL;
  if(!url)return null;
  _r=new Redis(url,{maxRetriesPerRequest:2,connectTimeout:5000,enableReadyCheck:false,lazyConnect:false,
    tls:/^rediss:/.test(url)?{}:undefined});
  _r.on('error',e=>console.error('[redis]',e.message));
  return _r;
}

function setCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
}

async function readBody(req){
  return new Promise((resolve,reject)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}

module.exports=async(req,res)=>{
  setCors(res);
  if(req.method==='OPTIONS')return res.status(204).end();

  const r=getRedis();

  // POST: LINE webhook events (follow, message, etc.)
  if(req.method==='POST'){
    const rawBody=await readBody(req);

    // Signature verification (optional — skip if no channel secret set)
    if(LINE_SECRET){
      const sig=req.headers['x-line-signature']||'';
      const expected=crypto.createHmac('SHA256',LINE_SECRET).update(rawBody).digest('base64');
      if(sig!==expected)return res.status(403).json({error:'Invalid signature'});
    }

    let body;
    try{body=JSON.parse(rawBody.toString('utf-8'));}catch(e){return res.status(400).json({error:'Invalid JSON'});}

    const events=body.events||[];
    for(const ev of events){
      const userId=ev.source&&ev.source.userId;
      const groupId=ev.source&&ev.source.groupId;
      const type=ev.type; // follow, message, join, etc.

      if(userId&&r){
        const info=JSON.stringify({
          userId,
          groupId:groupId||null,
          displayName:ev.source.displayName||null,
          type,
          at:new Date().toISOString()
        });
        await r.hset('line:users',userId,info);
      }
      if(groupId&&r){
        await r.hset('line:groups',groupId,JSON.stringify({groupId,at:new Date().toISOString()}));
      }
    }
    return res.status(200).json({});
  }

  // GET: admin lists captured User IDs (for copying to LINE_PUSH_TARGETS)
  if(req.method==='GET'){
    if(!ADMIN_PASSWORD||(req.headers['x-admin-token']||'')!==ADMIN_PASSWORD){
      // Also allow query string token for easy browser access
      const qt=(req.query&&req.query.token)||'';
      if(qt!==ADMIN_PASSWORD)return res.status(401).json({error:'Unauthorized. Use ?token=YOUR_ADMIN_PASSWORD'});
    }
    if(!r)return res.status(503).json({error:'Redis not configured'});
    const users=await r.hgetall('line:users')||{};
    const groups=await r.hgetall('line:groups')||{};
    const userList=Object.entries(users).map(([k,v])=>{try{return JSON.parse(v);}catch(e){return{userId:k};}});
    const groupList=Object.entries(groups).map(([k,v])=>{try{return JSON.parse(v);}catch(e){return{groupId:k};}});
    return res.json({
      users:userList,
      groups:groupList,
      hint:'Copy the userId values you want into LINE_PUSH_TARGETS env var (comma-separated)'
    });
  }

  res.status(405).json({error:'Method not allowed'});
};
