const fetch=require('node-fetch');
const DK_ID=process.env.DIGIKEY_CLIENT_ID;
const DK_SECRET=process.env.DIGIKEY_CLIENT_SECRET;
const MOUSER_KEY=process.env.MOUSER_API_KEY;
let tok=null,tokTs=0;
async function getToken(){
  if(tok&&Date.now()-tokTs<25*60*1000)return tok;
  const r=await fetch('https://api.digikey.com/v1/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:DK_ID,client_secret:DK_SECRET})});
  const d=await r.json();
  tok=d.access_token;tokTs=Date.now();return tok;
}

async function searchDigiKey(q){
  if(!DK_ID||!DK_SECRET)return{source:'digikey',error:'DigiKey credentials not configured',results:[]};
  try{
    const t=await getToken();
    const s=await fetch('https://api.digikey.com/products/v4/search/keyword',{method:'POST',headers:{'Authorization':'Bearer '+t,'X-DIGIKEY-Client-Id':DK_ID,'X-DIGIKEY-Locale-Site':'TW','X-DIGIKEY-Locale-Language':'en','X-DIGIKEY-Locale-Currency':'USD','Content-Type':'application/json'},body:JSON.stringify({Keywords:q,Limit:5,Offset:0})});
    const d=await s.json();
    const results=(d.Products||[]).map(p=>{
      const v=(p.ProductVariations||[])[0]||{};
      const pricing=(v.StandardPricing||[]).map(pb=>({qty:pb.BreakQuantity,price:pb.UnitPrice})).sort((a,b)=>a.qty-b.qty);
      const unitPrice=typeof p.UnitPrice==='number'?p.UnitPrice:(pricing[0]?pricing[0].price:null);
      return{source:'digikey',partNumber:p.ManufacturerProductNumber,manufacturer:p.Manufacturer?.Name||'',description:p.Description?.ProductDescription||'',packageType:v.PackageType?.Name||'',spq:v.StandardPackage||null,moq:v.MinimumOrderQuantity||1,quantity:v.QuantityAvailableforPackageType||p.QuantityAvailable||0,status:p.ProductStatus?.Status||'Active',leadWeeks:p.ManufacturerLeadWeeks||null,rohsStatus:p.Classifications?.RohsStatus||'',unitPrice,priceBreaks:pricing,currency:'USD'};
    });
    results.sort((a,b)=>b.quantity-a.quantity);
    return{source:'digikey',count:results.length,results};
  }catch(err){return{source:'digikey',error:err.message,results:[]};}
}

async function searchMouser(q){
  if(!MOUSER_KEY)return{source:'mouser',error:'Mouser API key not configured',results:[]};
  try{
    const s=await fetch('https://api.mouser.com/api/v1/search/keyword?apiKey='+encodeURIComponent(MOUSER_KEY),{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({SearchByKeywordRequest:{keyword:q,records:5,startingRecord:0,searchOptions:'',searchWithYourSignUpLanguage:'false'}})});
    const d=await s.json();
    if(d.Errors&&d.Errors.length){return{source:'mouser',error:d.Errors.map(e=>e.Message||e.Code).join('; '),results:[]};}
    const parts=(d.SearchResults&&d.SearchResults.Parts)||[];
    const results=parts.map(p=>{
      const qty=parseInt((p.AvailabilityInStock||p.Availability||'0').toString().replace(/[^\d]/g,''),10)||0;
      const moq=parseInt(p.Min||'1',10)||1;
      const spq=parseInt(p.Mult||p.StandardCost||'0',10)||null;
      const pricing=(p.PriceBreaks||[]).map(pb=>({qty:pb.Quantity,price:parseFloat(String(pb.Price||'').replace(/[^\d.]/g,''))||0})).filter(pb=>pb.price>0).sort((a,b)=>a.qty-b.qty);
      const currency=(p.PriceBreaks&&p.PriceBreaks[0]&&p.PriceBreaks[0].Currency)||'USD';
      const unitPrice=pricing[0]?pricing[0].price:null;
      return{source:'mouser',partNumber:p.ManufacturerPartNumber||'',manufacturer:p.Manufacturer||'',description:p.Description||'',packageType:p.Package||'',spq,moq,quantity:qty,status:p.LifecycleStatus||'Active',leadWeeks:p.LeadTime?parseInt(p.LeadTime,10)||null:null,rohsStatus:p.ROHSStatus||'',mouserPartNumber:p.MouserPartNumber||'',productUrl:p.ProductDetailUrl||'',unitPrice,priceBreaks:pricing,currency};
    });
    results.sort((a,b)=>b.quantity-a.quantity);
    return{source:'mouser',count:results.length,results};
  }catch(err){return{source:'mouser',error:err.message,results:[]};}
}

const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;

// Strip market-API-only sensitive fields (prices, source label)
function stripMarket(arr){return (arr||[]).map(p=>{const{source,unitPrice,priceBreaks,currency,...rest}=p;return rest;});}
// Strip inventory-only sensitive fields but KEEP source='inventory' so frontend can badge it
function stripInventory(arr){return (arr||[]).map(p=>{const{cost,supplier,internalPn,dateLogged,currency,...rest}=p;return rest;});}

let _redis=null;
function getRedis(){
  if(_redis)return _redis;
  const url=process.env.REDIS_URL||process.env.KV_URL;
  if(!url)return null;
  const Redis=require('ioredis');
  _redis=new Redis(url,{
    maxRetriesPerRequest:2,
    connectTimeout:5000,
    enableReadyCheck:false,
    lazyConnect:false,
    tls:/^rediss:/.test(url)?{}:undefined
  });
  _redis.on('error',e=>console.error('[redis]',e.message));
  return _redis;
}

async function searchInventory(q){
  try{
    const r=getRedis();
    if(!r)return{source:'inventory',count:0,results:[]};
    const raw=await r.get('inventory:items');
    const items=raw?JSON.parse(raw):[];
    const needle=q.toUpperCase();
    const matches=items.filter(p=>{
      const pn=(p.partNumber||'').toUpperCase();
      const alt=(p.internalPn||'').toUpperCase();
      return pn.includes(needle)||alt.includes(needle);
    });
    matches.sort((a,b)=>(b.quantity||0)-(a.quantity||0));
    return{source:'inventory',count:matches.length,results:matches};
  }catch(err){
    return{source:'inventory',error:err.message,results:[]};
  }
}

module.exports=async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS')return res.status(204).end();

  const q=(req.query.q||'').trim();
  if(!q)return res.json({error:'請輸入料號',count:0,results:[]});

  const token=req.headers['x-admin-token']||'';
  const isAdmin=!!ADMIN_PASSWORD && token===ADMIN_PASSWORD;

  const [digikey,mouser,inventory]=await Promise.all([searchDigiKey(q),searchMouser(q),searchInventory(q)]);

  if(isAdmin){
    const combined=[...(inventory.results||[]),...(digikey.results||[]),...(mouser.results||[])];
    return res.json({keyword:q,sources:{inventory,digikey,mouser},count:combined.length,results:combined});
  }

  const combined=[...stripInventory(inventory.results),...stripMarket(digikey.results),...stripMarket(mouser.results)];
  // Keep inventory at top, then market results by quantity desc
  combined.sort((a,b)=>{
    const ao=a.source==='inventory'?0:1;
    const bo=b.source==='inventory'?0:1;
    if(ao!==bo)return ao-bo;
    return (b.quantity||0)-(a.quantity||0);
  });
  res.json({keyword:q,count:combined.length,results:combined});
};
