const TRANSIENT_STATUSES=new Set([408,409,425,429,500,502,503,504,520,521,522,523,524,525,526,527,529,530]);
export function createExplicitStreamProviderError(payload) {
 const data=payload?.error||payload||{};
 const raw=String(data?.message||data||'').slice(0,700);
 const code=String(data?.code||'').trim();
 const hinted=Number(data?.status||data?.statusCode||data?.httpStatus||0);
 const matched=raw.match(/(?:статус|status|http)\s*[:=№]?\s*([45]\d\d)/iu);
 const status=Number.isSafeInteger(hinted)&&hinted>=400&&hinted<=599?hinted:Number(matched?.[1]||0);
 const error=new Error('GPT STREAM ERROR'+(code?' '+code:'')+': '+raw);
 error.code=code||'GPT_STREAM_ERROR';
 if(status>=400)error.status=status;
 error.explicitProviderError=true;
 return error;
}
export function finalizeChatStreamFailure(error,{accumulatedText='',requestTimeout=false,streamBytesReceived=0}={}){
 const output=String(accumulatedText||'').length>0;
 const rejection=error?.explicitProviderError===true&&!output&&!error?.responseId;
 error.inferenceMayHaveStarted=output||(!requestTimeout&&!rejection);
 if(output)error.streamOutputStarted=true;
 if(rejection && (TRANSIENT_STATUSES.has(Number(error?.status)) || /temporar|временно недоступен|overload|capacity|upstream/iu.test(String(error?.message||''))))error.retryable=true;
 if(requestTimeout&&!output)error.retryable=true;
 error.streamBytesReceived=Number(streamBytesReceived)||0;
 return error;
}
