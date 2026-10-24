// Read-only diagnostics: never send, acknowledge, register, or install a task.
export async function doctor({config={},token,url,request,listenerStatus,now=Date.now()}) {
  const checks=[],next=[];
  const result={ok:false,connected:false,state:'not_connected',checks,next};
  const check=(id,status,message)=>checks.push({id,status,message});
  if(!token){check('identity','fail','No connection is selected. Use the instance connection instruction to join.');next.push('Join using the owner-approved connection instruction.');return result;}
  if(config.token&&config.token!==token||config.url&&config.url.replace(/\/$/,'')!==url.replace(/\/$/,'')){
    check('profile','fail','Environment overrides conflict with the saved profile.');next.push('Clear conflicting URL/token overrides or select the intended profile.');return result;
  }
  let principal;
  try{principal=(await request('/me')).principal;
    if(!principal||typeof principal.id!=='string'||principal.kind!=='agent'||config.principal_id&&principal.id!==config.principal_id)throw new Error('Identity mismatch');
  }catch{check('identity','fail','The instance did not confirm the selected Agent identity.');next.push('Check the instance URL and access, then reconnect if access was revoked.');return result;}
  result.connected=true;result.agent={id:principal.id,name:principal.name};result.state='connected';
  check('identity','pass','The instance confirmed this Agent identity.');
  try{const probe=await request('/probe');
    if(probe.agent?.id!==principal.id||typeof probe.pending!=='boolean')throw new Error('Invalid probe');
    result.pending=probe.pending;check('mailbox','pass',probe.pending?'Messages are waiting to be processed.':'No pending messages.');
  }catch{check('mailbox','warn','Mailbox availability could not be confirmed.');next.push('Run summary --once to inspect the mailbox.');}
  let status;
  try{status=await listenerStatus();}catch{check('receiving','fail','Local receiving status could not be read.');next.push('Inspect listen status and repair its private local state.');result.state='needs_attention';return result;}
  const queued=status?.queued||0,failed=status?.failed_queued||0;
  result.scheduled_messages={queued,failed};
  if(failed){check('scheduled_messages','fail','Scheduled messages have failed deliveries retained for retry.');next.push('Inspect schedule list and retry delivery after fixing access.');}
  if(status?.native?.runtime==='dsh'){
    const native=status.native,healthy=native.active&&!native.last_error;
    result.receiving={mode:healthy?'native_dsh':'needs_attention',verified:Boolean(healthy&&native.verified),session_id:native.session_id||null,last_model_at:native.last_processed_at||null};
    result.realtime={connected:Boolean(native.connected)};
    check('receiving',!healthy?'fail':native.verified?'pass':'warn',!native.active?'The DSH host is not running for this identity.':native.last_error?'The native DSH task failed; messages remain pending.':native.verified?'The native DSH channel has processed, replied and acknowledged work.':'The DSH channel is active; verify a real task and ACK.');
    if(!healthy)next.push('Start or repair the same DSH profile with its saved model and session storage; do not install a second CLI receiver.');
  }else if(!status?.installed){
    result.receiving={mode:'external_or_manual',verified:false};
    check('receiving','warn','No CLI listener is installed. A native platform schedule must be checked on that platform; otherwise receiving is manual.');
    next.push('Follow the installed skill to verify the chosen native schedule, configure receiving once, or retain manual mode.');
  }else{
    if(status.receiving_transport==='websocket_with_periodic_fallback'){
      check('realtime',status.realtime?.connected?'pass':'warn',status.realtime?.connected?'Push stream is connected; periodic receiving remains as fallback.':'Push stream is disconnected; periodic receiving remains as fallback.');
      result.realtime=status.realtime;
    }
    const latest=status.last_check,model=status.last_model_check;
    const time=Date.parse(latest?.model_finished_at||latest?.checked_at||'');
    const stale=Number.isFinite(time)&&now-time>Math.max(120,(status.interval_seconds||1800)*2+1980)*1000;
    const failedCheck=latest?.success===false&&Boolean(latest.error);
    const running=latest?.model_started===true&&!latest.model_finished_at&&!latest.error;
    const active=Boolean(status.active&&status.enabled);
    const wake=status.last_wake_check,session=status.delivery_mode==='session';
    const verified=session?Number.isFinite(Date.parse(wake?.processed_at||''))&&wake.acknowledged>0:model?.success===true&&model?.model_started===true&&model.acknowledged>0&&Number.isFinite(Date.parse(model.model_finished_at||''));
    result.receiving={mode:!active||stale||failedCheck?'needs_attention':running?'checking':verified?'verified':'unverified',verified:active&&!stale&&!failedCheck&&verified,task_id:status.task_id,interval_seconds:status.interval_seconds,last_check_at:latest?.checked_at||null,last_model_at:session?wake?.processed_at||null:model?.model_finished_at||null,delivery_mode:status.delivery_mode||'independent',last_wake_submitted:latest?.wake_submitted||false};
    if(!active){check('receiving','fail','The configured CLI listener is stopped or disabled.');next.push('Restore the existing listener using the skill; reuse its task instead of creating duplicates.');}
    else if(stale){check('receiving','fail','The listener has not reported a recent check.');next.push('Inspect the existing process manager or service on the Agent host.');}
    else if(failedCheck){check('receiving','fail','The latest receiving check failed; messages remain pending.');next.push('Inspect runtime access and permissions, then retry the existing listener.');}
    else check('receiving',verified?'pass':'warn',running?'A model turn is currently checking the mailbox.':verified?(session?'The bound session has acknowledged work after a wake.':'The active listener has processed and acknowledged a received message.'):(session?'Session wake is configured; successful processing has not yet been observed.':'The listener is active, but successful message processing has not been verified.'));
  }
  if(checks.some(c=>c.status==='fail'))result.state='needs_attention';
  else if(result.receiving?.verified)result.state='receiving_verified';
  else result.state=result.receiving?.mode==='external_or_manual'?'connected_manual_or_external':'receiving_unverified';
  result.ok=!checks.some(c=>c.status==='fail');return result;
}
