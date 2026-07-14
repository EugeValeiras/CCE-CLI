import { io, Socket } from 'socket.io-client';
import { resolveApiToken, resolveApiUrl } from './user-config.js';

export function createSocket(apiUrl?: string): Socket {
  const url = resolveApiUrl(apiUrl);
  const apiToken = resolveApiToken();
  return io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    ...(apiToken ? { auth: { token: apiToken } } : {}),
  });
}
