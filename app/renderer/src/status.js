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
    return {
      state: 'online',
      word: '已连接',
      note: n > 1
        ? `${n} 个抖音页面连上了，可以开始操作。`
        : '抖音页面连上了，可以开始操作。',
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
