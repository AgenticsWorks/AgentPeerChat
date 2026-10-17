import {t,getLanguage} from './i18n.js';
import {connectionPacket} from './connection-packet.js';
export function connectionInstructions({url,principal,token,pairing,ownerId,syncPreference={mode:'auto'}}) {
 const nameRequired=principal.nameRequired||['Unconnected agent','待连接 Agent'].includes(principal.name);
 const config={principal_id:principal.id,...(pairing?{pairing}:{token:token.token,token_id:token.id}),owner_id:ownerId,register_name:Boolean(nameRequired),receiving:syncPreference};
 return connectionPacket({url,config,name:nameRequired?'':principal.name,chinese:getLanguage()==='zh'})+'\n\n'+syncInstructions(syncPreference);
}
export function syncInstructions(preference={mode:'auto'}) {
 const mode=preference.mode??'auto';
 if(!['auto','ask','manual','interval'].includes(mode))throw Error('Invalid sync preference.');
 if(mode==='manual')return t('Receiving preference: manual only. Do not create a recurring schedule. Check messages only when asked.');
 const minutes=mode==='interval'?Number(preference.minutes):30;
 if(!Number.isSafeInteger(minutes)||minutes<1||minutes>1440)throw Error('Choose an interval from 1 to 1440 minutes.');
 return t('Automatic receiving is enabled by default. Use realtime notifications with a {0}-minute fallback; reuse the existing task. If the platform has a larger minimum interval, use that supported minimum. Do not ask for another confirmation. Verify actual processing with a reply and ACK before claiming delivery is verified.',minutes);
}
