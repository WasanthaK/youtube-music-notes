import './styles.css';
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { createClient } from '@supabase/supabase-js';

const MODEL_URL = 'https://unpkg.com/@spotify/basic-pitch@1.0.1/model/model.json';
const SUPABASE_URL = 'https://kgoowanohmtprbwdokjd.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4dlNhnTkkyQRx8CJTqWXfQ_tfx8bz-o';
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const state = {
  stream: null,
  recorder: null,
  chunks: [],
  musicDocument: null,
  notes: [],
  instrument: 'guitar',
  session: null,
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
  const filtered = notes.filter(n=>n.midi>=min&&n.midi<=max&&n.confidence>=0.18).sort((a,b)=>a.start-b.start||b.midi-a.midi);
  const out=[];
  for(const n of filtered){
    if(!out.length || n.start-out[out.length-1].start>0.09) out.push(n);
    else if(n.confidence>out[out.length-1].confidence) out[out.length-1]=n;
  }
  return out;
}
function buildDocument(title,instrument,notes,duration,source='browser-tab-capture'){
  return {
    schema:'youtube-music-notes.music-document',schema_version:'0.1.0',
    track:{title,source,duration_seconds:duration},
    analysis:{requested_instrument:instrument,mode:'arrange',confidence_summary:null,warnings:['Browser transcription is approximate on dense mixes.']},
    tempo:{bpm:null,confidence:null},meter:{time_signature:null,confidence:null},key:{tonic:null,mode:null,confidence:null},
    sections:[],measures:[],chords:[],instruments:[{name:instrument,role:'target',source:'arranged'}],notes,
    exports:{midi_base64:null},learning:{difficulty:null,skills:[],practice_points:[]}
  };
}

function captureControls(){
  if(isIOS){
    return `
      <div class="status"><strong>iPhone/iPad:</strong> iOS browsers cannot capture another app or browser tab's audio. Use an audio file or a screen recording saved on the device.</div>
      <div class="row"><button class="primary" id="uploadBtn">Choose audio / screen recording</button></div>
      <input id="fileInput" type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.aac,.mp4,.mov" style="display:none" />`;
  }
  return `
    <div class="row"><button class="primary" id="start">Select YouTube tab</button><button class="danger" id="stop" disabled>Stop & analyse</button></div>
    <div class="status" id="status">Ready. Choose a browser tab and make sure “Share tab audio” is enabled.</div>`;
}

function app(){
  document.querySelector('#app').innerHTML = `
    <main class="shell">
      <header class="top">
        <div class="brand"><h1>YouTube Music Notes</h1><p>Turn music into playable notes, then learn it with an AI music teacher.</p></div>
        <div id="account" class="account"></div>
      </header>

      <section id="authBanner" class="auth-card"></section>

      <section class="grid">
        <div class="card"><h2>1. Capture & transcribe</h2>
          <div class="controls">
            <div class="field"><label>Instrument</label><select id="instrument"><option value="guitar">Guitar</option><option value="flute">Flute</option></select></div>
            <div class="field"><label>Track title</label><input id="title" value="Captured song" /></div>
          </div>
          ${captureControls()}
          <p class="muted">Transcription runs locally in your browser and does not use your AI allowance.</p>
        </div>

        <div class="card"><h2>2. AI music teacher</h2>
          <div class="teacher-head">
            <div class="field"><label>Provider</label><select id="provider"><option value="openai">OpenAI</option><option value="gemini">Gemini</option></select></div>
            <div id="quota" class="quota">Free plan · sign in to use AI</div>
          </div>
          <div class="quick" id="quick"><button>Explain this passage</button><button>Teach me this</button><button>Make it easier</button><button>What scale fits?</button><button>Create a practice exercise</button><button>Convert for another instrument</button></div>
          <textarea id="question" placeholder="Ask about harmony, fingering, technique, practice strategy…"></textarea>
          <div class="row"><button class="secondary" id="ask">Ask AI teacher</button></div>
          <div class="answer" id="answer">Transcribe some music, then sign in to ask your AI teacher.</div>
        </div>

        <div class="card full"><h2>3. Notes</h2><div class="score tabs" id="score">No transcription yet.</div><div class="row"><button id="download" class="secondary" disabled>Download MusicDocument JSON</button></div></div>
      </section>
    </main>`;
}

function renderAuth(){
  const account=document.querySelector('#account');
  const banner=document.querySelector('#authBanner');
  if(state.session?.user){
    const user=state.session.user;
    const name=user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'Signed in';
    account.innerHTML=`<span class="user-pill">${escapeHtml(name)}</span><button id="signout" class="small">Sign out</button>`;
    banner.innerHTML=`<div><strong>Free account active</strong><span> Browser transcription is unlimited. AI teacher: 5 questions/day, 50/month.</span></div>`;
    document.querySelector('#signout').onclick=async()=>{ await supabase.auth.signOut(); };
  } else {
    account.innerHTML='<span class="badge">Private-by-default transcription</span>';
    banner.innerHTML=`
      <div class="auth-copy"><strong>Sign in for the free AI teacher</strong><span> Transcription stays free and local. Sign-in protects the shared AI allowance from abuse.</span></div>
      <div class="social-row">
        <button data-provider="google" class="social">Google</button>
        <button data-provider="facebook" class="social">Facebook</button>
        <button data-provider="github" class="social">GitHub</button>
        <button data-provider="azure" class="social">Microsoft</button>
      </div>`;
    banner.querySelectorAll('[data-provider]').forEach(btn=>btn.onclick=()=>socialSignIn(btn.dataset.provider));
  }
}

function escapeHtml(value=''){
  return String(value).replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

async function socialSignIn(provider){
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options:{ redirectTo: window.location.href.split('#')[0].split('?')[0] }
  });
  if(error) document.querySelector('#answer').textContent=`Sign-in error: ${error.message}`;
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
  const score=document.querySelector('#score');
  score.innerHTML = state.instrument==='guitar' ? renderGuitar(state.notes) : renderFlute(state.notes);
  document.querySelector('#download').disabled=!state.musicDocument;
}

async function decodeToMono22050(blob){
  const ctx=new AudioContext();
  try{
    const input=await ctx.decodeAudioData(await blob.arrayBuffer());
    const offline=new OfflineAudioContext(1,Math.ceil(input.duration*22050),22050);
    const src=offline.createBufferSource(); src.buffer=input; src.connect(offline.destination); src.start();
    const rendered=await offline.startRendering();
    return rendered;
  } finally {
    await ctx.close();
  }
}

async function transcribe(blob, source='browser-tab-capture'){
  const status=document.querySelector('#status') || document.querySelector('#mobileStatus');
  try{
    if(status) status.textContent='Preparing audio…';
    const audioBuffer=await decodeToMono22050(blob);
    if(status) status.textContent='Loading transcription model…';
    const basicPitch=new BasicPitch(MODEL_URL);
    const frames=[]; const onsets=[]; const contours=[];
    if(status) status.textContent='Analysing notes in browser…';
    await basicPitch.evaluateModel(audioBuffer,(f,o,c)=>{frames.push(...f);onsets.push(...o);contours.push(...c);},p=>{if(status) status.textContent=`Analysing notes… ${Math.round(p*100)}%`;});
    const raw=outputToNotesPoly(frames,onsets,0.25,0.25,5);
    noteFramesToTime(raw);
    let notes=raw.map(n=>({start:n.startTimeSeconds,end:n.startTimeSeconds+n.durationSeconds,midi:n.pitchMidi,confidence:n.amplitude,name:midiName(n.pitchMidi)}));
    state.instrument=document.querySelector('#instrument').value;
    notes=reduceMelody(notes,state.instrument==='flute'?60:40,state.instrument==='flute'?96:88);
    if(state.instrument==='guitar') notes=notes.map(n=>({...n,guitar:guitarPosition(n.midi)})).filter(n=>n.guitar);
    state.notes=notes;
    state.musicDocument=buildDocument(document.querySelector('#title').value,state.instrument,notes,audioBuffer.duration,source);
    if(status) status.textContent=`Done: ${notes.length} notes detected.`;
    render();
  } catch(e){
    const message = isIOS
      ? `Could not decode this file on iPhone/iPad: ${e.message}. Try an M4A, MP3 or WAV audio file; some MOV/MP4 screen recordings may not expose their audio track to Safari.`
      : e.message;
    if(status) status.textContent=message;
  }
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
  const done=new Promise(resolve=>state.recorder.addEventListener('stop',resolve,{once:true})); state.recorder.stop(); await done;
  state.stream?.getTracks().forEach(t=>t.stop()); document.querySelector('#start').disabled=false; document.querySelector('#stop').disabled=true;
  await transcribe(new Blob(state.chunks,{type:'audio/webm'}));
}

async function handleUpload(file){
  if(!file) return;
  let status=document.querySelector('#mobileStatus');
  if(!status){
    status=document.createElement('div');
    status.id='mobileStatus';
    status.className='status';
    document.querySelector('#uploadBtn').parentElement.after(status);
  }
  status.textContent=`Selected ${file.name}. Preparing locally…`;
  if(document.querySelector('#title').value==='Captured song') document.querySelector('#title').value=file.name.replace(/\.[^.]+$/,'');
  await transcribe(file,'uploaded-file');
}

async function askAI(){
  const answer=document.querySelector('#answer');
  if(!state.musicDocument){answer.textContent='Transcribe some music first.';return;}
  if(!state.session?.access_token){answer.textContent='Sign in with Google, Facebook, GitHub or Microsoft to use the free AI teacher.';return;}
  const question=document.querySelector('#question').value.trim();
  if(!question){answer.textContent='Enter a question first.';return;}
  answer.textContent='Thinking…';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/music-teacher`,{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${state.session.access_token}`,
        'apikey':SUPABASE_PUBLISHABLE_KEY,
      },
      body:JSON.stringify({music_document:state.musicDocument,question,provider:document.querySelector('#provider').value})
    });
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'AI teacher request failed');
    answer.textContent=data.answer;
    if(data.usage&&data.limits) document.querySelector('#quota').textContent=`${data.plan} · ${data.usage.daily}/${data.limits.daily} today · ${data.usage.monthly}/${data.limits.monthly} this month`;
  }catch(e){answer.textContent=e.message;}
}

app();
if(isIOS){
  document.querySelector('#uploadBtn').onclick=()=>document.querySelector('#fileInput').click();
  document.querySelector('#fileInput').onchange=e=>handleUpload(e.target.files?.[0]);
} else {
  document.querySelector('#start').onclick=startCapture;
  document.querySelector('#stop').onclick=stopCapture;
}
document.querySelector('#ask').onclick=askAI;
document.querySelectorAll('#quick button').forEach(b=>b.onclick=()=>document.querySelector('#question').value=b.textContent);
document.querySelector('#download').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(state.musicDocument,null,2)],{type:'application/json'}));a.download='music-document.json';a.click();};

const { data:{ session } } = await supabase.auth.getSession();
state.session=session;
renderAuth();
supabase.auth.onAuthStateChange((_event,session)=>{
  state.session=session;
  renderAuth();
  if(!session) document.querySelector('#quota').textContent='Free plan · sign in to use AI';
});
