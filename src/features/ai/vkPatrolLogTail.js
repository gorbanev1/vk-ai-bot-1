import {openSync,readSync,fstatSync,closeSync} from 'node:fs';
// Read only the required tail; keep UTF-8 bytes intact across chunk boundaries.
export function readJsonlTail(path,count=20){
 const limit=Math.max(0,Math.min(1000,Math.trunc(Number(count)||0)));
 if(!limit)return [];
 let fd;const rows=[];let carry=Buffer.alloc(0);
 try{
  fd=openSync(path,'r');let position=fstatSync(fd).size;
  const parse=bytes=>{try{const value=JSON.parse(bytes.toString('utf8'));if(value&&typeof value==='object')rows.push(value);}catch{}};
  while(position>0&&rows.length<limit){
   const size=Math.min(position,65536),chunk=Buffer.alloc(size);position-=size;
   const actual=readSync(fd,chunk,0,size,position),data=Buffer.concat([chunk.subarray(0,actual),carry]);let end=data.length;
   for(let i=data.length-1;i>=0;i--)if(data[i]===10){parse(data.subarray(i+1,end));end=i;if(rows.length>=limit)break;}
   carry=data.subarray(0,end);
  }
  if(position===0&&rows.length<limit)parse(carry);
 }catch(error){if(error.code!=='ENOENT')throw error;}finally{if(fd!==undefined)closeSync(fd);}
 return rows.slice(0,limit).reverse();
}
