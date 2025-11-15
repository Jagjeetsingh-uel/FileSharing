// Client-side: register with signaling server, manage RTCPeerConnections and data channels
 (function(){
  const CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function genId(len=4){
    let s='';
    for(let i=0;i<len;i++) s+=CHARSET[Math.floor(Math.random()*CHARSET.length)];
    return s;
  }

  const myIdEl = document.getElementById('myId');
  const peerListEl = document.getElementById('peerList');
  const remoteIdInput = document.getElementById('remoteIdInput');
  const connectBtn = document.getElementById('connectBtn');
  const fileInput = document.getElementById('fileInput');
  const sendSelectedBtn = document.getElementById('sendSelected');
  const sendAllBtn = document.getElementById('sendAll');
  const transfersEl = document.getElementById('transfers');
  const activeTransfersEl = document.getElementById('activeTransfers');
  const selectAllPeers = document.getElementById('selectAllPeers');
  const refreshPeersBtn = document.getElementById('refreshPeers');
  const menuBtn = document.getElementById('menuBtn');
  const sidebar = document.querySelector('.sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');

  let myId = localStorage.getItem('fs:tempId') || genId();
  localStorage.setItem('fs:tempId', myId);
  myIdEl.textContent = myId;

  // Try to open a signaling WebSocket to the same origin. If none exists (static hosting), fall back to manual mode.
  let ws = null;
  let signalingEnabled = false;
  try{
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.addEventListener('open', ()=>{ signalingEnabled = true; createTempNote('Signaling server connected'); ws.send(JSON.stringify({type:'register', id: myId})); ws.send(JSON.stringify({type:'list'})); });
    ws.addEventListener('error', ()=>{ signalingEnabled = false; createTempNote('No signaling server (serverless mode)'); });
    ws.addEventListener('close', ()=>{ signalingEnabled = false; createTempNote('Signaling connection closed'); });
  }catch(e){ signalingEnabled = false; ws = null; }

  const peers = {}; // id -> {pc, dc}
  const pendingChunkHeaders = {}; // peerId -> [{fileId,size}, ...]

  ws.addEventListener('open', ()=>{
    ws.send(JSON.stringify({type:'register', id: myId}));
    ws.send(JSON.stringify({type:'list'}));
  });

  // Drop zone support: allow files to be dragged into the main area
  const dropZone = document.getElementById('dropZone');
  if (dropZone){
    dropZone.addEventListener('dragover', (e)=>{ e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', (e)=>{ dropZone.classList.remove('dragover'); });
    dropZone.addEventListener('drop', (e)=>{
      e.preventDefault(); dropZone.classList.remove('dragover');
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files && dt.files.length){
        // assign files to file input so the rest of UI can use them
        try{ fileInput.files = dt.files; }catch(err){ /* some browsers disallow setting files; handle via direct send prompt */ }
        // small visual cue
        createTempNote(`${dt.files.length} file(s) added`);
      }
    });
  }

  function createTempNote(text, timeout=1800){
    const n = document.createElement('div'); n.textContent = text; n.style.position='fixed'; n.style.right='20px'; n.style.bottom='20px'; n.style.padding='10px 14px'; n.style.background='rgba(0,0,0,0.6)'; n.style.borderRadius='8px'; n.style.color='#fff'; n.style.zIndex=9999;
    document.body.appendChild(n); setTimeout(()=>n.remove(), timeout);
  }

  // Manual (serverless) signaling helpers -------------------------------------------------
  const createOfferBtn = document.getElementById('createOfferBtn');
  const acceptOfferBtn = document.getElementById('acceptOfferBtn');
  const manualOut = document.getElementById('manualOut');
  const copyOut = document.getElementById('copyOut');
  const pasteRemote = document.getElementById('pasteRemote');

  function encodeSignal(obj){ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
  function decodeSignal(str){ return JSON.parse(decodeURIComponent(escape(atob(str)))); }

  function waitForIceGatheringComplete(pc, timeout = 4000){
    return new Promise((resolve)=>{
      if (pc.iceGatheringState === 'complete') return resolve();
      function check(){ if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); } }
      pc.addEventListener('icegatheringstatechange', check);
      // fallback timeout
      setTimeout(()=>resolve(), timeout);
    });
  }

  // Create an offer and show encoded string to copy/share
  createOfferBtn && createOfferBtn.addEventListener('click', async ()=>{
    try{
      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel('files');
      setupDataChannel('manual:'+Date.now(), dc);
      const id = 'manual-'+Date.now();
      peers[id] = { pc, dc: null };
      pc.ondatachannel = (ev)=> setupDataChannel(id, ev.channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      const payload = { type: 'offer', sdp: pc.localDescription.sdp, from: myId };
      manualOut.value = encodeSignal(payload);
      createTempNote('Offer created — copy and send to remote');
    }catch(e){ console.error(e); alert('Failed to create offer: '+e.message); }
  });

  // Accept an incoming offer (paste into manualOut), create answer and show encoded answer
  acceptOfferBtn && acceptOfferBtn.addEventListener('click', async ()=>{
    const txt = manualOut.value.trim();
    if (!txt) return alert('Paste the remote offer in the box first');
    try{
      const offer = decodeSignal(txt);
      if (offer.type !== 'offer') return alert('Not an offer');
      const pc = new RTCPeerConnection();
      pc.ondatachannel = (ev)=> setupDataChannel(offer.from || ('manual-'+Date.now()), ev.channel);
      peers[offer.from || ('manual-'+Date.now())] = { pc, dc: null };
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);
      const payload = { type: 'answer', sdp: pc.localDescription.sdp, from: myId };
      manualOut.value = encodeSignal(payload);
      createTempNote('Answer created — copy and send back to caller');
    }catch(e){ console.error(e); alert('Failed to accept offer: '+e.message); }
  });

  // Copy output to clipboard
  copyOut && copyOut.addEventListener('click', async ()=>{
    try{ await navigator.clipboard.writeText(manualOut.value); createTempNote('Copied to clipboard'); }catch(e){ createTempNote('Copy failed — select & copy manually'); }
  });

  // Paste remote data from clipboard and finish (for caller paste answer, for callee paste offer)
  pasteRemote && pasteRemote.addEventListener('click', async ()=>{
    try{
      const txt = await navigator.clipboard.readText();
      if (!txt) return alert('Clipboard empty');
      const data = decodeSignal(txt.trim());
      if (data.type === 'answer'){
        // caller: set remote description for the correct manual peer
        const key = Object.keys(peers).find(k=>k.startsWith('manual-'));
        if (!key) return alert('No manual offer in progress (create an offer first)');
        const entry = peers[key];
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        createTempNote('Answer applied — connection should establish');
      } else if (data.type === 'offer'){
        // accept incoming offer and generate answer automatically
        const pc = new RTCPeerConnection();
        pc.ondatachannel = (ev)=> setupDataChannel(data.from || ('manual-'+Date.now()), ev.channel);
        peers[data.from || ('manual-'+Date.now())] = { pc, dc: null };
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGatheringComplete(pc);
        const payload = { type: 'answer', sdp: pc.localDescription.sdp, from: myId };
        manualOut.value = encodeSignal(payload);
        createTempNote('Answer created — copy and send back to caller');
      } else {
        alert('Unsupported payload');
      }
    }catch(e){ console.error(e); alert('Paste failed: '+e.message); }
  });

  if (ws){
    ws.addEventListener('message', async (ev)=>{
      try{
        const data = JSON.parse(ev.data);
        if (data.type === 'peers') {
          renderPeerList(data.peers.filter(id=>id!==myId));
          return;
        }

        if (data.type === 'signal') {
          const { from, payload } = data;
          await handleSignal(from, payload);
          return;
        }
      }catch(e){ /* ignore invalid messages */ }
    });
  } else {
    // no WebSocket signaling available — manual mode only
    createTempNote('Signaling server not found — manual copy/paste mode enabled');
  }

  // Mobile sidebar toggle behavior
  if (menuBtn && sidebar && sidebarOverlay){
    menuBtn.addEventListener('click', ()=>{
      sidebar.classList.toggle('open');
      sidebarOverlay.classList.toggle('show');
    });
    sidebarOverlay.addEventListener('click', ()=>{
      sidebar.classList.remove('open');
      sidebarOverlay.classList.remove('show');
    });
  }

  function renderPeerList(list){
    peerListEl.innerHTML='';
    list.forEach(id=>{
      const d = document.createElement('div'); d.className='peer'; d.id='peer_'+id;
      const top = document.createElement('div'); top.style.display='flex'; top.style.width='100%'; top.style.justifyContent='space-between';
      const left = document.createElement('div');
      const cb = document.createElement('input'); cb.type='checkbox'; cb.value=id; cb.id='cb_'+id;
      const idSpan = document.createElement('span'); idSpan.className='id'; idSpan.textContent = id;
      left.appendChild(cb); left.appendChild(idSpan);
      const btns = document.createElement('div');
      const btn = document.createElement('button'); btn.textContent='Connect'; btn.onclick = ()=> connectToPeer(id);
      const disconnect = document.createElement('button'); disconnect.textContent='Disconnect'; disconnect.style.marginLeft='6px';
      disconnect.onclick = ()=> disconnectPeer(id);
      btns.appendChild(btn); btns.appendChild(disconnect);
      top.appendChild(left); top.appendChild(btns);
      const status = document.createElement('div'); status.className='status'; status.textContent = peers[id] && peers[id].dc && peers[id].dc.readyState === 'open' ? 'connected' : 'not connected';
      d.appendChild(top);
      d.appendChild(status);
      peerListEl.appendChild(d);
      updatePeerConnectedState(id);
    });
  }

  connectBtn.addEventListener('click', ()=>{
    const id = (remoteIdInput.value || '').trim().toLowerCase();
    if (id) connectToPeer(id);
  });

  function sendSignal(to, payload){
    if (!signalingEnabled || !ws || ws.readyState !== WebSocket.OPEN){
      console.warn('Signaling not available — use manual mode');
      createTempNote('Signaling not available — use manual copy/paste');
      return;
    }
    ws.send(JSON.stringify({type:'signal', to, from: myId, payload}));
  }

  async function connectToPeer(id){
    if (peers[id]) return;
    const pc = new RTCPeerConnection();
    const dc = pc.createDataChannel('files');
    setupDataChannel(id, dc);

    pc.onicecandidate = (e)=>{ if (e.candidate) sendSignal(id, {type:'ice', candidate: e.candidate}); };

    pc.ondatachannel = (ev)=>{ setupDataChannel(id, ev.channel); };

    peers[id] = { pc, dc: null };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(id, {type:'offer', sdp: offer.sdp});
  }

  async function handleSignal(from, payload){
    let entry = peers[from];
    if (!entry) {
      // create peer connection to accept
      const pc = new RTCPeerConnection();
      pc.onicecandidate = (e)=>{ if (e.candidate) sendSignal(from, {type:'ice', candidate: e.candidate}); };
      pc.ondatachannel = (ev)=>{ setupDataChannel(from, ev.channel); };
      peers[from] = { pc, dc: null };
      entry = peers[from];
    }
    const pc = entry.pc;

    if (payload.type === 'offer'){
      await pc.setRemoteDescription({type:'offer', sdp: payload.sdp});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, {type:'answer', sdp: answer.sdp});
      return;
    }

    if (payload.type === 'answer'){
      await pc.setRemoteDescription({type:'answer', sdp: payload.sdp});
      return;
    }

    if (payload.type === 'ice'){
      try{ await pc.addIceCandidate(payload.candidate); }catch(e){console.warn(e)}
      return;
    }
  }

  function setupDataChannel(peerId, channel){
    channel.binaryType = 'arraybuffer';
    peers[peerId].dc = channel;
    pendingChunkHeaders[peerId] = pendingChunkHeaders[peerId] || [];

    channel.addEventListener('open', ()=>{ console.log('DC open', peerId); updatePeerConnectedState(peerId); });
    channel.addEventListener('close', ()=>{ console.log('DC closed', peerId); updatePeerConnectedState(peerId); });

    // Receive file protocol: JSON meta messages, then header 'file-chunk' JSON before each binary chunk
    const incoming = {};

    channel.addEventListener('message', (ev)=>{
      if (typeof ev.data === 'string'){
        try{
          const msg = JSON.parse(ev.data);
          if (msg.type === 'file-meta'){
            incoming[msg.fileId] = {meta: msg, chunks: [], received: 0};
            createTransferUI(msg.fileId, msg.name, msg.size, peerId, false);
          } else if (msg.type === 'file-chunk'){
            // header indicates the next binary message belongs to this fileId
            pendingChunkHeaders[peerId].push({fileId: msg.fileId, size: msg.size});
          }
        }catch(e){console.warn('invalid json')}
        return;
      }

      // binary chunk follows a preceding 'file-chunk' header
      const q = pendingChunkHeaders[peerId];
      if (!q || !q.length){ console.warn('Received stray binary chunk'); return; }
      const header = q.shift();
      const fileId = header.fileId;
      if (!incoming[fileId]){ console.warn('No metadata for file', fileId); return; }
      incoming[fileId].chunks.push(ev.data);
      incoming[fileId].received += ev.data.byteLength;
      updateTransferProgress(fileId, incoming[fileId].received / incoming[fileId].meta.size * 100);
      if (incoming[fileId].received >= incoming[fileId].meta.size){
        const blob = new Blob(incoming[fileId].chunks, {type: incoming[fileId].meta.mime});
        saveBlob(blob, incoming[fileId].meta.name);
        updateTransferProgress(fileId, 100, true);
        delete incoming[fileId];
      }
    });
  }

  // UI helpers for transfers
  function createTransferUI(fileId, name, size, peerId, outgoing=true){
    const el = document.createElement('div'); el.className='transfer'; el.id='transfer_'+fileId;
    const meta = document.createElement('div'); meta.className='meta';
    const title = document.createElement('div'); title.className='name'; title.textContent = name;
    const sub = document.createElement('div'); sub.className='sub'; sub.textContent = `${outgoing ? 'To' : 'From'} ${peerId} • ${Math.round(size/1024)} KB`;
    meta.appendChild(title); meta.appendChild(sub);
    const progress = document.createElement('div'); progress.className='progress'; progress.innerHTML = '<i style="width:0%"></i>';
    meta.appendChild(progress);
    const actions = document.createElement('div'); actions.className='actions';
    const pct = document.createElement('div'); pct.className='pct'; pct.textContent = '0%';
    actions.appendChild(pct);
    el.appendChild(meta); el.appendChild(actions);
    activeTransfersEl.appendChild(el);
  }
  function updateTransferProgress(fileId, percent, done=false){
    const el = document.getElementById('transfer_'+fileId);
    if (!el) return;
    const bar = el.querySelector('.progress > i');
    const pct = el.querySelector('.pct');
    bar.style.width = percent + '%';
    if (pct) pct.textContent = Math.round(percent)+'%';
    if (done) el.style.opacity = '0.6';
  }

  function saveBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display='none';
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 5000);
  }

  // Sending files: send a JSON meta, then for each chunk send a 'file-chunk' header JSON and the binary chunk
  function sendFilesToPeer(peerId, files){
    const entry = peers[peerId];
    if (!entry || !entry.dc || entry.dc.readyState !== 'open') { alert('No connection to '+peerId); return; }
    for (const file of files){
      const fileId = peerId + ':' + Date.now() + ':' + Math.floor(Math.random()*1000);
      createTransferUI(fileId, file.name, file.size, peerId, true);
      // send meta
      entry.dc.send(JSON.stringify({type:'file-meta', fileId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream'}));
      const chunkSize = 64*1024;
      let offset = 0;
      const sendSlice = (o) => {
        const slice = file.slice(o, o + chunkSize);
        const reader = new FileReader();
        reader.addEventListener('error', error => console.error('Read error', error));
        reader.addEventListener('load', e => {
          const ab = e.target.result;
          // header describing following binary
          entry.dc.send(JSON.stringify({type:'file-chunk', fileId, size: ab.byteLength}));
          entry.dc.send(ab);
          offset += ab.byteLength;
          updateTransferProgress(fileId, offset / file.size * 100);
          if (offset < file.size) sendSlice(offset);
          else updateTransferProgress(fileId, 100, true);
        });
        reader.readAsArrayBuffer(slice);
      };
      sendSlice(0);
    }
  }

  sendSelectedBtn.addEventListener('click', ()=>{
    const boxes = peerListEl.querySelectorAll('input[type=checkbox]:checked');
    const ids = Array.from(boxes).map(b=>b.value);
    if (!ids.length){ alert('Select at least one peer'); return; }
    const files = Array.from(fileInput.files);
    if (!files.length){ alert('Choose files first'); return; }
    ids.forEach(id => sendFilesToPeer(id, files));
  });

  sendAllBtn.addEventListener('click', ()=>{
    const ids = Object.keys(peers);
    if (!ids.length){ alert('No connected peers'); return; }
    const files = Array.from(fileInput.files);
    if (!files.length){ alert('Choose files first'); return; }
    ids.forEach(id => sendFilesToPeer(id, files));
  });

  selectAllPeers.addEventListener('change', (e)=>{
    const checked = e.target.checked;
    const boxes = peerListEl.querySelectorAll('input[type=checkbox]');
    boxes.forEach(b=>b.checked = checked);
  });

  refreshPeersBtn.addEventListener('click', ()=>{
    ws.send(JSON.stringify({type:'list'}));
  });

  function disconnectPeer(id){
    const entry = peers[id];
    if (!entry) return;
    try{ if (entry.dc) entry.dc.close(); if (entry.pc) entry.pc.close(); }catch(e){}
    delete peers[id];
    updatePeerConnectedState(id);
  }

  function updatePeerConnectedState(id){
    const el = document.getElementById('peer_'+id);
    if (!el) return;
    const status = el.querySelector('.status');
    if (peers[id] && peers[id].dc && peers[id].dc.readyState === 'open'){
      el.classList.add('connected');
      status.textContent = 'connected';
    } else {
      el.classList.remove('connected');
      status.textContent = 'not connected';
    }
  }

})();
