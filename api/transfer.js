const Redis=require('ioredis');
const fetch=require('node-fetch');

const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;
const SUPABASE_URL=process.env.SUPABASE_URL;
const SUPABASE_KEY=process.env.SUPABASE_SERVICE_KEY;
const LINE_TOKEN=process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TARGETS=(process.env.LINE_PUSH_TARGETS||'').split(',').map(s=>s.trim()).filter(Boolean);

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
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
}
function isAdmin(req){return !!ADMIN_PASSWORD&&(req.headers['x-admin-token']||'')===ADMIN_PASSWORD;}

async function readBody(req){
  return new Promise((resolve,reject)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
    req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error',reject);
  });
}
async function parseJsonBody(req){
  if(req.body){return typeof req.body==='string'?JSON.parse(req.body):req.body;}
  const raw=await readBody(req);
  return raw.trim()?JSON.parse(raw):{};
}

function sbHeaders(){
  return {'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'return=representation'};
}

async function sbGet(table,query){
  const r=await fetch(SUPABASE_URL+'/rest/v1/'+table+'?'+query,{headers:sbHeaders()});
  return r.json();
}
async function sbPost(table,data){
  const r=await fetch(SUPABASE_URL+'/rest/v1/'+table,{method:'POST',headers:sbHeaders(),body:JSON.stringify(data)});
  return r.json();
}

async function findOrCreateCompany(name){
  if(!name)return null;
  const rows=await sbGet('companies','name=ilike.'+encodeURIComponent('%'+name+'%')+'&select=id,name&limit=1');
  if(Array.isArray(rows)&&rows.length>0)return rows[0].id;
  const created=await sbPost('companies',{name});
  if(Array.isArray(created)&&created.length>0)return created[0].id;
  if(created&&created.id)return created.id;
  return null;
}

async function findOrCreateContact(companyId,contact){
  if(!contact.email&&!contact.name)return null;
  if(contact.email){
    const q='email=ilike.'+encodeURIComponent(contact.email)+'&select=id&limit=1';
    const rows=await sbGet('contacts',q);
    if(Array.isArray(rows)&&rows.length>0)return rows[0].id;
  }
  const newContact={
    company_id:companyId,
    name:contact.name||'',
    email:contact.email||'',
    phone:contact.phone||'',
    title:''
  };
  const created=await sbPost('contacts',newContact);
  if(Array.isArray(created)&&created.length>0)return created[0].id;
  if(created&&created.id)return created.id;
  return null;
}

function parseLeadTime(lt){
  if(!lt)return null;
  const m=lt.match(/(\d+)\s*(week|wk|w|day|d|month|mon|m)/i);
  if(!m)return null;
  const n=parseInt(m[1],10);
  const u=m[2].toLowerCase();
  const now=new Date();
  if(u.startsWith('w'))now.setDate(now.getDate()+n*7);
  else if(u.startsWith('d'))now.setDate(now.getDate()+n);
  else if(u.startsWith('m'))now.setMonth(now.getMonth()+n);
  return now.toISOString().slice(0,10);
}

async function notifyLineTransfer(inquiries,reqCount){
  if(!LINE_TOKEN)return;
  const companies=inquiries.map(i=>(i.contact||{}).company||'—').filter((v,i,a)=>a.indexOf(v)===i);
  const text='📋 批次轉採購通知\n━━━━━━━━━━\n'+
    '共 '+inquiries.length+' 筆詢價 → '+reqCount+' 筆需求\n'+
    '客戶：'+companies.join('、')+'\n'+
    '負責：Laura / Vicky\n'+
    '狀態：待報價\n\n'+
    '→ CRM 系統查看最新需求';
  const msgs=[{type:'text',text:text.slice(0,4800)}];
  if(LINE_TARGETS.length>0){
    for(const to of LINE_TARGETS){
      try{await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+LINE_TOKEN},body:JSON.stringify({to,messages:msgs}),timeout:5000});}catch(e){}
    }
  } else {
    try{await fetch('https://api.line.me/v2/bot/message/broadcast',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+LINE_TOKEN},body:JSON.stringify({messages:msgs}),timeout:5000});}catch(e){}
  }
}

module.exports=async(req,res)=>{
  setCors(res);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  if(!isAdmin(req))return res.status(401).json({error:'Unauthorized'});

  if(!SUPABASE_URL||!SUPABASE_KEY)return res.status(503).json({error:'SUPABASE_URL and SUPABASE_SERVICE_KEY not configured on Vercel'});

  const r=getRedis();
  if(!r)return res.status(503).json({error:'Redis not configured'});

  let body;
  try{body=await parseJsonBody(req);}catch(e){return res.status(400).json({error:'Invalid JSON'});}
  const ids=Array.isArray(body.ids)?body.ids:[];
  if(ids.length===0)return res.status(400).json({error:'ids array required'});

  try{
    // Load all selected inquiries
    const keys=ids.map(id=>'inquiry:'+id);
    const rawList=await r.mget(...keys);
    const inquiries=rawList.filter(Boolean).map(s=>{try{return JSON.parse(s);}catch(e){return null;}}).filter(Boolean);
    if(inquiries.length===0)return res.status(404).json({error:'No valid inquiries found'});

    const results=[];
    let totalReqs=0;

    for(const inq of inquiries){
      if(inq.status==='transferred'){
        results.push({id:inq.id,skipped:true,reason:'already transferred'});
        continue;
      }

      const contact=inq.contact||{};
      const companyId=await findOrCreateCompany(contact.company);
      const contactId=companyId?await findOrCreateContact(companyId,contact):null;
      const reqDate=parseLeadTime(contact.leadTime);
      const parts=inq.parts||[];

      const createdIds=[];
      for(const part of parts){
        if(!part.pn)continue;
        const reqData={
          company_id:companyId,
          contact_id:contactId,
          part_number:part.pn,
          description:(part.manufacturer?part.manufacturer+' ':'')+(part.pn||''),
          quantity:part.qty||0,
          currency:'USD',
          required_date:reqDate,
          sales_rep:'Laura/Vicky',
          note:'[來自網站詢價 #'+inq.id.slice(-8)+']\n'+(inq.notes||''),
          status:'待報價'
        };
        const created=await sbPost('requirements',reqData);
        const newId=(Array.isArray(created)?created[0]:created)?.id;
        if(newId)createdIds.push(newId);
        totalReqs++;
      }

      // If no parts, create one requirement with the notes
      if(parts.length===0){
        const reqData={
          company_id:companyId,
          contact_id:contactId,
          part_number:'（見備註）',
          description:'',
          quantity:0,
          currency:'USD',
          required_date:reqDate,
          sales_rep:'Laura/Vicky',
          note:'[來自網站詢價 #'+inq.id.slice(-8)+']\n'+(inq.notes||''),
          status:'待報價'
        };
        const created=await sbPost('requirements',reqData);
        const newId=(Array.isArray(created)?created[0]:created)?.id;
        if(newId)createdIds.push(newId);
        totalReqs++;
      }

      // Update inquiry status to transferred
      inq.status='transferred';
      inq.internalNotes=inq.internalNotes||[];
      inq.internalNotes.push({
        at:new Date().toISOString(),
        text:'已轉入 CRM 採購系統 → requirements '+(createdIds.length?createdIds.map(id=>('#'+String(id).slice(0,8))).join(', '):'')
      });
      await r.set('inquiry:'+inq.id,JSON.stringify(inq));
      results.push({id:inq.id,success:true,requirementIds:createdIds});
    }

    // LINE notify Simon + Laura + Vicky
    await notifyLineTransfer(inquiries.filter(i=>i.status==='transferred'),totalReqs);

    return res.json({success:true,transferred:results.filter(r=>r.success).length,skipped:results.filter(r=>r.skipped).length,total:totalReqs,results});
  }catch(err){
    console.error('[transfer]',err);
    return res.status(500).json({error:err.message});
  }
};
