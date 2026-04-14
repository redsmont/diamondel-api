const express=require('express');
const fetch=require('node-fetch');
const cors=require('cors');
const app=express();
app.use(cors());
app.use(express.json());
const DK_ID=process.env.DIGIKEY_CLIENT_ID;
const DK_SECRET=process.env.DIGIKEY_CLIENT_SECRET;
let token=null,tokenTs=0;
async function getToken(){
  if(token&&Date.now()-tokenTs<25*60*1000)return token;
  const r=await fetch('https://api.digikey.com/v1/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:DK_ID,client_secret:DK_SECRET})});
  const d=await r.json();
  token=d.access_token;tokenTs=Date.now();return token;
}
app.get('/search',async(req,res)=>{
  const q=(req.query.q||'').trim();
  if(!q)return res.json({error:'請輸入料號',results:[]});
  try{
    const t=await getToken();
    const s=await fetch('https://api.digikey.com/products/v4/search/keyword',{method:'POST',headers:{'Authorization':'Bearer '+t,'X-DIGIKEY-Client-Id':DK_ID,'X-DIGIKEY-Locale-Site':'TW','X-DIGIKEY-Locale-Language':'en','X-DIGIKEY-Locale-Currency':'USD','Content-Type':'application/json'},body:JSON.stringify({Keywords:q,Limit:5,Offset:0})});
    const d=await s.json();
    const results=(d.Products||[]).map(p=>{
      const v=(p.ProductVariations||[])[0]||{};
      return {
        partNumber:p.ManufacturerProductNumber,
        manufacturer:p.Manufacturer?.Name||'',
        description:p.Description?.ProductDescription||'',
        packageType:v.PackageType?.Name||'',
        spq:v.StandardPackage||null,
        moq:v.MinimumOrderQuantity||1,
        quantity:v.QuantityAvailableforPackageType??p.QuantityAvailable??0,
        status:p.ProductStatus?.Status||'Active',
        leadWeeks:p.ManufacturerLeadWeeks||null,
        rohsStatus:p.Classifications?.RohsStatus||'',
        pricingTiers:(v.StandardPricing||[]).map(pb=>({breakQty:pb.BreakQuantity,unitPrice:pb.UnitPrice}))
      };
    });
    results.sort((a,b)=>b.quantity-a.quantity);
    const forCustomer=results.map(({pricingTiers,...r})=>r);
    res.json({keyword:q,count:results.length,results:forCustomer});
  }catch(err){
    res.status(500).json({error:err.message,results:[]});
  }
});
app.get('/admin/search',async(req,res)=>{
  const q=(req.query.q||'').trim();
  if(req.headers['x-admin-secret']!==process.env.ADMIN_SECRET)return res.status(401).json({error:'未授權'});
  try{
    const t=await getToken();
    const s=await fetch('https://api.digikey.com/products/v4/search/keyword',{method:'POST',headers:{'Authorization':'Bearer '+t,'X-DIGIKEY-Client-Id':DK_ID,'X-DIGIKEY-Locale-Site':'TW','X-DIGIKEY-Locale-Language':'en','X-DIGIKEY-Locale-Currency':'USD','Content-Type':'application/json'},body:JSON.stringify({Keywords:q,Limit:5,Offset:0})});
    const d=await s.json();
    const results=(d.Products||[]).map(p=>{
      const v=(p.ProductVariations||[])[0]||{};
      return {source:'digikey',partNumber:p.ManufacturerProductNumber,manufacturer:p.Manufacturer?.Name||'',description:p.Description?.ProductDescription||'',packageType:v.PackageType?.Name||'',spq:v.StandardPackage||null,moq:v.MinimumOrderQuantity||1,quantity:v.QuantityAvailableforPackageType??p.QuantityAvailable??0,status:p.ProductStatus?.Status||'Active',leadWeeks:p.ManufacturerLeadWeeks||null,rohsStatus:p.Classifications?.RohsStatus||'',pricingTiers:(v.StandardPricing||[]).map(pb=>({breakQty:pb.BreakQuantity,unitPrice:pb.UnitPrice})),lowestPrice:v.StandardPricing?.length>0?Math.min(...v.StandardPricing.map(pb=>pb.UnitPrice)):null};
    });
    results.sort((a,b)=>b.quantity-a.quantity);
    res.json({keyword:q,count:results.length,results});
  }catch(err){res.status(500).json({error:err.message});}
});
app.get('/health',(req,res)=>res.json({status:'ok'}));
app.listen(3000,()=>console.log('✅ 信東電子後端啟動！\n   http://localhost:3000/search?q=STM32F103C8T6'));
