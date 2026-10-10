// lib/client/bridge-client.js — HTTP 客户端封装（CLI / Agent SDK 共用）

const http = require('http');

class BridgeClient {
  /**
   * @param {object} options
   * @param {string} [options.host='127.0.0.1']
   * @param {number} [options.port=19422]
   * @param {string} [options.token=''] - 访问令牌
   */
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 19422;
    this.token = options.token || '';
  }

  /**
   * 执行 eval 表达式
   *
   * 多账号寻址就落在这里：account/opType 必须原样送到服务端，
   * 否则服务端只会当作"未指定账号的读操作"并自行轮换 —— `--account` 形同虚设，
   * 写操作的账号护栏（expectAccount 下发 / markWrite 记账）也全部失效。
   *
   * @param {object} params
   * @param {string} params.site - 站点标识
   * @param {string} params.expression - JS 表达式
   * @param {boolean} [params.awaitPromise=true]
   * @param {number} [params.connIndex=0] 已废弃（多账号下位置寻址会落到别的号，保留仅为兼容）
   * @param {number} [params.timeout]
   * @param {string|null} [params.account] 目标账号 uid；null = 未指定，读操作由服务端轮换
   * @param {'read'|'write'} [params.opType='read'] write 会让服务端校验账号显式性并下发写护栏
   * @param {boolean} [params.noThrottle=false]
   * @returns {Promise<{ok: boolean, value?: any, error?: string, connection?: string, account?: string}>}
   */
  async call({
    site,
    expression,
    awaitPromise = true,
    connIndex = 0,
    timeout,
    account = null,
    opType = 'read',
    noThrottle = false,
  }) {
    const body = {
      site,
      expression,
      awaitPromise,
      connIndex,
      account,
      opType,
      noThrottle,
    };
    if (timeout !== undefined) body.timeout = timeout;
    return this._post('/api/call', body);
  }

  /**
   * 获取连接状态
   * @returns {Promise<object>}
   */
  async status() {
    return this._get('/api/status');
  }

  /**
   * 健康检查
   * @returns {Promise<object>}
   */
  async health() {
    return this._get('/api/health');
  }

  // ── 内部方法 ──

  _post(path, body) {
    return this._request('POST', path, body);
  }

  _get(path) {
    return this._request('GET', path);
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 35000,
      };

      if (this.token) {
        options.headers['Authorization'] = `Bearer ${this.token}`;
      }

      if (payload) {
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Bridge Server 未启动 (${this.host}:${this.port}) — 请先运行 node server.js`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}

module.exports = { BridgeClient };
