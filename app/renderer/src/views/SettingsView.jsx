import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LoadingState from '../components/LoadingState.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { failText } from '../errors.js';
import { GROUPS, T } from '../settings/schema.js';
import Field from '../settings/fields.jsx';
import PersonasField from '../settings/PersonasField.jsx';
import PromptsField from '../settings/PromptsField.jsx';
import { getPath, flatten, buildPatch } from '../settings/patch.js';

/**
 * 设置页。
 *
 * 三个关键约定：
 *
 * 1. **只提交改动过的字段**。加载进来的是脱敏快照（api_key 是打码文案），
 *    整份回写会把密钥写成那串星星。主进程与 core/config 各有一道拦截，
 *    但正确的用法是传补丁 —— 所以这里用 dirty 集合驱动提交。
 *
 * 2. **默认值与校验以 core 为准**。界面只拿 config.describe() 给的 config /
 *    defaults / warnings，不自己复制一份规则，避免两处漂移。
 *
 * 3. **保存即热重载**。core/config 的 set() 会刷新内存里的合并结果，
 *    所有消费方下次取值就是新的，不需要重启。
 */
export default function SettingsView() {
  const [described, setDescribed] = useState(null);
  /** 这一次配置没读回来的理由：没有它，失败与「还在读」在屏幕上同形 */
  const [loadError, setLoadError] = useState(null);
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(() => new Set());
  /**
   * 当前填得不对的字段：path → 人话原因。
   *
   * 为什么要有它：数字控件对非法输入的处理此前是"静默丢弃"（见 fields.jsx 里
   * NumInput 的注释）。现在非法值当天标红、且不会被提交 —— 但那样又会产生
   * 一个更坏的局面：用户填了个非法值、点保存、界面说「已保存，立即生效」，
   * 而那一项其实还停在旧值上。所以这里把它攒起来，**保存按钮直接拦下**，
   * 并列出是哪几项 —— 与"配置里有非法值被自动回退"那条提示是两回事：
   * 那条是 core 在保存后判的，这条是界面在保存前判的。
   */
  const [invalid, setInvalid] = useState(() => new Map());
  const [group, setGroup] = useState(GROUPS[0].key);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [replyDesc, setReplyDesc] = useState(null);
  /**
   * 高级分组（节奏间隔/发布策略/评论筛选/应用与桥接）默认收起。
   * 不持久化：需要的人每次点一下即可，而普通用户永远不会被端口、超时
   * 这类项打扰 —— 这个页面对非技术用户的主要问题是"项太多不知道从哪
   * 看起"，分组分层比逐项写说明更能解决它。
   */
  const [showAdvanced, setShowAdvanced] = useState(false);

  const applyDescribed = useCallback((d) => {
    setDescribed(d);
    setDraft(flatten(d.config, d.sensitiveKeys));
    setDirty(new Set());
    // 重新读配置（保存成功或点「放弃」）后，界面上那些"填得不对"的标记
    // 指的是上一份草稿，必须一起清掉 —— 留着会拦住下一次保存而没有任何原因
    setInvalid(new Map());
  }, []);

  /** 某个字段报上来的校验结果（null = 这一项没问题了）*/
  const markInvalid = useCallback((path, message) => {
    setInvalid((prev) => {
      if (!message) {
        if (!prev.has(path)) return prev;      // 没记过就不用产生新对象
        const next = new Map(prev);
        next.delete(path);
        return next;
      }
      if (prev.get(path) === message) return prev;
      return new Map(prev).set(path, message);
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await window.dy.config.describe();
      if (r && r.ok) {
        applyDescribed(r.data);
        setLoadError(null);
        return;
      }
      setLoadError(failText(r && r.error, '主进程没有返回配置'));
      setNotice((r && r.error) || '读取配置失败');
    } catch (e) {
      // 上面那一支 {ok:false} 已经是这个通道的主要失败形状（handler 自己带 try/catch）。
      // 这里接的是剩下那一种：IPC 外壳层面的 reject —— 结果序列化不了，
      // 或这个通道压根还没注册上（第二十二轮 §2.41 说的就是这一层的串）。
      // 不接住它，described 永远停在 null，整页永远写着「正在读取配置…」，
      // 而它不会再有结果了。
      setLoadError(failText(e && e.message, '配置没读回来'));
      setNotice('配置没读回来 —— 这一页现在一个字段都没有');
    }
  }, [applyDescribed]);

  useEffect(() => { load(); }, [load]);

  // 固定内容"到底有几条真正参与循环"由 core 判定（依赖循环方式，加权会排除权重 0），
  // 界面不重复这套规则，保存后重新问一次。
  const refreshReplyDesc = useCallback(async () => {
    const r = await window.dy.reply.describe();
    if (r && r.ok) setReplyDesc(r.data);
  }, []);
  useEffect(() => { refreshReplyDesc(); }, [refreshReplyDesc]);

  function change(path, value) {
    setDraft(prev => ({ ...prev, [path]: value }));
    setDirty(prev => new Set(prev).add(path));
    setNotice(null);
  }

  function resetField(path) {
    const value = getPath(described.defaults, path);
    setDraft(prev => ({ ...prev, [path]: value }));
    setDirty(prev => new Set(prev).add(path));
  }

  async function save() {
    setSaving(true);
    try {
      const patch = buildPatch(dirty, draft, described.sensitiveKeys);
      const r = await window.dy.config.set(patch);
      if (!r || !r.ok) { setNotice(`保存失败：${(r && r.error) || '未知错误'}`); return; }

      applyDescribed(r.data);
      refreshReplyDesc();

      const corrected = ((r.data && r.data.warnings) || []).filter(w => w.key !== '(file)');
      setNotice(corrected.length
        ? `已保存，但有 ${corrected.length} 项非法值被自动回退，详见下方`
        : '已保存，立即生效');
    } finally {
      setSaving(false);
    }
  }

  const warnings = (described && described.warnings) || [];
  // 可见的分组：高级组只在勾了"显示高级设置"后出现
  const visibleGroups = GROUPS.filter(g => showAdvanced || !g.advanced);
  // 当前选中的分组被收起时（比如刚取消勾选），回退到第一个可见分组
  const activeGroup = visibleGroups.find(g => g.key === group) || visibleGroups[0];

  // showWhen 用的是**草稿**而不是已保存的配置：勾上"附带图片"，下面的选项
  // 应该立刻出现，而不是等保存后才出现。
  const visibleFields = useMemo(
    () => activeGroup.fields.filter(f => !f.showWhen || f.showWhen(draft)),
    [activeGroup, draft]
  );

  if (!described) {
    return (
      <div className="main-col">
        <h1 className="page-title">设置</h1>
        {loadError ? (
          // 这一支必须与"还在读"不同形：读不回来时这一页永远不会出现字段，
          // 而「正在读取配置…」承诺的是"再过一秒就有了"
          <EmptyState
            title="配置没读回来。"
            hint={<>这不是"配置是空的"。原因：{loadError}。所以这一页现在一个字段都看不到，
              也看不到任何当前值 —— 值仍留在磁盘上没被动过，改不了也不会被改。</>}
            action={<button className="btn" onClick={() => load()}>重新读取</button>}
          />
        ) : (
          <LoadingState variant="text" label="正在读取配置…" />
        )}
      </div>
    );
  }

  return (
    <div className="main-col">
      <h1 className="page-title">设置</h1>
      <p className="page-sub">改完点保存立即生效，不需要重启。悬停在各字段下方的小字上可以看到这项是干什么的。</p>

      {notice && <div className="notice"><div>{notice}</div></div>}

      {warnings.length > 0 && (
        <div className="notice notice-warn">
          <div>
            <b>配置里有非法值，已自动回退：</b>
            <ul>
              {warnings.map((w, i) => <li key={i}><code>{w.key}</code> — {w.message}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="settings-tabs">
        {visibleGroups.map(g => (
          <button
            key={g.key}
            className={`tab ${activeGroup.key === g.key ? 'tab-active' : ''}`}
            onClick={() => setGroup(g.key)}
          >
            {g.label}
            {countDirtyInGroup(g, dirty) > 0 && <span className="settings-tab-dot" />}
          </button>
        ))}
      </div>

      {/* 高级开关放在分组条下面、正文上面：眼熟的位置，不打断阅读 */}
      <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
        <label style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showAdvanced}
            onChange={e => setShowAdvanced(e.target.checked)}
          />{' '}
          显示高级设置（节奏间隔、发布策略、评论筛选、应用与桥接）
        </label>
      </div>

      <section className="section">
        <h2 className="section-title">{activeGroup.label}</h2>
        {activeGroup.desc && <p className="page-sub">{activeGroup.desc}</p>}

        {activeGroup.key === 'reply' && replyDesc && (
          <div className="notice">
            <div className="num">
              当前：{MODE_LABEL[replyDesc.mode] || replyDesc.mode}
              {replyDesc.fixed.total > 0 && ` · 固定内容 ${replyDesc.fixed.total} 条`}
              {replyDesc.fixed.total > 0 && `（真正参与循环 ${replyDesc.fixed.usable} 条）`}
              {replyDesc.fixed.zeroWeight > 0 && `，其中 ${replyDesc.fixed.zeroWeight} 条权重为 0 被排除`}
              {replyDesc.image.enabled && ` · 图片 ${replyDesc.image.usable} 张可用`}
              {replyDesc.image.enabled && replyDesc.image.rejected.length > 0
                && `，${replyDesc.image.rejected.length} 张不可用`}
            </div>
          </div>
        )}

        {/* 人格与提示词这两组不走通用字段渲染：前者编辑的是「内置 + 覆盖 + 自定义」
            叠加出来的列表，后者编辑的是磁盘上的模板文件（自带保存按钮，
            因为它的"保存"要连带备份与清缓存，与 config 补丁不是一回事）。 */}
        {activeGroup.component === 'personas' && (
          <PersonasField draft={draft} change={change} />
        )}
        {activeGroup.component === 'prompts' && <PromptsField />}

        {visibleFields.map(f => (
          <Field
            key={f.path}
            field={f}
            // 当前草稿（扁平的点号路径表）。status / statusNote 允许写成函数读它 ——
            // 有些项"管不管用"取决于别的配置项，比如固定回复内容只在
            // 非 AI 模式下才被读取，写死成静态文案必然有一半场合是错的。
            cfg={draft}
            // 已落盘的那一份，敏感字段是**打码值**而不是空串：
            // "这一格到底填没填过"只有这里看得出 —— draft 里敏感字段被 flatten
            // 一律抹成空串，从没填过与填过了两种情况长得一模一样。
            saved={described ? flatten(described.config, []) : {}}
            value={draft[f.path]}
            defaultValue={getPath(described.defaults, f.path)}
            dirty={dirty.has(f.path)}
            onReset={() => resetField(f.path)}
            onChange={(v) => change(f.path, v)}
            onInvalid={(msg) => markInvalid(f.path, msg)}
          />
        ))}

        <div className="muted settings-note">
          配置文件：<code>{described.file}</code>
          {!described.exists && '（尚未创建，保存后生成）'}
        </div>
      </section>

      {/* 填得不对的项：逐条列出，而不是只让用户看到某个输入框变红 ——
          它们可能分散在几个分组里，切来切去找是最烦的 */}
      {invalid.size > 0 && (
        <div className="notice notice-bad">
          <div>
            <b>{invalid.size} 项填得不对，不会保存：</b>
            <ul>
              {[...invalid.entries()].map(([p, msg]) => (
                <li key={p}><code>{p}</code> — {msg}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 保存条常驻在底部：滚到长分组的末尾时不必再翻回去找按钮 */}
      {dirty.size > 0 && (
        <div className="settings-savebar">
          <span className="num">
            {dirty.size} 项未保存
            {invalid.size > 0 && <span className="text-bad"> · {invalid.size} 项填得不对</span>}
          </span>
          <div className="row">
            <button className="btn btn-quiet" onClick={load} disabled={saving}>放弃</button>
            <button
              className="btn btn-primary"
              onClick={save}
              // 填错就不让保存：放行的话用户会得到一句"已保存，立即生效"，
              // 而那一项其实还停在旧值上 —— 承诺了一个没发生的事
              disabled={saving || invalid.size > 0}
              title={invalid.size > 0 ? '先把填得不对的项改好' : undefined}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const MODE_LABEL = { ai: 'AI 生成', fixed: '固定内容', hybrid: '混合' };

/**
 * 某个分组里有几项被改过 —— 用来在标签上点一个提示点，切到别的分组也看得到。
 *
 * 必须把 `covers` 也算上：人格/提示词那两组走专用组件、fields 是空的，
 * 只数 fields 的话它们的改动永远不亮提示点，用户切走再切回来就找不到改在哪了。
 * （提示词组是文件、不进 dirty 集合，所以 covers 为空，天然不受影响。）
 */
function countDirtyInGroup(g, dirty) {
  const paths = [...g.fields.map(f => f.path), ...(g.covers || [])];
  return paths.filter(p => dirty.has(p)).length;
}

// 值 ↔ 补丁 的转换在 ../settings/patch.js，那里是纯函数、可直接测
