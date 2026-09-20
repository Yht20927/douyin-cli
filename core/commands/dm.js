// lib/commands/dm.js — 抖音私信收发

const { escapeExpression, getFlag, throttleOpts } = require('./helpers');
const { safeSerialize } = require('../shared/serialize');
const riskControl = require('../risk-control');
const policy = require('../policy').getPolicy();
const logger = require('../runtime/logger');

/**
 * 判断 sendDM 的响应到底成没成。
 *
 * IM 接口不是 HTTP 那套 JSON：回的是 protobuf（proto/dm.proto 的 Response），
 * 失败信息只有 `error_desc`（字段 3，成功时是空串），**没有 status_code**。
 * 所以必须专门判一次 —— 不然一次被风控挡下的发送在界面上长得和成功一样。
 *
 * @returns {string|null} null = 判不出失败；字符串 = 给用户看的失败原因
 */
function describeSendResponse(data) {
  if (!data || typeof data !== 'object') return '抖音没有返回响应内容';
  const code = data.status_code != null ? data.status_code : data.code;
  if (code != null && Number(code) !== 0) {
    return `status_code=${code}${data.error_desc ? `（${data.error_desc}）` : ''}`;
  }
  if (data.error_desc) return String(data.error_desc);
  return null;
}

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

    // 发私信是**写操作**，走与 post / like / delete-comment 同一套闸门。
    //
    // 此前这里什么闸门都没有：dm 不在 policy 的 WRITE_COMMANDS 里，
    // 命令内部也没调 assertWritable / enforceDelay —— 也就是说私信可以
    // 以任意速度连发，而这是这个工具唯一一件"用它就是为了不触发风控"的事。
    // 接进界面之前必须先补上：界面上点一下就发，比命令行更容易连点。
    await policy.assertWritable({}, {
      signal: ctx.signal,
      onWait: ({ waitMs, reason }) => logger.info(`[dm.send] ${reason}，等待 ${Math.ceil(waitMs / 1000)}s…`),
    });
    await riskControl.enforceDelay('write', throttleOpts(ctx, args));

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

    // ⚠️ IM 接口回的是 protobuf（proto/dm.proto 的 Response），**没有 status_code**：
    // 失败信息只出现在 error_desc（字段 3），成功时是空串。
    // 这里曾经沿用其它命令那句 `data.status_code !== 0` —— 那个键在解码结果里
    // 根本不存在，条件恒为假，于是每一次发送失败都被报成"已发出"。
    const sendError = describeSendResponse(data);
    if (sendError) {
      const err = new Error(`私信没发出去：${sendError}`);
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
      logger.output('(超时，未收到新私信)');
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
      logger.output('(消息队列为空，请先运行 dm listen)');
      return [];
    }

    return messages;
  }

  throw new Error(`未知子命令: dm ${subcmd}\n可用: send, listen, list`);
}

module.exports = cmdDM;
