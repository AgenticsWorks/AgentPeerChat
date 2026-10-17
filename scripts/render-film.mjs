// Browser-free video generation: Pillow boards and a single, bounded FFmpeg process.
// Usage: node scripts/render-film.mjs OUTPUT.mp4 /path/to/ffmpeg
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const child=spawn('python3',[fileURLToPath(new URL('./render-film.py',import.meta.url)),...process.argv.slice(2)],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
