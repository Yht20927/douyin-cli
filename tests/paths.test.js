// tests/paths.test.js — 运行时数据路径解析
//
// 不变量：
// 1. 默认 dataDir = 应用根目录 → CLI 行为与改造前完全一致（无需数据迁移）
// 2. setDataDir() / DOUYIN_DATA_DIR 能一次性重定向全部路径（桌面版打包后的关键能力）
// 3. 旧的 DOUYIN_STORAGE_DIR / DOUYIN_LOG_DIR 优先级仍高于 dataDir 派生值（历史兼容）
// 4. appRoot 始终指向代码所在位置，不受 dataDir 影响

const fs = require('fs');
const path = require('path');
const os = require('os');

const paths = require('../core/paths');

/** 恢复所有路径相关状态，避免测试间串味 */
function cleanup() {
  paths.setDataDir(null);
  delete process.env.DOUYIN_DATA_DIR;
  delete process.env.DOUYIN_STORAGE_DIR;
  delete process.env.DOUYIN_LOG_DIR;
  delete process.env.DOUYIN_CONFIG;
}

/** 在临时目录里跑，结束后恢复 */
function withCleanEnv(fn) {
  return () => {
    const orig = {
      DOUYIN_DATA_DIR: process.env.DOUYIN_DATA_DIR,
      DOUYIN_STORAGE_DIR: process.env.DOUYIN_STORAGE_DIR,
      DOUYIN_LOG_DIR: process.env.DOUYIN_LOG_DIR,
      DOUYIN_CONFIG: process.env.DOUYIN_CONFIG,
    };
    cleanup();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-paths-'));
    try {
      return fn(tmp);
    } finally {
      paths.setDataDir(null);
      for (const [k, v] of Object.entries(orig)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe('默认解析（CLI 行为不变）', () => {
  it('dataDir 缺省等于应用根目录', withCleanEnv(() => {
    expect(paths.dataDir()).toBe(paths.appRoot());
    expect(paths.describe().dataDirSource).toContain('默认');
  }));

  it('默认路径与改造前的布局一致', withCleanEnv(() => {
    const root = paths.appRoot();
    expect(paths.configFile()).toBe(path.join(root, 'config.json'));
    expect(paths.dbDir()).toBe(path.join(root, 'storage'));
    expect(paths.dbFile()).toBe(path.join(root, 'storage', 'douyin.db'));
    expect(paths.logsDir()).toBe(path.join(root, 'logs'));
    expect(paths.auditFile()).toBe(path.join(root, 'logs', 'audit.json'));
    expect(paths.resultsDir()).toBe(path.join(root, 'logs', 'results'));
  }));
});

describe('setDataDir() 重定向', () => {
  it('所有派生路径跟随 dataDir 移动', withCleanEnv((tmp) => {
    const target = path.join(tmp, 'data');
    paths.setDataDir(target);

    expect(paths.dataDir()).toBe(target);
    expect(paths.dbFile()).toBe(path.join(target, 'storage', 'douyin.db'));
    expect(paths.logsDir()).toBe(path.join(target, 'logs'));
    expect(paths.auditFile()).toBe(path.join(target, 'logs', 'audit.json'));
    expect(paths.configFile()).toBe(path.join(target, 'config.json'));
    expect(paths.describe().dataDirSource).toBe('setDataDir()');
  }));

  it('appRoot 不随 dataDir 改变', withCleanEnv((tmp) => {
    const root = paths.appRoot();
    paths.setDataDir(path.join(tmp, 'data'));
    expect(paths.appRoot()).toBe(root);
  }));

  it('传 null 可清除覆盖，回到默认', withCleanEnv((tmp) => {
    paths.setDataDir(path.join(tmp, 'data'));
    expect(paths.dataDir()).not.toBe(paths.appRoot());
    paths.setDataDir(null);
    expect(paths.dataDir()).toBe(paths.appRoot());
  }));

  it('相对路径被解析为绝对路径', withCleanEnv(() => {
    paths.setDataDir('some/relative/dir');
    expect(path.isAbsolute(paths.dataDir())).toBe(true);
  }));
});

describe('环境变量', () => {
  it('DOUYIN_DATA_DIR 重定向全部路径', withCleanEnv((tmp) => {
    const target = path.join(tmp, 'from-env');
    process.env.DOUYIN_DATA_DIR = target;
    expect(paths.dataDir()).toBe(target);
    expect(paths.dbFile()).toBe(path.join(target, 'storage', 'douyin.db'));
    expect(paths.describe().dataDirSource).toContain('DOUYIN_DATA_DIR');
  }));

  it('setDataDir 优先级高于 DOUYIN_DATA_DIR', withCleanEnv((tmp) => {
    process.env.DOUYIN_DATA_DIR = path.join(tmp, 'env-dir');
    paths.setDataDir(path.join(tmp, 'explicit-dir'));
    expect(paths.dataDir()).toBe(path.join(tmp, 'explicit-dir'));
  }));

  it('DOUYIN_STORAGE_DIR 只影响 DB 目录，且优先于 dataDir 派生', withCleanEnv((tmp) => {
    paths.setDataDir(path.join(tmp, 'data'));
    const forced = path.join(tmp, 'forced-storage');
    process.env.DOUYIN_STORAGE_DIR = forced;

    expect(paths.dbDir()).toBe(forced);
    // 其余路径仍跟随 dataDir
    expect(paths.logsDir()).toBe(path.join(tmp, 'data', 'logs'));
  }));

  it('DOUYIN_LOG_DIR 只影响日志目录，且优先于 dataDir 派生', withCleanEnv((tmp) => {
    paths.setDataDir(path.join(tmp, 'data'));
    const forced = path.join(tmp, 'forced-logs');
    process.env.DOUYIN_LOG_DIR = forced;

    expect(paths.logsDir()).toBe(forced);
    expect(paths.auditFile()).toBe(path.join(forced, 'audit.json'));
    expect(paths.resultsDir()).toBe(path.join(forced, 'results'));
    // DB 仍跟随 dataDir
    expect(paths.dbDir()).toBe(path.join(tmp, 'data', 'storage'));
  }));

  it('DOUYIN_CONFIG 覆盖配置文件位置', withCleanEnv((tmp) => {
    const forced = path.join(tmp, 'custom-config.json');
    process.env.DOUYIN_CONFIG = forced;
    expect(paths.configFile()).toBe(forced);
  }));
});

describe('promptsDir() 的两级查找', () => {
  it('dataDir 下有 prompts/ 时优先用它（用户可编辑覆盖）', withCleanEnv((tmp) => {
    const dataDir = path.join(tmp, 'data');
    paths.setDataDir(dataDir);
    fs.mkdirSync(path.join(dataDir, 'prompts'), { recursive: true });
    expect(paths.promptsDir()).toBe(path.join(dataDir, 'prompts'));
  }));

  it('dataDir 下没有 prompts/ 时回退到内置模板目录', withCleanEnv((tmp) => {
    paths.setDataDir(path.join(tmp, 'empty-data'));
    expect(paths.promptsDir()).toBe(path.join(paths.appRoot(), 'prompts'));
  }));

  it('内置模板目录确实存在（回退目标不能是空的）', () => {
    expect(fs.existsSync(path.join(paths.appRoot(), 'prompts'))).toBe(true);
  });
});

describe('工具函数', () => {
  it('ensureDir 递归创建并返回路径', withCleanEnv((tmp) => {
    const deep = path.join(tmp, 'a', 'b', 'c');
    expect(paths.ensureDir(deep)).toBe(deep);
    expect(fs.statSync(deep).isDirectory()).toBe(true);
  }));

  it('ensureDir 对已存在目录幂等', withCleanEnv((tmp) => {
    paths.ensureDir(tmp);
    expect(() => paths.ensureDir(tmp)).not.toThrow();
  }));

  it('isWritable 对可写目录返回 true', withCleanEnv((tmp) => {
    expect(paths.isWritable(path.join(tmp, 'writable'))).toBe(true);
  }));

  it('isWritable 对不可写目录返回 false（不抛错）', withCleanEnv((tmp) => {
    // 造一个只读目录
    const ro = path.join(tmp, 'readonly');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o500);
    try {
      // root 用户无视权限位，跳过该断言
      if (process.getuid && process.getuid() === 0) return;
      expect(paths.isWritable(ro)).toBe(false);
    } finally {
      fs.chmodSync(ro, 0o700);
    }
  }));

  it('isWritable 不会留下探测文件', withCleanEnv((tmp) => {
    const dir = path.join(tmp, 'probe-target');
    paths.isWritable(dir);
    const left = fs.readdirSync(dir).filter(f => f.startsWith('.write-probe-'));
    expect(left).toEqual([]);
  }));

  it('describe() 返回可序列化的诊断快照', withCleanEnv((tmp) => {
    paths.setDataDir(path.join(tmp, 'data'));
    const d = paths.describe();
    for (const key of ['appRoot', 'dataDir', 'configFile', 'dbFile', 'logsDir', 'resultsDir', 'promptsDir', 'dataDirSource']) {
      expect(typeof d[key]).toBe('string');
      expect(d[key].length).toBeGreaterThan(0);
    }
    expect(() => JSON.stringify(d)).not.toThrow();
  }));
});

describe('路径被真正使用（集成）', () => {
  it('重定向后 db.js 落在新目录', withCleanEnv((tmp) => {
    const target = path.join(tmp, 'moved');
    paths.setDataDir(target);
    // 清掉 db 模块缓存，让它按新路径重新解析
    delete require.cache[require.resolve('../core/memory/db')];
    const db = require('../core/memory/db');
    expect(db.getDbPath()).toBe(path.join(target, 'storage', 'douyin.db'));
    delete require.cache[require.resolve('../core/memory/db')];
  }));
});
