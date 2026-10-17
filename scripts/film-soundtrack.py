"""Original, dependency-free sound bed and message cues for the product film."""
import math, wave, array, sys
rate=44100;duration=float(sys.argv[2]) if len(sys.argv)>2 else 64;audio=[0.0]*int(rate*duration)
def note(start,length,hz,volume,pluck=True):
 begin=int(start*rate);count=min(int(length*rate),len(audio)-begin)
 for i in range(max(0,count)):
  t=i/rate;attack=min(1,t/.018);release=min(1,(length-t)/.18)
  envelope=attack*release*(math.exp(-t*3.3) if pluck else .45+.1*math.sin(t*2))
  signal=math.sin(math.tau*hz*t)+.2*math.sin(math.tau*hz*2*t)
  audio[begin+i]+=signal*envelope*volume
beat=60/112
# An original four-chord pattern, deliberately quiet beneath the visual story.
chords=[(146.832,174.614,220.0),(116.541,146.832,174.614),(130.813,164.814,195.998),(130.813,146.832,195.998)]
for b in range(math.ceil(duration/beat)):
 start=b*beat
 if start>=duration-5:break
 chord=chords[(b//8)%len(chords)]
 note(start,.43,chord[b%3]*2,.075)
 if b%2==0:note(start,1.0,chord[0]/2,.045,False)
 if b%8==0:
  for hz in chord:note(start,3.7,hz,.014,False)
for t in [1.6,5,6.3,10,11.5,17,18.2,19.3,24,25.7,30,31.4,34.8,40,41.3,45.7,49,50,55,59]:
 note(t,.18,880,.035);note(t+.065,.23,1174.66,.022)
for hz in [130.813,195.998,261.626,329.628]:note(duration-4.9,4.7,hz,.035,False)
result=array.array('h')
for i,value in enumerate(audio):
 fade=min(1,i/rate/.6,(duration-i/rate)/1.5);sample=int(math.tanh(value)*fade*24000);result.extend([sample,sample])
with wave.open(sys.argv[1],'wb') as out:out.setnchannels(2);out.setsampwidth(2);out.setframerate(rate);out.writeframes(result.tobytes())
