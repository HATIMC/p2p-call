'use strict';

// ── Guard ─────────────────────────────────────────────────────────────────
const initialParams = new URLSearchParams(window.location.search);
const initialCallTarget = (initialParams.get('call') || '').trim().toLowerCase();
if (initialCallTarget) sessionStorage.setItem('pending-call', initialCallTarget);
const MY_USERNAME = sessionStorage.getItem('username');
let SESSION_TOKEN = sessionStorage.getItem('session-token');

function validSessionToken(token) {
  return typeof token === 'string'
    && token !== 'undefined'
    && token !== 'null'
    && /^[A-Za-z0-9_-]{20,128}$/.test(token);
}

if (!MY_USERNAME || !validSessionToken(SESSION_TOKEN)) {
  sessionStorage.removeItem('username');
  sessionStorage.removeItem('session-token');
  window.location.href = initialCallTarget ? `/?call=${encodeURIComponent(initialCallTarget)}` : '/';
  throw new Error('not logged in');
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const myUsernameEl      = $('my-username');
const shareLinkBtn      = $('share-link-btn');
const logoutBtn         = $('logout-btn');
const userList          = $('user-list');
const searchInput       = $('search-input');
const searchCallBtn     = $('search-call-btn');
const sidebarError      = $('sidebar-error');
const toastEl           = $('toast');
const idleScreen        = $('idle-screen');
const callingScreen     = $('calling-screen');
const callScreen        = $('call-screen');
const controlsOverlay   = document.querySelector('.controls-overlay');
const callingAvatar     = $('calling-avatar');
const callingLabel      = $('calling-label');
const cancelCallBtn     = $('cancel-call-btn');
const remoteVideo       = $('remote-video');
const remoteScreenVideo = $('remote-screen-video');
const remoteAudio       = document.createElement('audio');
const localVideo        = $('local-video');
const localScreenVideo  = $('local-screen-video');
const videoWrap         = remoteVideo.closest('.video-wrap');
const hangupBtn         = $('hangup-btn');
const muteBtn           = $('mute-btn');
const camBtn            = $('cam-btn');
const peerLabel         = $('peer-label');
const incomingModal     = $('incoming-modal');
const incomingAvatar    = $('incoming-avatar');
const incomingFromLabel = $('incoming-from-label');
const acceptBtn         = $('accept-btn');
const rejectBtn         = $('reject-btn');
const qualityGroup      = $('quality-group');
const chatPanel         = $('chat-panel');
const chatMessages      = $('chat-messages');
const chatInput         = $('chat-input');
const chatSendBtn       = $('chat-send-btn');
const chatToggleBtn     = $('chat-toggle-btn');
const camSelect         = $('cam-select');
const micSelect         = $('mic-select');
const screenshareBtn    = $('screenshare-btn');
const whiteboardBtn     = $('whiteboard-btn');
const whiteboardPanel   = $('whiteboard-panel');
const whiteboardCanvas  = $('whiteboard-canvas');
const whiteboardColor   = $('whiteboard-color');
const whiteboardSize    = $('whiteboard-size');
const whiteboardClear   = $('whiteboard-clear');
const whiteboardClose   = $('whiteboard-close');
const docToggleBtn      = $('doc-toggle-btn');
const docPanel          = $('doc-panel');
const docEditor         = $('doc-editor');
const docStatus         = $('doc-status');
const docCloseBtn       = $('doc-close-btn');
const fileSendBtn       = $('file-send-btn');
const fileInput         = $('file-input');
const transferPanel     = $('transfer-panel');
const transferDirection = $('transfer-direction');
const transferFilename  = $('transfer-filename');
const transferProgress  = $('transfer-progress');
const transferPct       = $('transfer-pct');

myUsernameEl.textContent = MY_USERNAME;
const sbAvatar = $('sb-avatar');
if (sbAvatar) sbAvatar.textContent = MY_USERNAME[0].toUpperCase();

remoteAudio.autoplay = true;
remoteAudio.playsInline = true;
remoteAudio.style.display = 'none';
document.body.appendChild(remoteAudio);

// ── ICE config ────────────────────────────────────────────────────────────
let ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
fetch('/config').then(r => r.json()).then(d => { ICE_CONFIG = { iceServers: d.iceServers }; }).catch(() => {});

// ── Video quality presets ─────────────────────────────────────────────────
const VIDEO_QUALITY = {
  low:    { width: 320,  height: 240,  frameRate: 15 },
  medium: { width: 640,  height: 480,  frameRate: 24 },
  high:   { width: 1280, height: 720,  frameRate: 30 },
};
let currentQuality = 'medium';

async function setVideoQuality(preset) {
  currentQuality = preset;
  ['low', 'medium', 'high'].forEach(p =>
    $(`quality-${p}`).classList.toggle('q-active', p === preset));
  if (localAudioTrack || localVideoTrack) {
    const track = localVideoTrack;
    if (track) {
      try { await track.applyConstraints(VIDEO_QUALITY[preset]); } catch {}
    }
  }
}
['low', 'medium', 'high'].forEach(p => {
  $(`quality-${p}`).addEventListener('click', () => setVideoQuality(p));
});

// ── Call state ────────────────────────────────────────────────────────────
let callState    = 'idle';
let pc           = null;
let remotePeer   = null;
let pendingOffer = null;
let wasInitiator = false;
let retryCount   = 0;
let callWasConnected = false;
let audioMuted   = false;
let videoOff     = false;
let screenStream = null;

// Track the actual media tracks independently of any MediaStream wrapper
let localAudioTrack = null;   // real mic track, or null
let localVideoTrack = null;   // real camera track, or null
let micEnabled = false;
let camEnabled = false;

let remoteAudioStream = null;
let remoteVideoStream = null;
let remoteScreenStream = null;
let remoteScreenEnabled = false;

function refreshRemoteScreenVisibility() {
  const hasScreenTrack = !!remoteScreenStream?.getVideoTracks().some(track => !track.muted);
  const active = remoteScreenEnabled && hasScreenTrack;
  remoteScreenVideo.classList.toggle('hidden', !active);
  videoWrap.classList.toggle('remote-screen-active', active);
}

function playRemoteMedia() {
  remoteAudio.play().catch(() => {});
  remoteVideo.play().catch(() => {});
  remoteScreenVideo.play().catch(() => {});
}

function getVideoTransceivers() {
  return pc ? pc.getTransceivers().filter(tx => tx.receiver.track.kind === 'video') : [];
}

function getCameraTransceiver() {
  return getVideoTransceivers()[0] || null;
}

function getScreenTransceiver() {
  return getVideoTransceivers()[1] || null;
}

function getTrackTransceiver(connection, track) {
  return connection.getTransceivers().find(tx => tx.receiver.track === track) || null;
}

function enterConnectedCall(targetUsername) {
  if (callState === 'connected') return;
  stopRing(); stopSetupPoll();
  retryCount = 0; callState = 'connected';
  callWasConnected = true;
  peerLabel.textContent = targetUsername;
  showScreen('call-screen');
  setInCallMode(true);
  startConnectedPoll();
  playRemoteMedia();
  toast(`📹 Connected with ${targetUsername}`);
}

const MAX_RETRIES     = 3;
const CALL_TIMEOUT_MS = 30_000;

// ── Polling timers ────────────────────────────────────────────────────────
let idlePollActive      = false;
let setupPollActive     = false;
let connectedPollActive = false;
let idlePollAbort       = null;
let setupPollAbort      = null;
let connectedPollAbort  = null;
let callTimeoutTimer   = null;
let presenceHeartbeatTimer = null;
let controlsHideTimer = null;
let pendingIceCandidates = [];
let iceFlushTimer = null;

function showCallControls(autoHide = true) {
  document.body.classList.remove('controls-hidden');
  clearTimeout(controlsHideTimer);
  if (autoHide && callState === 'connected') {
    controlsHideTimer = setTimeout(() => {
      document.body.classList.add('controls-hidden');
    }, 3500);
  }
}

function setInCallMode(active) {
  document.body.classList.toggle('in-call', active);
  if (active) showCallControls(callState === 'connected');
  else {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
    document.body.classList.remove('controls-hidden');
  }
}

function startIdlePoll()      { if (idlePollActive)      return; idlePollActive      = true; pollForIncoming(); }
function stopIdlePoll()       { idlePollActive      = false; idlePollAbort?.abort(); idlePollAbort = null; }
function startSetupPoll()     { if (setupPollActive)     return; setupPollActive     = true; pollForSetup(); }
function stopSetupPoll()      { setupPollActive     = false; setupPollAbort?.abort(); setupPollAbort = null; }
function startConnectedPoll() { if (connectedPollActive) return; connectedPollActive = true; pollForHangup(); }
function stopConnectedPoll()  { connectedPollActive = false; connectedPollAbort?.abort(); connectedPollAbort = null; }

function startPresenceHeartbeat() {
  if (presenceHeartbeatTimer) return;
  presenceHeartbeatTimer = setInterval(() => {
    if (callState === 'idle') verifySessionPresence();
  }, 20_000);
}

// ── Signal helpers ────────────────────────────────────────────────────────
async function postSignal(targetUsername, payload) {
  try {
    const res = await fetch(`/api/signal/${encodeURIComponent(targetUsername)}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': SESSION_TOKEN },
      body:    JSON.stringify({ from: MY_USERNAME, ...payload }),
    });
    return res.ok;
  } catch { return false; }
}

function queueIceCandidate(targetUsername, candidate) {
  pendingIceCandidates.push(candidate);
  clearTimeout(iceFlushTimer);
  iceFlushTimer = setTimeout(() => flushIceCandidates(targetUsername), 120);
}

async function flushIceCandidates(targetUsername) {
  clearTimeout(iceFlushTimer);
  iceFlushTimer = null;
  if (pendingIceCandidates.length === 0) return;
  const candidates = pendingIceCandidates.splice(0);
  await postSignal(targetUsername, { type: 'candidates', candidates });
}

async function fetchSignals(wait = false, signal) {
  const waitParam = wait ? '?wait=1' : '';
  const res = await fetch(`/api/signal/${encodeURIComponent(MY_USERNAME)}${waitParam}`, {
    signal,
    headers: { 'X-Session-Token': SESSION_TOKEN },
  });
  if (res.status === 401) { await logout(false); return []; }
  const { signals } = await res.json();
  return signals || [];
}

async function handleSignal(sig) {
  if (sig.type === 'offer') {
    if (callState === 'idle') { handleIncomingOffer(sig); return true; }
    if (!wasInitiator && pc) { await handleIceRestartOffer(sig.sdp); return false; }
  } else if (sig.type === 'answer') {
    if (pc?.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
    }
  } else if (sig.type === 'candidate' && pc && sig.candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)); } catch {}
  } else if (sig.type === 'candidates' && pc && Array.isArray(sig.candidates)) {
    for (const candidate of sig.candidates) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  } else if (sig.type === 'reject') {
    toast(`${sig.from} rejected the call.`); hangup(false); return true;
  } else if (sig.type === 'cancel') {
    toast(`${sig.from} cancelled the call.`);
    stopRing(); incomingModal.classList.add('hidden');
    pendingOffer = null; callState = 'idle'; remotePeer = null;
    updateDialAvailability();
    stopSetupPoll(); startIdlePoll(); rejoinDirectory(); return true;
  } else if (sig.type === 'hangup') {
    toast(`${sig.from} ended the call.`); hangup(false); return true;
  }
  return false;
}

async function pollForIncoming() {
  if (!idlePollActive || callState !== 'idle') return;
  try {
    idlePollAbort = new AbortController();
    const signals = await fetchSignals(true, idlePollAbort.signal);
    idlePollAbort = null;
    for (const sig of signals) {
      if (await handleSignal(sig)) break;
    }
  } catch { idlePollAbort = null; }
  if (idlePollActive && callState === 'idle') pollForIncoming();
}

async function pollForSetup() {
  if (!setupPollActive || callState === 'idle' || callState === 'connected') { stopSetupPoll(); return; }
  try {
    setupPollAbort = new AbortController();
    const signals = await fetchSignals(true, setupPollAbort.signal);
    setupPollAbort = null;
    for (const sig of signals) {
      if (await handleSignal(sig)) return;
    }
  } catch { setupPollAbort = null; }
  if (setupPollActive && callState !== 'idle' && callState !== 'connected') pollForSetup();
}

async function pollForHangup() {
  if (!connectedPollActive || callState !== 'connected') { stopConnectedPoll(); return; }
  try {
    connectedPollAbort = new AbortController();
    const signals = await fetchSignals(true, connectedPollAbort.signal);
    connectedPollAbort = null;
    for (const sig of signals) {
      if (await handleSignal(sig)) return;
    }
  } catch { connectedPollAbort = null; }
  if (connectedPollActive && callState === 'connected') pollForHangup();
}

// ── DataChannels ──────────────────────────────────────────────────────────
let chatDc = null;
let fileDc = null;
let controlDc = null;
let whiteboardDc = null;
let docDc = null;
const CHUNK_SIZE   = 16 * 1024;
const BUFFER_LIMIT = 8 * 1024 * 1024;
let outgoingTransfer  = null;
let pendingChunkMeta  = null;
const incomingTransfers = new Map();

function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function setupControlDc(dc) {
  controlDc = dc;
  dc.onopen = () => { if (remotePeer) enterConnectedCall(remotePeer); };
  dc.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'hangup') {
        toast(`${remotePeer || 'Peer'} ended the call.`);
        hangup(false);
      } else if (msg.type === 'screen-share-start') {
        remoteScreenEnabled = true;
        refreshRemoteScreenVisibility();
      } else if (msg.type === 'screen-share-stop') {
        remoteScreenEnabled = false;
        refreshRemoteScreenVisibility();
      }
    } catch {}
  };
}

function sendControl(msg) {
  if (!controlDc || controlDc.readyState !== 'open') return false;
  controlDc.send(JSON.stringify(msg));
  return true;
}

let whiteboardDrawing = false;
let whiteboardLastPoint = null;
const whiteboardCtx = whiteboardCanvas.getContext('2d');

function setupWhiteboardDc(dc) {
  whiteboardDc = dc;
  dc.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'wb-open') setWhiteboardOpen(true, false);
      if (msg.type === 'wb-close') setWhiteboardOpen(false, false);
      if (msg.type === 'wb-clear') clearWhiteboard(false);
      if (msg.type === 'wb-stroke') drawWhiteboardStroke(msg.stroke);
    } catch {}
  };
}

function sendWhiteboard(msg) {
  if (!whiteboardDc || whiteboardDc.readyState !== 'open') return;
  whiteboardDc.send(JSON.stringify(msg));
}

function resizeWhiteboardCanvas() {
  const rect = whiteboardCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const snapshot = document.createElement('canvas');
  snapshot.width = whiteboardCanvas.width;
  snapshot.height = whiteboardCanvas.height;
  snapshot.getContext('2d').drawImage(whiteboardCanvas, 0, 0);
  whiteboardCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  whiteboardCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  whiteboardCtx.setTransform(1, 0, 0, 1, 0, 0);
  whiteboardCtx.lineCap = 'round';
  whiteboardCtx.lineJoin = 'round';
  if (snapshot.width && snapshot.height) {
    whiteboardCtx.drawImage(snapshot, 0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
  }
}

function setWhiteboardOpen(open, notify = true) {
  whiteboardPanel.classList.toggle('hidden', !open);
  whiteboardBtn.classList.toggle('pill-active', open);
  if (open) requestAnimationFrame(resizeWhiteboardCanvas);
  if (notify) sendWhiteboard({ type: open ? 'wb-open' : 'wb-close' });
}

function clearWhiteboard(notify = true) {
  whiteboardCtx.clearRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
  if (notify) sendWhiteboard({ type: 'wb-clear' });
}

function getWhiteboardPoint(e) {
  const rect = whiteboardCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
}

function drawWhiteboardStroke(stroke) {
  if (!stroke) return;
  whiteboardCtx.strokeStyle = stroke.color;
  whiteboardCtx.lineWidth = stroke.size * (window.devicePixelRatio || 1);
  whiteboardCtx.beginPath();
  whiteboardCtx.moveTo(stroke.from.x * whiteboardCanvas.width, stroke.from.y * whiteboardCanvas.height);
  whiteboardCtx.lineTo(stroke.to.x * whiteboardCanvas.width, stroke.to.y * whiteboardCanvas.height);
  whiteboardCtx.stroke();
}

function sendAndDrawWhiteboardStroke(from, to) {
  const stroke = { from, to, color: whiteboardColor.value, size: parseInt(whiteboardSize.value, 10) || 5 };
  drawWhiteboardStroke(stroke);
  sendWhiteboard({ type: 'wb-stroke', stroke });
}

whiteboardBtn.addEventListener('click', () => setWhiteboardOpen(whiteboardPanel.classList.contains('hidden')));
whiteboardClose.addEventListener('click', () => setWhiteboardOpen(false));
whiteboardClear.addEventListener('click', () => clearWhiteboard());
window.addEventListener('resize', () => { if (!whiteboardPanel.classList.contains('hidden')) resizeWhiteboardCanvas(); });

whiteboardCanvas.addEventListener('pointerdown', e => {
  whiteboardDrawing = true;
  whiteboardLastPoint = getWhiteboardPoint(e);
  whiteboardCanvas.setPointerCapture(e.pointerId);
});

whiteboardCanvas.addEventListener('pointermove', e => {
  if (!whiteboardDrawing || !whiteboardLastPoint) return;
  const nextPoint = getWhiteboardPoint(e);
  sendAndDrawWhiteboardStroke(whiteboardLastPoint, nextPoint);
  whiteboardLastPoint = nextPoint;
});

function stopWhiteboardDraw() {
  whiteboardDrawing = false;
  whiteboardLastPoint = null;
}

whiteboardCanvas.addEventListener('pointerup', stopWhiteboardDraw);
whiteboardCanvas.addEventListener('pointercancel', stopWhiteboardDraw);

let docApplyingRemote = false;
let docSyncTimer = null;
let docVersion = 0;

function setupDocDc(dc) {
  docDc = dc;
  dc.onopen = () => {
    docStatus.textContent = 'P2P document connected';
    sendDoc({ type: 'doc-sync', text: docEditor.value, version: docVersion });
  };
  dc.onclose = () => { docStatus.textContent = 'P2P document disconnected'; };
  dc.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'doc-open') setDocOpen(true, false);
      if (msg.type === 'doc-close') setDocOpen(false, false);
      if (msg.type === 'doc-sync') applyRemoteDoc(msg);
    } catch {}
  };
}

function sendDoc(msg) {
  if (!docDc || docDc.readyState !== 'open') return;
  docDc.send(JSON.stringify(msg));
}

function setDocOpen(open, notify = true) {
  docPanel.classList.toggle('hidden', !open);
  docToggleBtn.classList.toggle('pill-active', open);
  if (open) docStatus.textContent = docDc?.readyState === 'open' ? 'P2P document connected' : 'Waiting for document channel';
  if (notify) sendDoc({ type: open ? 'doc-open' : 'doc-close' });
}

function applyRemoteDoc(msg) {
  if (!Number.isFinite(msg.version) || msg.version < docVersion) return;
  docApplyingRemote = true;
  const start = docEditor.selectionStart;
  const end = docEditor.selectionEnd;
  docEditor.value = msg.text || '';
  docVersion = msg.version;
  docEditor.setSelectionRange(Math.min(start, docEditor.value.length), Math.min(end, docEditor.value.length));
  docApplyingRemote = false;
  docStatus.textContent = 'Updated from peer';
}

function scheduleDocSync() {
  if (docApplyingRemote) return;
  clearTimeout(docSyncTimer);
  docSyncTimer = setTimeout(() => {
    docVersion++;
    sendDoc({ type: 'doc-sync', text: docEditor.value, version: docVersion });
    docStatus.textContent = 'Synced to peer';
  }, 180);
}

docToggleBtn.addEventListener('click', () => setDocOpen(docPanel.classList.contains('hidden')));
docCloseBtn.addEventListener('click', () => setDocOpen(false));
docEditor.addEventListener('input', scheduleDocSync);

function setupChatDc(dc) {
  chatDc = dc;
  dc.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'chat') appendChatMessage(msg.from, msg.text, msg.ts, false);
    } catch {}
  };
}

function appendChatMessage(from, text, ts, mine) {
  const div = document.createElement('div');
  div.className = `chat-msg ${mine ? 'mine' : 'theirs'}`;
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<div class="chat-bubble">${escHtml(text)}</div>
    <div class="chat-meta">${mine ? 'You' : escHtml(from)} · ${time}</div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (!mine) {
    showCallControls(true);
    if (chatPanel.classList.contains('hidden')) {
      chatToggleBtn.classList.add('has-unread');
    }
  }
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !chatDc || chatDc.readyState !== 'open') return;
  const msg = { type: 'chat', text, from: MY_USERNAME, ts: Date.now() };
  chatDc.send(JSON.stringify(msg));
  appendChatMessage(MY_USERNAME, text, msg.ts, true);
  chatInput.value = '';
}

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

chatToggleBtn.addEventListener('click', () => {
  chatPanel.classList.toggle('hidden');
  chatToggleBtn.classList.remove('has-unread');
});
const chatCloseBtn = $('chat-close-btn');
if (chatCloseBtn) chatCloseBtn.addEventListener('click', () => chatPanel.classList.add('hidden'));

function setupFileDc(dc) {
  fileDc = dc;
  dc.binaryType = 'arraybuffer';
  dc.onmessage = ({ data }) => {
    if (data instanceof ArrayBuffer) { handleChunkData(data); return; }
    try { handleFileMsg(JSON.parse(data)); } catch {}
  };
  dc.onopen = () => {
    if (outgoingTransfer && outgoingTransfer.waitingForResume) {
      const t = outgoingTransfer;
      fileDc.send(JSON.stringify({ type:'file-start', fileId:t.fileId, name:t.file.name, size:t.file.size, totalChunks:t.totalChunks, chunkSize:CHUNK_SIZE }));
    }
  };
}

function handleFileMsg(msg) {
  switch (msg.type) {
    case 'file-start': {
      let nextChunk = 0;
      if (incomingTransfers.has(msg.fileId)) {
        nextChunk = incomingTransfers.get(msg.fileId).receivedChunks;
        toast(`📥 Resuming "${msg.name}"`);
      } else {
        incomingTransfers.set(msg.fileId, { name:msg.name, size:msg.size, totalChunks:msg.totalChunks, chunks:[], receivedChunks:0 });
        toast(`📥 Incoming: ${msg.name} (${fmtBytes(msg.size)})`);
      }
      showTransferProgress('↓', msg.name, 0);
      fileDc.send(JSON.stringify({ type:'file-resume-from', fileId:msg.fileId, nextChunk }));
      break;
    }
    case 'file-resume-from': {
      if (!outgoingTransfer || outgoingTransfer.fileId !== msg.fileId) return;
      outgoingTransfer.nextChunk = msg.nextChunk;
      outgoingTransfer.waitingForResume = false;
      pumpChunks();
      break;
    }
    case 'file-chunk-meta': { pendingChunkMeta = msg; break; }
    case 'file-progress': {
      if (outgoingTransfer && outgoingTransfer.fileId === msg.fileId)
        updateTransferUI(Math.round((msg.receivedChunks / outgoingTransfer.totalChunks) * 100));
      break;
    }
    case 'file-done': {
      const state = incomingTransfers.get(msg.fileId);
      if (!state) return;
      const blob = new Blob(state.chunks, { type:'application/octet-stream' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = state.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      incomingTransfers.delete(msg.fileId);
      pendingChunkMeta = null;
      hideTransferPanel();
      toast(`✅ File received: ${state.name}`);
      break;
    }
    case 'file-error': {
      toast(`⚠️ File transfer error: ${msg.reason || 'unknown'}`);
      incomingTransfers.delete(msg.fileId);
      hideTransferPanel();
      break;
    }
  }
}

function handleChunkData(buf) {
  if (!pendingChunkMeta) return;
  const { fileId, index } = pendingChunkMeta;
  pendingChunkMeta = null;
  const state = incomingTransfers.get(fileId);
  if (!state) return;
  state.chunks[index] = buf;
  state.receivedChunks++;
  updateTransferUI(Math.round((state.receivedChunks / state.totalChunks) * 100));
  if (state.receivedChunks % 50 === 0 && fileDc?.readyState === 'open')
    fileDc.send(JSON.stringify({ type:'file-progress', fileId, receivedChunks:state.receivedChunks }));
}

async function pumpChunks() {
  if (!outgoingTransfer || !fileDc || fileDc.readyState !== 'open') return;
  const t = outgoingTransfer;
  while (t.nextChunk < t.totalChunks) {
    if (fileDc.bufferedAmount > BUFFER_LIMIT) {
      fileDc.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
      fileDc.onbufferedamountlow = pumpChunks;
      return;
    }
    const start = t.nextChunk * CHUNK_SIZE;
    const buf = await t.file.slice(start, Math.min(start + CHUNK_SIZE, t.file.size)).arrayBuffer();
    fileDc.send(JSON.stringify({ type:'file-chunk-meta', fileId:t.fileId, index:t.nextChunk }));
    fileDc.send(buf);
    updateTransferUI(Math.round(((t.nextChunk + 1) / t.totalChunks) * 100));
    t.nextChunk++;
  }
  fileDc.send(JSON.stringify({ type:'file-done', fileId:t.fileId }));
  outgoingTransfer = null;
  hideTransferPanel();
  toast('✅ File sent');
}

fileSendBtn.addEventListener('click', () => {
  if (!fileDc || fileDc.readyState !== 'open') { toast('⚠️ Data channel not ready.'); return; }
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0]; fileInput.value = '';
  if (!file) return;
  const fileId = genId(), totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  outgoingTransfer = { fileId, file, totalChunks, nextChunk:0, waitingForResume:true };
  showTransferProgress('↑', file.name, 0);
  fileDc.send(JSON.stringify({ type:'file-start', fileId, name:file.name, size:file.size, totalChunks, chunkSize:CHUNK_SIZE }));
});

function showTransferProgress(dir, name, pct) {
  transferDirection.textContent = dir;
  transferFilename.textContent  = name.length > 30 ? name.slice(0,28)+'…' : name;
  updateTransferUI(pct);
  transferPanel.classList.remove('hidden');
}
function updateTransferUI(pct) {
  transferProgress.style.width = pct + '%';
  transferPct.textContent      = pct + '%';
}
function hideTransferPanel() {
  transferPanel.classList.add('hidden');
  transferProgress.style.width = '0%';
  transferPct.textContent = '0%';
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

// ── Screen share ──────────────────────────────────────────────────────────
async function startScreenShare() {
  if (!pc || callState !== 'connected') { toast('⚠️ Start a call first.'); return; }
  try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false }); }
  catch { toast('⚠️ Screen share cancelled.'); return; }
  const screenTrack = screenStream.getVideoTracks()[0];
  const tx = getScreenTransceiver();
  if (!tx) { toast('⚠️ Screen share is not available in this call.'); screenTrack.stop(); screenStream = null; return; }
  tx.direction = 'sendrecv';
  await tx.sender.replaceTrack(screenTrack);
  localScreenVideo.srcObject = screenStream;
  localScreenVideo.classList.remove('hidden');
  screenshareBtn.classList.add('pill-active');
  sendControl({ type: 'screen-share-start' });
  screenTrack.onended = stopScreenShare;
}

async function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  const tx = getScreenTransceiver();
  if (tx) await tx.sender.replaceTrack(null);
  localScreenVideo.srcObject = null;
  localScreenVideo.classList.add('hidden');
  screenshareBtn.classList.remove('pill-active');
  sendControl({ type: 'screen-share-stop' });
}

screenshareBtn.addEventListener('click', () => {
  if (screenStream) stopScreenShare(); else startScreenShare();
});

// ── Device switching ──────────────────────────────────────────────────────
let activeCamId = '';
let activeMicId = '';

async function enumerateDevices() {
  let devices;
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const cameras = devices.filter(d => d.kind === 'videoinput');
  const mics    = devices.filter(d => d.kind === 'audioinput');
  populateSelect(camSelect, cameras, activeCamId, '📷 ');
  populateSelect(micSelect, mics,    activeMicId, '🎤 ');
  camSelect.classList.toggle('hidden', cameras.length < 2);
  micSelect.classList.toggle('hidden', mics.length    < 2);
}

function populateSelect(sel, devices, currentId, prefix) {
  const prev = sel.value;
  sel.innerHTML = devices.map(d =>
    `<option value="${d.deviceId}" ${d.deviceId === currentId ? 'selected' : ''}>
      ${prefix}${d.label || d.deviceId.slice(0,8)}
    </option>`).join('');
  if (devices.some(d => d.deviceId === prev)) sel.value = prev;
}

async function switchCamera(deviceId) {
  activeCamId = deviceId;
  if (!camEnabled) return;
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      video: { ...VIDEO_QUALITY[currentQuality], deviceId: { exact: deviceId } }, audio: false });
  } catch { toast('⚠️ Could not switch camera.'); return; }
  const newTrack = newStream.getVideoTracks()[0];
  if (pc) {
    const tx = getCameraTransceiver();
    if (tx) await tx.sender.replaceTrack(newTrack);
  }
  if (localVideoTrack) localVideoTrack.stop();
  localVideoTrack = newTrack;
  const stream = new MediaStream([localVideoTrack]);
  localVideo.srcObject = stream;
}

async function switchMic(deviceId) {
  activeMicId = deviceId;
  if (!micEnabled) return;
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }, video: false });
  } catch { toast('⚠️ Could not switch microphone.'); return; }
  const newTrack = newStream.getAudioTracks()[0];
  newTrack.enabled = !audioMuted;
  if (pc) {
    const tx = pc.getTransceivers().find(t => t.receiver.track.kind === 'audio');
    if (tx) await tx.sender.replaceTrack(newTrack);
  }
  if (localAudioTrack) localAudioTrack.stop();
  localAudioTrack = newTrack;
}

camSelect.addEventListener('change', () => switchCamera(camSelect.value));
micSelect.addEventListener('change', () => switchMic(micSelect.value));
navigator.mediaDevices.addEventListener('devicechange', enumerateDevices);

// ── RTCPeerConnection factory ─────────────────────────────────────────────
// initiator=true: caller side — adds transceivers and DataChannels.
// initiator=false: callee side — does NOT add transceivers (setRemoteDescription does that).
function createPc(targetUsername, initiator) {
  remoteAudioStream = new MediaStream();
  remoteVideoStream = new MediaStream();
  remoteScreenStream = new MediaStream();
  remoteAudio.srcObject = remoteAudioStream;
  remoteVideo.srcObject = remoteVideoStream;
  remoteScreenVideo.srcObject = remoteScreenStream;
  remoteScreenVideo.classList.add('hidden');
  remoteScreenEnabled = false;
  videoWrap.classList.remove('remote-screen-active', 'remote-camera-active');

  const connection = new RTCPeerConnection(ICE_CONFIG);

  connection.onicecandidate = ({ candidate }) => {
    if (candidate) queueIceCandidate(targetUsername, candidate);
  };

  // Keep audio out of the video element so audio-only calls play without requiring a video track.
  connection.ontrack = (e) => {
    if (e.track.kind === 'audio') {
      remoteAudioStream.addTrack(e.track);
      remoteAudio.srcObject = new MediaStream(remoteAudioStream.getTracks());
      remoteAudioStream = remoteAudio.srcObject;
    }
    if (e.track.kind === 'video') {
      const tx = getTrackTransceiver(connection, e.track);
      const videoIndex = connection.getTransceivers()
        .filter(t => t.receiver.track.kind === 'video')
        .indexOf(tx);
      if (videoIndex === 1) {
        remoteScreenStream.addTrack(e.track);
        remoteScreenVideo.srcObject = new MediaStream(remoteScreenStream.getTracks());
        remoteScreenStream = remoteScreenVideo.srcObject;
        e.track.onunmute = () => { refreshRemoteScreenVisibility(); playRemoteMedia(); };
        e.track.onmute = refreshRemoteScreenVisibility;
      } else {
        remoteVideoStream.addTrack(e.track);
        remoteVideo.srcObject = new MediaStream(remoteVideoStream.getTracks());
        remoteVideoStream = remoteVideo.srcObject;
        e.track.onunmute = () => {
          videoWrap.classList.add('remote-camera-active');
          playRemoteMedia();
        };
        e.track.onmute = () => videoWrap.classList.remove('remote-camera-active');
      }
    }
    if (!e.track.onunmute) e.track.onunmute = playRemoteMedia;
    playRemoteMedia();
  };

  connection.ondatachannel = (e) => {
    if (e.channel.label === 'control')      setupControlDc(e.channel);
    if (e.channel.label === 'whiteboard')   setupWhiteboardDc(e.channel);
    if (e.channel.label === 'doc')          setupDocDc(e.channel);
    if (e.channel.label === 'chat')         setupChatDc(e.channel);
    if (e.channel.label === 'filetransfer') setupFileDc(e.channel);
  };

  connection.onconnectionstatechange = () => {
    const s = connection.connectionState;
    console.log('[rtc] state:', s);
    if (s === 'connected') enterConnectedCall(targetUsername);
    if (s === 'failed' || s === 'disconnected') {
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        toast(`⚠️ Connection unstable — retrying (${retryCount}/${MAX_RETRIES})…`);
        attemptIceRestart(targetUsername);
      } else {
        toast(`❌ Could not reconnect after ${MAX_RETRIES} attempts.`);
        hangup(false);
      }
    }
  };

  connection.oniceconnectionstatechange = () => {
    const s = connection.iceConnectionState;
    console.log('[rtc] ice state:', s);
    if (s === 'connected' || s === 'completed') enterConnectedCall(targetUsername);
  };

  if (initiator) {
    // Caller adds transceivers — this creates the m-lines in the offer.
    // We have the references immediately, so replaceTrack works before createOffer.
    const audioTx = connection.addTransceiver('audio', { direction: 'sendrecv' });
    const videoTx = connection.addTransceiver('video', { direction: 'sendrecv' });
    const screenTx = connection.addTransceiver('video', { direction: 'sendrecv' });
    if (localAudioTrack) audioTx.sender.replaceTrack(localAudioTrack);
    if (localVideoTrack) videoTx.sender.replaceTrack(localVideoTrack);
    if (screenStream) screenTx.sender.replaceTrack(screenStream.getVideoTracks()[0]);

    setupControlDc(connection.createDataChannel('control',      { ordered: true }));
    setupWhiteboardDc(connection.createDataChannel('whiteboard', { ordered: true }));
    setupDocDc(connection.createDataChannel('doc',        { ordered: true }));
    setupChatDc(connection.createDataChannel('chat',         { ordered: true }));
    setupFileDc(connection.createDataChannel('filetransfer', { ordered: true }));
  }
  // Callee: does NOT add transceivers here.
  // setRemoteDescription() will create them from the offer's m-lines.
  // replaceTrack is called after setRemoteDescription in acceptBtn handler.

  return connection;
}

// Helper: put already-enabled tracks onto an existing PC's senders.
// Called by callee after setRemoteDescription() creates the transceivers.
async function syncLocalTracksToPC() {
  if (!pc) return;
  const txcvrs = pc.getTransceivers();
  for (const tx of txcvrs) {
    if (tx.receiver.track.kind === 'audio' || tx.receiver.track.kind === 'video') {
      tx.direction = 'sendrecv';
    }
    if (tx.receiver.track.kind === 'audio' && localAudioTrack) {
      await tx.sender.replaceTrack(localAudioTrack);
    }
    if (tx === getCameraTransceiver() && localVideoTrack) {
      await tx.sender.replaceTrack(localVideoTrack);
    }
    if (tx === getScreenTransceiver() && screenStream) {
      await tx.sender.replaceTrack(screenStream.getVideoTracks()[0]);
    }
  }
}

// ── ICE restart ───────────────────────────────────────────────────────────
async function attemptIceRestart(targetUsername) {
  if (!pc) return;
  stopConnectedPoll(); startSetupPoll();
  if (wasInitiator) {
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await postSignal(targetUsername, { type: 'offer', sdp: pc.localDescription });
    } catch (err) { console.error('[rtc] ICE restart failed:', err); hangup(false); }
  }
  if (outgoingTransfer) outgoingTransfer.waitingForResume = true;
}

async function handleIceRestartOffer(sdp) {
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await syncLocalTracksToPC();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await postSignal(remotePeer, { type: 'answer', sdp: pc.localDescription });
  } catch (err) { console.error('[rtc] ICE restart answer failed:', err); }
}

// ── Outgoing call ─────────────────────────────────────────────────────────
async function dial(targetUsername) {
  if (callState !== 'idle')           { toast('Already in a call.'); return; }
  if (targetUsername === MY_USERNAME) { toast("You can't call yourself."); return; }

  wasInitiator = true;
  remotePeer   = targetUsername;
  retryCount   = 0;
  goOffDirectory();

  pc = createPc(targetUsername, true);  // initiator: adds transceivers + tracks
  playRemoteMedia();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  callState = 'calling';
  stopIdlePoll(); startSetupPoll();
  showScreen('calling-screen');
  setInCallMode(true);

  await postSignal(targetUsername, { type: 'offer', sdp: pc.localDescription });

  callTimeoutTimer = setTimeout(() => {
    if (callState === 'calling') { toast('No answer.'); hangup(true); }
  }, CALL_TIMEOUT_MS);

  callingAvatar.textContent = targetUsername[0].toUpperCase();
  callingLabel.textContent  = `Calling ${targetUsername}…`;
  startRing(true);
}

// ── Incoming offer ────────────────────────────────────────────────────────
function handleIncomingOffer(sig) {
  if (callState !== 'idle') { postSignal(sig.from, { type: 'reject' }); return; }
  callState    = 'ringing';
  remotePeer   = sig.from;
  wasInitiator = false;
  pendingOffer = { from: sig.from, sdp: sig.sdp };
  updateDialAvailability();
  stopIdlePoll(); startSetupPoll(); startRing(false); goOffDirectory();
  incomingAvatar.textContent    = sig.from[0].toUpperCase();
  incomingFromLabel.textContent = sig.from;
  incomingModal.classList.remove('hidden');
}

// ── Accept ────────────────────────────────────────────────────────────────
acceptBtn.addEventListener('click', async () => {
  if (callState !== 'ringing' || !pendingOffer) return;
  incomingModal.classList.add('hidden');
  stopRing();

  pc = createPc(remotePeer, false);  // callee: no transceivers yet
  playRemoteMedia();

  // setRemoteDescription creates transceivers from the offer's m-lines
  await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.sdp));

  // Now transceivers exist — keep them bidirectional and sync any already-enabled local tracks onto them
  await syncLocalTracksToPC();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await postSignal(remotePeer, { type: 'answer', sdp: pc.localDescription });

  pendingOffer = null;
  startSetupPoll();
});

// ── Reject ────────────────────────────────────────────────────────────────
rejectBtn.addEventListener('click', () => {
  if (callState !== 'ringing') return;
  stopRing();
  postSignal(remotePeer, { type: 'reject' });
  incomingModal.classList.add('hidden');
  pendingOffer = null; callState = 'idle'; remotePeer = null;
  updateDialAvailability();
  startIdlePoll(); rejoinDirectory();
});

// ── Hang up ───────────────────────────────────────────────────────────────
async function hangup(notifyRemote = true, forceLogout = false) {
  const shouldLogout = forceLogout || callWasConnected || callState === 'connected';
  stopRing(); stopSetupPoll(); stopConnectedPoll();
  clearTimeout(callTimeoutTimer); callTimeoutTimer = null;
  clearTimeout(iceFlushTimer); iceFlushTimer = null; pendingIceCandidates = [];

  if (notifyRemote && remotePeer && callState !== 'idle') {
    const sentP2P = callState === 'connected' && sendControl({ type: 'hangup' });
    if (!sentP2P) await postSignal(remotePeer, { type: callState === 'calling' ? 'cancel' : 'hangup' });
  }

  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    screenshareBtn.classList.remove('pill-active');
  }

  if (chatDc) { try { chatDc.close(); } catch {} chatDc = null; }
  if (fileDc) { try { fileDc.close(); } catch {} fileDc = null; }
  if (controlDc) { try { controlDc.close(); } catch {} controlDc = null; }
  if (whiteboardDc) { try { whiteboardDc.close(); } catch {} whiteboardDc = null; }
  if (docDc) { try { docDc.close(); } catch {} docDc = null; }
  clearTimeout(docSyncTimer); docSyncTimer = null;
  outgoingTransfer = null; pendingChunkMeta = null; incomingTransfers.clear();

  if (pc) { pc.close(); pc = null; }

  // Stop all local tracks
  if (localAudioTrack) { localAudioTrack.stop(); localAudioTrack = null; }
  if (localVideoTrack) { localVideoTrack.stop(); localVideoTrack = null; }
  micEnabled = false; camEnabled = false;
  localVideo.srcObject = null;
  localScreenVideo.srcObject = null;
  localScreenVideo.classList.add('hidden');

  remoteAudio.srcObject = null;
  remoteVideo.srcObject = null;
  remoteScreenVideo.srcObject = null;
  remoteScreenVideo.classList.add('hidden');
  remoteScreenEnabled = false;
  videoWrap.classList.remove('remote-screen-active', 'remote-camera-active');
  remoteAudioStream = null;
  remoteVideoStream = null;
  remoteScreenStream = null;

  incomingModal.classList.add('hidden');
  whiteboardPanel.classList.add('hidden');
  whiteboardBtn.classList.remove('pill-active');
  clearWhiteboard(false);
  docPanel.classList.add('hidden');
  docToggleBtn.classList.remove('pill-active');
  docEditor.value = '';
  docStatus.textContent = 'P2P document';
  docVersion = 0;
  chatPanel.classList.add('hidden');
  chatMessages.innerHTML = ''; chatInput.value = '';
  chatToggleBtn.classList.remove('has-unread');
  hideTransferPanel();

  pendingOffer = null; remotePeer = null;
  wasInitiator = false; retryCount = 0; callWasConnected = false;
  audioMuted = false; videoOff = false;
  currentQuality = 'medium';
  activeCamId = ''; activeMicId = '';
  camSelect.classList.add('hidden');
  micSelect.classList.add('hidden');
  setMicState('off'); setCamState('off');
  ['low','medium','high'].forEach(p =>
    $(`quality-${p}`).classList.toggle('q-active', p === 'medium'));

  callState = 'idle';
  showScreen('idle-screen');
  setInCallMode(false);
  if (shouldLogout) {
    logout(true);
    return;
  }
  startIdlePoll();
  rejoinDirectory();
  loadUsers();
}

cancelCallBtn.addEventListener('click', () => hangup(true));
hangupBtn.addEventListener('click', () => hangup(true));

// ── Mic / cam button state helpers ────────────────────────────────────────
function setMicState(state) {
  muteBtn.classList.toggle('pill-off',   state === 'off');
  muteBtn.classList.toggle('pill-muted', state === 'muted');
  muteBtn.classList.toggle('slashed',    state !== 'on');
  muteBtn.title = state === 'off' ? 'Enable microphone' : state === 'muted' ? 'Unmute' : 'Mute';
}
function setCamState(state) {
  camBtn.classList.toggle('pill-off',   state === 'off');
  camBtn.classList.toggle('pill-muted', state === 'muted');
  camBtn.classList.toggle('slashed',    state !== 'on');
  camBtn.title = state === 'off' ? 'Enable camera' : state === 'muted' ? 'Show camera' : 'Hide camera';
}

setMicState('off');
setCamState('off');

callScreen.addEventListener('pointerdown', e => {
  if (callState !== 'connected') return;
  if (e.target.closest('.controls-overlay, .chat-panel, .doc-panel, .whiteboard-panel, .transfer-panel')) return;
  showCallControls(true);
});

controlsOverlay.addEventListener('pointerdown', () => showCallControls(true));

// ── Mic button ────────────────────────────────────────────────────────────
muteBtn.addEventListener('click', async () => {
  if (!micEnabled) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: activeMicId ? { deviceId: { exact: activeMicId } } : true,
        video: false,
      });
    } catch { toast('⚠️ Microphone permission denied.'); return; }

    localAudioTrack = stream.getAudioTracks()[0];

    // Put real audio track on the connection
    if (pc) {
      const tx = pc.getTransceivers().find(t => t.receiver.track.kind === 'audio');
      if (tx) {
        tx.direction = 'sendrecv';
        await tx.sender.replaceTrack(localAudioTrack);
      }
    }

    playRemoteMedia();

    micEnabled = true; audioMuted = false;
    setMicState('on');
    enumerateDevices();
    return;
  }

  // Toggle mute
  audioMuted = !audioMuted;
  if (localAudioTrack) localAudioTrack.enabled = !audioMuted;
  setMicState(audioMuted ? 'muted' : 'on');
});

// ── Cam button ────────────────────────────────────────────────────────────
camBtn.addEventListener('click', async () => {
  if (!camEnabled) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...VIDEO_QUALITY[currentQuality], ...(activeCamId ? { deviceId: { exact: activeCamId } } : {}) },
        audio: false,
      });
    } catch { toast('⚠️ Camera permission denied.'); return; }

    localVideoTrack = stream.getVideoTracks()[0];

    // Show in PiP
    localVideo.srcObject = new MediaStream([localVideoTrack]);

    // Put real video track on the connection
    if (pc) {
      const tx = getCameraTransceiver();
      if (tx) await tx.sender.replaceTrack(localVideoTrack);
    }

    camEnabled = true; videoOff = false;
    setCamState('on');
    enumerateDevices();
    return;
  }

  // Toggle cam
  videoOff = !videoOff;
  if (localVideoTrack) localVideoTrack.enabled = !videoOff;
  setCamState(videoOff ? 'muted' : 'on');
});

// ── Mute / cam reset on hangup already covered above ─────────────────────

// ── Ring tone ─────────────────────────────────────────────────────────────
let ringCtx = null, ringInterval = null;

function startRing(outgoing = false) {
  stopRing();
  ringCtx = new AudioContext();
  const freq = outgoing ? 440 : 880, period = outgoing ? 2000 : 1000;
  function beep() {
    if (!ringCtx) return;
    const osc = ringCtx.createOscillator(), gain = ringCtx.createGain();
    osc.frequency.value = freq; osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, ringCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ringCtx.currentTime + 0.4);
    osc.connect(gain); gain.connect(ringCtx.destination);
    osc.start(); osc.stop(ringCtx.currentTime + 0.4);
  }
  beep();
  ringInterval = setInterval(beep, period);
}

function stopRing() {
  clearInterval(ringInterval); ringInterval = null;
  if (ringCtx) { ringCtx.close(); ringCtx = null; }
}

// ── UI helpers ────────────────────────────────────────────────────────────
function showScreen(id) {
  [idleScreen, callingScreen, callScreen].forEach(s =>
    s.classList.toggle('active', s.id === id));
  updateDialAvailability();
}

function updateDialAvailability() {
  const busy = callState !== 'idle';
  searchInput.disabled = busy;
  searchCallBtn.disabled = busy || searchInput.value.trim().length < 2;
  userList.querySelectorAll('.btn-call').forEach(btn => { btn.disabled = busy; });
}

let toastTimer;
function toast(msg, ms = 3500) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

function showError(msg) {
  sidebarError.textContent = msg;
  sidebarError.classList.remove('hidden');
  setTimeout(() => sidebarError.classList.add('hidden'), 4000);
}

function clearSessionAndGoHome() {
  sessionStorage.removeItem('username');
  sessionStorage.removeItem('session-token');
  window.location.href = '/';
}

async function logout(deletePresence = true) {
  if (deletePresence) {
    try { await fetch(`/api/users/${encodeURIComponent(MY_USERNAME)}`, { method: 'DELETE', headers: { 'X-Session-Token': SESSION_TOKEN } }); } catch {}
  }
  clearSessionAndGoHome();
}

async function verifySessionPresence() {
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(MY_USERNAME)}`);
    if (res.status === 404) { await logout(false); return false; }
    return res.ok;
  } catch { return true; }
}

async function copyShareLink() {
  const url = new URL('/app.html', window.location.origin);
  url.searchParams.set('call', MY_USERNAME);
  try {
    if (!navigator.clipboard) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(url.toString());
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      toast('Local link copied. Use your LAN/ngrok URL to invite another device.', 5500);
    } else {
      toast('Call link copied.');
    }
  } catch {
    window.prompt('Copy call link:', url.toString());
  }
}

shareLinkBtn.addEventListener('click', copyShareLink);
logoutBtn.addEventListener('click', () => {
  if (callState !== 'idle') hangup(true, true);
  else logout(true);
});

// ── Directory helpers ─────────────────────────────────────────────────────
async function goOffDirectory() {
  try { await fetch(`/api/users/${encodeURIComponent(MY_USERNAME)}?mode=hide`, { method: 'DELETE', headers: { 'X-Session-Token': SESSION_TOKEN } }); } catch {}
}

async function rejoinDirectory() {
  try {
    const payload = { username: MY_USERNAME, peerId: MY_USERNAME };
    if (validSessionToken(SESSION_TOKEN)) payload.sessionToken = SESSION_TOKEN;
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (validSessionToken(data.sessionToken)) {
      SESSION_TOKEN = data.sessionToken;
      sessionStorage.setItem('session-token', data.sessionToken);
    }
    return true;
  } catch { return false; }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── User list ─────────────────────────────────────────────────────────────
async function loadUsers() {
  try {
    const { users } = await fetch('/api/users').then(r => r.json());
    if (!users.some(u => u.username === MY_USERNAME)) {
      if (callState !== 'idle') return;
      await logout(false);
      return;
    }
    const others = users.filter(u => u.username !== MY_USERNAME);
    if (others.length === 0) {
      userList.innerHTML = '<li class="empty-msg">No other users registered yet.</li>';
      updateDialAvailability();
      return;
    }
    userList.innerHTML = others.map(u => `
      <li class="user-item">
        <div class="user-av">${u.username[0].toUpperCase()}</div>
        <span class="user-name">${u.username}</span>
        <button class="btn-call" data-username="${u.username}" title="Call ${u.username}">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.8 11.3l-2.4-.3a1 1 0 00-.8.3l-1.7 1.7a11 11 0 01-5.9-5.9l1.7-1.7a1 1 0 00.3-.8L4.7 2.2A1 1 0 003.7 1.2H2A1 1 0 001 2.3 13 13 0 0013.7 15a1 1 0 001.1-1v-1.7a1 1 0 00-1-1z" fill="currentColor"/></svg>
        </button>
      </li>`).join('');
    updateDialAvailability();
  } catch {
    userList.innerHTML = '<li class="empty-msg">Could not load users.</li>';
    updateDialAvailability();
  }
}

async function consumePendingCall() {
  const target = (sessionStorage.getItem('pending-call') || '').trim().toLowerCase();
  if (!target) return;
  sessionStorage.removeItem('pending-call');
  if (target === MY_USERNAME) { toast("That's your own call link."); return; }
  if (window.location.search) history.replaceState(null, '', '/app.html');
  toast(`Calling ${target} from invite link...`);
  await wait(300);
  if (callState === 'idle') dial(target);
}

const refreshBtn = $('refresh-btn');
refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  await loadUsers();
  setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
});

userList.addEventListener('click', e => {
  const btn = e.target.closest('.btn-call');
  if (btn && !btn.disabled && callState === 'idle') dial(btn.dataset.username);
});

// ── Search ────────────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  updateDialAvailability();
});

async function dialByUsername(username, options = {}) {
  if (callState !== 'idle') { toast('Already in a call.'); return; }
  const retries = options.retries || 0;
  const retryDelayMs = options.retryDelayMs || 500;
  let res = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(`/api/users/${encodeURIComponent(username)}`).catch(() => null);
    if (res?.ok) break;
    if (attempt < retries) await wait(retryDelayMs);
  }
  if (!res || !res.ok) { showError(`User "${username}" not found.`); return; }
  dial(username);
}

searchCallBtn.addEventListener('click', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (q) dialByUsername(q);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const q = searchInput.value.trim().toLowerCase();
    if (q) dialByUsername(q);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
async function startApp() {
  const hasPendingInvite = !!(sessionStorage.getItem('pending-call') || '').trim();
  if (hasPendingInvite) await rejoinDirectory();
  else if (!await verifySessionPresence()) return;
  await loadUsers();
  startPresenceHeartbeat();
  startIdlePoll();
  await consumePendingCall();
}

startApp();
