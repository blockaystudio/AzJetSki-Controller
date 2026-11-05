// Node 22 fetch does not use the managed host's inherited HTTPS proxy.
// Keep provider credentials inside the verified TLS connection, including when
// the connection is carried through an authenticated HTTP(S) CONNECT proxy.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {isIP} from 'node:net';

const DEFAULT_TIMEOUT = 12_000;
const DEFAULT_RESPONSE_LIMIT = 2 * 1024 * 1024;
const blockedHeaders = new Set(['host', 'connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'content-length']);
const safeError = (message, name = 'Error') => Object.assign(new Error(message), {name});
const hostname = url => url.hostname.replace(/^\[|\]$/g, '');

function requestSettings(input, init, env) {
  let target, proxy, headers, body;
  try {
    target = new URL(input);
    if (target.protocol !== 'https:' || target.username || target.password) throw Error();
    const proxyValue = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
    if (proxyValue) {
      proxy = new URL(proxyValue);
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash) throw Error();
    }
    headers = Object.fromEntries(new Headers(init.headers));
    if (Object.keys(headers).some(name => blockedHeaders.has(name))) throw Error();
    headers['accept-encoding'] = 'identity';
    if (init.body == null) body = null;
    else if (typeof init.body === 'string') body = Buffer.from(init.body);
    else if (init.body instanceof URLSearchParams) {
      body = Buffer.from(init.body.toString());
      headers['content-type'] ||= 'application/x-www-form-urlencoded;charset=UTF-8';
    } else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
    else if (init.body instanceof ArrayBuffer) body = Buffer.from(init.body);
    else throw Error();
    const method = String(init.method || 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method) || ['CONNECT', 'TRACE', 'TRACK'].includes(method) || (['GET', 'HEAD'].includes(method) && body)) throw Error();
    if (body) headers['content-length'] = String(body.length);
    if (init.signal != null && (typeof init.signal.addEventListener !== 'function' || typeof init.signal.removeEventListener !== 'function')) throw Error();
    let proxyAuthorization;
    if (proxy && (proxy.username || proxy.password)) {
      proxyAuthorization = 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    }
    return {target, proxy, proxyAuthorization, method, headers, body, signal: init.signal};
  } catch {
    // Native URL, header and HTTP errors can include credentials or OAuth data.
    throw safeError('Google HTTPS request or proxy configuration is invalid');
  }
}

/** Test fixtures may supply their own environment and CA without changing globals.
 * Normal operation always verifies the provider and HTTPS proxy certificates.
 * Responses are buffered within a size limit; the deadline covers CONNECT, TLS,
 * headers and body. Redirects are returned to the caller without forwarding auth.
 */
export function createGoogleFetch({env = process.env, timeoutMs = DEFAULT_TIMEOUT, maxResponseBytes = DEFAULT_RESPONSE_LIMIT, ca} = {}) {
  if (!env || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw safeError('Google transport limits are invalid');
  }
  return async function googleFetch(input, init = {}) {
    const {target, proxy, proxyAuthorization, method, headers, body, signal} = requestSettings(input, init, env);
    if (signal?.aborted) throw safeError('Google request was aborted', 'AbortError');
    return new Promise((resolve, reject) => {
      const resources = new Set();
      let settled = false;
      const track = resource => { resources.add(resource); return resource; };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        for (const resource of resources) resource.destroy();
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(safeError('Google request was aborted', 'AbortError'));
      const failed = () => finish(safeError('Google HTTPS request could not complete'));
      const deadline = setTimeout(() => finish(safeError('Google request timed out', 'TimeoutError')), timeoutMs);
      signal?.addEventListener('abort', abort, {once: true});
      // The signal may have changed between the initial check and subscription.
      if (signal?.aborted) { abort(); return; }

      const send = secureSocket => {
        if (settled) { secureSocket?.destroy(); return; }
        try {
          let agent = false;
          if (secureSocket) {
            agent = track(new https.Agent({keepAlive: false}));
            agent.createConnection = () => secureSocket;
          }
          const request = track(https.request(target, {
            method, headers, agent, ca, rejectUnauthorized: true, maxHeaderSize: 16 * 1024
          }, response => {
            track(response);
            if (settled) { response.destroy(); return; }
            const oversized = () => finish(safeError('Google response exceeded its size limit'));
            if (Number(response.headers['content-length']) > maxResponseBytes) { oversized(); return; }
            const chunks = [];
            let length = 0;
            response.on('data', chunk => {
              length += chunk.length;
              if (length > maxResponseBytes) { oversized(); return; }
              chunks.push(chunk);
            });
            response.once('error', failed);
            response.once('aborted', failed);
            response.once('end', () => {
              if (settled) return;
              const bytes = Buffer.concat(chunks, length);
              const status = response.statusCode;
              finish(null, {
                status, ok: status >= 200 && status < 300,
                headers: new Headers(response.rawHeaders.reduce((pairs, value, index, all) => {
                  if (index % 2 === 0) pairs.push([value, all[index + 1]]);
                  return pairs;
                }, [])),
                async text() { return bytes.toString('utf8'); },
                async json() {
                  try { return JSON.parse(bytes.toString('utf8')); }
                  catch { throw safeError('Google response was not valid JSON'); }
                }
              });
            });
          }));
          request.once('error', failed);
          request.end(body);
        } catch { failed(); }
      };

      if (!proxy) { send(); return; }
      try {
        const authority = `${target.hostname}:${target.port || '443'}`;
        const proxyHeaders = {host: authority};
        if (proxyAuthorization) proxyHeaders['proxy-authorization'] = proxyAuthorization;
        const connect = track((proxy.protocol === 'https:' ? https : http).request({
          hostname: hostname(proxy), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
          method: 'CONNECT', path: authority, headers: proxyHeaders, agent: false,
          ca, rejectUnauthorized: true, maxHeaderSize: 16 * 1024
        }));
        connect.once('error', () => finish(safeError('Google HTTPS proxy connection failed')));
        connect.once('connect', (response, socket, head) => {
          track(socket);
          if (settled) { socket.destroy(); return; }
          if (response.statusCode !== 200) {
            finish(safeError('Google HTTPS proxy rejected the connection'));
            return;
          }
          try {
            if (head.length) socket.unshift(head);
            const host = hostname(target);
            const secure = track(tls.connect({socket, host, ...(isIP(host) ? {} : {servername: host}), ca, rejectUnauthorized: true}));
            secure.once('error', failed);
            secure.once('secureConnect', () => send(secure));
          } catch { failed(); }
        });
        connect.end();
      } catch { finish(safeError('Google HTTPS proxy connection failed')); }
    });
  };
}

export const googleFetch = createGoogleFetch();
export default googleFetch;
