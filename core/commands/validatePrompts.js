// lib/commands/validatePrompts.js — 校验提示词模板格式
//
// 遍历 prompts/*.md 模板文件，检查格式正确性和占位符完备性。
//
// 用法：
//   node cli.js validate-prompts               校验所有模板
//   node cli.js validate-prompts <template>     校验单个模板（如 suggest.md）
//
// ⚠️ 校验逻辑在 `core/prompts.validateAll()` 里，这里只负责**打印**。
// 此前这里自己实现了一份，而 prompts.js 另有一份"保存时该拦的最小检查" ——
// 两份必然漂移，用户会看到"保存时说没问题、校验时说有问题"。
// 界面上的「校验」按钮调的是同一份，所以三处口径永远一致。

const prompts = require('../prompts');
const logger = require('../runtime/logger');

/** 校验单个模板文件 */
function validateTemplate(filePath) {
  const name = path.basename(filePath);
  const issues = [];

  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { return [{ file: name, severity: 'error', message: `无法读取: ${e.message}` }]; }

  const hasSystem = raw.includes('=== SYSTEM ===');
  const hasUser = raw.includes('=== USER ===');

  if (!hasSystem && !hasUser) {
    // 无分隔符的模板：整体作为 user prompt
    if (raw.trim().length === 0) {
      issues.push({ file: name, severity: 'error', message: '模板为空' });
    }
  } else if (!hasSystem) {
    issues.push({ file: name, severity: 'warn', message: '缺少 === SYSTEM === 分隔符（将整体作为 user prompt）' });
  } else if (!hasUser) {
    issues.push({ file: name, severity: 'warn', message: '缺少 === USER === 分隔符' });
  }

  // 提取所有占位符
  const placeholders = extractPlaceholders(raw);
  if (placeholders.length === 0) {
    issues.push({ file: name, severity: 'info', message: '模板无占位符（可能是静态模板）' });
  }

  // 检查常见占位符拼写错误
  const knownPlaceholders = [
    'PERSONA_PROMPT', 'VIDEO_BLOCK', 'NOTE_BLOCK', 'IMAGE_HINT',
    'SCOPED_BLOCK', 'COMMENT_LIST_JSON', 'COMMENT_TEXT', 'COMMENT_TAGS',
    'USER_PROFILE', 'THREAD_CONTEXT', 'PERSONA_HINT', 'PERSONA_EXAMPLES',
    'PERSONA_NAME', 'COUNT_HINT', 'COUNT', 'STRATEGY', 'BATCH_COUNT',
    'STRATEGY_BLOCK',
  ];
  const unknown = placeholders.filter(p => !knownPlaceholders.includes(p));
  if (unknown.length > 0) {
    issues.push({ file: name, severity: 'info', message: `非标准占位符: ${unknown.join(', ')}` });
  }

  return issues.length > 0 ? issues : [{ file: name, severity: 'ok', message: '格式正确' }];
}

async function cmdValidatePrompts(ctx, args) {
  const targetFile = args[0] || null;
  const { templates, hasError, count } = prompts.validateAll(targetFile);

  if (count === 0) {
    logger.info('没有找到模板文件');
    return { templates: [], hasError: false };
  }

  const MARK = { error: '✗', warn: '⚠', ok: '✓', info: 'ℹ' };
  for (const issue of templates) {
    const line = `${MARK[issue.severity] || '·'} [${issue.file}] ${issue.message}`;
    // 保持既有输出约定：error 走 stderr，其余走 stdout
    if (issue.severity === 'error') console.error(line);
    else console.log(line);
  }
  logger.info(`\n共检查 ${count} 个模板`);
  return { templates, hasError };
}

module.exports = cmdValidatePrompts;
