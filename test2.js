const fetch = require('node-fetch');
const CLIENT_ID     = '1bae2OqJPsAjAnQ4NiWtaAS8PQm2yePlBJ86FAntSzbUS3K1';
const CLIENT_SECRET = 'fzP2f4Bi8UDZQy3nczjJ54NjYOXdGNSxnmLVIUYHS7JbMIJGrUKD4dj1Vj8YknKp';
(async () => {
  const r = await fetch('https://api.digikey.com/v1/oauth2/token', {
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'client_credentials',client_id:CLIENT_ID,client_secret:CLIENT_SECRET})
  });
  const t = await r.json();
  const s = await fetch('https://api.digikey.com/products/v4/search/keyword',{
    method:'POST',
    headers:{'Authorization':'Bearer '+t.access_token,'X-DIGIKEY-Client-Id':CLIENT_ID,'X-DIGIKEY-Locale-Site':'TW','X-DIGIKEY-Locale-Language':'en','X-DIGIKEY-Locale-Currency':'USD','Content-Type':'application/json'},
    body:JSON.stringify({Keywords:'STM32F103C8T6',Limit:1,Offset:0})
  });
  const d = await s.json();
  if(d.Products && d.Products[0]){
    console.log('=== 所有欄位 ===');
    Object.keys(d.Products[0]).forEach(k=>{
      const v = d.Products[0][k];
      console.log(k+':',(typeof v==='object'?JSON.stringify(v).substring(0,100):v));
    });
  }
})();
