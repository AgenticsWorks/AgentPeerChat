// Release media stays outside Git. Verify the exact approved film before a site deployment.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const output=new URL('../website/assets/agentpeerchat-promo-v8.mp4',import.meta.url);
const source='https://github.com/AgenticsWorks/AgentPeerChat/releases/download/promo-v8-20261018/AgentPeerChat-Promo-v8.mp4';
const expected='0f303cf76a81748061db767f316df6c34906dd52ac3f967a700331daa64a35ef';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
let bytes;
try { bytes=await readFile(output); } catch(error) { if(error.code!=='ENOENT')throw error; }
if(!bytes||digest(bytes)!==expected){
 const response=await fetch(source,{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error(`Cannot fetch the promotional film: HTTP ${response.status}`);
 bytes=Buffer.from(await response.arrayBuffer());
 if(digest(bytes)!==expected)throw new Error('Promotional film checksum mismatch; deployment stopped.');
 await writeFile(output,bytes);
}
console.log(`Verified promotional film: ${bytes.length} bytes, SHA-256 ${expected}`);
