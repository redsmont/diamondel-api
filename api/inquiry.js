const Redis=require('ioredis');
const fetch=require('node-fetch');

const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;
const LINE_TOKEN=process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TARGETS=(process.env.LINE_PUSH_TARGETS||'').split(',').map(s=>s.trim()).filter(Boolean);
const ADMIN_URL=process.env.ADMIN_URL||'https://redsmont.github.io/diamondel-web/inquiries.html';

let _r=null;
function getRedis(){
  if(_r)return _r;
  const url=process.env.REDIS_URL||process.env.KV_URL;
  if(!url)return null;
  _r=new Redis(url,{
    maxRetriesPerRequest:2,connectTimeout:5000,
    enableReadyCheck:false,lazyConnect:false,
    tls:/^rediss:/.test(url)?{}:undefined
  });
  _r.on('error',e=>console.error('[redis]',e.message));
  return _r;
}

function setCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, DELETE, OPTIONS');
}
function isAdmin(req){
  return !!ADMIN_PASSWORD && (req.headers['x-admin-token']||'')===ADMIN_PASSWORD;
}

function genId(){
  const t=new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14);
  const r=Math.random().toString(36).slice(2,7);
  return 'inq_'+t+'_'+r;
}

function fmt(q){
  try{return (typeof q==='number'?q:parseInt(q,10)).toLocaleString();}
  catch(e){return String(q);}
}

function buildMessage(inq){
  const c=inq.contact||{};
  const partsTxt=(inq.parts||[]).map(p=>'・'+(p.pn||p.partNumber||'—')+(p.qty?' × '+fmt(p.qty)+' pcs':'')).join('\n')||'（無）';
  return '🔔 新詢價  #'+inq.id.slice(-8)+'\n'+
    '━━━━━━━━━━\n'+
    '公司：'+(c.company||'—')+'\n'+
    '姓名：'+(c.name||'—')+'\n'+
    'Email：'+(c.email||'—')+'\n'+
    '電話：'+(c.phone||'—')+'\n'+
    (c.leadTime?'交期：'+c.leadTime+'\n':'')+
    '\n料號：\n'+partsTxt+'\n'+
    (inq.notes?'\n備註：'+inq.notes+'\n':'')+
    '\n→ '+ADMIN_URL;
}

async function notifyLine(inq){
  if(!LINE_TOKEN)return{skipped:true,reason:'LINE_CHANNEL_ACCESS_TOKEN not set'};
  const text=buildMessage(inq).slice(0,4800);
  if(LINE_TARGETS.length>0){
    const results=[];
    for(const to of LINE_TARGETS){
      try{
        const r=await fetch('https://api.line.me/v2/bot/message/push',{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+LINE_TOKEN},
          body:JSON.stringify({to,messages:[{type:'text',text}]}),
          timeout:5000
        });
        const body=r.ok?null:await r.text().catch(()=>null);
        results.push({mode:'push',to,status:r.status,ok:r.ok,body});
      }catch(e){
        results.push({mode:'push',to,error:e.message});
      }
    }
    return{sent:results};
  }
  try{
    const r=await fetch('https://api.line.me/v2/bot/message/broadcast',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+LINE_TOKEN},
      body:JSON.stringify({messages:[{type:'text',text}]}),
      timeout:5000
    });
    const body=r.ok?null:await r.text().catch(()=>null);
    return{sent:[{mode:'broadcast',status:r.status,ok:r.ok,body}]};
  }catch(e){
    return{sent:[{mode:'broadcast',error:e.message}]};
  }
}

async function readBody(req){
  return new Promise((resolve,reject)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
    req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error',reject);
  });
}

async function parseJsonBody(req){
  if(req.body){
    if(typeof req.body==='string')return JSON.parse(req.body);
    return req.body;
  }
  const raw=await readBody(req);
  if(!raw.trim())return {};
  return JSON.parse(raw);
}

module.exports=async(req,res)=>{
  setCors(res);
  if(req.method==='OPTIONS')return res.status(204).end();

  const r=getRedis();
  if(!r)return res.status(503).json({error:'Redis not configured. Set REDIS_URL on Vercel.'});

  try{
    // POST is PUBLIC — customers submit inquiries
    if(req.method==='POST'){
      let body;
      try{body=await parseJsonBody(req);}catch(e){return res.status(400).json({error:'Invalid JSON body'});}
      const parts=Array.isArray(body.parts)?body.parts:[];
      const contact=body.contact||{};
      if(!contact.email&&!contact.phone)return res.status(400).json({error:'Email or phone required'});
      if(!contact.company&&!contact.name)return res.status(400).json({error:'Company or name required'});

      const id=genId();
      const inquiry={
        id,
        createdAt:new Date().toISOString(),
        status:'pending',
        contact:{
          company:String(contact.company||'').slice(0,200),
          name:String(contact.name||'').slice(0,100),
          email:String(contact.email||'').slice(0,200),
          phone:String(contact.phone||'').slice(0,50),
          leadTime:String(contact.leadTime||'').slice(0,100)
        },
        parts:parts.slice(0,50).map(p=>({
          pn:String(p.pn||p.partNumber||'').slice(0,100),
          qty:parseInt(String(p.qty||'0').replace(/[^\d]/g,''),10)||0,
          manufacturer:String(p.manufacturer||p.mfr||'').slice(0,100)
        })),
        notes:String(body.notes||'').slice(0,2000),
        source:body.source==='admin'?'admin':'public',
        internalNotes:[]
      };

      await r.set('inquiry:'+id,JSON.stringify(inquiry));
      await r.zadd('inquiries:all',Date.now(),id);

      const notified=await notifyLine(inquiry);
      return res.json({success:true,id,notified});
    }

    // All following are admin-only
    if(!isAdmin(req))return res.status(401).json({error:'Unauthorized'});

    if(req.method==='GET'){
      const statusFilter=(req.query&&req.query.status)||'';
      const ids=await r.zrange('inquiries:all',0,-1,'REV');
      if(ids.length===0)return res.json({count:0,inquiries:[]});
      const keys=ids.map(id=>'inquiry:'+id);
      const raw=await r.mget(...keys);
      let inquiries=raw.filter(Boolean).map(s=>{try{return JSON.parse(s);}catch(e){return null;}}).filter(Boolean);
      if(statusFilter)inquiries=inquiries.filter(i=>i.status===statusFilter);
      return res.json({count:inquiries.length,inquiries});
    }

    if(req.method==='PATCH'){
      let body;
      try{body=await parseJsonBody(req);}catch(e){return res.status(400).json({error:'Invalid JSON'});}
      const id=body.id;
      if(!id)return res.status(400).json({error:'id required'});
      const raw=await r.get('inquiry:'+id);
      if(!raw)return res.status(404).json({error:'Not found'});
      const inq=JSON.parse(raw);
      const valid=['pending','quoted','won','closed','transferred'];
      if(body.status&&valid.includes(body.status))inq.status=body.status;
      if(body.addNote&&String(body.addNote).trim()){
        inq.internalNotes=inq.internalNotes||[];
        inq.internalNotes.push({at:new Date().toISOString(),text:String(body.addNote).slice(0,2000)});
      }
      if(body.deleteNoteIndex!=null){
        inq.internalNotes=(inq.internalNotes||[]).filter((_,i)=>i!==body.deleteNoteIndex);
      }
      await r.set('inquiry:'+id,JSON.stringify(inq));
      return res.json({success:true,inquiry:inq});
    }

    if(req.method==='DELETE'){
      const id=(req.query&&req.query.id)||'';
      if(!id)return res.status(400).json({error:'id required'});
      await r.del('inquiry:'+id);
      await r.zrem('inquiries:all',id);
      return res.json({success:true});
    }

    res.status(405).json({error:'Method not allowed'});
  }catch(err){
    console.error('[inquiry]',err);
    res.status(500).json({error:err.message});
  }
};
