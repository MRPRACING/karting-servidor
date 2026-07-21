#!/usr/bin/env node
/*
  apex-relay.js  —  Relé Apex Timing → navegador
  ------------------------------------------------
  El servidor de Apex exige la cabecera Origin: https://www.apex-timing.com y usa
  compresión permessage-deflate. El navegador NO deja falsificar Origin desde una
  página suelta, así que este relé se conecta server-side (donde sí se puede poner
  esa cabecera) y reenvía el feed crudo a tu navegador por un WebSocket local.

  USO:
    1) npm install ws            (una sola vez, en esta carpeta)
    2) node apex-relay.js "https://www.apex-timing.com/live-timing/cronosystem2/index.html?...(la URL de la carrera)..."
    3) Abre  http://localhost:8080  en el navegador  → ya viene cableado al relé.

  Opcional:
    PORT=9000 node apex-relay.js <url>        cambia el puerto
    APEX_WS=wss://otro-host:7913/ node ...      cambia el endpoint del feed
*/
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
let WebSocket;
try { WebSocket = require('ws'); }
catch (e) {
  console.error('\n  Falta el paquete "ws". Instálalo con:\n      npm install ws\n');
  process.exit(1);
}

const PORT      = parseInt(process.env.PORT, 10) || 8080;
const APEX_WS   = process.env.APEX_WS || 'wss://live-data.apex-timing.com:7913/';
const PAGE_URL  = process.argv[2] || 'https://www.apex-timing.com/live-timing/cronosystem2/index.html';
const ORIGIN    = process.env.ORIGIN || (function(){ try{ const u=new URL(PAGE_URL); return u.protocol+'//'+u.host; }catch(e){ return 'https://www.apex-timing.com'; } })();
const PAGE_FILE = path.join(__dirname, 'gestor-apex-live.html');

// ---- GRABACIÓN CRUDA de la carrera (copia literal del feed de Apex, con tiempos) ----
const REC = process.env.REC !== '0';
const PUSH_URL = process.env.PUSH_URL || '';
let pushWs = null, pushTimer = null;
let recStream = null, recStart = null, recCount = 0, REC_FILE = '';
if (REC) {
  const ts = new Date(), pad = n => String(n).padStart(2, '0');
  REC_FILE = path.join(__dirname, 'carrera-' + ts.getFullYear() + pad(ts.getMonth()+1) + pad(ts.getDate()) + '-' + pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds()) + '-p' + PORT + '.jsonl');
  recStream = fs.createWriteStream(REC_FILE, { flags: 'a' });
}
function record(text){
  if (!recStream) return;
  if (recStart === null) recStart = Date.now();
  recStream.write(JSON.stringify({ t: Date.now() - recStart, m: text }) + '\n');
  recCount++;
  if (recCount === 1) log('● GRABANDO (crudo) en: ' + path.basename(REC_FILE));
  else if (recCount % 100 === 0) log('● grabados ' + recCount + ' frames');
}

// ---- estado cacheado para clientes nuevos (se les manda el último init/estado) ----
const stateFrames = [];          // frames "gordos" (init/grid/title/track) para repoblar a quien llega
let lastClock = null;
function cacheFrame(text){
  if (/^(init\|)/m.test(text) || /^grid\|\|/m.test(text)) { stateFrames.length = 0; }
  if (/^(grid\|\||title1\||title2\||track\||css\||light\||wth)/m.test(text)) stateFrames.push(text);
  const m = text.match(/^dyn1\|countdown\|(\d+)/m); if (m) lastClock = m[1];
  if (stateFrames.length > 40) stateFrames.shift();
}

// ---- servidor HTTP (sirve la página del lector) ----
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/index') || req.url.startsWith('/gestor-apex-live')) {
    fs.readFile(PAGE_FILE, (err, buf) => {
      if (err) { res.writeHead(404); res.end('No encuentro gestor-apex-live.html junto a este script.'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

// ---- WebSocket local: el navegador se conecta aquí (ws://localhost:PORT/feed) ----
const wss = new WebSocket.Server({ server, path: '/feed' });
wss.on('connection', (client) => {
  log('navegador conectado (' + wss.clients.size + ' activo/s)');
  // repuebla al recién llegado con el último estado conocido
  for (const f of stateFrames) { try { client.send(f); } catch (_) {} }
  if (lastClock) { try { client.send('dyn1|countdown|' + lastClock); } catch (_) {} }
  client.send('relay|status|conectado al relé · esperando feed de Apex…');
});
function broadcast(text){
  for (const c of wss.clients) { if (c.readyState === WebSocket.OPEN) { try { c.send(text); } catch (_) {} } }
}
function connectPush(){
  if (!PUSH_URL || !WebSocket) return;
  try {
    pushWs = new WebSocket(PUSH_URL);
    pushWs.on('open', () => { log('[push] enviando el feed al servidor: ' + PUSH_URL); try { if (stateFrames.length) pushWs.send(stateFrames.join('\n')); } catch (_) {} });
    pushWs.on('close', () => { pushWs = null; if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; connectPush(); }, 2000); });
    pushWs.on('error', () => {});
  } catch (_) {}
}
function pushSend(text){ if (pushWs && pushWs.readyState === WebSocket.OPEN) { try { pushWs.send(text); } catch (_) {} } }

// ---- conexión upstream a Apex (con Origin + Referer + deflate) ----
let upstream = null, retry = 0, retryTimer = null;
function connectApex(){
  log('conectando a Apex: ' + APEX_WS);
  upstream = new WebSocket(APEX_WS, {
    origin: ORIGIN,
    perMessageDeflate: true,
    headers: {
      'Origin': ORIGIN,
      'Referer': PAGE_URL,
      'User-Agent': 'Mozilla/5.0 (apex-relay)'
    },
    handshakeTimeout: 15000
  });
  upstream.on('open', () => { retry = 0; log('✓ conectado a Apex. Esperando frames…'); broadcast('relay|status|feed de Apex en vivo'); });
  let nFrames = 0;
  // captura automática: desde el primer frame con grid|| guarda ~50 frames a apex-capture.txt
  let capBuf = [], capStarted = false, capDone = false, capTimer = null;
  const CAP_FILE = 'apex-capture-p' + PORT + '.txt';
  function writeCapture(){
    if (capDone) return; capDone = true;
    try { fs.writeFileSync(path.join(__dirname, CAP_FILE), capBuf.join('\n========\n'), 'utf8');
      log('✔ GUARDADO ' + CAP_FILE + ' (' + capBuf.length + ' frames). Ábrelo y pásamelo.'); }
    catch (e) { log('no pude guardar ' + CAP_FILE + ': ' + e.message); }
  }
  function capture(text){
    if (capDone) return;
    if (!capStarted && /grid\|\|/.test(text)) { capStarted = true; capTimer = setTimeout(writeCapture, 6000); }
    if (capStarted) { capBuf.push(text); if (capBuf.length >= 50) { if (capTimer) clearTimeout(capTimer); writeCapture(); } }
  }
  upstream.on('message', (data, isBinary) => {
    const text = isBinary ? data.toString('utf8') : data.toString();
    nFrames++;
    if (nFrames <= 4) log('frame #' + nFrames + ' (' + text.length + ' bytes): ' + text.slice(0, 200).replace(/\n/g, ' ¶ '));
    else if (nFrames % 60 === 0) log('… recibidos ' + nFrames + ' frames');
    capture(text);
    record(text);
    cacheFrame(text);
    broadcast(text);
    pushSend(text);
  });
  upstream.on('close', (code) => { log('Apex cerró (' + code + '). Reintentando…'); broadcast('relay|status|Apex desconectado, reintentando'); scheduleRetry(); });
  upstream.on('error', (err) => { log('error Apex: ' + (err && err.message || err)); });
}
function scheduleRetry(){
  if (retryTimer) return;
  const wait = Math.min(15000, 1000 * Math.pow(2, retry++));
  retryTimer = setTimeout(() => { retryTimer = null; connectApex(); }, wait);
}

function log(msg){ const t = new Date().toLocaleTimeString(); console.log('[' + t + '] ' + msg); }

server.listen(PORT, () => {
  if (PUSH_URL) connectPush();
  console.log('\n  Relé Apex en marcha.');
  console.log('  • Página del gestor:  http://localhost:' + PORT);
  console.log('  • Feed para el navegador:  ws://localhost:' + PORT + '/feed');
  console.log('  • Carrera (Referer):  ' + PAGE_URL);
  console.log('  • Endpoint Apex:      ' + APEX_WS);
  console.log('  • Grabación cruda:    ' + (REC ? path.basename(REC_FILE) + ' (empieza con el 1er frame)' : 'DESACTIVADA (REC=0)') + '\n');
  connectApex();
});
