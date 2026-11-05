import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {setImmediate as nextTurn} from 'node:timers/promises';
import googleFetch, {googleFetch as namedGoogleFetch, createGoogleFetch} from '../src/google-transport.mjs';

// Public, fictional fixture key and self-signed CA, valid from 2020 to 2120.
// Only the explicit fixture transport trusts it; global trust is never changed.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnXf1kYMuPq9K61NO
Z1WnyIuq0qaNayxBlnFc+7iy1CahRANCAAQY8/eJq7jZPWemvK4p4dctkAinj3P1
/W0iNSlMY9fDy9HMzoZNKhIlO2bq3B4uGmqa6NodGN2/yhK8qqePGQaz
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
MIIBZTCCAQugAwIBAgICA+kwCgYIKoZIzj0EAwIwIjEgMB4GA1UEAwwXZmljdGlv
bmFsLWNhbGVuZGFyLnRlc3QwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEwMDAw
MDBaMCIxIDAeBgNVBAMMF2ZpY3Rpb25hbC1jYWxlbmRhci50ZXN0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEGPP3iau42T1npryuKeHXLZAIp49z9f1tIjUpTGPX
w8vRzM6GTSoSJTtm6tweLhpqmujaHRjdv8oSvKqnjxkGs6MvMC0wDwYDVR0TAQH/
BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZIzj0EAwID
SAAwRQIgDOIXDSx2EKJQYnKGQHmODTVuxjsCzfBjO2OEUK/7eSQCIQDJwb97gix6
/GmZCo7Ak2jqrsolmOdQphLGZofaE/WjIw==
-----END CERTIFICATE-----`;

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server;
}

async function targetFixture(t, handler = (_req, res) => res.end('{"fixture":true}')) {
  const server = await listen(t, https.createServer({key, cert}, handler));
  return {server, port: server.address().port, url: `https://127.0.0.1:${server.address().port}`};
}

async function proxyFixture(t, target, {secure = false, reject = false, stall = false, onConnect} = {}) {
  const seen = [], upstreams = new Set();
  const server = secure ? https.createServer({key, cert}) : http.createServer();
  server.on('connect', (request, socket, head) => {
    seen.push({url: request.url, headers: request.headers});
    onConnect?.();
    if (stall) return;
    if (reject) {
      socket.end('HTTP/1.1 407 fictional-proxy-password fictional-bearer\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (request.url !== `127.0.0.1:${target.port}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect({host: '127.0.0.1', port: target.port}, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstreams.add(upstream);
    upstream.on('error', () => socket.destroy());
    upstream.once('close', () => upstreams.delete(upstream));
    socket.once('close', () => upstream.destroy());
  });
  await listen(t, server);
  t.after(() => { for (const socket of upstreams) socket.destroy(); });
  return {seen, url: `${secure ? 'https' : 'http'}://fictional-proxy-user:fictional-proxy-password@127.0.0.1:${server.address().port}`};
}

function redacted(error) {
  assert.doesNotMatch(`${error}\n${JSON.stringify(error)}\n${error.stack}`, /fictional-proxy-password|fictional-bearer|fictional-client-secret|secret-query/);
  assert.equal(error.cause, undefined);
  return true;
}

test('Google transport uses HTTP and HTTPS CONNECT with each inherited proxy spelling and protects provider credentials', async t => {
  assert.equal(googleFetch, namedGoogleFetch);
  for (const secure of [false, true]) for (const variable of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    await t.test(`${secure ? 'HTTPS' : 'HTTP'} ${variable}`, async t => {
      let received;
      const target = await targetFixture(t, (request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
          received = {url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString()};
          response.writeHead(201, {'content-type': 'application/json'});
          response.end('{"id":"fictional-event"}');
        });
      });
      const proxy = await proxyFixture(t, target, {secure});
      const fetch = createGoogleFetch({env: {[variable]: proxy.url}, ca: cert});
      const response = await fetch(`${target.url}/events?sendUpdates=none`, {
        method: 'POST', headers: {authorization: 'Bearer fictional-bearer', 'content-type': 'application/json'},
        body: '{"summary":"Fictional appointment"}'
      });
      assert.equal(response.status, 201); assert.equal(response.ok, true);
      assert.deepEqual(await response.json(), {id: 'fictional-event'});
      assert.equal(response.headers.get('content-type'), 'application/json');
      assert.equal(received.url, '/events?sendUpdates=none'); assert.equal(received.method, 'POST');
      assert.equal(received.body, '{"summary":"Fictional appointment"}');
      assert.equal(received.headers.authorization, 'Bearer fictional-bearer');
      assert.equal(received.headers['proxy-authorization'], undefined);
      assert.equal(proxy.seen.length, 1);
      assert.equal(proxy.seen[0].headers.authorization, undefined);
      assert.equal(proxy.seen[0].headers['proxy-authorization'], 'Basic ' + Buffer.from('fictional-proxy-user:fictional-proxy-password').toString('base64'));
    });
  }
});

test('Google transport supports direct HTTPS and OAuth URLSearchParams without mutating global configuration', async t => {
  const original = {...process.env};
  let received;
  const target = await targetFixture(t, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received = {body: Buffer.concat(chunks).toString(), headers: request.headers};
      response.end('{"access_token":"fictional-token"}');
    });
  });
  const response = await createGoogleFetch({env: {}, ca: cert})(`${target.url}/token`, {
    method: 'POST', body: new URLSearchParams({client_secret: 'fictional-client-secret', grant_type: 'refresh_token'})
  });
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), {access_token: 'fictional-token'});
  assert.equal(received.body, 'client_secret=fictional-client-secret&grant_type=refresh_token');
  assert.match(received.headers['content-type'], /^application\/x-www-form-urlencoded/);
  assert.equal(received.headers['proxy-authorization'], undefined);
  assert.deepEqual({...process.env}, original);
});

test('HTTPS_PROXY takes precedence and empty variables fall through', async t => {
  const target = await targetFixture(t);
  const proxy = await proxyFixture(t, target);
  for (const env of [
    {HTTPS_PROXY: proxy.url, https_proxy: 'invalid', HTTP_PROXY: 'invalid', http_proxy: 'invalid'},
    {HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: proxy.url, http_proxy: 'invalid'}
  ]) assert.equal((await createGoogleFetch({env, ca: cert})(target.url)).ok, true);
  assert.equal(proxy.seen.length, 2);
});

test('untrusted provider and HTTPS proxy certificates are rejected with normal TLS verification', async t => {
  const target = await targetFixture(t);
  const plainProxy = await proxyFixture(t, target);
  const secureProxy = await proxyFixture(t, target, {secure: true});
  for (const env of [{}, {HTTPS_PROXY: plainProxy.url}, {HTTPS_PROXY: secureProxy.url}]) {
    await assert.rejects(createGoogleFetch({env})(target.url), error => {
      assert.match(error.message, /could not complete|proxy connection failed/); return redacted(error);
    });
  }
  assert.equal(secureProxy.seen.length, 0, 'untrusted proxy is rejected before sending CONNECT credentials');
});

test('proxy rejection and invalid configuration errors never include URLs, credentials, OAuth bodies or native causes', async t => {
  const target = await targetFixture(t);
  const proxy = await proxyFixture(t, target, {reject: true});
  const init = {method: 'POST', headers: {authorization: 'Bearer fictional-bearer'}, body: 'fictional-client-secret'};
  await assert.rejects(createGoogleFetch({env: {HTTPS_PROXY: proxy.url}, ca: cert})(`${target.url}/?secret-query`, init), error => {
    assert.match(error.message, /proxy rejected/); return redacted(error);
  });
  for (const url of ['http://127.0.0.1/?secret-query', 'https://fictional-proxy-user:fictional-proxy-password@127.0.0.1/']) {
    await assert.rejects(createGoogleFetch({env: {}})(url, init), redacted);
  }
  await assert.rejects(createGoogleFetch({env: {HTTPS_PROXY: 'socks://fictional-proxy-user:fictional-proxy-password@127.0.0.1'}})(target.url, init), redacted);
  await assert.rejects(createGoogleFetch({env: {HTTPS_PROXY: 'http://fictional-proxy-user:%bad@127.0.0.1'}})(target.url, init), redacted);
  await assert.rejects(createGoogleFetch({env: {}})(target.url, {headers: {authorization: 'fictional-bearer\n'}}), redacted);
});

test('caller abort interrupts CONNECT and ignores sensitive abort reasons', async t => {
  const target = await targetFixture(t);
  let connected;
  const reachedProxy = new Promise(resolve => { connected = resolve; });
  const proxy = await proxyFixture(t, target, {stall: true, onConnect: connected});
  const controller = new AbortController();
  const fetch = createGoogleFetch({env: {HTTPS_PROXY: proxy.url}, ca: cert});
  const request = fetch(target.url, {signal: controller.signal});
  const rejection = assert.rejects(request, error => { assert.equal(error.name, 'AbortError'); return redacted(error); });
  await reachedProxy;
  controller.abort(Error('fictional-client-secret'));
  await rejection;
  await assert.rejects(fetch(target.url, {signal: controller.signal}), error => error.name === 'AbortError' && redacted(error));
  assert.equal(proxy.seen.length, 1);
});

test('caller abort remains active after headers while an HTTPS response body is incomplete', async t => {
  let started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const target = await targetFixture(t, (_request, response) => {
    response.writeHead(200, {'content-type': 'application/json'});
    response.write('{"incomplete":');
    started();
  });
  const controller = new AbortController();
  let settled = false;
  const request = createGoogleFetch({env: {}, ca: cert})(target.url, {signal: controller.signal});
  const rejection = assert.rejects(request, error => { settled = true; assert.equal(error.name, 'AbortError'); return redacted(error); });
  await bodyStarted; await nextTurn();
  assert.equal(settled, false);
  controller.abort('fictional-bearer');
  await rejection;
});

test('whole request deadline interrupts stalled CONNECT and a continuously arriving response body', async t => {
  await t.test('CONNECT deadline', async t => {
    const target = await targetFixture(t);
    const proxy = await proxyFixture(t, target, {stall: true});
    await assert.rejects(createGoogleFetch({env: {HTTPS_PROXY: proxy.url}, ca: cert, timeoutMs: 70})(target.url), error => error.name === 'TimeoutError');
  });
  await t.test('body deadline', async t => {
    let timer;
    t.after(() => clearInterval(timer));
    const target = await targetFixture(t, (_request, response) => {
      response.writeHead(200, {'content-type': 'application/json'});
      response.write('[');
      timer = setInterval(() => response.write('0,'), 10);
    });
    await assert.rejects(createGoogleFetch({env: {}, ca: cert, timeoutMs: 90})(target.url), error => error.name === 'TimeoutError');
  });
});

test('response limit applies to declared and streamed bodies, and JSON errors are redacted', async t => {
  for (const declared of [true, false]) await t.test(declared ? 'content length' : 'chunked', async t => {
    const target = await targetFixture(t, (_request, response) => {
      response.writeHead(200, declared ? {'content-length': '1000'} : {});
      response.end('x'.repeat(1000));
    });
    await assert.rejects(createGoogleFetch({env: {}, ca: cert, maxResponseBytes: 100})(target.url), /size limit/);
  });
  const target = await targetFixture(t, (_request, response) => response.end('fictional-client-secret'));
  const response = await createGoogleFetch({env: {}, ca: cert})(target.url);
  await assert.rejects(response.json(), redacted);
});

test('non-success status and redirects are returned without another authenticated request', async t => {
  let requests = 0;
  const target = await targetFixture(t, (request, response) => {
    requests++;
    if (request.url === '/redirect') response.writeHead(302, {location: '/other'});
    else response.writeHead(429);
    response.end('{"error":"fictional-rate-limit"}');
  });
  const fetch = createGoogleFetch({env: {}, ca: cert});
  const redirected = await fetch(target.url + '/redirect', {headers: {authorization: 'Bearer fictional-bearer'}});
  assert.equal(redirected.status, 302); assert.equal(redirected.ok, false); assert.equal(requests, 1);
  const rejected = await fetch(target.url + '/limited');
  assert.equal(rejected.status, 429); assert.equal(rejected.ok, false);
  assert.deepEqual(await rejected.json(), {error: 'fictional-rate-limit'});
});
