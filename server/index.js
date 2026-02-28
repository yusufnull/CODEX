const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const { WebSocketServer } = require("ws");

function loadLocalEnvFile(filename) {
  const filePath = path.join(__dirname, "..", filename);
  if (!fs.existsSync(filePath)) {
    return;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvFile(".env.local");
loadLocalEnvFile(".env");

const PORT = Number(process.env.PORT || 3000);
const EVENT_MIN_INTERVAL_MS = Number(process.env.EVENT_MIN_INTERVAL_MS || 80);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 12000);
const INFER_MIN_INTERVAL_MS = Number(process.env.INFER_MIN_INTERVAL_MS || 400);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_TRANSCRIBE_PROMPT = process.env.OPENAI_TRANSCRIBE_PROMPT || "Only transcribe speech accurately.";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "client")));

const sessions = new Map();
const sockets = new Map();

function randomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function now() {
  return Date.now();
}

function makeSession() {
  return {
    id: crypto.randomUUID(),
    code: randomCode(),
    createdAt: now(),
    updatedAt: now(),
    devices: {
      phone: null,
      tablet: null
    },
    latest: {
      landmarks: null,
      transcript: "",
      frameMeta: null
    },
    ai: {
      inFlight: false,
      lastInferAt: 0,
      pendingInfer: null,
      lastSeqProcessed: 0,
      chatHistory: []
    }
  };
}

function summarizeSession(session) {
  return {
    id: session.id,
    code: session.code,
    paired: Boolean(session.devices.phone && session.devices.tablet),
    devices: {
      phone: Boolean(session.devices.phone),
      tablet: Boolean(session.devices.tablet)
    },
    updatedAt: session.updatedAt
  };
}

function sendJson(ws, message) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function broadcastToSession(session, message) {
  for (const role of ["phone", "tablet"]) {
    const device = session.devices[role];
    if (!device) {
      continue;
    }
    const ws = sockets.get(device.wsId);
    sendJson(ws, message);
  }
}

function peerRole(role) {
  return role === "phone" ? "tablet" : "phone";
}

function routeToPeer(session, senderRole, message) {
  const target = session.devices[peerRole(senderRole)];
  if (!target) {
    return;
  }
  const ws = sockets.get(target.wsId);
  sendJson(ws, message);
}

function cleanupSessionIfEmpty(session) {
  if (!session.devices.phone && !session.devices.tablet) {
    sessions.delete(session.id);
  }
}

function removeSocketMembership(ws) {
  if (!ws.meta || !ws.meta.sessionId || !ws.meta.role) {
    return;
  }
  const session = sessions.get(ws.meta.sessionId);
  if (!session) {
    return;
  }
  const current = session.devices[ws.meta.role];
  if (current && current.wsId === ws.meta.wsId) {
    session.devices[ws.meta.role] = null;
    session.updatedAt = now();
    broadcastToSession(session, {
      type: "pair_state",
      session: summarizeSession(session)
    });
  }
  cleanupSessionIfEmpty(session);
}

function fakeOrchestrator(session, request, sourceRole) {
  const prompt = typeof request.prompt === "string" ? request.prompt : "Analyze current frame.";
  const source = sourceRole || "phone";
  const seq = Number(request.seq || 0);
  return {
    type: "directive",
    seq,
    ts: now(),
    source,
    directives: [
      {
        id: crypto.randomUUID(),
        label: `Hint: ${prompt.slice(0, 80)}`,
        anchor: {
          x: 0.5,
          y: 0.25,
          z: 0
        },
        confidence: 0.85,
        ttl_ms: 2500,
        priority: 1
      }
    ],
    meta: {
      sessionId: session.id,
      from: "fake-orchestrator"
    }
  };
}

function maybeProcessInference(session, sourceRole) {
  if (session.ai.inFlight || !session.ai.pendingInfer) {
    return;
  }
  const request = session.ai.pendingInfer;
  session.ai.pendingInfer = null;
  session.ai.inFlight = true;
  session.ai.lastInferAt = now();

  setTimeout(() => {
    const seq = Number(request.seq || 0);
    if (seq < session.ai.lastSeqProcessed) {
      session.ai.inFlight = false;
      maybeProcessInference(session, sourceRole);
      return;
    }
    session.ai.lastSeqProcessed = seq;
    const response = fakeOrchestrator(session, request, sourceRole);
    broadcastToSession(session, response);
    session.ai.inFlight = false;
    maybeProcessInference(session, sourceRole);
  }, 250);
}

function bindWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    const wsId = crypto.randomUUID();
    sockets.set(wsId, ws);
    ws.meta = { wsId, sessionId: null, role: null, lastHeartbeatAt: now(), lastEventAt: 0 };
    sendJson(ws, { type: "hello", wsId, ts: now() });

    ws.on("message", (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(ws, { type: "error", code: "BAD_JSON", detail: "Invalid JSON payload." });
        return;
      }

      if (!msg || typeof msg.type !== "string") {
        sendJson(ws, { type: "error", code: "BAD_MESSAGE", detail: "Message must include type." });
        return;
      }

      if (msg.type === "join") {
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
        const role = msg.role === "phone" || msg.role === "tablet" ? msg.role : null;
        const session = sessions.get(sessionId);
        if (!session || !role) {
          sendJson(ws, { type: "error", code: "JOIN_FAILED", detail: "Invalid session or role." });
          return;
        }
        const existing = session.devices[role];
        if (existing && existing.wsId !== wsId) {
          const prior = sockets.get(existing.wsId);
          sendJson(prior, {
            type: "error",
            code: "REPLACED",
            detail: "This role joined from another device."
          });
          prior?.close();
        }

        ws.meta.sessionId = sessionId;
        ws.meta.role = role;
        session.devices[role] = {
          wsId,
          lastSeen: now()
        };
        session.updatedAt = now();

        sendJson(ws, {
          type: "joined",
          session: summarizeSession(session),
          role
        });

        broadcastToSession(session, {
          type: "pair_state",
          session: summarizeSession(session)
        });
        return;
      }

      if (!ws.meta.sessionId || !ws.meta.role) {
        sendJson(ws, { type: "error", code: "NOT_JOINED", detail: "Join a session first." });
        return;
      }

      const session = sessions.get(ws.meta.sessionId);
      if (!session) {
        sendJson(ws, { type: "error", code: "SESSION_GONE", detail: "Session no longer exists." });
        return;
      }

      if (msg.type === "heartbeat") {
        ws.meta.lastHeartbeatAt = now();
        const device = session.devices[ws.meta.role];
        if (device) {
          device.lastSeen = now();
        }
        return;
      }

      if (msg.type === "webrtc_offer" || msg.type === "webrtc_answer" || msg.type === "webrtc_ice") {
        routeToPeer(session, ws.meta.role, {
          type: msg.type,
          from: ws.meta.role,
          payload: msg.payload || null
        });
        return;
      }

      if (msg.type === "landmarks" || msg.type === "transcript" || msg.type === "frame_meta") {
        const since = now() - ws.meta.lastEventAt;
        if (since < EVENT_MIN_INTERVAL_MS) {
          return;
        }
        ws.meta.lastEventAt = now();
        session.updatedAt = now();
        if (msg.type === "landmarks") {
          session.latest.landmarks = msg.payload || null;
        } else if (msg.type === "transcript") {
          session.latest.transcript = String(msg.payload || "");
        } else {
          session.latest.frameMeta = msg.payload || null;
        }
        routeToPeer(session, ws.meta.role, {
          type: msg.type,
          from: ws.meta.role,
          seq: Number(msg.seq || 0),
          ts: Number(msg.ts || now()),
          payload: msg.payload || null
        });
        return;
      }

      if (msg.type === "infer") {
        const elapsed = now() - session.ai.lastInferAt;
        const request = {
          seq: Number(msg.seq || 0),
          prompt: msg.prompt || "Analyze frame",
          frameMeta: msg.frameMeta || session.latest.frameMeta || null,
          ts: Number(msg.ts || now())
        };
        if (elapsed < INFER_MIN_INTERVAL_MS && !session.ai.inFlight) {
          return;
        }
        session.ai.pendingInfer = request;
        session.updatedAt = now();
        maybeProcessInference(session, ws.meta.role);
        return;
      }

      sendJson(ws, { type: "error", code: "UNKNOWN_TYPE", detail: `Unsupported type: ${msg.type}` });
    });

    ws.on("close", () => {
      removeSocketMembership(ws);
      sockets.delete(wsId);
    });
  });

  setInterval(() => {
    const t = now();
    for (const [wsId, ws] of sockets.entries()) {
      if (t - ws.meta.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        ws.close();
        sockets.delete(wsId);
      }
    }
  }, 2000);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: now(), sessions: sessions.size });
});

app.post("/api/session/new", (_req, res) => {
  const session = makeSession();
  sessions.set(session.id, session);
  res.status(201).json({
    session: summarizeSession(session),
    joinUrl: `/index.html?session=${session.id}`
  });
});

app.post("/api/session/by-code/:code", (req, res) => {
  const code = String(req.params.code || "").trim();
  const session = [...sessions.values()].find((s) => s.code === code);
  if (!session) {
    res.status(404).json({ error: "Session code not found." });
    return;
  }
  res.json({ session: summarizeSession(session) });
});

app.post("/api/realtime/transcription/client-secret", async (req, res) => {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });
    return;
  }

  const language = typeof req.body?.language === "string" ? req.body.language : "en";
  const sessionConfig = {
    expires_after: {
      anchor: "created_at",
      seconds: 600
    },
    session: {
      type: "transcription",
      audio: {
        input: {
          transcription: {
            model: OPENAI_TRANSCRIBE_MODEL,
            language,
            prompt: OPENAI_TRANSCRIBE_PROMPT
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      }
    }
  };

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(sessionConfig)
    });

    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      res.status(response.status).json({
        error: "Failed to create client secret.",
        detail: data
      });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({
      error: "Realtime client secret request failed.",
      detail: err instanceof Error ? err.message : String(err)
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

const server = http.createServer(app);
bindWebSocket(server);
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
