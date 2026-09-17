// lib/commands/dm.js — 抖音私信收发

const { escapeExpression, getFlag } = require('./helpers');
const { safeSerialize } = require('../shared/serialize');

/**
 * 私信命令
 * @param {object} ctx - { bridge, audit, loggedCall, bridgeCall }
 * @param {string[]} args
 *
 * 子命令:
 *   dm send <user_id> <text>        发送私信给指定用户
 *   dm listen [--timeout N]         长轮询收到的私信 (默认 30s)
 *   dm list                         获取最近收到的消息
 */
async function cmdDM(ctx, args) {
  const subcmd = args[0];

  if (!subcmd) {
    throw new Error('用法:\n'
      + '  node cli.js dm send <user_id> "消息内容"\n'
      + '  node cli.js dm listen [--timeout N]\n'
      + '  node cli.js dm list');
  }

  // ═══ dm send <user_id> <text> ═══
  if (subcmd === 'send') {
    const userId = args[1];
    const text = args[2] || args.slice(2).join(' ');

    if (!userId) throw new Error('用法: node cli.js dm send <user_id> <text>');
    if (!text) throw new Error('消息内容不能为空');

    ctx.audit.startOperation('dm.send', { user_id: userId, text });

    // Step 1: 创建/查找会话
    const convExpr = `window.__bridge.createConversation('${escapeExpression(userId)}')`;
    const conv = await ctx.loggedCall('dm.createConversation', { user_id: userId }, convExpr);

    if (!conv || !conv.conversation_id) {
      const err = new Error('无法创建私信会话: ' + JSON.stringify(safeSerialize(conv || {})));
      ctx.audit.endOperation('error', { user_id: userId }, null, err.message);
      throw err;
    }

    // 构造会话标识 (conversation_id|short_id|ticket)
    const convId = [conv.conversation_id, conv.conversation_short_id || '0', conv.ticket || ''].join('|');

    // Step 2: 发送消息
    const sendExpr = `window.__bridge.sendDM('${escapeExpression(convId)}', '${escapeExpression(text)}')`;
    const data = await ctx.loggedCall('dm.send',
      { conversation_id: conv.conversation_id, text },
      sendExpr);

    if (data.status_code !== undefined && data.status_code !== 0) {
      const err = new Error(`发送失败: status_code=${data.status_code}`);
      ctx.audit.endOperation('error', { conversation_id: conv.conversation_id }, null, err.message);
      throw err;
    }

    const result = {
      conversation_id: conv.conversation_id,
      text: text,
      status: 'sent',
      raw: data,
    };
    ctx.audit.endOperation('success', {
      user_id: userId,
      conversation_id: conv.conversation_id,
    }, { result });
    return result;
  }

  // ═══ dm listen [--timeout N] ═══
  if (subcmd === 'listen') {
    const timeout = getFlag(args, '--timeout', 30000);

    ctx.audit.startOperation('dm.listen', { timeout });

    const expr = `window.__bridge.pollDMs(${timeout})`;
    const data = await ctx.loggedCall('dm.listen', { timeout }, expr);

    const messages = data.messages || [];
    ctx.audit.endOperation('success', { count: messages.length }, { messages });

    if (messages.length === 0) {
      console.log('(超时，未收到新私信)');
      return [];
    }

    return messages;
  }

  // ═══ dm list ═══
  if (subcmd === 'list') {
    ctx.audit.startOperation('dm.list', {});

    const expr = 'window.__bridge.getDMs()';
    const data = await ctx.loggedCall('dm.list', {}, expr);

    const messages = Array.isArray(data) ? data : (data.messages || []);
    ctx.audit.endOperation('success', { count: messages.length }, { messages });

    if (messages.length === 0) {
      console.log('(消息队列为空，请先运行 dm listen)');
      return [];
    }

    return messages;
  }

  throw new Error(`未知子命令: dm ${subcmd}\n可用: send, listen, list`);
}

module.exports = cmdDM;
