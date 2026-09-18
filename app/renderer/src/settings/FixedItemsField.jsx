import React from 'react';

/**
 * 固定回复内容列表编辑器。
 *
 * 这是 P4.2 里唯一一个"必须和模式选择一起做"的控件：列表为空时固定内容模式
 * 会直接报错，所以不能只给一个模式开关就完事。
 *
 * 这里只负责编辑，不重复 core 的"哪几条真正可用"的判断 —— 那套规则依赖
 * 循环方式（加权会排除权重 0），在界面里再写一遍必然漂移。编辑完保存后，
 * 由 SettingsView 调 reply:describe() 把 core 算出来的结果展示出来。
 */
export default function FixedItemsField({ value, onChange }) {
  const items = Array.isArray(value) ? value : [];

  const update = (i, patch) => {
    const next = items.map((it, j) => (j === i ? { ...it, ...patch } : it));
    onChange(next);
  };
  const remove = (i) => onChange(items.filter((_, j) => j !== i));
  const add = () => onChange([...items, { text: '', weight: 1, enabled: true }]);

  return (
    <div className="fixed-items">
      {items.length === 0 && (
        <div className="settings-error">
          还没有任何固定内容。选「固定内容」模式时生成会直接失败；
          选「混合」模式时若 AI 失败也没有可降级的内容。先加几条，或把回复模式改回 AI。
        </div>
      )}

      {items.map((it, i) => (
        <div className={`fixed-item ${it.enabled === false ? 'fixed-item-off' : ''}`} key={i}>
          <input
            className="input fixed-item-text"
            type="text"
            placeholder="回复内容"
            value={it.text ?? ''}
            onChange={e => update(i, { text: e.target.value })}
          />
          <input
            className="input fixed-item-weight"
            type="number"
            min={0}
            step={1}
            title="权重：只在「加权」循环下生效，0 表示这条不参与抽取"
            value={it.weight ?? 1}
            onChange={e => {
              const n = Number(e.target.value);
              if (e.target.value === '' || !Number.isFinite(n)) return;
              update(i, { weight: Math.max(0, n) });
            }}
          />
          <label className="fixed-item-enabled" title="取消勾选即可临时停用这条">
            <input
              type="checkbox"
              checked={it.enabled !== false}
              onChange={e => update(i, { enabled: e.target.checked })}
            />
          </label>
          <button className="btn btn-quiet fixed-item-del" onClick={() => remove(i)} title="删除这条">
            ×
          </button>
        </div>
      ))}

      <div className="settings-inline">
        <button className="btn" onClick={add}>添加一条</button>
        <span className="muted num">
          共 {items.length} 条
          {items.length > 0 && ` · 启用 ${items.filter(it => it.enabled !== false).length} 条`}
        </span>
      </div>
    </div>
  );
}
