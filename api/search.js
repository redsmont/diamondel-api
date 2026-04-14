const fetch=require('node-fetch');
const DK_ID=process.env.DIGIKEY_CLIENT_ID;
const DK_SECRET=process.env.DIGIKEY_CLIENT_SECRET;
let tok=null,tokTs=0;
async function getToken(){
  if(tok&&Date.now()-tokTs<25*60*1000)return tok;
  const r=await fetch('https://api.digikey.com/v1/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:DK_ID,client_secret:DK_SECRET})});
  const d=await r.json();
  tok=d.access_token;tokTs=Date.now();return tok;
}
module.exports=async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  const q=(req.query.q||'').trim();
  if(!q)return res.json({error:'請輸入料號',results:[]});
  try{
    const t=await getToken();
    const s=await fetch('https://api.digikey.com/products/v4/search/keyword',{method:'POST',headers:{'Authorization':'Bearer '+t,'X-DIGIKEY-Client-Id':DK_ID,'X-DIGIKEY-Locale-Site':'TW','X-DIGIKEY-Locale-Language':'en','X-DIGIKEY-Locale-Currency':'USD','Content-Type':'application/json'},body:JSON.stringify({Keywords:q,Limit:5,Offset:0})});
    const d=await s.json();
    const results=(d.Products||[]).map(p=>{
      const v=(p.ProductVariations||[])[0]||{};
      return{partNumber:p.ManufacturerProductNumber,manufacturer:p.Manufacturer?.Name||'',description:p.Description?.ProductDescription||'',packageType:v.PackageType?.Name||'',spq:v.StandardPackage||null,moq:v.MinimumOrderQuantity||1,quantity:v.QuantityAvailableforPackageType||p.QuantityAvailable||0,status:p.ProductStatus?.Status||'Active',leadWeeks:p.ManufacturerLeadWeeks||null,rohsStatus:p.Classifications?.RohsStatus||''};
    });
    results.sort((a,b)=>b.quantity-a.quantity);
    res.json({keyword:q,count:results.length,results});
  }catch(err){res.status(500).json({error:err.message,results:[]});}
};