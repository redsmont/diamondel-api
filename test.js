const fetch = require('node-fetch');
const CLIENT_ID     = '1bae2OqJPsAjAnQ4NiWtaAS8PQm2yePlBJ86FAntSzbUS3K1';
const CLIENT_SECRET = 'fzP2f4Bi8UDZQy3nczjJ54NjYOXdGNSxnmLVIUYHS7JbMIJGrUKD4dj1Vj8YknKp';
(async () => {
  console.log('Step 1: 取得 Token...');
  const r = await fetch('https://api.digikey.com/v1/oauth2/token', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'client_credentials',client_id:CLIENT_ID,client_secret:CLIENT_SECRET})
  });
  const t = await r.json();
  if(!t.access_token){console.log('❌ Token失敗:',JSON.stringify(t));return;}
  console.log('✅ Token OK!');
  console.log('Step 2: 搜尋 STM32F103C8T6...');
  const s = await fetch('https://api.digikey.com/products/v4/search/keyword',{
    method:'POST',
    headers:{'Authorization':'Bearer '+t.access_token,'X-DIGIKEY-Client-Id':CLIENT_ID,'X-DIGIKEY-Locale-Site':'TW','X-DIGIKEY-Locale-Language':'en','X-DIGIKEY-Locale-Currency':'USD','Content-Type':'application/json'},
    body:JSON.stringify({Keywords:'STM32F103C8T6',Limit:3,Offset:0})
  });
  const d = await s.json();
  const products = d.Products || [];
  if(products.length===0){console.log('搜尋回應:',JSON.stringify(d).substring(0,400));return;}
  console.log('✅ 找到',products.length,'筆！\n');
  products.slice(0,2).forEach((p,i)=>{
    console.log('--- 結果'+(i+1)+' ---');
    console.log('料號:', p.ManufacturerProductNumber);
    console.log('廠牌:', p.Manufacturer?.Name);
    console.log('庫存:', p.QuantityAvailable,'pcs');
    console.log('SPQ: ', p.StandardPackage);
    if(p.PriceBreaks?.length>0){
      console.log('價格:');
      p.PriceBreaks.slice(0,4).forEach(pb=>console.log('  '+String(pb.BreakQuantity).padEnd(8)+' pcs → $'+pb.UnitPrice));
    }
    console.log('');
  });
})();
