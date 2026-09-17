#!/usr/bin/env node
// scripts/build-userscript.js — 生成可安装的油猴脚本
//
// 为什么需要构建这一步
// --------------------
// scripts/douyin.user.js 是**源模板**，里面有两处占位符：
//   {{BRIDGE_TOKEN}} —— Bridge Server 的访问令牌
//   {{SITE_KEY}}     —— 站点/账号标识（多账号预留，见计划 D4）
//
// 改造前 token 是硬编码在源文件里的，而这个文件受 git 跟踪、远端是公开仓库 ——
// 等于把"能驱动你浏览器发评论"的凭证提交进了版本库。现在改为构建时注入，
// 产物写到 dist/（已 gitignore），源码里只留占位符。
//
// 桌面应用会复用同一条路径：以本机自动生成的 token 渲染脚本，
// 再经本地 HTTP 提供一键安装。
//
// 用法
// ----
//   node scripts/build-userscript.js                       # token 取自 config.json
//   node scripts/build-userscript.js --token <t> --site douyin.com
//   node scripts/build-userscript.js --out /tmp/dy.user.js
//   node scripts/build-userscript.js --stdout              # 输出到 stdout（供桌面应用调用）
//
// 退出码：0 成功；1 参数/输入错误；2 占位符未全部替换（防呆）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'scripts', 'douyin.user.js');
const DEFAULT_OUT = path.join(ROOT, 'dist', 'douyin.user.js');

const PLACEHOLDERS = ['{{BRIDGE_TOKEN}}', '{{SITE_KEY}}'];

// ── 参数解析 ──

function parseArgs(argv) {
  const opts = { token: null, site: null, out: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token') opts.token = argv[++i];
    else if (a === '--site') opts.site = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--stdout') opts.stdout = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function usage() {
  console.error(`用法: node scripts/build-userscript.js [选项]

  --token <t>     Bridge 访问令牌（缺省读 config.json 的 bridge.token）
  --site <key>    站点/账号标识（缺省 douyin.com）
  --out <path>    输出路径（缺省 dist/douyin.user.js）
  --stdout        输出到标准输出，不落盘
  -h, --help      显示本帮助

注意：源文件里的占位符如果没能全部替换，脚本会以退出码 2 失败 ——
      宁可装不上，也不要把带 {{...}} 的脚本发出去。`);
}

// ── 读配置（默认 token 来源）──

function readConfig() {
  // 注意用 paths 模块而不是直接拼路径：桌面应用会把数据目录重定向到安装目录下
  try {
    const paths = require('../core/paths');
    const file = paths.configFile();
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {};
  }
}

// ── 主流程 ──

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return 0; }

  if (!fs.existsSync(SOURCE)) {
    console.error(`找不到源模板: ${SOURCE}`);
    return 1;
  }

  const config = readConfig();
  const token = opts.token || (config.bridge && config.bridge.token) || '';
  const site = opts.site || 'douyin.com';

  if (!token) {
    console.error('错误: 没有可用的 bridge token。');
    console.error('  请在 config.json 里配置 bridge.token，或用 --token 指定。');
    console.error('  （缺 token 的脚本无法通过 Bridge Server 认证）');
    return 1;
  }

  let out = fs.readFileSync(SOURCE, 'utf8');
  out = out.split('{{BRIDGE_TOKEN}}').join(token);
  out = out.split('{{SITE_KEY}}').join(site);

  // 防呆：占位符没替换干净就发出去，脚本会带着 {{...}} 运行，故障很难排查
  const leftover = PLACEHOLDERS.filter(p => out.includes(p));
  if (leftover.length) {
    console.error(`错误: 仍有未替换的占位符: ${leftover.join(', ')}`);
    return 2;
  }

  if (opts.stdout) {
    process.stdout.write(out);
    return 0;
  }

  const dest = opts.out ? path.resolve(opts.out) : DEFAULT_OUT;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out, 'utf8');

  console.error(`已生成: ${dest}`);
  console.error(`  站点标识: ${site}`);
  console.error(`  令牌: ${token.slice(0, 6)}…（${token.length} 字符）`);
  console.error('  安装: 在 Tampermonkey 中新建脚本并粘贴上述文件内容，');
  console.error('        或由桌面应用经本地 HTTP 提供一键安装。');
  return 0;
}

process.exit(main());
