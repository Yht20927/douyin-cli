// tests/bridge-client.test.js — HTTP 客户端必须把多账号寻址字段原样送到服务端
//
// 曾经的 bug：cli.js 每次都把 account/opType 塞进 bridge.call(...)，
// 但 BridgeClient.call 只解构了 site/expression/awaitPromise/connIndex/timeout，
// 于是这几个字段在客户端就被丢了 —— 服务端永远当成"未指定账号的读操作"，
// `--account` 形同虚设，写操作的 expectAccount 护栏与 markWrite 记账也全部失效。
//
// 这里起一个真 HTTP server 收原始 body，钉住字段透传，避免再次退化。

const http = require('http');
const { BridgeClient } = require('../lib/client/bridge-client');

/** 起一个只回一份 JSON 的 server，返回 { port, lastBody, lastHeaders, close } */
function captureServer(reply = { ok: true, value: 42 }) {
  return new Promise((resolve) => {
    const state = { lastBody: null, lastHeaders: null };
    const srv = http.createServer((req, res) => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => {
        state.lastBody = data ? JSON.parse(data) : null;
        state.lastHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      state.port = srv.address().port;
      state.close = () => new Promise(r => srv.close(r));
      resolve(state);
    });
  });
}

describe('BridgeClient.call 多账号字段透传', () => {
  let srv;
  afterEach(async () => { if (srv) { await srv.close(); srv = null; } });

  it('account / opType / noThrottle 原样送达服务端', async () => {
    srv = await captureServer();
    const c = new BridgeClient({ host: '127.0.0.1', port: srv.port });
    await c.call({
      site: 'douyin.com',
      expression: 'publish()',
      account: '1179139456380456',
      opType: 'write',
      noThrottle: true,
    });
    expect(srv.lastBody.account).toBe('1179139456380456');
    expect(srv.lastBody.opType).toBe('write');
    expect(srv.lastBody.noThrottle).toBe(true);
    expect(srv.lastBody.site).toBe('douyin.com');
    expect(srv.lastBody.expression).toBe('publish()');
  });

  it('未指定账号时默认 read / account=null（交由服务端轮换，而不是悄悄落到某个号）', async () => {
    srv = await captureServer();
    const c = new BridgeClient({ host: '127.0.0.1', port: srv.port });
    await c.call({ site: 'douyin.com', expression: '1+1' });
    expect(srv.lastBody.account).toBeNull();
    expect(srv.lastBody.opType).toBe('read');
    expect(srv.lastBody.noThrottle).toBe(false);
  });

  it('token 放进 Authorization 头（多账号调用的鉴权路径不能丢）', async () => {
    srv = await captureServer();
    const c = new BridgeClient({ host: '127.0.0.1', port: srv.port, token: 'secret-token' });
    await c.call({ site: 'douyin.com', expression: '1+1' });
    expect(srv.lastHeaders.authorization).toBe('Bearer secret-token');
  });

  it('timeout 未传时不写入 body（避免给服务端塞 null 覆盖默认超时）', async () => {
    srv = await captureServer();
    const c = new BridgeClient({ host: '127.0.0.1', port: srv.port });
    await c.call({ site: 'douyin.com', expression: '1+1' });
    expect('timeout' in srv.lastBody).toBe(false);
  });

  it('返回值原样透出，服务端回传的 account 可被 CLI 用于审计归属', async () => {
    srv = await captureServer({ ok: true, value: { n: 1 }, account: 'ACC_A', channel: 'douyin.com#ACC_A' });
    const c = new BridgeClient({ host: '127.0.0.1', port: srv.port });
    const resp = await c.call({ site: 'douyin.com', expression: '1+1' });
    expect(resp.ok).toBe(true);
    expect(resp.value).toEqual({ n: 1 });
    expect(resp.account).toBe('ACC_A');
  });
});
