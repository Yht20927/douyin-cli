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

/** 比例：内部存 0–1，界面按百分比输入，省得用户去数小数点 */
function RatioField({ value, onChange }) {
  const pct = Number.isFinite(value) ? Math.round(value * 100) : 0;
  return (
    <div className="settings-inline">
      <input
        className="input settings-num"
        type="number"
        min={0}
        max={100}
        value={pct}
        onChange={e => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(Math.min(100, Math.max(0, n)) / 100);
        }}
      />
      <span className="muted">%</span>
    </div>
  );
}

function Range2Field({ value, onChange }) {
  const arr = Array.isArray(value) ? value : [0, 0];
  const set = (i, n) => {
    const next = [...arr];
    next[i] = n;
    onChange(next);
  };
  return (
    <div className="settings-inline">
      <input
        className="input settings-num" type="number" min={1} value={arr[0] ?? ''}
        onChange={e => set(0, Number(e.target.value))}
      />
      <span className="muted">~</span>
      <input
        className="input settings-num" type="number" min={1} value={arr[1] ?? ''}
        onChange={e => set(1, Number(e.target.value))}
      />
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
 * @param {React.ReactNode} [props.extra] - 特殊组件需要的额外内容
 */
export default function Field({ field, cfg, value, onChange, defaultValue, dirty, onReset, extra }) {
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
      control = (
        <input
          className="input settings-num"
          type="number"
          value={value ?? ''}
          onChange={e => {
            const n = Number(e.target.value);
            if (e.target.value === '' || !Number.isFinite(n)) return;
            onChange(Math.round(n));
          }}
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
      control = <Range2Field value={value} onChange={onChange} />;
      break;

    case T.RATIO:
      control = <RatioField value={value} onChange={onChange} />;
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
