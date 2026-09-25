// tests/unconnected-accounts.test.js — 「另有 N 个号未连接」的 N 只允许有一个算法
//
// 为什么要有这个测试
// ----------------
// 侧栏那句 N 与连接页那一节的行数**必须是同一个数**：这个应用刚在连接页修过
// 一次"标题数量与屏幕行数不是一回事"，而这次的判据天然被两个组件共用。
// 静态测试能钉住"两处都调用了同一个函数"，钉不住"函数本身算错了" ——
// 后者只有喂真形状的行为测试能发现（见 memory：测试夹具必须喂真形状）。
//
// 夹具形状来自两处真代码，不是编的：
//   status.connections[]  ← app/main/bridge-manager.js 的 extractConnections
//   account.accounts[]    ← app/main/ipc.js 的 account:state
// 注意 uid 的类型：名册里存的是原样（抖音返回的是**数字串**，但旧数据/手工
// 登记过的是数字），连接行里的 account.uid 同样是两种都可能出现。
// `core/memory/accounts.js` 的 aliveUids 为此刻意两边 String() —— 这里也一样，
// 否则数字 123 与字符串 '123' 会被当成两个号，N 多算一个。
//
// 这里不 require('vitest') —— describe/it/expect 由 vitest.config.js 的
// globals: true 提供（同 errors-humanize.test.js）。

/** 桥接状态里的一条连接，字段与 extractConnections 输出一一对应 */
const conn = (uid, { alive = true, withAccount = true } = {}) => ({
  site: 'douyin',
  id: 'c-1',
  url: 'https://www.douyin.com/',
  title: '抖音',
  account: withAccount && uid != null
    ? { uid, nickname: `号${uid}`, avatar: '' }
    : null,
  clientVersion: 2,
  alive,
  lastActivity: Date.now(),
});

const bridgeStatus = (connections, extra = {}) => ({
  listening: true,
  url: 'http://127.0.0.1:19422',
  userscriptUrl: 'http://127.0.0.1:19422/app.user.js',
  online: connections.some(c => c.alive),
  offlineForMs: 0,
  connections,
  totalConnections: connections.filter(c => c.alive).length,
  error: null,
  ...extra,
});

/** account:state 的 data.accounts[]：online/current 由主进程算好后传下来 */
const roster = (rows) => rows.map(r => ({
  uid: r.uid,
  nickname: r.nickname || `号${r.uid}`,
  avatar: '',
  online: !!r.online,
  current: !!r.current,
}));

const load = () => import('../app/renderer/src/status.js');

describe('unconnectedAccounts: 名册里认得、界面上还没交代过的号', () => {
  it('在线的与当前操作的都不算 —— 它们别处已经说了', async () => {
    const { unconnectedAccounts } = await load();
    const account = {
      uid: '222',
      needsChoice: false,
      candidates: ['222'],
      accounts: roster([
        { uid: '111', online: false },
        { uid: '222', online: true, current: true },
        { uid: '333', online: true },
      ]),
    };
    const status = bridgeStatus([conn('222'), conn('333')]);
    expect(unconnectedAccounts(account, status).map(a => a.uid)).toEqual(['111']);
  });

  it('已经作为连接行列出的号不重复计 —— 含已断开的残留连接行', async () => {
    const { unconnectedAccounts } = await load();
    const account = {
      uid: '222',
      needsChoice: false,
      candidates: ['222'],
      accounts: roster([
        { uid: '111', online: false },
        { uid: '222', online: true, current: true },
      ]),
    };
    // 111 掉线后桥接侧还留着它那一行（alive:false）。连接页会把这行画进
    // 「之前的连接（已断开）」，所以它同样**已经被交代过**，不能再进 N。
    const status = bridgeStatus([conn('222'), conn('111', { alive: false })]);
    expect(unconnectedAccounts(account, status)).toEqual([]);
  });

  it('数字 uid 与数字串 uid 是同一个号（两侧都要归一）', async () => {
    const { unconnectedAccounts } = await load();
    // 两个号都不在线、都不是当前账号 —— 排除它们**只能靠"已经在连接行里出现过"**，
    // 不能混进 online/current 那两个条件蒙对。
    const account = {
      uid: null,
      needsChoice: false,
      candidates: [],
      accounts: roster([{ uid: 111 }, { uid: '222' }]),
    };
    // 两边的类型**故意相反**：名册给数字 111 / 串 '222'，连接行给串 '111' / 数字 222。
    // 只写一个方向的话，另一侧的 String() 删了也测不出来（变异检查抓到的就是这个）。
    // 两行都是 alive:false，所以 online 那个条件帮不上忙。
    const status = bridgeStatus([conn('111', { alive: false }), conn(222, { alive: false })]);
    expect(unconnectedAccounts(account, status)).toEqual([]);
  });

  it('两个过滤条件各自都单独起作用：online 但没有行 / current 但已掉线', async () => {
    const { unconnectedAccounts } = await load();
    const acct = (rows, uid = null) => ({
      uid, needsChoice: false, candidates: [], accounts: roster(rows),
    });
    // A. 名册说这个号在线，而这一份 status 里根本没有它的行 —— 名册的 online 与
    // connections 来自**两次** IPC 读取，存在这种错位窗口。
    // 把 !a.online 那个条件删掉，这一条就会变红。
    const onlineOnly = acct([{ uid: '555', online: true }], '555');
    expect(unconnectedAccounts(onlineOnly, bridgeStatus([]))).toEqual([]);
    // B. 手工选定过（account:set）之后，那个号可能已经把页面关掉：
    // current:true + online:false。它已经以「当前账号」的身份摆在同一块侧栏里，
    // 再计入"另有的号"等于把自己正在操作的号说成别的号。
    // 把 !a.current 那个条件删掉，这一条就会变红。
    const currentOffline = acct([{ uid: '555', current: true }], '555');
    expect(unconnectedAccounts(currentOffline, bridgeStatus([]))).toEqual([]);
  });

  it('连接行没有账号信息（旧脚本）时，名册里的号照常计入 N', async () => {
    const { unconnectedAccounts } = await load();
    const account = {
      uid: null,
      needsChoice: false,
      candidates: [],
      accounts: roster([{ uid: '111' }, { uid: '222' }]),
    };
    // 旧版脚本不上报 account：这里不能把两个号都吞掉，否则"另有 N 个号"
    // 会静默变成一句都不说，正是这个缺陷最初的表象
    const status = bridgeStatus([conn(null, { withAccount: false })]);
    expect(unconnectedAccounts(account, status).map(a => a.uid)).toEqual(['111', '222']);
  });

  it('任一侧还没取到数据时不抛，且两种缺失的语义不一样', async () => {
    const { unconnectedAccounts } = await load();
    const account = { uid: null, needsChoice: false, candidates: [], accounts: roster([{ uid: '111' }]) };
    // account 缺失 = 名册都不知道，算不出 N → 空
    expect(unconnectedAccounts(null, bridgeStatus([conn('222')]))).toEqual([]);
    expect(unconnectedAccounts(undefined, undefined)).toEqual([]);
    expect(unconnectedAccounts({ ...account, accounts: undefined }, bridgeStatus([]))).toEqual([]);
    // status 缺失 = 界面上没有任何连接行"交代过"这些号 → 名册里那些不在架的就还是 N。
    // 若图省事写成"status 没有就返回 []"，这句提示会在桥接状态读取失败时**恰好消失**，
    // 而那正是用户最需要知道"库里还有号没连上"的场合。
    expect(unconnectedAccounts(account, null).map(a => a.uid)).toEqual(['111']);
  });
});
