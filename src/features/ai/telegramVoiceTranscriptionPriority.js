import {isUsableVoiceTranscript} from './voiceTranscription.js';

// One shared Telegram STT order, regardless of sender:
// Gemini router once -> local Whisper once -> existing one-round STT ladder.
export async function transcribeTelegramVoiceInOrder({
  routerEnabled=false,localEnabled=false,routerTranscribe,localTranscribe,
  providerTranscribe,onStageFailure=()=>{},
}={}){
 for(const [stage,enabled,run] of [
  ['router-gemini',routerEnabled,routerTranscribe],
  ['local-whisper',localEnabled,localTranscribe],
 ]){
  if(!enabled)continue;
  if(typeof run!=='function')throw new Error('Missing speech recognition stage: '+stage);
  try{
   const result=await run();
   if(!isUsableVoiceTranscript(result?.text))
    throw new Error('Speech transcription returned no usable words');
   return result;
  }catch(error){
   onStageFailure(stage,error);
  }
 }
 if(typeof providerTranscribe!=='function')throw new Error('Missing STT provider fallback');
 return providerTranscribe();
}
