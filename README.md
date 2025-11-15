# Local File Sharing Web App

This is a minimal local-network file sharing web app using a small signaling server and WebRTC DataChannels.

Quick start

1. Install dependencies

```bash
npm install
```

2. Start server

```bash
npm start
```

3. Open the app from devices on the same network

Open `http://<server-ip>:3000` in your desktop or mobile browser. Each client gets a temporary 4-character ID. Use that ID to connect peers.

Notes and limitations

- The server only provides signaling; file transfer is peer-to-peer via WebRTC DataChannels.
- For peers to discover each other, the signaling server must be reachable from all devices (run it on a machine with local network IP and open that IP to other devices: e.g. `http://192.168.1.10:3000`).
- The browser will save received files to the default download location. Web pages cannot automatically write to the device gallery on most mobile browsers — users should save images/videos manually from the downloads area or use platform-specific browser features. Newer File System Access APIs may help on some platforms.
- This scaffold is minimal. It demonstrates per-file chunked transfer and per-file progress. It is not production hardened — do not expose it publicly without securing signaling.

Next steps you may want me to implement

- Improve protocol to support concurrent transfers reliably (identify chunks with fileId and sequence numbers)
- Persist temporary account/profile options in localStorage UI
- Add UI to select recipients with nicer UX
- Add permission prompts and image/video gallery saving helpers for Android/iOS PWA contexts
