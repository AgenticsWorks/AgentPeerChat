// An offline native-video player: embeds the generated MP4, poster and captions. No rendering.
import {readFile,writeFile} from 'node:fs/promises';
let html=await readFile('scripts/film-player.html','utf8');
const movie='data:video/mp4;base64,'+(await readFile('outputs/agentpeerchat-en.mp4')).toString('base64');
const poster='data:image/jpeg;base64,'+(await readFile('outputs/agentpeerchat-poster.jpg')).toString('base64');
const icon='data:image/svg+xml;base64,'+(await readFile('website/assets/icon.svg')).toString('base64');
const captions='data:text/vtt;base64,'+(await readFile('website/film/captions.vtt')).toString('base64');
html=html.replace('src="agentpeerchat-en.mp4"','src="'+movie+'"').replaceAll('../assets/icon.svg',icon).replace('poster="agentpeerchat-poster.jpg"','poster="'+poster+'"').replace('src="captions.vtt"','src="'+captions+'"').replace('href="../"','href="https://github.com/AgenticsWorks/AgentPeerChat"');
await writeFile('outputs/agentpeerchat-film.html',html);
console.log('Packaged native video, English captions and poster into outputs/agentpeerchat-film.html.');
