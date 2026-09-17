// lib/commands/validatePrompts.js — 校验提示词模板格式
//
// 遍历 prompts/*.md 模板文件，检查格式正确性和占位符完备性。
//
// 用法：
//   node cli.js validate-prompts               校验所有模板
//   node cli.js validate-prompts <template>     校验单个模板（如 suggest.md）

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');

/** 提取模板中的所有占位符 */
function extractPlaceholders(text) {
  const matches = text.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(matches.map(m => m.replace(/^\{\{|\}\}$/g, '')))];
}

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

  let files;
  if (targetFile) {
    const fp = path.join(PROMPTS_DIR, targetFile);
    if (!fs.existsSync(fp)) throw new Error(`模板文件不存在: ${targetFile}`);
    files = [fp];
  } else {
    try {
      files = fs.readdirSync(PROMPTS_DIR)
        .filter(f => f.endsWith('.md') && !f.startsWith('partial-'))
        .map(f => path.join(PROMPTS_DIR, f));
    } catch (e) {
      throw new Error(`无法读取 prompts 目录: ${PROMPTS_DIR}`);
    }
  }

  if (files.length === 0) {
    console.error('没有找到模板文件');
    return [];
  }

  const allIssues = [];
  for (const fp of files) {
    const issues = validateTemplate(fp);
    allIssues.push(...issues);
  }

  // 输出结果
  let hasError = false;
  for (const issue of allIssues) {
    const prefix = issue.severity === 'error' ? '✗' : issue.severity === 'warn' ? '⚠' : issue.severity === 'ok' ? '✓' : 'ℹ';
    const stream = issue.severity === 'error' ? 'error' : 'log';
    console[stream](`${prefix} [${issue.file}] ${issue.message}`);
    if (issue.severity === 'error') hasError = true;
  }

  console.error(`\n共检查 ${new Set(allIssues.map(i => i.file)).size} 个模板`);
  return { templates: allIssues, hasError };
}

module.exports = cmdValidatePrompts;
