# AR Hackathon Demo (Single User, No Redis)





https://github.com/user-attachments/assets/b7b21245-1c55-4535-9130-c6283eb6c751





- It looks best with a stereoscopic headset. Approach us to try it out :)

This starter implements a minimal architecture for phone/tablet pairing with:

- In-memory session state (single backend process)
- WebSocket session hub and WebRTC signaling
- Basic media relay setup with peer-to-peer stream
- Mocked AI orchestrator returning AR directives
- Client-side stereoscopic AR filter (side-by-side stereo output for 3D glasses)

## Quick Start

1. Install deps:

```bash
npm install
```

2. Start:

```bash
npm start
```

3. Open `http://localhost:3000` on phone + tablet browser.

4. On one device:
   - click **Create Session**
   - share 6-digit code with other device

5. On other device:
   - enter code
   - click **Find by Code**

6. On both:
   - pick role (`phone` and `tablet`)
   - click **Connect WS**

7. Optional media:
   - click **Start Camera**
   - click **Start WebRTC** on one device
   - in Demo controls, enable **Stereo AR** and tune eye/depth sliders
8. Optional voice commands:
   - set `OPENAI_API_KEY` in backend environment
   - click **Start voice commands**
   - say one command: `left`, `right`, `back`, `exit`, `click`

## Current Message Types

- Session/control: `join`, `joined`, `pair_state`, `heartbeat`
- Realtime events: `landmarks`, `transcript`, `frame_meta`
- AI flow: `infer`, `directive`
- WebRTC signaling: `webrtc_offer`, `webrtc_answer`, `webrtc_ice`

## Bottleneck Controls Included

- Event throttling (`EVENT_MIN_INTERVAL_MS`, default `80ms`)
- Inference throttling (`INFER_MIN_INTERVAL_MS`, default `400ms`)
- Single in-flight inference with newest-request-wins
- Sequence-based stale directive drop on client
- Heartbeat timeout cleanup (`HEARTBEAT_TIMEOUT_MS`, default `12s`)

## What To Replace For Real Demo

- In `server/index.js`, replace `fakeOrchestrator` with real VLM/LLM calls.
- In `client/app.js`, replace `sendMockLandmarks` with MediaPipe outputs.
- Replace plain video UI with your AR WebGL/Three.js overlay scene.
- Add TURN credentials in client `RTCPeerConnection` for strict NAT cases.

## DevOps (Minimal)

Deploy only:

1. One static frontend + backend service (same process is fine)
2. One TURN service (managed is easiest) for reliable WebRTC

Recommended env vars:

- `PORT`
- `EVENT_MIN_INTERVAL_MS`
- `INFER_MIN_INTERVAL_MS`
- `HEARTBEAT_TIMEOUT_MS`
- `OPENAI_API_KEY` (required for realtime transcription)
- `OPENAI_TRANSCRIBE_MODEL` (optional, default `gpt-4o-mini-transcribe`)
- `OPENAI_TRANSCRIBE_PROMPT` (optional transcription hint)
