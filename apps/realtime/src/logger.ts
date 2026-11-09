import pino from "pino";

export function createRealtimeLogger(input: {
  level: string;
  nodeId: string;
}): pino.Logger {
  return pino({
    level: input.level,
    base: { service: "trellis-realtime", nodeId: input.nodeId },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['sec-websocket-protocol']",
        "token",
        "*.token",
      ],
      censor: "[redacted]",
    },
  });
}
