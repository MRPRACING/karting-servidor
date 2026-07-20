// ===================================================================
//  SERVIDOR de la suite de karting de resistencia
//  - Sirve el hub y los dos gestores (carpeta ./public)
//  - API de sesiones (carreras): crear / listar / borrar
//  - Sincronización en tiempo real por sala (WebSocket): el servidor
//    guarda el estado de cada carrera y lo reparte a todos los conectados.
//  Sin base de datos: estado en memoria + archivos JSON en ./data
//  Funciona igual en tu PC (local) y en Railway (usa process.env.PORT).
// ===================================================================
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT     = process.env.PORT || 8090;          // Railway inyecta PORT; en local, 8090
const PUB_DIR  = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SESS_FILE= path.join(DATA_DIR, 'sessions.json');
const TRACKS_FILE=path.join(DATA_DIR, 'tracks.json');

if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});

// ---------- sesiones (índice de carreras) ----------
function loadSessions(){ try{ return JSON.parse(fs.readFileSync(SESS_FILE,'utf8')).sessions||[]; }catch(e){ return []; } }
function saveSessions(list){ try{ fs.writeFileSync(SESS_FILE, JSON.stringify({sessions:list},null,2)); }catch(e){ console.error('saveSessions',e.message); } }
let sessions = loadSessions();   // [{id,name,gestor,created}]

function stateFile(id){ return path.join(DATA_DIR, 'state-'+id.replace(/[^a-z0-9]/gi,'')+'.json'); }
function loadState(id){ try{ return JSON.parse(fs.readFileSync(stateFile(id),'utf8')); }catch(e){ return null; } }
function saveState(id,state){ try{ fs.writeFileSync(stateFile(id), JSON.stringify(state)); }catch(e){ console.error('saveState',e.message); } }
function delState(id){ try{ fs.unlinkSync(stateFile(id)); }catch(e){} }

function newId(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

// ---------- trazados (circuitos) ----------
function loadTracks(){ try{ return JSON.parse(fs.readFileSync(TRACKS_FILE,'utf8')).tracks||[]; }catch(e){ return []; } }
function saveTracks(list){ try{ fs.writeFileSync(TRACKS_FILE, JSON.stringify({tracks:list},null,2)); }catch(e){ console.error('saveTracks',e.message); } }
let tracks = loadTracks();   // [{id,name,created,hasImg}]
function trackFile(id){ return path.join(DATA_DIR, 'track-'+id.replace(/[^a-z0-9]/gi,'')+'.json'); }
function loadTrackData(id){ try{ return JSON.parse(fs.readFileSync(trackFile(id),'utf8')); }catch(e){ return null; } }
function saveTrackData(id,data){ try{ fs.writeFileSync(trackFile(id), JSON.stringify(data)); }catch(e){ console.error('saveTrackData',e.message); } }
function delTrackData(id){ try{ fs.unlinkSync(trackFile(id)); }catch(e){} }

// ---------- utilidades HTTP ----------
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
function sendJson(res,obj,code){ const b=Buffer.from(JSON.stringify(obj)); res.writeHead(code||200,{'Content-Type':'application/json; charset=utf-8','Content-Length':b.length}); res.end(b); }
function readBody(req,maxBytes){ const lim=maxBytes||5e6; return new Promise(r=>{ let d=''; req.on('data',c=>{ d+=c; if(d.length>lim) req.destroy(); }); req.on('end',()=>{ try{ r(d?JSON.parse(d):{}); }catch(e){ r({}); } }); }); }
function safeStatic(res, urlPath){
  let rel = urlPath==='/'?'/hub.html':urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const file = path.normalize(path.join(PUB_DIR, rel));
  if(!file.startsWith(PUB_DIR)){ res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file,(err,data)=>{
    if(err){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('No encontrado: '+rel); return; }
    res.writeHead(200,{'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream'}); res.end(data);
  });
}

// ---------- servidor HTTP ----------
const server = http.createServer(async (req,res)=>{
  const u = req.url || '/';
  // API
  if(u.startsWith('/api/sessions')){
    if(req.method==='GET'){
      const gestor=new URL(u,'http://x').searchParams.get('gestor');
      const list=sessions.filter(s=>!gestor||s.gestor===gestor).sort((a,b)=>b.created-a.created);
      return sendJson(res,{sessions:list});
    }
    if(req.method==='POST'){
      const b=await readBody(req);
      const gestor=(b.gestor==='general')?'general':'boxes';
      const name=(b.name||'').toString().trim().slice(0,60)||'Carrera';
      const s={id:newId(),name,gestor,created:Date.now()};
      sessions.push(s); saveSessions(sessions);
      return sendJson(res,{session:s},201);
    }
    if(req.method==='DELETE'){
      const id=new URL(u,'http://x').searchParams.get('id');
      sessions=sessions.filter(s=>s.id!==id); saveSessions(sessions); delState(id);
      return sendJson(res,{ok:true});
    }
  }
  if(u.startsWith('/api/state') && req.method==='GET'){
    const id=new URL(u,'http://x').searchParams.get('id');
    return sendJson(res,{state:loadState(id)});
  }
  if(u.startsWith('/api/tracks')){
    if(req.method==='GET'){
      const id=new URL(u,'http://x').searchParams.get('id');
      if(id){ const data=loadTrackData(id); return sendJson(res,{track:tracks.find(t=>t.id===id)||null, data}); }
      return sendJson(res,{tracks:tracks.slice().sort((a,b)=>b.created-a.created)});   // índice ligero (sin datos)
    }
    if(req.method==='POST'){
      const b=await readBody(req, 15e6);                    // los trazados con foto pueden pesar
      const data=(b && b.data) ? b.data : b;                // acepta {name,data} o el propio trazado
      const name=((b&&b.name) || (data&&data.nombre) || 'Circuito').toString().trim().slice(0,60)||'Circuito';
      const t={id:newId(), name, created:Date.now(), hasImg:!!(data&&data.imagen)};
      tracks.push(t); saveTracks(tracks); saveTrackData(t.id, data);
      return sendJson(res,{track:t},201);
    }
    if(req.method==='DELETE'){
      const id=new URL(u,'http://x').searchParams.get('id');
      tracks=tracks.filter(t=>t.id!==id); saveTracks(tracks); delTrackData(id);
      return sendJson(res,{ok:true});
    }
  }
  if(u==='/api/health'){ return sendJson(res,{ok:true,sessions:sessions.length,tracks:tracks.length}); }
  if(u.split('?')[0]==='/api/relay'){
    if(req.method==='POST'){ const b=await readBody(req); apexUrl=(b.url||'').toString().trim(); stateLines={}; lastClock=null; allFrames.length=0; try{if(upstream)upstream.terminate();}catch(_){}; upRetry=0; if(apexUrl) connectApex(); return sendJson(res,{ok:true,url:apexUrl}); }
    return sendJson(res,{url:apexUrl, live:!!(upstream&&upstream.readyState===1), peers:feedWss?feedWss.clients.size:0});
  }
  // estático
  safeStatic(res,u);
});

// ---------- WebSocket: salas por carrera ----------
const wss = new WebSocketServer({ noServer:true });   // sync por sala
const rooms = new Map();   // id -> [ws, ws, ...] en ORDEN de llegada (el primero = principal)

function roomArr(id){ if(!rooms.has(id)) rooms.set(id,[]); return rooms.get(id); }
function sendRole(ws, isPrimary){ try{ ws.send(JSON.stringify({type:'role', primary:!!isPrimary})); }catch(e){} }
function broadcast(id, fromWs, msg){
  const arr=rooms.get(id); if(!arr) return;
  const data=JSON.stringify(msg);
  for(const c of arr){ if(c!==fromWs && c.readyState===1){ try{ c.send(data); }catch(e){} } }
}

wss.on('connection', ws=>{
  ws._room=null;
  ws.on('message', raw=>{
    let m; try{ m=JSON.parse(raw.toString()); }catch(e){ return; }
    if(m.type==='join' && m.id){
      ws._room=m.id;
      const arr=roomArr(m.id); arr.push(ws);
      const st=loadState(m.id);                       // al entrar: darle el estado actual de la carrera
      try{ ws.send(JSON.stringify({type:'state', state:st})); }catch(e){}
      sendRole(ws, arr[0]===ws);                      // ¿el más antiguo? -> principal (ejecuta las acciones por tiempo)
      broadcast(m.id, ws, {type:'peers', n:arr.length});
    }
    else if(m.type==='state' && ws._room){
      saveState(ws._room, m.state);                    // guardar (sobrevive reinicios)
      broadcast(ws._room, ws, {type:'state', state:m.state});   // repartir a los demás
    }
  });
  ws.on('close', ()=>{
    const id=ws._room; if(!id || !rooms.has(id)) return;
    const arr=rooms.get(id); const i=arr.indexOf(ws); if(i>=0) arr.splice(i,1);
    if(!arr.length){ rooms.delete(id); return; }
    if(i===0){ sendRole(arr[0], true); }              // si se fue el principal, el nuevo más antiguo pasa a serlo
    broadcast(id, ws, {type:'peers', n:arr.length});
  });
});

// ---------- RELÉ de Apex integrado (feed en la nube, ws://.../feed) ----------
const APEX_ENDPOINT = process.env.APEX_WS || 'wss://live-data.apex-timing.com:7913/';
const APEX_ORIGIN   = 'https://www.apex-timing.com';
let apexUrl = (process.env.APEX_URL || '').trim();   // URL de la carrera (página); se fija en runtime vía /api/relay
let upstream = null, upRetry = 0, upTimer = null;
let stateLines = {}, lastClock = null, allFrames = [];
const feedWss = new WebSocketServer({ noServer:true });  // feed de Apex
const injectWss = new WebSocketServer({ noServer:true });  // fuente externa (reproductor) inyecta el feed
injectWss.on('connection', ws=>{ console.log('[inject] fuente conectada (reproductor)'); ws.on('message', data=>{ const text=data.toString(); cacheFrame(text); feedBroadcast(text); }); });
function feedBroadcast(text){ for(const c of feedWss.clients){ if(c.readyState===1){ try{ c.send(text); }catch(_){} } } }
function chanOf(line){ const i=line.indexOf('|'); if(i<0)return line; const j=line.indexOf('|',i+1); return line.slice(0,i)+'|'+((j<0)?'':line.slice(i+1,j)); }
function cacheFrame(text){
  if(/^init\|/m.test(text)){ stateLines={}; allFrames.length=0; }   // nueva sesión: empezar histórico de cero
  allFrames.push(text); if(allFrames.length>150000) allFrames.shift();
  for(const line of text.split('\n')){ if(!line) continue; stateLines[chanOf(line)]=line; const m=line.match(/^dyn1\|countdown\|(\d+)/); if(m) lastClock=m[1]; }
}
feedWss.on('connection', client=>{
  try{
    if(allFrames.length){                          // REPROCESO: reenviar toda la carrera para reconstruir TODO
      client.send('relay|replaystart|');
      for(const fr of allFrames){ client.send(fr); }
      client.send('relay|replayend|');
    } else {
      const vals=Object.values(stateLines);
      if(vals.length) client.send(vals.join('\n'));
    }
    if(lastClock) client.send('dyn1|countdown|'+lastClock);
    client.send('relay|status|'+(upstream&&upstream.readyState===1?'feed de Apex en vivo':'esperando feed de Apex…'));
  }catch(_){}
});
function connectApex(){
  if(!apexUrl) return;
  try{ if(upstream) upstream.terminate(); }catch(_){}
  console.log('[relay] conectando a Apex ('+APEX_ENDPOINT+')  ref='+apexUrl);
  upstream = new WebSocket(APEX_ENDPOINT, { origin:APEX_ORIGIN, perMessageDeflate:true,
    headers:{ 'Origin':APEX_ORIGIN, 'Referer':apexUrl, 'User-Agent':'Mozilla/5.0 (apex-relay)' }, handshakeTimeout:15000 });
  upstream.on('open', ()=>{ upRetry=0; console.log('[relay] ✓ conectado a Apex'); feedBroadcast('relay|status|feed de Apex en vivo'); });
  upstream.on('message', (data,isBinary)=>{ const text=isBinary?data.toString('utf8'):data.toString(); cacheFrame(text); feedBroadcast(text); });
  upstream.on('close', ()=>{ console.log('[relay] Apex cerró, reintentando'); feedBroadcast('relay|status|Apex desconectado, reintentando'); scheduleRetry(); });
  upstream.on('error', e=>{ console.log('[relay] error Apex:', (e&&e.message)||e); });
}
function scheduleRetry(){ if(upTimer) return; const w=Math.min(15000,1000*Math.pow(2,upRetry++)); upTimer=setTimeout(()=>{ upTimer=null; connectApex(); }, w); }
if(apexUrl) connectApex();

server.on('upgrade', (req, socket, head)=>{
  const p=(req.url||'').split('?')[0];
  if(p==='/ws'){ wss.handleUpgrade(req, socket, head, ws=>wss.emit('connection', ws, req)); }
  else if(p==='/feed'){ feedWss.handleUpgrade(req, socket, head, ws=>feedWss.emit('connection', ws, req)); }
  else if(p==='/inject'){ injectWss.handleUpgrade(req, socket, head, ws=>injectWss.emit('connection', ws, req)); }
  else socket.destroy();
});
server.listen(PORT, ()=>{ console.log('Servidor de karting en marcha  ->  http://localhost:'+PORT+'   (sesiones guardadas: '+sessions.length+')'); });
