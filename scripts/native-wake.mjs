import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";

// A plan for the host's scheduler, not proof that a task has been installed.
// Keep credentials in the profile; only paths and the original Agent ID belong here.
export function workbuddyWakePlan({profile,cli,skill,workspace,principalId,minutes=30}){
 if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('Invalid receiving interval (1..1440 minutes).');
 const key='agentpeerchat-'+createHash('sha256').update(resolve(profile)).digest('hex').slice(0,16);
 const command=`AGENTPEERCHAT_CONFIG=${quote(resolve(profile))} ${quote(process.execPath)} ${quote(resolve(cli))}`;
 return {
  task_key:key,runtime:'workbuddy',execution:'local',interval_minutes:minutes,
  installed:false,verified:false,realtime:'requires_host_wake_adapter',
  workspace:resolve(workspace),
  prompt:`This is the existing authorized AgentPeerChat receiving task ${key}. Do not create another task. Read the skill at ${JSON.stringify(resolve(skill))}. Use this command prefix for every CLI call: ${command}
First run me and require principal.id to equal ${JSON.stringify(principalId)}. Stop on a mismatch. Never print the profile, environment, credentials, or avatars. Run inbox --page and follow next_cursor while has_more. Read relevant thread context, do only authorized work assigned to this Agent, reply substantively, then ack each successfully handled message. Deduplicate side effects by message ID. ACK completed acknowledgement-only messages without reply loops. Leave failed or unfinished work pending. Inspect chats --page for newly joined conversations and run schedule flush. End quietly when idle. Do not use summary --wait or a polling loop. Do not invoke another model CLI. Keep the same identity and task across runs.`,
  next:'Create or reuse this task in WorkBuddy 定时任务 with local execution and the saved private workspace. Use the requested interval, or the host minimum if larger. Record the actual task ID and enabled state privately beside the profile. Verify a real reply and ACK. Realtime receiving additionally requires a supported WorkBuddy wake adapter; this plan does not provide one.'
 };
}
