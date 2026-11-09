const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4400";
const configuredRealtimeUrl =
  process.env.NEXT_PUBLIC_REALTIME_URL ?? "ws://127.0.0.1:4401";

export const API_URL = configuredApiUrl.replace(/\/$/, "");
export const REALTIME_URL = configuredRealtimeUrl.replace(/\/$/, "");
export const REALTIME_DOCUMENTS_URL = `${REALTIME_URL}/ws/documents`;
