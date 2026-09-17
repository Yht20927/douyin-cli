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
   * @param {object} params
   * @param {string} params.site - 站点标识
   * @param {string} params.expression - JS 表达式
   * @param {boolean} [params.awaitPromise=true]
   * @param {number} [params.connIndex=0]
   * @param {number} [params.timeout]
   * @returns {Promise<{ok: boolean, value?: any, error?: string, connection?: string}>}
   */
  async call({ site, expression, awaitPromise = true, connIndex = 0, timeout }) {
    return this._post('/api/call', {
      site,
      expression,
      awaitPromise,
      connIndex,
      timeout,
    });
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
