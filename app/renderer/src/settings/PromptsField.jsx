import React, { useCallback, useEffect, useState } from 'react';

/**
 * 提示词模板编辑器。
 *
 * 与设置页其它分组不同，这一组编辑的是**磁盘上的模板文件**而不是 config，
 * 所以它有自己独立的保存按钮，不参与页面底部的统一保存。保存动作由
 * core/prompts 负责，它把三件事绑在一起（这是刻意的，散在界面里必漏）：
 *   写盘 → 备份旧版 → 清模板缓存（否则改了要重启才生效）
 *
 * 覆盖是**逐文件**的：只改过的那份写进用户目录，其余仍读打包目录里的默认值。
 */
export default function PromptsField() {
  const [files, setFiles] = useState([]);
  const [name, setName] = useState(null);
  const [doc, setDoc] = useState(null);
  const [text, setText] = useState('');
  const [backups, setBackups] = useState([]);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  /**
   * 载入一个模板。
   *
   * 注意**不清提示** —— 保存/恢复默认之后都要重新载入，而提示是在那之前设的。
   * 早期版本在这里 setNotice(null)，结果"已保存"刚设上就被清掉，用户永远看不到。
   * 清提示是"用户主动切换文件"这个动作的语义，放在列表按钮的 onClick 里。
   */
  const selectFile = useCallback(async (n) => {
    setName(n);
    const [rd, bk] = await Promise.all([
      window.dy.prompts.read(n),
      window.dy.prompts.backups(n),
    ]);
    if (!rd || !rd.ok) { setNotice((rd && rd.error) || '读取失败'); return; }
    setDoc(rd.data);
    setText(rd.data.text == null ? '' : rd.data.text);
    setBackups(bk && bk.ok ? bk.data : []);
  }, []);

  const loadList = useCallback(async () => {
    const r = await window.dy.prompts.list();
    if (!r || !r.ok) { setNotice((r && r.error) || '读取模板列表失败'); return; }
    setFiles(r.data);
    if (!name && r.data.length) selectFile(r.data[0].name);
    // eslint-disable-next-line
  }, [name]);

  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, []);

  const dirty = !!doc && doc.exists && text !== (doc.text == null ? '' : doc.text);
  const isNew = !!doc && !doc.exists;

  async function save() {
    setBusy(true);
    try {
      const r = await window.dy.prompts.save(name, text);
      if (!r || !r.ok) { setNotice(`保存失败：${(r && r.error) || '未知错误'}`); return; }
      const v = r.data.validated;
      const problems = (v && v.issues || []).filter(i => i.severity !== 'ok');
      setNotice(problems.length
        ? `已保存并生效${r.data.backedUp ? `（旧版已备份为 ${r.data.backedUp}）` : ''}，但格式有问题：${problems.map(p => p.message).join('；')}`
        : `已保存并生效${r.data.backedUp ? `（旧版已备份）` : ''}`);
      await selectFile(name);
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefault() {
    const r = await window.dy.prompts.reset(name);
    if (!r || !r.ok) { setNotice(`恢复失败：${(r && r.error) || '未知错误'}`); return; }
    setNotice(r.data.removed ? '已恢复为内置默认版本' : '本来就是默认版本，无需恢复');
    await selectFile(name);
  }

  async function restore(file) {
    const r = await window.dy.prompts.restore(name, file);
    if (!r || !r.ok) { setNotice(`恢复失败：${(r && r.error) || '未知错误'}`); return; }
    setNotice(`已从备份恢复：${file}`);
    await selectFile(name);
  }

  const editedFiles = files.filter(f => f.overridden).length;

  return (
    <div className="prompts">
      {notice && <div className="notice" style={{ marginBottom: 12 }}><div>{notice}</div></div>}

      <div className="prompt-layout">
        <div className="prompt-list">
          {files.map(f => (
            <button
              key={f.name}
              className={`prompt-item ${name === f.name ? 'prompt-item-active' : ''}`}
              onClick={() => { setNotice(null); selectFile(f.name); }}
            >
              <span className="prompt-item-name">{f.name}</span>
              {f.overridden && <span className="tag tag-warn">已改</span>}
              {f.partial && <span className="tag tag-dim">片段</span>}
            </button>
          ))}
          <div className="settings-hint" style={{ padding: '10px 8px' }}>
            共 {files.length} 个模板{editedFiles > 0 ? `，其中 ${editedFiles} 个被改过` : ''}。
            <br />
            partial-* 是跨模板共享的策略片段，改动会影响所有引用它的模板。
          </div>
        </div>

        <div className="prompt-editor">
          {!doc
            ? <div className="empty">从左边选一个模板。</div>
            : (
              <>
                <div className="prompt-head">
                  <span className="num">{doc.name}</span>
                  <span className={`tag ${doc.overridden ? 'tag-warn' : 'tag-dim'}`}>
                    {doc.overridden ? '已覆盖内置' : '内置默认'}
                  </span>
                  {dirty && <span className="tag tag-warn">未保存</span>}
                </div>

                <textarea
                  className="input prompt-textarea"
                  value={text}
                  onChange={e => setText(e.target.value)}
                  spellCheck={false}
                  placeholder={isNew ? '（文件不存在）' : ''}
                />

                <div className="settings-inline" style={{ marginTop: 10 }}>
                  <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
                    {busy ? '保存中…' : '保存'}
                  </button>
                  <button className="btn" onClick={() => setText(doc.text == null ? '' : doc.text)} disabled={!dirty}>
                    撤销改动
                  </button>
                  <button className="btn" onClick={resetToDefault} disabled={!doc.overridden}>
                    恢复默认
                  </button>
                  <span className="muted num">{text.length} 字符</span>
                </div>

                <div className="settings-hint">
                  保存会立即生效（不需要重启），旧版本自动备份。
                  这个文件里的 <code>{'{{XXX}}'}</code> 占位符由代码填充，改错名字会导致那部分内容消失。
                </div>

                {backups.length > 0 && (
                  <div className="prompt-backups">
                    <div className="settings-field-label"><span>历史备份</span></div>
                    {backups.slice(0, 8).map(b => (
                      <div className="prompt-backup" key={b.file}>
                        <span className="num muted">{b.file}</span>
                        <button className="btn btn-quiet" onClick={() => restore(b.file)}>恢复这一版</button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
        </div>
      </div>
    </div>
  );
}
