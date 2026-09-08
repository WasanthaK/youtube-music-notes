import './styles.css';
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';

const MODEL_URL = 'https://unpkg.com/@spotify/basic-pitch@1.0.1/model/model.json';
const state = {
  stream: null,
  recorder: null,
  chunks: [],
  musicDocument: null,
  notes: [],
  instrument: 'guitar',
};

const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const guitarOpen = [40,45,50,55,59,64];

function midiName(midi){ return `${noteNames[midi%12]}${Math.floor(midi/12)-1}`; }
function guitarPosition(midi){
  const candidates = guitarOpen.map((open,i)=>({string:i+1,fret:midi-open})).filter(x=>x.fret>=0&&x.fret<=20);
  candidates.sort((a,b)=>a.fret-b.fret || b.string-a.string);
  return candidates[0] || null;
}
function reduceMelody(notes,min,max){
  const f = notes.filter(n=>n.midi>=min&&n.midi<=max&&n.confidence>=0.18).sort((a,b)=>a.start-b.start||b.midi-a.midi);
  const out=[];
  for(const n of f){
    if(!out.length || n.start-out[out.length-1].start>0.09) out.push(n);
    else if(n.confidence>out[out.length-1].confidence) out[out.length-1]=n;
  }
  return out;
}
function buildDocument(title,instrument,notes,duration){
  return {
    schema:'youtube-music-notes.music-document',schema_version:'0.1.0',
    track:{title,source:'browser-tab-capture',duration_seconds:duration},
    analysis:{requested_instrument:instrument,mode:'arrange',confidence_summary:null,warnings:['Browser transcription is approximate on dense mixes.']},
    tempo:{bpm:null,confidence:null},meter:{time_signature:null,confidence:null},key:{tonic:null,mode:null,confidence:null},
    sections:[],measures:[],chords:[],instruments:[{name:instrument,role:'target',source:'arranged'}],notes,
    exports:{midi_base64:null},learning:{difficulty:null,skills:[],practice_points:[]}
  };
}

function app(){
  document.querySelector('#app').innerHTML = `
    <main class="shell">
      <header class="top"><div class="brand"><h1>YouTube Music Notes</h1><p>Capture a browser tab, create playable notes, then learn with an AI music teacher.</p></div><div class="badge">Private-by-default transcription</div></header>
      <section class="grid">
        <div class="card"><h2>1. Capture & transcribe</h2>
          <div class="controls">
            <div class="field"><label>Instrument</label><select id="instrument"><option value="guitar">Guitar</option><option value="flute">Flute</option></select></div>
            <div class="field"><label>Track title</label><input id="title" value="Captured song" /></div>
          </div>
          <div class="row"><button class="primary" id="start">Select YouTube tab</button><button class="danger" id="stop" disabled>Stop & analyse</button></div>
          <div class="status" id="status">Ready. Choose a browser tab and make sure “Share tab audio” is enabled.</div>
          <p class="muted">Audio transcription runs in your browser. For best results, capture 20–45 seconds of a clear musical section.</p>
        </div>
        <div class="card"><h2>2. AI music teacher</h2>
          <div class="controls"><div class="field"><label>Provider</label><select id="provider"><option value="openai">OpenAI</option><option value="gemini">Gemini</option></select></div><div class="field"><label>Reasoning API URL</label><input id="api" placeholder="https://your-api.example.com" /></div></div>
          <div class="quick" id="quick"><button>Explain this passage</button><button>Teach me this</button><button>Make it easier</button><button>What scale fits?</button><button>Create a practice exercise</button><button>Convert for another instrument</button></div>
          <textarea id="question" placeholder="Ask about harmony, fingering, technique, practice strategy…"></textarea>
          <div class="row"><button class="secondary" id="ask">Ask AI teacher</button></div>
          <div class="answer" id="answer">Transcribe some music first, then ask a question.</div>
        </div>
        <div class="card full"><h2>3. Notes</h2><div class="score tabs" id="score">No transcription yet.</div><div class="row"><button id="download" class="secondary" disabled>Download MusicDocument JSON</button></div></div>
      </section>
    </main>`;
}

function renderGuitar(notes){
  const lines=[['e'],['B'],['G'],['D'],['A'],['E']].map(x=>x[0]+'|');
  notes.slice(0,80).forEach(n=>{
    const p=n.guitar; if(!p) return;
    const idx=6-p.string; const token=String(p.fret).padEnd(3,'-');
    for(let i=0;i<6;i++) lines[i]+=i===idx?token:'---';
  });
  return `<pre>${lines.join('\n')}</pre>`;
}
function renderFlute(notes){
  const rows = notes.slice(0,120).map(n=>`<tr><td>${n.start.toFixed(2)}s</td><td>${n.name}</td><td>${(n.end-n.start).toFixed(2)}s</td><td>${Math.round(n.confidence*100)}%</td></tr>`).join('');
  return `<table class="note-table"><thead><tr><th>Time</th><th>Note</th><th>Length</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function render(){
  const s=document.querySelector('#score');
  s.innerHTML = state.instrument==='guitar' ? renderGuitar(state.notes) : renderFlute(state.notes);
  document.querySelector('#download').disabled=!state.musicDocument;
}

async function decodeToMono22050(blob){
  const ctx=new AudioContext();
  const input=await ctx.decodeAudioData(await blob.arrayBuffer());
  const offline=new OfflineAudioContext(1,Math.ceil(input.duration*22050),22050);
  const src=offline.createBufferSource(); src.buffer=input; src.connect(offline.destination); src.start();
  const rendered=await offline.startRendering(); await ctx.close();
  return rendered;
}

async function transcribe(blob){
  const status=document.querySelector('#status'); status.textContent='Preparing audio…';
  const audioBuffer=await decodeToMono22050(blob);
  status.textContent='Loading transcription model…';
  const basicPitch=new BasicPitch(MODEL_URL);
  const frames=[]; const onsets=[]; const contours=[];
  status.textContent='Analysing notes in browser…';
  await basicPitch.evaluateModel(audioBuffer,(f,o,c)=>{frames.push(...f);onsets.push(...o);contours.push(...c);},p=>{status.textContent=`Analysing notes… ${Math.round(p*100)}%`;});
  const raw=outputToNotesPoly(frames,onsets,0.25,0.25,5);
  noteFramesToTime(raw);
  let notes=raw.map(n=>({start:n.startTimeSeconds,end:n.startTimeSeconds+n.durationSeconds,midi:n.pitchMidi,confidence:n.amplitude,name:midiName(n.pitchMidi)}));
  state.instrument=document.querySelector('#instrument').value;
  notes=reduceMelody(notes,state.instrument==='flute'?60:40,state.instrument==='flute'?96:88);
  if(state.instrument==='guitar') notes=notes.map(n=>({...n,guitar:guitarPosition(n.midi)})).filter(n=>n.guitar);
  state.notes=notes;
  state.musicDocument=buildDocument(document.querySelector('#title').value,state.instrument,notes,audioBuffer.duration);
  status.textContent=`Done: ${notes.length} notes detected.`; render();
}

async function startCapture(){
  const status=document.querySelector('#status');
  try{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
    if(!stream.getAudioTracks().length) throw new Error('No tab audio was shared. Select a browser tab and enable “Share tab audio”.');
    state.stream=stream; state.chunks=[];
    const audioOnly=new MediaStream(stream.getAudioTracks());
    const rec=new MediaRecorder(audioOnly,{mimeType:MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm'});
    state.recorder=rec; rec.ondataavailable=e=>{if(e.data.size) state.chunks.push(e.data);};
    rec.start(1000); document.querySelector('#start').disabled=true; document.querySelector('#stop').disabled=false;
    status.textContent='Recording tab audio…';
    stream.getVideoTracks().forEach(t=>t.onended=()=>stopCapture());
  }catch(e){status.textContent=e.message;}
}
async function stopCapture(){
  if(!state.recorder || state.recorder.state==='inactive') return;
  const done=new Promise(r=>state.recorder.addEventListener('stop',r,{once:true})); state.recorder.stop(); await done;
  state.stream?.getTracks().forEach(t=>t.stop()); document.querySelector('#start').disabled=false; document.querySelector('#stop').disabled=true;
  await transcribe(new Blob(state.chunks,{type:'audio/webm'}));
}
async function askAI(){
  const answer=document.querySelector('#answer'); const api=document.querySelector('#api').value.trim().replace(/\/$/,'');
  if(!state.musicDocument){answer.textContent='Transcribe some music first.';return;}
  if(!api){answer.textContent='Add the deployed reasoning API URL first. API keys stay on that server, not in this page.';return;}
  const question=document.querySelector('#question').value.trim(); if(!question){answer.textContent='Enter a question first.';return;}
  answer.textContent='Thinking…';
  try{
    const res=await fetch(`${api}/reason`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({music_document:state.musicDocument,question,provider:document.querySelector('#provider').value})});
    const data=await res.json(); if(!res.ok) throw new Error(data.detail||'Reasoning request failed'); answer.textContent=data.answer;
  }catch(e){answer.textContent=e.message;}
}

app();
document.querySelector('#start').onclick=startCapture; document.querySelector('#stop').onclick=stopCapture; document.querySelector('#ask').onclick=askAI;
document.querySelectorAll('#quick button').forEach(b=>b.onclick=()=>document.querySelector('#question').value=b.textContent);
document.querySelector('#download').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(state.musicDocument,null,2)],{type:'application/json'}));a.download='music-document.json';a.click();};
