/** Editing must upload original photo bytes; never call images/generations. */
function decode(url,i){
 const m=/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\r\n]+)$/iu.exec(String(url||''));
 if(!m)throw Error('Исходное фото '+(i+1)+' не удалось загрузить.');
 const b=Buffer.from(m[2].replace(/\s+/gu,''),'base64'),type=m[1].toLowerCase();
 if(!b.length||b.length>20*1024*1024)throw Error('Размер исходного фото должен быть до 20 МБ.');
 const ok=type==='png'&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
  ['jpg','jpeg'].includes(type)&&b[0]===255&&b[1]===216&&b[2]===255||
  type==='webp'&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
 if(!ok)throw Error('Повреждённое исходное фото '+(i+1)+'.');
 return {name:'source-'+(i+1)+'.'+(type==='jpg'?'jpeg':type),blob:new Blob([b],{type:type==='jpg'?'image/jpeg':'image/'+type})};
}
export function buildImageEditMultipart({model,prompt,sourceImageDataUrls,imageField='image'}){
 if(!String(model||'').trim()||!String(prompt||'').trim())throw Error('Не задана модель или инструкция редактирования.');
 if(!Array.isArray(sourceImageDataUrls)||!sourceImageDataUrls.length||sourceImageDataUrls.length>4)throw Error('Нужно от 1 до 4 исходных фото.');
 const form=new FormData();form.append('model',model);form.append('prompt',String(prompt).slice(0,32000));form.append('n','1');
 sourceImageDataUrls.forEach((x,i)=>{const img=decode(x,i);form.append(imageField,img.blob,img.name)});
 return form;
}
export async function postOpenAIImageEdit({baseUrl,apiKey,model,prompt,sourceImageDataUrls,signal,fetchImpl=fetch}){
 const root=String(baseUrl||'').replace(/\/+$/u,'');
 if(!/^https?:\/\//iu.test(root)||!apiKey)throw Error('Нет доступного провайдера изображений.');
 const request=async imageField=>fetchImpl(root+'/images/edits',{method:'POST',headers:{Authorization:'Bearer '+apiKey,Accept:'application/json,image/*'},body:buildImageEditMultipart({model,prompt,sourceImageDataUrls,imageField}),signal});
 let response=await request('image');
 if(!response.ok&&[400,422].includes(response.status)){
  const message=(await response.clone().text()).slice(0,600);
  if(/image\[\]|(?:image|file).{0,50}(?:required|missing)|(?:unknown|unrecognized|unexpected).{0,40}image/iu.test(message))response=await request('image[]');
 }
 return response;
}
