import React, { useEffect, useState } from 'react';
import LoadingState from '../components/LoadingState.jsx';

/**
 * 人格编辑器。
 *
 * 编辑的对象是「内置 + 覆盖 + 自定义 - 停用」叠加出来的**生效列表**，
 * 但落盘的是三份原始数据：
 *   personas.disabled   停用哪些
 *   personas.overrides  改过哪些字段（只写改动的，未改字段自动跟内置走）
 *   personas.custom     完整定义的自定义人格
 *
 * 之所以落盘存"差异"而不是存整份列表：存整份的话，内置人格以后调整了
 * （比如修一句不规范的语气描述），用户那份副本会把它永远盖住。
 */

export default function PersonasField({ draft, change }) {
  const [desc, setDesc] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    window.dy.personas.describe().then(r => {
      if (r && r.ok) setDesc(r.data);
      else setNotice((r && r.error) || '读取人格失败');
    });
  }, []);

  // 加载态走统一组件（text 形态）：改造前这里是一句裸文字，与"没有数据"同款
  if (!desc) return <LoadingState variant="text" label="正在读取人格…" />;

  const builtinIds = new Set(desc.builtin.map(p => p.id));
  const disabled = Array.isArray(draft['personas.disabled']) ? draft['personas.disabled'] : [];
  const overrides = Array.isArray(draft['personas.overrides']) ? draft['personas.overrides'] : [];
  const custom = Array.isArray(draft['personas.custom']) ? draft['personas.custom'] : [];

  // 展示列表直接用 core 给的那份：它已经按"内置 + 覆盖"合并过，
  // 且在 includeDisabled 下带上了停用的人格（否则用户没法把它重新启用）。
  // 界面不自己合并 —— 那会让"看到的"和"生成时用的"分成两份规则。
  const all = desc.all.map(p => ({ ...p, custom: !builtinIds.has(p.id) }));

  const overrideOf = (id) => overrides.find(o => o && o.id === id) || null;

  function setDisabled(id, off) {
    const next = off ? [...new Set([...disabled, id])] : disabled.filter(x => x !== id);
    change('personas.disabled', next);
  }

  function setOverrideField(id, key, value) {
    const idx = overrides.findIndex(o => o && o.id === id);
    const next = idx >= 0
      // 保留这条记录里其它已改字段：只改当前这一个
      ? overrides.map((o, i) => (i === idx ? { ...o, [key]: value } : o))
      : [...overrides, { id, [key]: value }];
    change('personas.overrides', next);
  }

  /** 恢复默认 = 删掉这条覆盖记录（未改动的字段本来就跟着内置走，删除即还原） */
  function resetPersona(id) {
    change('personas.overrides', overrides.filter(o => o.id !== id));
    setNotice(`已恢复默认 —— 记得点页面底部的保存`);
  }

  function setCustomField(id, key, value) {
    change('personas.custom', custom.map(p => (p.id === id ? { ...p, [key]: value } : p)));
  }

  function addCustom() {
    // id 用时间戳后缀：撞上内置或已有自定义的 id 会被 core 忽略掉，
    // 那是最难查的一类问题（"加了但没生效"）
    let n = custom.length + 1;
    while (builtinIds.has(`my_persona_${n}`) || custom.some(p => p.id === `my_persona_${n}`)) n++;
    const id = `my_persona_${n}`;
    change('personas.custom', [...custom, {
      id, name: `自定义人格 ${n}`, weight: 10, temperature: 0.7,
      lengthRange: [10, 45], emojiChance: 0.3,
      promptPrefix: '', forbiddenWords: [], examples: [],
    }]);
    setExpanded(id);
  }

  function removeCustom(id) {
    change('personas.custom', custom.filter(p => p.id !== id));
    if (expanded === id) setExpanded(null);
  }

  const enabledCount = all.filter(p => !disabled.includes(p.id)).length;

  return (
    <div className="personas">
      {notice && <div className="notice" style={{ marginBottom: 12 }}><div>{notice}</div></div>}

      <div className="muted num settings-hint" style={{ marginBottom: 12 }}>
        共 {all.length} 个 · 启用 {enabledCount} 个
        {enabledCount === 0 && '　⚠ 全部停用时，生成会退回使用全部内置人格'}
      </div>

      {all.map(p => {
        const off = disabled.includes(p.id);
        const ov = overrideOf(p.id);
        const changed = ov && Object.keys(ov).filter(k => k !== 'id').length > 0;
        const isOpen = expanded === p.id;

        return (
          <div className={`persona ${off ? 'persona-off' : ''}`} key={p.id}>
            <div className="persona-head">
              <label className="persona-toggle" title={off ? '已停用' : '启用中'}>
                <input type="checkbox" checked={!off} onChange={e => setDisabled(p.id, !e.target.checked)} />
              </label>
              <button className="persona-name" onClick={() => setExpanded(isOpen ? null : p.id)}>
                <span className="persona-label">{p.name}</span>
                <span className="muted num">{p.id}</span>
                {p.custom && <span className="tag tag-dim">自定义</span>}
                {changed && <span className="tag tag-warn">已改</span>}
              </button>
              <span className="muted num persona-meta">
                权重 {p.weight} · 温度 {p.temperature} · {p.lengthRange?.[0]}–{p.lengthRange?.[1]} 字
              </span>
              {p.custom && (
                <button className="btn btn-quiet" onClick={() => removeCustom(p.id)}>删除</button>
              )}
            </div>

            {isOpen && (
              <PersonaEditor
                persona={p}
                isCustom={p.custom}
                overridden={!!changed}
                onChangeField={(key, value) => (p.custom
                  ? setCustomField(p.id, key, value)
                  : setOverrideField(p.id, key, value))}
                onReset={() => resetPersona(p.id)}
              />
            )}
          </div>
        );
      })}

      <div className="settings-inline" style={{ marginTop: 12 }}>
        <button className="btn" onClick={addCustom}>添加自定义人格</button>
        {overrides.length > 0 && (
          <span className="muted num">共 {overrides.length} 个内置人格被改过</span>
        )}
      </div>

      <div className="settings-hint">
        改完点页面底部的「保存」。停用的人格在生成时不会被选中；
        自定义人格的 id 如果和内置重复，会被忽略（内置优先）。
      </div>
    </div>
  );
}

/** 单个可展开编辑区。字段与内置定义同构，所以内置与自定义共用这一个组件 */
function PersonaEditor({ persona, isCustom, overridden, onChangeField, onReset }) {
  return (
    <div className="persona-body">
      <Field label="显示名" hint="只用于界面与日志里辨认，不发给模型">
        <input
          className="input settings-wide" type="text" value={persona.name || ''}
          onChange={e => onChangeField('name', e.target.value)}
        />
      </Field>

      <div className="settings-inline">
        <Field label="权重" hint="被随机选中的相对概率。0 表示不参与加权（等同无权重）">
          <input
            className="input settings-num" type="number" min={0} value={persona.weight ?? 0}
            onChange={e => onChangeField('weight', Math.max(0, Number(e.target.value) || 0))}
          />
        </Field>
        <Field label="温度" hint="越高越跳脱。建议 0.5–0.9">
          <input
            className="input settings-num" type="number" min={0} max={2} step={0.05} value={persona.temperature ?? 0.7}
            onChange={e => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChangeField('temperature', Math.min(2, Math.max(0, n)));
            }}
          />
        </Field>
        <Field label="emoji 概率" hint="0–1。这条回复里出现 emoji 的概率">
          <input
            className="input settings-num" type="number" min={0} max={1} step={0.05} value={persona.emojiChance ?? 0}
            onChange={e => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChangeField('emojiChance', Math.min(1, Math.max(0, n)));
            }}
          />
        </Field>
        <Field label="长度区间" hint="字数下限–上限，会被写进发给模型的要求里">
          <div className="settings-inline">
            <input
              className="input settings-num" type="number" min={1} value={persona.lengthRange?.[0] ?? 10}
              onChange={e => onChangeField('lengthRange', [Math.max(1, Number(e.target.value) || 1), persona.lengthRange?.[1] ?? 45])}
            />
            <span className="muted">~</span>
            <input
              className="input settings-num" type="number" min={1} value={persona.lengthRange?.[1] ?? 45}
              onChange={e => onChangeField('lengthRange', [persona.lengthRange?.[0] ?? 10, Math.max(1, Number(e.target.value) || 1)])}
            />
          </div>
        </Field>
      </div>

      <Field label="语气描述" hint="这段文字会作为系统提示发给模型，决定这个人格说话的样子">
        <textarea
          className="input settings-textarea" rows={5} value={persona.promptPrefix || ''}
          onChange={e => onChangeField('promptPrefix', e.target.value)}
        />
      </Field>

      <Field label="示例语料" hint="一行一条。模型照着学语气，不会原句复制。这里放什么语境由你决定">
        <textarea
          className="input settings-textarea" rows={4}
          value={(persona.examples || []).join('\n')}
          onChange={e => onChangeField('examples', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
        />
      </Field>

      <Field label="禁用词" hint="一行一条。与设置页「评论筛选」里的全局禁用词叠加，不是替代">
        <textarea
          className="input settings-textarea" rows={3}
          value={(persona.forbiddenWords || []).join('\n')}
          onChange={e => onChangeField('forbiddenWords', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
        />
      </Field>

      {!isCustom && overridden && (
        <div className="settings-inline">
          <button className="btn btn-quiet" onClick={onReset}>恢复这个内置人格的默认值</button>
        </div>
      )}
    </div>
  );
}

/** 带标题与说明的小包装，与设置页其他字段的排版一致 */
function Field({ label, hint, children }) {
  return (
    <div className="settings-field" style={{ borderBottom: 'none', padding: '8px 0' }}>
      <div className="settings-field-label"><span>{label}</span></div>
      {children}
      {hint && <div className="settings-hint">{hint}</div>}
    </div>
  );
}
