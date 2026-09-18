// tests/userscript-build.test.js — 油猴脚本构建与密钥卫生
//
// 回归背景：改造前 scripts/douyin.user.js 里硬编码着本机 bridge token，
// 而该文件受 git 跟踪、远端为公开仓库 —— 等于把"能驱动你浏览器发评论"的
// 凭证提交进了版本库。现改为源模板留占位符、构建时注入、产物写 dist/（已忽略）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const paths = require('../core/paths');

const ROOT = paths.appRoot();
const SOURCE = path.join(ROOT, 'scripts', 'douyin.user.js');
const BUILD = path.join(ROOT, 'scripts', 'build-userscript.js');

/**
 * 取出源码里 CONFIG.token 的字面量值。
 * 刻意用结构化断言而不是"像不像十六进制串"的启发式 —— 脚本里本就有抖音 IM 协议的
 * appKey / build_number 等长十六进制常量（如 e1bd35ec9db7b8d846de66ed140b1ad9），
 * 用宽泛正则会把它们误判成密钥。
 */
function readTokenLiteral(src) {
  const m = src.match(/\btoken:\s*(['"`])(.*?)\1/);
  return m ? m[2] : null;
}

function runBuild(args, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [BUILD, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout: out };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

describe('密钥卫生：源模板不含真实凭证', () => {
  it('源模板使用占位符而非硬编码 token', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    expect(src).toContain('{{BRIDGE_TOKEN}}');
    expect(src).toContain('{{SITE_KEY}}');
  });

  it('CONFIG.token 的值是占位符，不是任何字面量凭证', () => {
    const literal = readTokenLiteral(fs.readFileSync(SOURCE, 'utf8'));
    expect(literal).toBe('{{BRIDGE_TOKEN}}');
  });

  it('CONFIG.site 同样是占位符（多账号预留由构建注入）', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const m = src.match(/\bsite:\s*(['"`])(.*?)\1/);
    expect(m && m[2]).toBe('{{SITE_KEY}}');
  });

  it('构建产物不被 git 跟踪（.gitignore 覆盖 dist/）', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^dist\/$/m);
  });
});

describe('构建脚本', () => {
  it('--stdout 用给定 token 渲染，且无占位符残留', () => {
    const r = runBuild(['--stdout', '--token', 'deadbeef'.repeat(6), '--site', 'douyin.com']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`token: '${'deadbeef'.repeat(6)}'`);
    expect(r.stdout).toContain("site: 'douyin.com'");
    expect(r.stdout).not.toContain('{{BRIDGE_TOKEN}}');
    expect(r.stdout).not.toContain('{{SITE_KEY}}');
  });

  it('--site 可自定义（多账号预留：同一份源渲染出不同 siteKey 的脚本）', () => {
    const r = runBuild(['--stdout', '--token', 'abc123', '--site', 'douyin#2']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("site: 'douyin#2'");
  });

  it('--out 写文件并创建父目录', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-build-'));
    const dest = path.join(tmp, 'nested', 'douyin.user.js');
    try {
      const r = runBuild(['--out', dest, '--token', 'cafebabe']);
      expect(r.code).toBe(0);
      expect(fs.existsSync(dest)).toBe(true);
      const out = fs.readFileSync(dest, 'utf8');
      expect(out).toContain("token: 'cafebabe'");
      expect(out).not.toContain('{{BRIDGE_TOKEN}}');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('缺 token 时以退出码 1 失败并给出可操作的提示（不产出不可用的脚本）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-build-'));
    const dest = path.join(tmp, 'out.js');
    try {
      // 用空的 config 指向，确保读不到 token
      const emptyCfg = path.join(tmp, 'config.json');
      fs.writeFileSync(emptyCfg, JSON.stringify({ bridge: { token: '' } }));
      const r = runBuild(['--out', dest], { env: { ...process.env, DOUYIN_CONFIG: emptyCfg } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('没有可用的 bridge token');
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('渲染结果仍是完整脚本（含 BRIDGE_CODE 与 __bridge）', () => {
    const r = runBuild(['--stdout', '--token', 'x'.repeat(32)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('window.__bridge');
    expect(r.stdout).toContain('// ==UserScript==');
  });
});

// ═══════════════════════════════════════════════════════════
// 源模板被"渲染产物"覆盖时必须拒绝渲染
//
// 回归背景：实测发生过 —— 工作区里的 scripts/douyin.user.js 变成了
// 带**真实 token** 的渲染产物（占位符没了）。而 renderUserscript 当时只检查
// "替换后还有没有残留占位符"，源里既然没有占位符，替换就什么都不做，
// 于是它照常返回"成功"，把那份产物原样发给每一位装机用户。
//
// 结果有两层：① 所有人的脚本里都是同一个人的凭证；
// ② 安装端点返回的内容与当前实例的 token 对不上，且没有任何报错。
// ═══════════════════════════════════════════════════════════
describe('油猴脚本 / 源模板不再是模板时拒绝渲染', () => {
  const { renderUserscript } = require('../core/userscript');

  /** 造一份"渲染过的产物"当源文件：没有占位符，但嵌着一个真实凭证 */
  function renderedSource(tmp, token) {
    const p = path.join(tmp, 'rendered.user.js');
    fs.writeFileSync(p, fs.readFileSync(SOURCE, 'utf8')
      .split('{{BRIDGE_TOKEN}}').join(token)
      .split('{{SITE_KEY}}').join('douyin.com'), 'utf8');
    return p;
  }

  it('拒绝把渲染产物当模板用，并说清怎么修', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-src-'));
    try {
      const fake = renderedSource(tmp, 'a'.repeat(48));
      expect(() => renderUserscript({ token: 'b'.repeat(48), sourceFile: fake }))
        .toThrow(/缺少占位符/);
      // 报错要能直接照着修，而不是只说"出错了"
      expect(() => renderUserscript({ token: 'b'.repeat(48), sourceFile: fake }))
        .toThrow(/git checkout/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('正常的源模板照常渲染（防呆不能把正常路径也拦住）', () => {
    const out = renderUserscript({ token: 'c'.repeat(48) });
    expect(out).toContain('c'.repeat(48));
    expect(out).not.toContain('{{BRIDGE_TOKEN}}');
    expect(out).not.toContain('{{SITE_KEY}}');
  });

  it('缺 token 仍然先报缺 token（错误信息不能互相盖住）', () => {
    expect(() => renderUserscript({ token: '' })).toThrow(/缺少 token/);
  });
});
