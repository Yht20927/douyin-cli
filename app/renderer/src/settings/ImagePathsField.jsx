import React, { useEffect, useState } from 'react';
import { fileNameOf, formatBytes } from '../format.js';

export default function ImagePathsField({ value, onChange }) {
  const paths = Array.isArray(value) ? value : [];
  /** path → 预检结果 */
  const [checks, setChecks] = useState({});
  const [manual, setManual] = useState('');

  // 路径列表变化就重查。用 join 做依赖：数组每次渲染都是新引用，
  // 直接依赖它会导致每次渲染都发一轮 IPC。
  const key = paths.join('\n');
  useEffect(() => {
    let alive = true;
    const list = key ? key.split('\n') : [];
    if (!list.length) { setChecks({}); return undefined; }

    Promise.all(list.map(p => window.dy.reply.checkImage(p).then(r => [p, r && r.ok ? r.data : { ok: false, reason: (r && r.error) || '检查失败' }])))
      .then((pairs) => { if (alive) setChecks(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [key]);

  async function pick() {
    const r = await window.dy.pickImages();
    if (!r || !r.ok || !r.paths || !r.paths.length) return;
    // 去重：同一个文件重复加进去没有意义，还会让"洗牌不重复"提前用尽
    const next = [...paths];
    for (const p of r.paths) if (!next.includes(p)) next.push(p);
    onChange(next);
  }

  function addManual() {
    const p = manual.trim();
    if (!p || paths.includes(p)) { setManual(''); return; }
    onChange([...paths, p]);
    setManual('');
  }

  const usable = Object.values(checks).filter(c => c.ok).length;

  return (
    <div className="image-paths">
      {paths.length === 0 && (
        <div className="settings-error">
          没有配置任何图片，这个开关目前不会生效。加一张，或把上面的开关关掉。
        </div>
      )}

      {paths.map((p, i) => {
        const c = checks[p];
        return (
          <div className="image-path" key={p}>
            <div className="image-path-main">
              <div className="image-path-name">{fileNameOf(p)}</div>
              <div className="image-path-full muted" title={p}>{p}</div>
              {c && (c.ok
                ? (
                  <div className="muted num image-path-meta">
                    {c.format} · {formatBytes(c.size)}
                    {c.large && ' · 偏大，上传会慢一些'}
                  </div>
                )
                : <div className="settings-error">{c.reason}</div>)}
            </div>
            <button
              className="btn btn-quiet"
              onClick={() => onChange(paths.filter((_, j) => j !== i))}
            >
              移除
            </button>
          </div>
        );
      })}

      <div className="settings-inline">
        <button className="btn" onClick={pick}>选择图片…</button>
        <input
          className="input settings-wide"
          type="text"
          placeholder="或直接粘贴路径后回车"
          value={manual}
          onChange={e => setManual(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
        />
      </div>

      {paths.length > 0 && (
        <div className="muted num settings-hint">
          共 {paths.length} 张 · 可用 {usable} 张
        </div>
      )}
    </div>
  );
}
