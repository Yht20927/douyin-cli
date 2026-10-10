// tests/userscript-uid-parse.test.js — 锁定油猴端「当前登录 uid」的解析
//
// 为什么值得单独测：这段逻辑曾经只看 info.user.uid，而真实回包把 uid 放在
// **顶层 user_uid**，于是 API 路径一直空跑、实际靠 cookie/localStorage 兜底拿值。
// 多账号下那种兜底值（UIFID 之类）在同设备多个账号间是同一个，会把两个号算成
// 一个 —— 后果是用错号发评论。所以字段路径必须有测试钉住。
//
// 油猴脚本没法 require（window.__bridge 那段整体在 /* */ 大注释里，靠函数源码
// 自举注入），所以这里从源码里把 _parseMyUid 抽出来跑，保证测的就是部署的那份。

const fs = require('fs');
const path = require('path');

function loadParseMyUid() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'douyin.user.js'), 'utf8');
  const m = src.match(/function _parseMyUid\(info\)\{[\s\S]*?\n\}/);
  if (!m) throw new Error('scripts/douyin.user.js 里找不到 _parseMyUid —— 解析逻辑被改名/删除了？');
  // eslint-disable-next-line no-eval
  return eval('(' + m[0] + ')'); // 只求值从本仓库源码里抽出的函数定义
}

describe('油猴端当前登录 uid 解析', () => {
  let parse;
  beforeAll(() => { parse = loadParseMyUid(); });

  it('真实回包：uid 在顶层 user_uid（不是 user.uid）', () => {
    const real = {
      id: '7644566873048106542',
      create_time: '1779889431',
      last_time: '1791472159',
      user_uid: '1179139456380456',
      user_uid_type: 0,
      firebase_instance_id: '',
      user_agent: 'Mozilla/5.0',
      browser_name: 'Firefox',
      status_code: 0,
    };
    expect(parse(real)).toBe('1179139456380456');
  });

  it('未登录：user_uid 为空串或字段缺失 → 空（不连接）', () => {
    expect(parse({ status_code: 0, user_uid: '' })).toBe('');
    expect(parse({ status_code: 0, id: '7644' })).toBe('');
    expect(parse({})).toBe('');
    expect(parse(null)).toBe('');
  });

  it('status_code 非 0 视为不可用', () => {
    expect(parse({ status_code: 8, user_uid: '1179139456380456' })).toBe('');
  });

  it('非数字 id 不放行（挡 UIFID 之类的脏值当成账号）', () => {
    expect(parse({ user_uid: 'UIFID_abc123' })).toBe('');
    expect(parse({ user:{ uid: 'not-a-uid' } })).toBe('');
  });

  it('兼容旧字段 user.uid / user.short_id', () => {
    expect(parse({ user: { uid: '123456789' } })).toBe('123456789');
    expect(parse({ user: { short_id: '987654321' } })).toBe('987654321');
  });

  it('顶层 user_uid 优先于 user.uid', () => {
    expect(parse({ user_uid: '111111111', user: { uid: '222222222' } })).toBe('111111111');
  });
});

// ── 昵称探测：必须与严格探测出的 uid 对齐 ──
// 曾经的实现去 /aweme/v1/web/query/user/ 要昵称，但那个接口换哪组参数都只回
// {id, user_uid, user_uid_type, status_code} —— 没有昵称也没有 user 对象。
// 现在只读零请求的本地来源，代价是 localStorage 里可能是别的账号（或登出后残留）
// 写下的值，所以必须校验 uid 一致，否则会把 A 号的名字挂到 B 号上。
function loadNicknameProbe() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'douyin.user.js'), 'utf8');
  const m = src.match(/_getMyNickname: function\(expectedUid\)\{[\s\S]*?\n  \}/);
  if (!m) throw new Error('scripts/douyin.user.js 里找不到 _getMyNickname');
  const body = m[0].replace(/^_getMyNickname:\s*/, '');
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', 'window', 'console', 'return (' + body + ');');
}

describe('油猴端昵称探测（douyin）', () => {
  const cases = [
    ['uid 一致 + 有昵称 → 采用', { uid: '111', nickname: '小九' }, '111', '小九'],
    ['uid 不一致 → 宁可不取（防串号）', { uid: '222', nickname: '别人' }, '111', ''],
    ['有 uid 无昵称 → 空', { uid: '111' }, '111', ''],
    ['只有 short_id 也能对上', { short_id: '111', nickname: '小九' }, '111', '小九'],
    ['user_info 为 null → 空', null, '111', ''],
    ['非对象（数组）→ 空', [], '111', ''],
  ];

  for (const [name, stored, expectedUid, want] of cases) {
    it(name, () => {
      const build = loadNicknameProbe();
      const fn = build(
        { getItem: () => (stored === null ? null : JSON.stringify(stored)) },
        {},
        { log() {}, warn() {} },
      );
      expect(fn.call({ _nicknameCache: null }, expectedUid)).toBe(want);
    });
  }

  it('结果缓存：第二次不再读 localStorage', () => {
    const build = loadNicknameProbe();
    let reads = 0;
    const fn = build(
      { getItem: () => { reads++; return JSON.stringify({ uid: '111', nickname: '小九' }); } },
      {},
      { log() {}, warn() {} },
    );
    const self = { _nicknameCache: null };
    expect(fn.call(self, '111')).toBe('小九');
    expect(fn.call(self, '111')).toBe('小九');
    expect(reads).toBe(1);
  });
});

// ── sec_uid 探测：myPosts 的来源，同样必须与严格探测出的 uid 对齐 ──
// 旧实现读 /aweme/v1/web/query/user/ 的 info.user.sec_uid，但那个接口只回顶层
// {id, user_uid, ...}，永远取不到 → 拿空 sec_user_id 查「我的作品」返回空/别人的。
// 新实现读本地来源（与昵称同源），且 uid 不符就宁可拿不到（由 myPosts 报错）。
function loadSecUidProbe() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'douyin.user.js'), 'utf8');
  const m = src.match(/_getMySecUid: function\(expectedUid\)\{[\s\S]*?\n  \}/);
  if (!m) throw new Error('scripts/douyin.user.js 里找不到 _getMySecUid');
  const body = m[0].replace(/^_getMySecUid:\s*/, '');
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', 'window', 'console', 'return (' + body + ');');
}

describe('油猴端 sec_uid 探测（douyin）', () => {
  /** @param {object|null} stored user_info 的内容 @param {object} win 额外的 window 字段 */
  function probe(stored, expectedUid, win = {}) {
    const build = loadSecUidProbe();
    const fn = build(
      { getItem: () => (stored === null ? null : JSON.stringify(stored)) },
      win,
      { log() {}, warn() {} },
    );
    return fn.call({ _secUidCache: null }, expectedUid);
  }

  it('user_info 有 sec_uid 且 uid 一致 → 采用', () => {
    expect(probe({ uid: '111', sec_uid: 'MS4wLjABAAAA' }, '111')).toBe('MS4wLjABAAAA');
  });

  it('uid 不一致 → 空（防把 A 号的 sec_uid 用到 B 号）', () => {
    expect(probe({ uid: '222', sec_uid: 'MS4wLjABAAAA' }, '111')).toBe('');
  });

  it('expectedUid 为空（单账号未指定）→ 无从校验，采用', () => {
    expect(probe({ uid: '999', sec_uid: 'SEC_q' }, '')).toBe('SEC_q');
  });

  it('兼容 sec_user_id / secUid 命名', () => {
    expect(probe({ user_id: '111', sec_user_id: 'SEC_a' }, '111')).toBe('SEC_a');
    expect(probe({ short_id: '111', secUid: 'SEC_b' }, '111')).toBe('SEC_b');
  });

  it('user_info 无 sec_uid → 叠加空（不回退到别的字段）', () => {
    expect(probe({ uid: '111', nickname: '小九' }, '111')).toBe('');
  });

  it('user_info 空时回落到 __INITIAL_STATE__（uid 对齐）', () => {
    expect(probe(null, '111', { __INITIAL_STATE__: { userInfo: { uid: '111', sec_uid: 'SEC_st' } } })).toBe('SEC_st');
  });

  it('__INITIAL_STATE__ 的 uid 不一致 → 空', () => {
    expect(probe(null, '111', { __INITIAL_STATE__: { userInfo: { uid: '222', sec_uid: 'SEC_st' } } })).toBe('');
  });

  it('来源无 uid 字段（无法证伪）→ 采用（diag 标未校验）', () => {
    expect(probe({ sec_uid: 'SEC_noverify' }, '111')).toBe('SEC_noverify');
  });

  it('结果缓存：第二次不再读 localStorage', () => {
    const build = loadSecUidProbe();
    let reads = 0;
    const fn = build(
      { getItem: () => { reads++; return JSON.stringify({ uid: '111', sec_uid: 'SEC' }); } },
      {},
      { log() {}, warn() {} },
    );
    const self = { _secUidCache: null };
    expect(fn.call(self, '111')).toBe('SEC');
    expect(fn.call(self, '111')).toBe('SEC');
    expect(reads).toBe(1);
  });
});
