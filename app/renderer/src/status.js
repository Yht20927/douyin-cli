// app/renderer/src/status.js — 把桥接状态翻译成"人话 + 该做什么"
//
// 放在独立模块里，是因为"怎么描述状态"和"怎么画状态"是两件事：
// 前者以后托盘、通知、日志都要用同一套说法，不能各写各的。

/**
 * @param {object|null} status - 来自主进程的桥接状态
 * @returns {{state:string, word:string, note:string, hint?:{title:string, steps:string[]}, actions:string[]}}
 */
export function describeStatus(status) {
  if (!status) {
    return { state: 'unknown', word: '检测中', note: '正在读取桥接服务状态…', actions: [] };
  }

  if (!status.listening) {
    return {
      state: 'down',
      word: '服务未启动',
      note: '桥接服务没有跑起来，命令发不出去。',
      hint: {
        title: '怎么恢复',
        steps: [
          '先看下面的诊断信息，确认失败原因',
          '若是端口被占用，改小设置里的 bridge.port 后重启应用',
        ],
      },
      actions: ['refresh'],
    };
  }

  if (status.online) {
    const n = status.totalConnections || 0;
    // 连接页现在以账号为主角，状态条同样把"操作的是哪个号"说出来 ——
    // 尤其多开时，"可以开始操作"不说明身份，用户没法确认连的是大号还是小号。
    const names = [...new Set(
      (status.connections || [])
        .filter(c => c.alive && c.account && c.account.nickname)
        .map(c => c.account.nickname)
    )];
    const who = names.length === 1
      ? `，正在以「${names[0]}」的身份操作`
      : names.length > 1 ? `，共 ${names.length} 个账号：${names.join('、')}` : '';
    return {
      state: 'online',
      word: '已连接',
      note: n > 1
        ? `${n} 个抖音页面连上了${who || ''}。`
        : `抖音页面连上了${who}，可以开始操作。`,
      actions: ['refresh', 'openDouyin'],
    };
  }

  // 连过又断了 —— 与"从未连上"是两回事，提示语完全不同
  if (status.offlineForMs > 0) {
    const sec = Math.round(status.offlineForMs / 1000);
    const dur = sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分钟`;
    return {
      state: 'offline',
      word: '连接中断',
      note: `已经 ${dur} 没收到页面心跳了。命令暂时发不出去。`,
      hint: {
        title: '通常是这几种情况',
        steps: [
          '抖音页面被关掉了 —— 重新打开 www.douyin.com',
          '页面还在但脚本被停用了 —— 在 Tampermonkey 里确认该脚本已启用',
          '页面被浏览器休眠了（长时间没切回去，或开了内存节省）—— 切到那个标签页点一下即可唤醒',
          '登录态过期 —— 刷新页面并重新登录',
        ],
      },
      actions: ['refresh', 'openDouyin'],
    };
  }

  // 从未连上过：这是初始设置问题，不是故障
  return {
    state: 'waiting',
    word: '等待连接',
    note: '服务在跑，但还没有抖音页面连上来。',
    hint: {
      title: '第一次使用需要确认两件事',
      steps: [
        '浏览器里已安装 Tampermonkey 扩展，且本工具的脚本处于「启用」状态',
        '打开并登录 www.douyin.com，然后保持这个页面开着',
      ],
    },
    actions: ['refresh', 'openDouyin'],
  };
}

/** 状态是否有问题（离线/未启动），用于决定是否要更醒目地提示 */
export function isProblem(state) {
  return state === 'offline' || state === 'down';
}

/**
 * 名册里认得、但界面上别的地方还没有交代过的号。
 *
 * 侧栏那句「另有 N 个号」与连接页那一节**必须用同一个判据算同一个 N**：
 * 两处数字对不上的话，用户会开始怀疑屏幕上所有数字（这个毛病在连接页刚修过一次）。
 *
 * 三个排除条件，每个都对应"别处已经说过了"：
 * - 已作为连接行列出（含已断开的残留行）：那一行就是它的交代
 * - `online`：名册的 online 与 status.connections 来自两次 IPC 读取，会有
 *   "名册说在线、这份 status 里却没它的行"的错位窗口 —— 那种时候不能说它没连上
 * - `current`：它已经以「当前账号」的身份摆在同一块侧栏里，再算进"另有的号"
 *   等于把自己正在操作的那个号说成别的号
 *
 * @param {object|null} account - account:state 的 data（用它的 accounts[]）
 * @param {object|null} status - 桥接状态（用它的 connections[]）
 */
export function unconnectedAccounts(account, status) {
  const listed = new Set(((status && status.connections) || [])
    .filter(c => c.account)
    .map(c => String(c.account.uid)));
  return ((account && account.accounts) || [])
    .filter(a => !a.online && !a.current && !listed.has(String(a.uid)));
}
