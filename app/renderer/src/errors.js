// app/renderer/src/errors.js — 把工程错误串翻成「人话 + 下一步」
//
// 为什么要有这一层：屏幕上的失败原因此前是 core / 油猴 / Node 三方原始字符串的直通，
// 运营者能做的只有截图发给开发者。真实库里出现过的原话（不是假设，是 events.error 的实测值）：
//
//   status_code=3002229 — 评论可能被拦截，请更换内容重试
//   Bridge Server 未启动 (127.0.0.1:19422) — 请先运行 node server.js
//   Request timeout after 30000ms — no polling client connected
//   GM_xmlhttpRequest failed
//   Unauthorized — 无效的 access token
//   this._isAnthropicProvider is not a function
//   '' string literal contains an unescaped line break
//
// 三条纪律：
// 1. **不编含义**。抖音的返回码含义我们没有查实（见 开发进度.md §3.1 对 2055 的结论），
//    所以只说"抖音没接受这条评论"，把码原样留在折叠的原文里。
// 2. **下一步必须是能做的动作**，不是"请重试"。分不清「该等 / 该改 / 该放弃」的错误等于没有错误。
// 3. 查不到映射时**回退原文**并说明它是程序错误 —— 宁可露出原话，也不要编一句安慰人的假话。
//
// 与 status.js 同一分工：那边管"连接状态怎么描述"，这边管"失败怎么描述"，
// 两边都不碰画法 —— 同一个说法以后托盘、日志、导出报告要复用。

/**
 * @typedef {{ text: string, next: string[], detail: string|null, tone: 'bad'|'wait' }} ErrorNote
 */

/** 抖音/服务端返回码：含义未查实，所以说"没接受"而不是"被拦截" */
function statusCode(code) {
  return {
    text: `抖音没接受这条评论（返回码 ${code}）`,
    next: [
      '换一种说法再发 —— 原样重试多半还是同一个码',
      '连着几条都是同一个码就先停手，去「队列」页看是不是已经被风控停写',
    ],
    detail: null,
    tone: 'bad',
  };
}

/**
 * 规则表。自上而下第一条命中即采用，所以**从具体到笼统**排序。
 * `test` 收到的是已经压成一行、转过小写的原文。
 */
const RULES = [
  {
    name: 'status-code',
    test: s => /status_code\s*=\s*(\d+)/.exec(s),
    make: m => statusCode(m[1]),
  },
  {
    // 油猴脚本发不出请求：页面被休眠 / 断网 / 扩展被停用
    name: 'gm-request-failed',
    test: s => /gm_xmlhttprequest failed/.test(s),
    make: () => ({
      text: '浏览器里的脚本发不出这个请求',
      next: [
        '切回抖音那个标签页点一下（浏览器会把长时间没看的页面休眠掉），再重试',
        '还是不行就去「连接」页确认脚本处于启用状态',
      ],
      detail: null,
      tone: 'bad',
    }),
  },
  {
    // 没人接单 = 抖音页面没连着。与"服务没起来"是两件事，处置也不同。
    name: 'no-client',
    test: s => /no polling client connected|等待.*客户端|没有.*页面连上/.test(s),
    make: m => ({
      text: '等了一段时间，没有任何抖音页面接这个活',
      next: [
        '打开并登录 www.douyin.com，保持这个页面开着',
        '在 Tampermonkey 里确认本工具的脚本是「启用」状态',
      ],
      detail: null,
      tone: 'bad',
    }),
  },
  {
    name: 'bridge-offline',
    test: s => /bridge server 未启动|econnrefused|连接被拒绝/.test(s),
    make: () => ({
      text: '本工具的桥接服务没在跑，命令发不出去',
      next: [
        '重启这个应用（服务是随应用启动的）',
        '重启后还不行，看「诊断」页里端口有没有被别的程序占用',
      ],
      detail: null,
      tone: 'bad',
    }),
  },
  {
    name: 'bridge-unauthorized',
    test: s => /unauthorized|无效的 access token|认证失败/.test(s),
    make: () => ({
      text: '浏览器里的脚本和本工具之间的凭证对不上了',
      next: [
        '去「连接」页重新安装一次脚本（安装地址里带着当前凭证，不用手抄）',
        '装完刷新一次抖音页面',
      ],
      detail: null,
      tone: 'bad',
    }),
  },
  {
    name: 'port-in-use',
    test: s => /eaddrinuse|address already in use/.test(s),
    make: () => ({
      text: '端口被别的程序占着，桥接服务起不来',
      next: [
        '关掉另一个正在跑这个工具的程序或窗口',
        '或者去「设置」把 bridge.port 改成别的数，再重启应用',
      ],
      detail: null,
      tone: 'bad',
    }),
  },
  {
    // 请求到了 AI 服务但被拒 —— 十有八九是 key 与 base_url 不是一家
    name: 'llm-auth',
    test: s => /llm api 请求失败 \(http (40[13])\)/.exec(s),
    make: m => ({
      text: m[1] === '401' ? 'AI 服务不认这个密钥' : 'AI 服务不允许这样调用（密钥没有对应权限）',
      next: [
        '去「设置 → AI 模型」填 api_key',
        '填谁家的 key 就要把 base_url 改成谁家的地址 —— 两者不配套就是这个错',
      ],
      detail: null,
      tone: 'bad',
    }),
  },
  {
    name: 'llm-limit',
    test: s => /llm api 请求失败 \(http (429|5\d\d)\)/.exec(s),
    make: m => ({
      text: m[1] === '429' ? 'AI 服务说：请求太频繁或额度用完了' : 'AI 服务那边自己出了点问题（不是你这个工具的问题）',
      next: [
        '过几分钟再生成看看',
        '持续这样的话，去「设置 → AI 模型」确认 base_url 和 model 填的是同一家',
      ],
      detail: null,
      tone: 'wait',
    }),
  },
  {
    name: 'llm-network',
    test: s => /enotfound|eai_again|econnreset|fetch failed|networkerror/.test(s),
    make: () => ({
      text: '这台机器连不上要访问的地址',
      next: [
        '确认网络通（浏览器打开 www.douyin.com 试试）',
        '如果只在生成回复时出现，检查「设置 → AI 模型」的 base_url 是不是写错了域名',
      ],
      detail: null,
      tone: 'bad',
    }),
  },
  {
    // 只认 failures.classify 产出的**机器键**。
    // 这里刻意不匹配"之前已经发过"这类中文 —— policy 给的理由本身就是带细节的
    // 具体说明（发到哪个视频、多久以前），翻成下面这句通用话反而把信息抹掉了。
    // 同理也**没有**"风控 / 冷却 / 额度"一类的规则：assertWritable 与
    // beforeWrite 产出的句子已经写明"还要等多久、额度剩多少"，
    // 翻译层要是把它们统一成一句"被规则拦下了"，就是负收益。
    // 翻译层的职责边界：机器串翻成人话；已经是人话的原样过。
    name: 'dup-text',
    test: s => /\bdup_text\b|duplicate/i.test(s),
    make: () => ({
      text: '这句话之前已经发过了，不能原样再发',
      next: ['去草稿箱改几个字再发，或者换一条草稿'],
      detail: null,
      tone: 'wait',
    }),
  },
  {
    // 取消不是故障。不认出来的话，"我撤掉的"会被说成"没发出去的"。
    name: 'cancelled',
    test: s => /^已取消|^任务已取消/.test(s),
    make: () => ({ text: '已取消', next: [], detail: null, tone: 'wait' }),
  },
  {
    // 程序自己的错误。这类串不该端给用户，但既然露出来了，就必须说清"这不是你的操作问题"，
    // 否则用户会去改自己的网络、账号、内容 —— 全是白费的方向。
    name: 'internal-bug',
    test: s => /(is not a function|is not defined|cannot read propert|unexpected token|unexpected end|syntaxerror|string literal|referenceerror|typeerror)/.test(s),
    make: () => ({
      text: '这是工具自己的程序错误，不是你的操作或内容问题',
      next: [
        '不用改网络、账号或回复内容 —— 那些方向都是白费的',
        '需要的话把这条原始信息发给开发者（点下面的「原始信息」展开）',
      ],
      detail: null,
      tone: 'bad',
    }),
  },
];

/**
 * Electron 的 IPC 拒绝串外层。
 *
 * `ipcRenderer.invoke` 失败时，主进程那个异常会被包成
 * `Error invoking remote method 'bridge:status': Error: <原话>` 再抛给界面。
 * 外层这一圈纯属工程噪音，而它**挡掉下面每一条规则**：本轮第一次把 reject
 * 递到翻译层就撞上了 —— "桥接服务未启动"本来有中文映射，因为前面多了这串
 * 英文，整条原样上了屏。所以先剥外层再翻，**原文整条留在 detail** 里
 * （通道名对排查有用，折叠着看得见）。
 */
const IPC_WRAPPER = /^Error invoking remote method '([^']+)':\s*/i;

/**
 * 翻一条错误。
 *
 * @param {string|Error|null} raw
 * @returns {ErrorNote} 永远有值：认不出来时 text 就是原文，不会返回 null 让调用方再判一次
 */
export function describeError(raw) {
  const detail = oneLine(raw && raw.message ? raw.message : raw);
  if (!detail) {
    return { text: '没有返回具体原因', next: ['到「队列」页展开这条任务看明细'], detail: null, tone: 'bad' };
  }
  const wrap = IPC_WRAPPER.exec(detail);
  const inner = wrap ? detail.slice(wrap[0].length).replace(/^Error:\s*/i, '').trim() : detail;
  if (!inner) {
    // 外层里没有原因可翻。这时候**不许**给一句"没有返回具体原因"了事：
    // 报出是哪一条调用没成功，才让人知道坏在哪个环节。
    return {
      text: `主进程的「${wrap[1]}」调用没成功，而且没给出原因`,
      next: ['到「诊断」页看运行环境', '重试一次还不行就把这一句发给开发者'],
      detail,
      tone: 'bad',
    };
  }
  const lower = inner.toLowerCase();
  for (const rule of RULES) {
    const m = rule.test(lower);
    if (!m) continue;
    const note = rule.make(typeof m === 'object' && m.length !== undefined ? m : [m]);
    // 原文一律保留在 detail 里：折叠着不占地方，但开发者排查与用户截图都要靠它
    return { ...note, detail: note.detail || detail };
  }
  return {
    // 认不出来就原样给（压成一行、最多留 120 字）：这类串本身多半是中文说明，
    // 切太短会把"为什么"的后半句丢掉 —— 而那正是要紧的部分。
    text: inner.length > 120 ? inner.slice(0, 120) + '…' : inner,
    next: [],
    detail,
    tone: 'bad',
  };
}

/** 一行提示用的极简版：只要"人话"，不要下一步 */
export function errorText(raw) {
  return describeError(raw).text;
}

/**
 * 提示文案里嵌失败原因时的通用入口。
 *
 * 为什么不直接用 `errorText(r.error) || '入队失败'`：翻译**空串**会得到
 * "没有返回具体原因"这样一句非空的话，于是 `||` 永远不生效，
 * 调用方准备好的更具体说法（"入队失败"/"切换账号失败"）被顶掉。
 * 所以空值必须在翻译之前就回退。
 *
 * @param {string|Error|null} raw
 * @param {string} [fallback] - raw 为空时用的说法
 */
export function failText(raw, fallback) {
  const s = oneLine(raw && raw.message ? raw.message : raw);
  return s ? describeError(s).text : (fallback || '没有返回具体原因');
}

/** 把多行/连续空白压成一行（错误串里常带堆栈或换行，会把明细行撑成五行） */
function oneLine(s) {
  if (s == null) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}
