import React, { useEffect, useRef, useState } from 'react';
import { T } from './schema.js';
import FixedItemsField from './FixedItemsField.jsx';
import ImagePathsField from './ImagePathsField.jsx';
import ResetCycleField from './ResetCycleField.jsx';

/**
 * 通用字段渲染。
 *
 * 每个字段自己只负责"把这个值变成合适的控件"，脏值跟踪、保存、校验提示
 * 都由 SettingsView 统一处理 —— 否则每个控件都要各写一遍那套逻辑。
 *
 * 关于受控输入的取舍：数组类字段（词表 / JSON）在本地保留**文本**状态，
 * 只有解析成功才向上抛数组。这样"正在输入第 3 行"这种中间状态不会被
 * 每次按键都格式化回去导致光标乱跳。
 */

/** 一行一条的字符串/数字列表 */
function ListField({ value, onChange, numeric }) {
  const toText = (v) => (Array.isArray(v) ? v.join('\n') : '');
  const [text, setText] = useState(() => toText(value));
  const lastExternal = useRef(JSON.stringify(value));

  // 外部值变了（切换分组重新挂载另说；这里是"恢复默认"之类的改动）才回灌，
  // 否则用户正在敲的内容会被自己抛出去的值覆盖
  useEffect(() => {
    const now = JSON.stringify(value);
    if (now !== lastExternal.current) {
      lastExternal.current = now;
      setText(toText(value));
    }
  }, [value]);

  function handle(t) {
    setText(t);
    const items = t
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => (numeric ? Number(s) : s))
      .filter(v => (numeric ? Number.isFinite(v) : true));
    onChange(items);
  }

  return (
    <textarea
      className="input settings-textarea"
      rows={Math.min(12, Math.max(3, (text.match(/\n/g) || []).length + 2))}
      value={text}
      onChange={e => handle(e.target.value)}
      spellCheck={false}
    />
  );
}

/** JSON 字段：解析失败时保留上一份合法值，并把错误显示出来 */
function JsonField({ value, onChange }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState(null);
  const lastExternal = useRef(JSON.stringify(value));

  useEffect(() => {
    const now = JSON.stringify(value);
    if (now !== lastExternal.current) {
      lastExternal.current = now;
      setText(JSON.stringify(value, null, 2));
      setError(null);
    }
  }, [value]);

  function handle(t) {
    setText(t);
    if (!t.trim()) {
      setError('不能为空');
      return;
    }
    try {
      const parsed = JSON.parse(t);
      setError(null);
      onChange(parsed);
    } catch (e) {
      setError(`JSON 格式错误：${e.message}`);
    }
  }

  return (
    <>
      <textarea
        className="input settings-textarea settings-json"
        rows={Math.min(16, Math.max(4, text.split('\n').length))}
        value={text}
        onChange={e => handle(e.target.value)}
        spellCheck={false}
      />
      {error && <div className="settings-error">{error}</div>}
    </>
  );
}

/**
 * 一个数字输入框：本地保留文本 + 非法值当场说清。
 *
 * 为什么不能直接 `value={value}` 受控 —— 改造前三个数字控件都那么写，
 * 于是同一个动作有三种坏法，共同点是**用户不知道发生了什么**：
 *   - INT：`if (!Number.isFinite(n)) return;` —— 敲进去的字符**根本不显示**，
 *     界面上什么都不发生，也没有任何提示（DESIGN.md 的 Known Gaps 记的就是它）
 *   - RANGE2：没有守卫，`Number('') === 0` —— 清空输入框会把值悄悄写成 0
 *   - RATIO：非法输入被静默夹到 0–100
 *
 * 保留本地文本、只在解析成功时向上抛，是同一个文件里 ListField 已经在用的做法
 * （见它上面的注释）。这样"正在输入"的中间状态不会被格式化回去，
 * 而"这个值不算数"是看得见的。
 *
 * 非法值**不向上抛**：草稿里留着的仍是上一个合法值，保存时不会把半个数字写进配置。
 * 同时通过 onInvalid 把错误报给上层，让保存按钮拦住 —— 不然"保存成功"会是假话。
 *
 * @param {object} props
 * @param {number} props.value
 * @param {(n:number)=>void} props.onChange
 * @param {(msg:string|null)=>void} [props.onInvalid]
 * @param {number} [props.scale=1] - 显示值 = 实际值 × scale（比例按百分比显示时用 100）
 * @param {number} [props.min] [props.max] - 以**显示值**为单位
 * @param {boolean} [props.integer]
 * @param {string} [props.suffix] - 控件后面的单位文字
 */
function NumInput({
  value, onChange, onInvalid, scale = 1, min, max, integer = false, suffix, width,
}) {
  // 浮点噪声（0.1*100 = 10.000000000000002）不该显示给用户
  const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v * scale * 1e6) / 1e6) : '');
  const [text, setText] = useState(() => fmt(value));
  const [error, setError] = useState(null);
  const lastExternal = useRef(fmt(value));

  // 外部值变了（点了「恢复默认」、保存后回灌）才回写文本 ——
  // 无条件回灌会把用户正在敲的内容覆盖掉
  useEffect(() => {
    const now = fmt(value);
    if (now !== lastExternal.current) {
      lastExternal.current = now;
      setText(now);
      setError(null);
      if (onInvalid) onInvalid(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function handle(t) {
    setText(t);
    const msg = validateNum(t, { min, max, integer });
    setError(msg);
    if (onInvalid) onInvalid(msg);
    if (msg) return;                       // 非法值不向上抛，草稿保持上一个合法值
    const n = Number(t) / scale;
    // 先把"外部值"对齐，免得下面 onChange 触发的重渲染把文本格式化回去
    lastExternal.current = fmt(n);
    onChange(n);
  }

  return (
    <div className={`settings-inline ${error ? 'settings-inline-invalid' : ''}`}>
      <input
        className={`input settings-num ${error ? 'input-invalid' : ''}`}
        // 用 text 而不是 number：number 输入框在部分浏览器上会把非法输入
        // 从 e.target.value 里直接吞掉，连"用户敲了什么"都拿不到
        type="text"
        inputMode="decimal"
        value={text}
        style={width ? { width } : undefined}
        onChange={e => handle(e.target.value)}
        aria-invalid={error ? 'true' : undefined}
      />
      {suffix && <span className="muted">{suffix}</span>}
      {error && <span className="settings-invalid">{error}</span>}
    </div>
  );
}

/** 只判"这个值算不算数"，不重复 core 的范围规则（那是 config 校验的事） */
function validateNum(text, { min, max, integer }) {
  const t = String(text).trim();
  if (t === '') return '不能为空';
  const n = Number(t);
  if (!Number.isFinite(n)) return '要填数字';
  if (integer && !Number.isInteger(n)) return '要填整数';
  if (min != null && n < min) return `不能小于 ${min}`;
  if (max != null && n > max) return `不能大于 ${max}`;
  return null;
}

/** 比例：内部存 0–1，界面按百分比输入，省得用户去数小数点 */
function RatioField({ value, onChange, onInvalid }) {
  return (
    <NumInput
      value={Number.isFinite(value) ? value : 0}
      onChange={onChange}
      onInvalid={onInvalid}
      scale={100}
      min={0}
      max={100}
      suffix="%"
    />
  );
}

/**
 * 区间（如"期望回复长度 30~60 字"）。
 *
 * 两个输入框各自会报错，但上层的 onInvalid 只有一个位置 ——
 * 所以这里要合成：**任意一个不对就算这一项不对**。分开报的话，
 * 后一个输入框的清空会把前一个的错误状态顶掉，保存按钮又放行了。
 */
function Range2Field({ value, onChange, onInvalid }) {
  const arr = Array.isArray(value) ? value : [0, 0];
  const [errs, setErrs] = useState([null, null]);
  // 用 ref 记一份：把 onInvalid 放进 setErrs 的更新函数里会让它在
  // StrictMode 下被调用两次，而它又会去 setState 上层 —— 侧效应不该写在更新函数里
  const errsRef = useRef([null, null]);

  function report(i, msg) {
    const next = [...errsRef.current];
    next[i] = msg;
    errsRef.current = next;
    setErrs(next);
    if (onInvalid) onInvalid(next[0] || next[1] || null);
  }

  const set = (i, n) => {
    const next = [...arr];
    next[i] = n;
    onChange(next);
  };

  return (
    <div className="settings-inline">
      <NumInput value={arr[0]} onChange={(n) => set(0, n)} onInvalid={(m) => report(0, m)} min={0} integer width={88} />
      <span className="muted">~</span>
      <NumInput value={arr[1]} onChange={(n) => set(1, n)} onInvalid={(m) => report(1, m)} min={0} integer width={88} />
    </div>
  );
}

/**
 * 渲染一个字段。
 *
 * @param {object} props
 * @param {object} props.field   - schema 里的字段定义
 * @param {*} props.value        - 当前值
 * @param {(v:*) => void} props.onChange
 * @param {*} props.defaultValue - 默认值（用于"恢复默认"按钮与占位提示）
 * @param {boolean} props.dirty  - 是否改过
 * @param {() => void} props.onReset
 * @param {(msg: string|null) => void} [props.onInvalid] - 这一项当前填得对不对。
 *   只有数字类控件会报（字符串/列表类没有"填错"这种状态），
 *   上报给设置页用来拦住保存 —— 否则用户填了个非法值、点保存、被告知"已保存"，
 *   而那个值根本没进去。
 * @param {React.ReactNode} [props.extra] - 特殊组件需要的额外内容
 */
export default function Field({ field, cfg, value, onChange, defaultValue, dirty, onReset, extra, onInvalid }) {
  const { type, path } = field;
  // status / statusNote 可以写成 (cfg) => string 的形式：有些配置项"管不管用"
  // 取决于别的项（比如固定回复内容只在非 AI 模式下被读取），
  // 静态文案必然有一半场合是错的，而说错比不说更糟。
  const status = typeof field.status === 'function' ? field.status(cfg || {}) : field.status;
  const statusNote = typeof field.statusNote === 'function'
    ? field.statusNote(cfg || {}) : field.statusNote;
  let control;

  switch (type) {
    case T.BOOL:
      control = (
        <label className="settings-check">
          <input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />
          <span className="muted">{value === true ? '已开启' : '已关闭'}</span>
        </label>
      );
      break;

    case T.INT:
      // 改造前这里是 `if (!Number.isFinite(n)) return;` —— 敲进去的字符
      // 不显示、不报错、不生效，用户只能反复试。现在交给 NumInput：
      // 当场标红并说明原因，且不把这个值提交上去（见它的注释）
      control = (
        <NumInput
          value={Number.isFinite(value) ? value : 0}
          onChange={onChange}
          onInvalid={onInvalid}
          integer
          min={0}
          width={130}
        />
      );
      break;

    case T.TEXT:
      control = (
        <input
          className="input settings-wide"
          type="text"
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
      );
      break;

    case T.PASSWORD:
      // 留空 = 不修改。不回显真实内容，也不把打码值当成值再提交回去
      // （core/config.set 对这一点另有一道拒绝）。
      control = (
        <input
          className="input settings-wide"
          type="password"
          placeholder={field.placeholder || '留空表示不修改'}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
      );
      break;

    case T.TEXTAREA:
      control = (
        <textarea
          className="input settings-textarea"
          rows={4}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
      );
      break;

    case T.ENUM:
      control = (
        <select className="input settings-wide" value={value ?? ''} onChange={e => onChange(e.target.value)}>
          {(field.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;

    case T.RANGE2:
      control = <Range2Field value={value} onChange={onChange} onInvalid={onInvalid} />;
      break;

    case T.RATIO:
      control = <RatioField value={value} onChange={onChange} onInvalid={onInvalid} />;
      break;

    case T.STR_LIST:
      control = <ListField value={value} onChange={onChange} />;
      break;

    case T.INT_LIST:
      control = <ListField value={value} onChange={onChange} numeric />;
      break;

    case T.JSON:
      control = <JsonField value={value} onChange={onChange} />;
      break;

    case T.FIXED_ITEMS:
      control = <FixedItemsField value={value} onChange={onChange} />;
      break;

    case T.IMAGE_PATHS:
      control = <ImagePathsField value={value} onChange={onChange} />;
      break;

    case T.RESET_CYCLE:
      return <ResetCycleField field={field} />;

    default:
      control = <div className="settings-error">未知控件类型：{type}</div>;
  }

  return (
    <div className="settings-field">
      <div className="settings-field-label">
        <span>{field.label}</span>
        <StatusBadge status={status} />
        {dirty && (
          <span className="settings-dirty">
            已改
            <button className="settings-reset" onClick={onReset} title="恢复为默认值">
              恢复默认
            </button>
          </span>
        )}
      </div>
      {extra}
      {control}
      {/* 状态说明紧跟在控件下面、在普通提示之上 —— 顺序是有意的：
          用户看完"这是什么"之后，紧接着就该知道"它到底管不管用" */}
      {statusNote && (
        <div className={`settings-status settings-status-${status || 'inactive'}`}>
          {statusNote}
        </div>
      )}
      {field.hint && <div className="settings-hint">{field.hint}</div>}
      {dirty && path !== 'reply.fixed.cursorReset' && defaultValue !== undefined && (
        <div className="settings-default muted num">
          默认：{formatDefault(defaultValue)}
        </div>
      )}
    </div>
  );
}

/**
 * 「这一项到底管不管用」的徽标。
 *
 * 存在的理由：这套配置面里有几个键是**可配置、但不影响行为**的 ——
 * 有历史遗留（toneWords 没有任何消费点），也有刻意的（风控升级只提示不拦截）。
 * 让它们和普通配置项长得一模一样，用户改完会以为生效了，
 * 而那正是项目开头发誓不再犯的"看着能配、实际不生效"。
 *
 * 与其把它们藏起来，不如留在原地、把状态说清楚 —— 所以这个徽标要和标签同一行、
 * 用状态色，而不是缩在下面的小字里。
 */
function StatusBadge({ status }) {
  if (status === 'inactive') {
    return <span className="tag tag-warn">不生效</span>;
  }
  if (status === 'advisory') {
    return <span className="tag tag-warn">只提示</span>;
  }
  return null;
}

/** 默认值提示：数组太长时只给个概要，不然一个词表就能占掉半屏 */
function formatDefault(v) {
  if (Array.isArray(v)) {
    if (!v.length) return '（空）';
    if (v.length > 4 || v.some(x => typeof x === 'object')) return `共 ${v.length} 项`;
    return v.join('、');
  }
  if (v === '') return '（空）';
  if (typeof v === 'boolean') return v ? '开' : '关';
  return String(v);
}
