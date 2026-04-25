import { io, Socket } from 'socket.io-client';
import { resolveApiUrl } from './user-config.js';

export function createSocket(apiUrl?: string): Socket {
  const url = resolveApiUrl(apiUrl);
  return io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });
}
