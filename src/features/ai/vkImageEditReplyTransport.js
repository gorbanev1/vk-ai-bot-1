/** Reply in VK using the conversation-local ID, including messages with global ID zero. */
export function buildVkConversationReplySendParams({peerId,conversationMessageId,message='',attachment='',randomId}={}){
 const peer=Number(peerId),cmid=Number(conversationMessageId),rid=Number(randomId);
 if(!Number.isSafeInteger(peer)||peer<2000000000||peer>2147483647)throw Error('VK_REPLY_BAD_PEER');
 if(!Number.isSafeInteger(cmid)||cmid<=0)throw Error('VK_REPLY_BAD_CMID');
 if(!Number.isSafeInteger(rid)||rid<1||rid>2147483647)throw Error('VK_REPLY_BAD_RANDOM_ID');
 return {peer_id:peer,random_id:rid,message:String(message),...(attachment?{attachment:String(attachment)}:{}),
  forward:JSON.stringify({peer_id:peer,conversation_message_ids:[cmid],is_reply:true})};
}
