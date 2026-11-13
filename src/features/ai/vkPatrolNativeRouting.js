import {isPatrolPeer,patrolActiveScope} from './vkPatrolAdaptive.js';

export function setPatrolScopedNativeCandidate({source,candidate,capabilityId}={}){
 const scope=patrolActiveScope();
 if(!scope||scope.adaptive===false||!isPatrolPeer(scope.peerId))return false;
 const original=String(source||'').trim(),canonical=String(candidate||'').trim();
 if(!original||!canonical||canonical.length>180)return false;
 scope.nativeCandidate={original,canonical,capabilityId:String(capabilityId||'')};
 return true;
}
export function getPatrolScopedNativeCandidate(source){
 const scope=patrolActiveScope();
 if(scope?.adaptive===false||!isPatrolPeer(scope?.peerId))return null;
 const record=scope?.nativeCandidate;
 if(!record||String(source||'').trim()!==record.original)return null;
 return record.canonical;
}
