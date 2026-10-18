"""Generate an English 720p MP4 from existing boards, without a browser.

Requires Pillow and FFmpeg. One encoder, two threads, bounded memory; no frame queue.
"""
import argparse,datetime,json,os,signal,subprocess,sys,tempfile,threading,wave
from pathlib import Path
from PIL import Image,ImageChops,ImageStat

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('output',type=Path)
parser.add_argument('ffmpeg',type=Path)
parser.add_argument('--frames',type=Path,default=ROOT/'outputs/film-frames',help='Local 720p boards; generated media is not stored in Git.')
parser.add_argument('--max-rss-mb',type=int,default=512)
parser.add_argument('--min-available-mb',type=int,default=1024)
args=parser.parse_args()
output=args.output.resolve();encoder=args.ffmpeg.resolve()
if not encoder.is_file():raise SystemExit('Provide an existing FFmpeg executable.')
board=json.loads((ROOT/'website/film/storyboard.json').read_text())
scenes=board['scenes'];duration=board['duration'];fps=24
for scene in scenes:
 if not (args.frames/f"{scene['id']}.png").is_file():raise SystemExit('Missing local board: '+scene['id']+'.png; provide --frames DIRECTORY.')
output.parent.mkdir(parents=True,exist_ok=True)
stop=threading.Event();active=None;active_lock=threading.Lock();failure=[]
report={'success':False,'renderer':'Pillow boards + one FFmpeg process','resolution':[1280,720],'duration_seconds':duration,'fps':fps,'encoder_threads':2,'peak_rss_mb':0,'minimum_system_available_mb':None,'browser_used':False}

def rss(pid):
 try:
  for line in Path('/proc',str(pid),'status').read_text().splitlines():
   if line.startswith('VmRSS:'):return int(line.split()[1])//1024
 except (OSError,ValueError):pass
 return 0

def available():
 try:
  for line in Path('/proc/meminfo').read_text().splitlines():
   if line.startswith('MemAvailable:'):return int(line.split()[1])//1024
 except (OSError,ValueError):pass
 return None

def monitor():
 while not stop.is_set():
  with active_lock:child=active
  used=rss(os.getpid())+(rss(child.pid) if child and child.poll() is None else 0)
  free=available();report['peak_rss_mb']=max(report['peak_rss_mb'],used)
  if free is not None:report['minimum_system_available_mb']=min(report['minimum_system_available_mb'] or free,free)
  reason='Render memory budget exceeded' if used>args.max_rss_mb else 'System memory reserve too low' if free is not None and free<args.min_available_mb else None
  if reason and child and child.poll() is None:
   failure.append(reason);child.terminate()
  stop.wait(.1)

thread=threading.Thread(target=monitor,daemon=True);thread.start()
def run(command,log):
 global active
 with log.open('w') as stream:
  with active_lock:active=subprocess.Popen([str(value) for value in command],stdout=stream,stderr=subprocess.STDOUT,cwd=ROOT)
  code=active.wait()
 if failure:raise RuntimeError(failure[-1])
 if code:raise RuntimeError('Video operation failed; inspect '+str(log))

def interrupted(signum,frame):
 with active_lock:child=active
 if child and child.poll() is None:
  child.terminate()
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 raise KeyboardInterrupt
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
def timestamp(value):
 ms=round(value*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'

try:
 with tempfile.TemporaryDirectory(prefix='agentpeerchat-film-') as temporary:
  scratch=Path(temporary);frames=[]
  for scene in scenes:
   source=args.frames.resolve()/f"{scene['id']}.png"
   with Image.open(source) as image:
    if image.size!=(1280,720):raise ValueError('Source board is not 720p: '+scene['id'])
    path=scratch/f"{scene['id']}.png";image.convert('RGB').save(path)
   frames.append(path)
  playlist=scratch/'boards.ffconcat';lines=['ffconcat version 1.0']
  for scene,path in zip(scenes,frames):lines.extend(["file '"+path.as_posix()+"'",'duration '+str(scene['end']-scene['start'])])
  lines.append("file '"+frames[-1].as_posix()+"'");playlist.write_text('\n'.join(lines)+'\n')
  subtitles=output.with_suffix('.srt')
  subtitles.write_text('\n\n'.join(f"{i+1}\n{timestamp(s['start'])} --> {timestamp(s['end'])}\n{s['caption']}" for i,s in enumerate(scenes))+'\n')
  sound=scratch/'score.wav'
  run([sys.executable,ROOT/'scripts/film-soundtrack.py',sound,duration],output.with_suffix('.sound.log'))
  with wave.open(str(sound)) as audio:assert audio.getnframes()/audio.getframerate()==duration
  staged=output.with_name(output.stem+'.rendering.mp4')
  run([encoder,'-hide_banner','-y','-f','concat','-safe','0','-i',playlist,'-i',sound,'-f','srt','-i',subtitles,
       '-map','0:v:0','-map','1:a:0','-map','2:s:0','-vf',f'fps={fps},format=yuv420p,fade=t=in:st=0:d=0.25,fade=t=out:st={duration-.4}:d=0.4',
       '-filter_threads','1','-c:v','libx264','-threads','2','-preset','veryfast','-crf','20','-c:a','aac','-b:a','128k','-ac','2','-c:s','mov_text',
       '-metadata:s:s:0','language=eng','-disposition:s:0','0','-t',duration,'-movflags','+faststart',staged],output.with_suffix('.encode.log'))
  run([encoder,'-v','error','-xerror','-threads','2','-i',staged,'-filter_threads','1','-threads','2','-map','0:v:0','-map','0:a:0','-f','null','-'],output.with_suffix('.decode.log'))
  indices=[int((s['start']+s['end'])/2*fps) for s in scenes]
  selected='+'.join(f'eq(n,{n})' for n in indices)
  run([encoder,'-hide_banner','-loglevel','error','-threads','2','-i',staged,'-vf',"select='"+selected+"'",'-filter_threads','1','-threads','2','-fps_mode','vfr',scratch/'review-%02d.png'],output.with_suffix('.frames.log'))
  review=output.parent/'film-review';review.mkdir(exist_ok=True);quality=[]
  for i,(scene,source) in enumerate(zip(scenes,frames)):
   decoded=scratch/f'review-{i+1:02d}.png'
   with Image.open(decoded).convert('RGB') as actual,Image.open(source).convert('RGB') as expected:
    error=sum(ImageStat.Stat(ImageChops.difference(actual,expected)).mean)/3
    if error>8:raise ValueError('Export differs from board: '+scene['id'])
    quality.append({'scene':scene['id'],'mean_pixel_error':round(error,3)})
    actual.save(review/(scene['id']+'.jpg'),quality=90)
  for timecode,label in [(35,'local'),(57.5,'human'),(62.5,'why')]:
   assert any(s['id']==label and s['start']<=timecode<s['end'] for s in scenes)
  staged.replace(output);report.update(success=True,verified_frames=len(quality),frame_quality=quality,bytes=output.stat().st_size,checks=['Complete video and audio decode','All 11 exported chapters compared with source boards','English subtitle track','720p H.264 + AAC','Single encoder and bounded memory'])
finally:
 stop.set();thread.join(timeout=1);report['checks_run_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();output.with_suffix('.verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
