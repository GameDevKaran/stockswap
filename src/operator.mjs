// Adapted from PlanPause's private operator gate; bind StockSwap tokens to its origin.
import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
const hashed=value=>createHash('sha256').update(value).digest();
export function operatorAccess({required,code,origin,now=()=>Date.now()}){
 if(required&&(typeof code!=='string'||code.length<32||code.length>256))throw Error('Live AI controls require a private operator access code of 32–256 characters');
 const cookieName='stockswap_operator',signature=value=>createHmac('sha256',code).update('stockswap:'+origin+':'+value).digest('hex');
 return{
  allowed(req){
   if(!required)return true;
   const value=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1),match=/^(\d{13})\.([a-f0-9]{64})$/.exec(value||'');
   return Boolean(match&&Number(match[1])>now()&&Number(match[1])<=now()+3600000&&timingSafeEqual(Buffer.from(signature(match[1]),'hex'),Buffer.from(match[2],'hex')));
  },
  unlock(value){
   if(!required||typeof value!=='string'||value.length>256||!timingSafeEqual(hashed(value),hashed(code)))return null;
   const expiry=String(now()+3600000);
   return `${cookieName}=${expiry}.${signature(expiry)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${origin.startsWith('https:')?'; Secure':''}`;
  }
 };
}
