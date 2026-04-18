const webpush=require('web-push');
const fetch=require('node-fetch');

const VAPID_PUBLIC=process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE=process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL=process.env.VAPID_EMAIL||'mailto:sale@diamondel.com';
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;
const SUPABASE_URL=process.env.SUPABASE_URL;
const SUPABASE_KEY=process.env.SUPABASE_SERVICE_KEY;

function setCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
}

function sbHeaders(){
  return {'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json'};
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
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});

  if(!ADMIN_PASSWORD||(req.headers['x-admin-token']||'')!==ADMIN_PASSWORD){
    return res.status(401).json({error:'Unauthorized'});
  }

  if(!VAPID_PUBLIC||!VAPID_PRIVATE){
    return res.status(503).json({error:'VAPID keys not configured'});
  }
  if(!SUPABASE_URL||!SUPABASE_KEY){
    return res.status(503).json({error:'Supabase not configured'});
  }

  webpush.setVapidDetails(VAPID_EMAIL,VAPID_PUBLIC,VAPID_PRIVATE);

  let body;
  try{
    const raw=req.body&&typeof req.body==='string'?req.body:(req.body?JSON.stringify(req.body):await readBody(req));
    body=JSON.parse(raw);
  }catch(e){return res.status(400).json({error:'Invalid JSON'});}

  // body: {targets:['email1','email2'] or 'all', title, body, url}
  const targets=body.targets||'all';
  const payload=JSON.stringify({
    title:body.title||'信東電子 CRM',
    body:body.body||'您有新通知',
    url:body.url||'/home.html'
  });

  try{
    // Fetch subscriptions from Supabase
    let url=SUPABASE_URL+'/rest/v1/push_subscriptions?select=user_email,subscription';
    if(targets!=='all'&&Array.isArray(targets)){
      const emails=targets.map(e=>'%22'+encodeURIComponent(e)+'%22').join(',');
      url+='&user_email=in.('+targets.map(e=>encodeURIComponent(e)).join(',')+')';
    }
    const r=await fetch(url,{headers:sbHeaders()});
    const subs=await r.json();

    if(!Array.isArray(subs)||subs.length===0){
      return res.json({success:true,sent:0,message:'No subscriptions found'});
    }

    let sent=0,failed=0;
    for(const row of subs){
      try{
        await webpush.sendNotification(row.subscription,payload);
        sent++;
      }catch(e){
        failed++;
        if(e.statusCode===404||e.statusCode===410){
          // Subscription expired, remove it
          await fetch(SUPABASE_URL+'/rest/v1/push_subscriptions?id=eq.'+row.id,{method:'DELETE',headers:sbHeaders()});
        }
      }
    }
    return res.json({success:true,sent,failed,total:subs.length});
  }catch(e){
    return res.status(500).json({error:e.message});
  }
};
