const fs=require('fs');
const path=require('path');
module.exports=(req,res)=>{
  const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(html);
};
