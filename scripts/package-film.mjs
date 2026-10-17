// An offline native-video player: embeds the generated MP4, poster and captions. No rendering.
import {readFile,writeFile} from 'node:fs/promises';
const release='https://github.com/AgenticsWorks/AgentPeerChat/releases/download/film-2026-10-18/agentpeerchat-en.mp4';
let html=await readFile('website/film/index.html','utf8');
const movie='data:video/mp4;base64,'+(await readFile('outputs/agentpeerchat-en.mp4')).toString('base64');
const poster='data:image/png;base64,'+(await readFile('website/film/frames/opening.png')).toString('base64');
const icon='data:image/svg+xml;base64,'+(await readFile('website/assets/icon.svg')).toString('base64');
const captions='data:text/vtt;base64,'+(await readFile('website/film/captions.vtt')).toString('base64');
html=html.replace('src="'+release+'"','src="'+movie+'"').replaceAll('../assets/icon.svg',icon).replace('poster="frames/opening.png"','poster="'+poster+'"').replace('src="captions.vtt"','src="'+captions+'"').replace('href="../"','href="https://github.com/AgenticsWorks/AgentPeerChat"');
await writeFile('outputs/agentpeerchat-film.html',html);
console.log('Packaged native video, English captions and poster into outputs/agentpeerchat-film.html.');
