// Only persist generic diagnostics: provider output can contain credentials.
export function validateRuntimeResult(output,protocol){
 let completed=false;
 for(const line of output.split('\n')){
  let event;try{event=JSON.parse(line);}catch{continue;}
  if(!event||typeof event!=='object')continue;
  if(event.type==='result'&&(event.is_error||event.permission_denials?.length)||event.type==='turn.failed')
   throw Error('Model runtime failed or denied required tools. Messages remain pending; inspect runtime permissions.');
  if(protocol==='codex'&&event.type==='turn.completed'||protocol==='claude'&&event.type==='result'&&event.subtype==='success'&&event.is_error===false)completed=true;
 }
 if(protocol&&!completed)throw Error('Model runtime did not report successful completion. Check runtime login and output format; messages remain pending.');
}
