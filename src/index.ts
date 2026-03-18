/**
 * 企业微信日程机器人 - Cloudflare Workers 版
 *
 * 功能：
 * 1. 接收企业微信消息（文字/图片/混合）
 * 2. AI 解析日程信息（Gemini Vision）
 * 3. 确认交互后保存到 D1 数据库
 * 4. 支持查询、修改、删除日程
 * 5. 会话状态存储在 KV（30分钟有效）
 */

import { TEAM_MEMBERS, EVENT_TYPES, getMemberNameByWeComId } from "./scheduleConst";

// ==================== 类型定义 ====================

export interface Env {
  // KV 命名空间（会话状态）
  SESSION_KV: KVNamespace;
  // D1 数据库
  DB: D1Database;
  // 企业微信配置（通过 wrangler secret 设置）
  WECOM_TOKEN: string;
  WECOM_ENCODING_AES_KEY: string;
  WECOM_CORP_ID: string;
  WECOM_CORP_SECRET: string;
  WECOM_AGENT_ID: string;
  // Gemini API
  GEMINI_API_KEY: string;
}

interface PendingSchedule {
  title: string;
  eventType: string;
  participants: string[];
  projectName: string;
  startDate: string;
  startTimeStr: string;
  endDate: string;
  endTimeStr: string;
  location: string;
  contactName: string;
  contactTitle: string;
  contactOrg: string;
  notes: string;
  _updateId?: number;
}

interface ParsedSchedule extends PendingSchedule {
  action: "create" | "update" | "delete" | "none";
}

type ConversationState =
  | { phase: "idle" }
  | { phase: "awaiting_confirm"; pending: PendingSchedule; originalText: string }
  | { phase: "done"; lastEventId: number; lastEventTitle: string }
  | { phase: "awaiting_batch_confirm"; items: PendingSchedule[]; originalText: string };

interface ConversationContext {
  state: ConversationState;
  lastMessageTime: number;
  history: Array<{ role: string; content: string }>;
}

// 图片缓冲区（存在KV中，key: img_buf:{userId}）
interface ImageBuffer {
  imageUrls: string[];  // base64 data URLs
  textParts: string[];
  firstMsgTime: number;
  senderName?: string;
}

// ==================== 加解密工具 ====================

async function sha1(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifySignature(token: string, timestamp: string, nonce: string, echostr?: string): Promise<string> {
  const arr = [token, timestamp, nonce];
  if (echostr) arr.push(echostr);
  arr.sort();
  return sha1(arr.join(""));
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decryptMessage(encodingAESKey: string, encryptedMsg: string): Promise<string> {
  try {
    const aesKeyBytes = base64ToUint8Array(encodingAESKey + "=");
    const iv = aesKeyBytes.slice(0, 16);
    const encryptedBytes = base64ToUint8Array(encryptedMsg);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      aesKeyBytes,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      encryptedBytes
    );

    const decryptedBytes = new Uint8Array(decryptedBuffer);
    // PKCS7 unpadding
    const padLen = decryptedBytes[decryptedBytes.length - 1];
    const unpadded = decryptedBytes.slice(0, decryptedBytes.length - padLen);

    if (unpadded.length < 20) return "";

    const msgLen = new DataView(unpadded.buffer).getUint32(16, false);
    const msgBytes = unpadded.slice(20, 20 + msgLen);
    return new TextDecoder("utf-8").decode(msgBytes);
  } catch (e) {
    console.error("[WeCom] Decrypt failed:", e);
    return "";
  }
}

// ==================== XML 解析（轻量版）====================

function parseXmlField(xml: string, field: string): string {
  // 支持 CDATA 和普通文本
  const cdataMatch = xml.match(new RegExp(`<${field}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${field}>`));
  if (cdataMatch) return cdataMatch[1];
  const plainMatch = xml.match(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`));
  return plainMatch ? plainMatch[1] : "";
}

// ==================== 时区工具 ====================

function cstToUtcMs(dateStr: string, timeStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

function formatCSTTime(timestamp: number, format: "date" | "time" | "datetime"): string {
  const cstOffset = 8 * 60 * 60 * 1000;
  const cstDate = new Date(timestamp + cstOffset);
  const month = cstDate.getUTCMonth() + 1;
  const day = cstDate.getUTCDate();
  const weekDayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const weekDay = weekDayNames[cstDate.getUTCDay()];
  const hour = cstDate.getUTCHours().toString().padStart(2, "0");
  const minute = cstDate.getUTCMinutes().toString().padStart(2, "0");
  if (format === "date") return `${month}月${day}日（${weekDay}）`;
  if (format === "time") return `${hour}:${minute}`;
  return `${month}月${day}日（${weekDay}）${hour}:${minute}`;
}

// ==================== 企业微信消息回复 ====================

async function sendWeComReply(env: Env, toUser: string, content: string): Promise<void> {
  const { WECOM_CORP_ID: corpId, WECOM_CORP_SECRET: corpSecret, WECOM_AGENT_ID: agentId } = env;
  if (!corpId || !corpSecret || !agentId) return;

  try {
    const tokenResp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`
    );
    const tokenData = await tokenResp.json() as { access_token?: string };
    if (!tokenData.access_token) return;

    await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenData.access_token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: toUser,
          msgtype: "text",
          agentid: parseInt(agentId),
          text: { content },
          safe: 0,
        }),
      }
    );
  } catch (e) {
    console.error("[WeCom] Error sending reply:", e);
  }
}

// ==================== 图片下载（企业微信 MediaId → base64）====================

async function downloadWeComImage(env: Env, mediaId: string): Promise<string | null> {
  const { WECOM_CORP_ID: corpId, WECOM_CORP_SECRET: corpSecret } = env;
  if (!corpId || !corpSecret || !mediaId) return null;

  try {
    const tokenResp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`
    );
    const tokenData = await tokenResp.json() as { access_token?: string };
    if (!tokenData.access_token) return null;

    const mediaResp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${tokenData.access_token}&media_id=${mediaId}`
    );
    if (!mediaResp.ok) return null;

    const contentType = mediaResp.headers.get("content-type") || "image/jpeg";
    if (contentType.includes("application/json")) return null;

    const arrayBuffer = await mediaResp.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const mimeType = contentType.split(";")[0].trim();
    return `data:${mimeType};base64,${base64}`;
  } catch (e) {
    console.error("[WeCom] Error downloading image:", e);
    return null;
  }
}

// ==================== KV 会话管理 ====================

const CONTEXT_EXPIRE_SECONDS = 30 * 60; // 30分钟
const IMAGE_BUFFER_EXPIRE_SECONDS = 30;  // 30秒

async function getContext(kv: KVNamespace, userId: string): Promise<ConversationContext | null> {
  const raw = await kv.get(`ctx:${userId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConversationContext;
  } catch {
    return null;
  }
}

async function saveContext(kv: KVNamespace, userId: string, ctx: ConversationContext): Promise<void> {
  await kv.put(`ctx:${userId}`, JSON.stringify(ctx), { expirationTtl: CONTEXT_EXPIRE_SECONDS });
}

async function getOrCreateContext(kv: KVNamespace, userId: string): Promise<ConversationContext> {
  const existing = await getContext(kv, userId);
  if (existing) return existing;
  return { state: { phase: "idle" }, lastMessageTime: Date.now(), history: [] };
}

async function getImageBuffer(kv: KVNamespace, userId: string): Promise<ImageBuffer | null> {
  const raw = await kv.get(`img_buf:${userId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ImageBuffer;
  } catch {
    return null;
  }
}

async function saveImageBuffer(kv: KVNamespace, userId: string, buf: ImageBuffer): Promise<void> {
  await kv.put(`img_buf:${userId}`, JSON.stringify(buf), { expirationTtl: IMAGE_BUFFER_EXPIRE_SECONDS });
}

async function clearImageBuffer(kv: KVNamespace, userId: string): Promise<void> {
  await kv.delete(`img_buf:${userId}`);
}

// ==================== D1 数据库操作 ====================

interface DbEvent {
  id: number;
  title: string;
  eventType: string;
  participants: string;
  projectName: string | null;
  startTime: number;
  endTime: number;
  location: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactOrg: string | null;
  notes: string | null;
  source: string;
  rawMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

async function dbCreateEvent(db: D1Database, data: {
  title: string;
  eventType: string;
  participants: string;
  projectName?: string;
  startTime: number;
  endTime: number;
  location?: string;
  contactName?: string;
  contactTitle?: string;
  contactOrg?: string;
  notes?: string;
  source?: string;
  rawMessage?: string;
}): Promise<DbEvent | null> {
  const now = Date.now();
  const result = await db.prepare(`
    INSERT INTO events (title, eventType, participants, projectName, startTime, endTime,
      location, contactName, contactTitle, contactOrg, notes, source, rawMessage, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    data.title, data.eventType, data.participants, data.projectName || "",
    data.startTime, data.endTime, data.location || "", data.contactName || "",
    data.contactTitle || "", data.contactOrg || "", data.notes || null,
    data.source || "wecom", data.rawMessage || null, now, now
  ).run();

  if (!result.meta.last_row_id) return null;
  return dbGetEventById(db, result.meta.last_row_id as number);
}

async function dbGetEventById(db: D1Database, id: number): Promise<DbEvent | null> {
  const result = await db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<DbEvent>();
  return result || null;
}

async function dbGetEvents(db: D1Database, params: {
  startTime?: number;
  endTime?: number;
  limit?: number;
}): Promise<DbEvent[]> {
  let sql = "SELECT * FROM events WHERE 1=1";
  const bindings: unknown[] = [];
  if (params.startTime !== undefined) { sql += " AND startTime >= ?"; bindings.push(params.startTime); }
  if (params.endTime !== undefined) { sql += " AND startTime <= ?"; bindings.push(params.endTime); }
  sql += " ORDER BY startTime ASC";
  if (params.limit !== undefined) { sql += " LIMIT ?"; bindings.push(params.limit); }

  const result = await db.prepare(sql).bind(...bindings).all<DbEvent>();
  return result.results || [];
}

async function dbUpdateEvent(db: D1Database, id: number, data: Partial<{
  title: string; eventType: string; participants: string; projectName: string;
  startTime: number; endTime: number; location: string; contactName: string;
  contactTitle: string; contactOrg: string; notes: string;
}>): Promise<DbEvent | null> {
  const fields = Object.keys(data);
  if (fields.length === 0) return dbGetEventById(db, id);
  const sets = fields.map(f => `${f} = ?`).join(", ");
  const values = fields.map(f => (data as Record<string, unknown>)[f]);
  await db.prepare(`UPDATE events SET ${sets}, updatedAt = ? WHERE id = ?`)
    .bind(...values, Date.now(), id).run();
  return dbGetEventById(db, id);
}

async function dbDeleteEvent(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
  return (result.meta.changes || 0) > 0;
}

// ==================== AI 解析日程 ====================

function buildSystemPrompt(senderName?: string): string {
  const cstOffset = 8 * 60 * 60 * 1000;
  const cstNow = new Date(Date.now() + cstOffset);
  const todayStr = cstNow.toISOString().split("T")[0];
  const weekDayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const todayWeekDay = weekDayNames[cstNow.getUTCDay()];
  const senderContext = senderName
    ? `\n发消息的人是团队成员「${senderName}」。如果消息中没有明确指定参与人，请自动将「${senderName}」加入参与人列表。`
    : "";

  return `你是一个日程信息提取助手，专门从自然语言或截图中提取日程安排信息。
当前日期：${todayStr}（${todayWeekDay}），时区为中国标准时间 UTC+8。
${senderContext}

【时间推断规则】
- 中国习惯中，一周从周一开始，周日是本周最后一天。
- "本周" = 本周一到本周日；"下周" = 下周一到下周日
- 说"周X"时：如果该天尚未到来取本周，已过去取下周
- 说"下周X"时：明确取下周对应日期
- 说"明天""后天"等相对日期，以当前日期为基准计算
- 如果只有日期没有时间，默认为当天 09:00
- 如果没有结束时间，默认开始时间+1小时

【机构名称识别规则】
- 一级市场投资机构（含"创投/资本/基金/投资/VC/PE/Partners/Capital/Ventures"等词，或已知机构名如"红杉/高榕/IDG/真格/经纬/GGV/源码/北极光/启明/DCM/软银/顺为/险峰/梅花/明势/云九/光速/蓝驰/创新工场"等）应识别为对方机构，而不是地点。
- 遇到机构名称时：将"与[机构名]会面/交流/见面"作为标题，eventType 设为"见投资人"，location 留空（除非有明确物理地点）。

【聊天记录截图识别规则】
- 如果截图是一段聊天记录，需要从对话流中找到最终确认的时间和地点，而不是最早提到的时间。
- 聊天标题栏通常显示"姓名 @ 机构名"格式，例如"徐涵 @ 蓝驰" → contactName="徐涵"，contactOrg="蓝驰创投"
- 时间可能是通过对话协商得出的，例如：对方说"10:00-13:30在那儿有会"，我方说"那就2点30"，对方说"好啊" → 最终确认时间是14:30
- 判断"最终确认"的标志：双方都表示同意的最后一个时间/地点方案
- 如果对话中有多个时间被提到，取最后一个双方都同意的时间

【参与人推断规则】
- 参与人是我方团队成员（${TEAM_MEMBERS.join("、")}），不是对方机构的人
- 截图中的聊天对象（标题栏显示的姓名）是对方联系人，不是参与人！
- 如果发消息的人是团队成员，自动将其加入参与人列表
- 如果无法确定参与人，返回空数组（不要猜测）

【多信息来源处理规则】
- 如果同时有截图和文字说明，文字说明优先级高于截图中的信息
- 截图提供原始约定信息（时间、地点、对方），文字说明提供补充信息（参与人、项目名等）

【操作类型判断】
- 新日程 → action = "create"
- "改时间"/"换个时间"/"改成X点"/"推迟到X"/"提前到X" → action = "update"
- "取消"/"删掉"/"不要了" → action = "delete"
- 与日程无关 → action = "none"

团队成员：${TEAM_MEMBERS.join("、")}
事件类型：${EVENT_TYPES.join("、")}

请从用户提供的内容中提取日程信息，以JSON格式返回（不要包含markdown代码块）：
{
  "action": "create" | "update" | "delete" | "none",
  "title": "日程标题",
  "eventType": "事件类型（必须是上面列表之一）",
  "participants": ["参与人数组"],
  "projectName": "项目名称（没有则为空字符串）",
  "startDate": "YYYY-MM-DD",
  "startTimeStr": "HH:MM",
  "endDate": "YYYY-MM-DD",
  "endTimeStr": "HH:MM",
  "location": "物理地点（没有则为空字符串）",
  "contactName": "对方联系人姓名（没有则为空字符串）",
  "contactTitle": "对方联系人职位（没有则为空字符串）",
  "contactOrg": "对方机构名称（没有则为空字符串）",
  "notes": "备注（没有则为空字符串）"
}

如果无法提取有效日程信息，返回 {"action": "none"}。`;
}

async function callGemini(env: Env, messages: Array<{ role: string; content: string | unknown[] }>): Promise<string | null> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[AI] GEMINI_API_KEY not set");
    return null;
  }

  // 转换消息格式为 Gemini API 格式
  const contents: Array<{ role: string; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }> = [];
  let systemInstruction: string | undefined;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = typeof msg.content === "string" ? msg.content : "";
      continue;
    }

    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type: string; text?: string; image_url?: { url: string } }>) {
        if (part.type === "text" && part.text) {
          parts.push({ text: part.text });
        } else if (part.type === "image_url" && part.image_url?.url) {
          const url = part.image_url.url;
          if (url.startsWith("data:")) {
            // base64 data URL
            const [header, data] = url.split(",");
            const mimeType = header.replace("data:", "").replace(";base64", "");
            parts.push({ inline_data: { mime_type: mimeType, data } });
          }
        }
      }
    }

    if (parts.length > 0) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }
  }

  const requestBody: Record<string, unknown> = { contents };
  if (systemInstruction) {
    requestBody.system_instruction = { parts: [{ text: systemInstruction }] };
  }
  requestBody.generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 1024,
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[AI] Gemini API error:", resp.status, errText.slice(0, 200));
      return null;
    }

    const data = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    console.error("[AI] Gemini call failed:", e);
    return null;
  }
}

async function parseScheduleFromMessage(
  env: Env,
  text: string,
  imageUrls: string[],
  history: Array<{ role: string; content: string }>,
  senderName?: string,
): Promise<ParsedSchedule | null> {
  const systemPrompt = buildSystemPrompt(senderName);
  const messages: Array<{ role: string; content: string | unknown[] }> = [
    { role: "system", content: systemPrompt },
    ...history.slice(-6),
  ];

  if (imageUrls.length > 0) {
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    const textDesc = text && text !== "（图片消息）"
      ? `请从以下截图和文字说明中提取日程信息。\n\n文字说明：${text}`
      : `请从以下截图中提取日程信息：`;
    parts.push({ type: "text", text: textDesc });
    for (const url of imageUrls) {
      parts.push({ type: "image_url", image_url: { url } });
    }
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: `请从以下消息中提取日程信息：\n${text}` });
  }

  const rawContent = await callGemini(env, messages);
  if (!rawContent) return null;

  try {
    const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/) || rawContent.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : rawContent.trim();
    const parsed = JSON.parse(jsonStr);
    return parsed.result !== undefined ? parsed.result : parsed;
  } catch (e) {
    console.error("[AI] Failed to parse JSON:", e, rawContent.slice(0, 200));
    return null;
  }
}

// ==================== 意图检测 ====================

function detectUserIntent(text: string): "confirm" | "reject" | "unknown" {
  const confirmWords = ["对", "确认", "好的", "好", "是", "没错", "正确", "ok", "OK", "Ok", "是的", "对的", "就这样", "保存", "确定"];
  const rejectWords = ["不对", "不是", "错了", "改一下", "重新", "不", "否", "取消", "算了", "不要", "不用了"];
  const trimmed = text.trim();
  if (confirmWords.some(w => trimmed === w || trimmed.startsWith(w))) return "confirm";
  if (rejectWords.some(w => trimmed === w || trimmed.startsWith(w))) return "reject";
  return "unknown";
}

interface QueryIntent {
  type: "query_schedule";
  member?: string;
  timeRange: "today" | "this_week" | "next_week" | "this_month";
}

function detectQueryIntent(text: string): QueryIntent | null {
  const t = text.trim();
  const queryKeywords = ["安排", "日程", "有哪些", "有什么", "查一下", "发一下", "说一下", "看看", "列一下", "排期", "行程"];
  if (!queryKeywords.some(kw => t.includes(kw))) return null;

  let timeRange: QueryIntent["timeRange"] = "this_week";
  if (t.includes("今天") || t.includes("今日")) timeRange = "today";
  else if (t.includes("下周") || t.includes("下一周")) timeRange = "next_week";
  else if (t.includes("本月") || t.includes("这个月")) timeRange = "this_month";

  const member = TEAM_MEMBERS.find(m => t.includes(m));
  return { type: "query_schedule", member, timeRange };
}

function detectFieldPatch(text: string, current: PendingSchedule): Partial<PendingSchedule> | null {
  const t = text.trim();

  // 参与人：支持"改一下，参与人仪征" / "参与人改成翔哥" 等格式
  const participantMatch = t.match(/(?:^|[，,、\s]+)(?:参与人|参与者)(?:改成|改为|是|加上|补充|：|:|还有|为)?\s*(.+)$/);
  if (participantMatch) {
    const raw = participantMatch[1].trim();
    const names = raw.split(/[和、,，+＆&以及]+/).map(n => n.trim()).filter(Boolean);
    const matched = names.filter(n => TEAM_MEMBERS.some(m => m.includes(n) || n.includes(m)));
    if (matched.length > 0) {
      const isAppend = /加上|还有|另外/.test(t);
      const newParticipants = isAppend
        ? Array.from(new Set([...current.participants, ...matched]))
        : matched;
      return { participants: newParticipants };
    }
  }

  // 地点
  const locationMatch = t.match(/(?:^|[，,、\s]+)(?:地点|地址|地方)(?:改成|改为|是|：|:)?\s*(.+)$/);
  if (locationMatch) return { location: locationMatch[1].trim() };

  // 类型
  const typeMatch = t.match(/(?:^|[，,、\s]+)(?:类型|事件类型|类别)(?:改成|改为|是|：|:)?\s*(.+)$/);
  if (typeMatch) {
    const rawType = typeMatch[1].trim();
    const matched = EVENT_TYPES.find(et => et.includes(rawType) || rawType.includes(et));
    if (matched) return { eventType: matched };
  }

  // 项目
  const projectMatch = t.match(/(?:^|[，,、\s]+)(?:项目名|项目)(?:改成|改为|是|：|:)?\s*(.+)$/);
  if (projectMatch) return { projectName: projectMatch[1].trim() };

  // 备注
  const notesMatch = t.match(/(?:^|[，,、\s]+)(?:备注|说明|补充说明)(?:改成|改为|是|：|:|加上)?\s*(.+)$/);
  if (notesMatch) return { notes: notesMatch[1].trim() };

  // 对方机构
  const orgMatch = t.match(/(?:^|[，,、\s]+)(?:对方机构|机构|公司)(?:改成|改为|是|：|:)?\s*(.+)$/);
  if (orgMatch) return { contactOrg: orgMatch[1].trim() };

  // 对方联系人
  const contactMatch = t.match(/(?:^|[，,、\s]+)(?:对方|联系人|对方联系人)(?:改成|改为|是|：|:)?\s*(.+)$/);
  if (contactMatch) return { contactName: contactMatch[1].trim() };

  // 纯名字匹配
  const names = t.split(/[和、,，+＆&以及]+/).map(n => n.trim()).filter(Boolean);
  const allMatched = names.every(n => TEAM_MEMBERS.some(m => m.includes(n) || n.includes(m)));
  if (allMatched && names.length > 0) {
    const matched = names.filter(n => TEAM_MEMBERS.some(m => m.includes(n) || n.includes(m)));
    return { participants: matched };
  }

  return null;
}

// ==================== 格式化消息 ====================

function buildConfirmMessage(p: PendingSchedule, suffix?: string): string {
  const startTime = cstToUtcMs(p.startDate, p.startTimeStr);
  const endTime = cstToUtcMs(p.endDate, p.endTimeStr);
  const dateStr = formatCSTTime(startTime, "date");
  const startStr = formatCSTTime(startTime, "time");
  const endStr = formatCSTTime(endTime, "time");
  const participantsStr = p.participants.length > 0 ? p.participants.join("、") : "（未指定）";
  const locationStr = p.location ? `\n地点：${p.location}` : "";
  const projectStr = p.projectName ? `\n项目：${p.projectName}` : "";
  const contactOrgStr = p.contactOrg ? `\n对方机构：${p.contactOrg}` : "";
  const contactPersonStr = p.contactName
    ? `\n对方联系人：${p.contactName}${p.contactTitle ? `（${p.contactTitle}）` : ""}`
    : "";
  const notesStr = p.notes ? `\n备注：${p.notes}` : "";
  const suffixStr = suffix ? `\n\n${suffix}` : "";

  return `📋 我理解的日程如下，请确认：

标题：${p.title}
类型：${p.eventType}
时间：${dateStr} ${startStr}–${endStr}
参与人：${participantsStr}${projectStr}${locationStr}${contactOrgStr}${contactPersonStr}${notesStr}${suffixStr}

回复"对"或"确认"保存，回复"不对"或"改一下"重新描述。`;
}

function getQueryTimeRange(timeRange: QueryIntent["timeRange"]): { start: number; end: number; label: string } {
  const cstOffset = 8 * 60 * 60 * 1000;
  const nowCst = new Date(Date.now() + cstOffset);
  const todayStart = Date.UTC(nowCst.getUTCFullYear(), nowCst.getUTCMonth(), nowCst.getUTCDate(), -8, 0, 0, 0);
  const weekDay = nowCst.getUTCDay();
  const mondayOffset = weekDay === 0 ? -6 : 1 - weekDay;

  if (timeRange === "today") {
    return { start: todayStart, end: todayStart + 86400000 - 1, label: `今天（${nowCst.getUTCMonth()+1}月${nowCst.getUTCDate()}日）` };
  }
  if (timeRange === "this_week") {
    const start = todayStart + mondayOffset * 86400000;
    const end = start + 7 * 86400000 - 1;
    const s = new Date(start + cstOffset); const e = new Date(end + cstOffset);
    return { start, end, label: `本周（${s.getUTCMonth()+1}月${s.getUTCDate()}日–${e.getUTCMonth()+1}月${e.getUTCDate()}日）` };
  }
  if (timeRange === "next_week") {
    const start = todayStart + (mondayOffset + 7) * 86400000;
    const end = start + 7 * 86400000 - 1;
    const s = new Date(start + cstOffset); const e = new Date(end + cstOffset);
    return { start, end, label: `下周（${s.getUTCMonth()+1}月${s.getUTCDate()}日–${e.getUTCMonth()+1}月${e.getUTCDate()}日）` };
  }
  // this_month
  const monthStart = Date.UTC(nowCst.getUTCFullYear(), nowCst.getUTCMonth(), 1, -8, 0, 0, 0);
  const monthEnd = Date.UTC(nowCst.getUTCFullYear(), nowCst.getUTCMonth() + 1, 1, -8, 0, 0, 0) - 1;
  return { start: monthStart, end: monthEnd, label: `本月（${nowCst.getUTCMonth()+1}月）` };
}

function formatScheduleList(events: DbEvent[], rangeLabel: string, memberFilter?: string): string {
  const eventsWithParticipants = events.map(e => ({
    ...e,
    participantList: e.participants ? e.participants.split(",").filter(Boolean) : [],
  }));

  const filtered = memberFilter
    ? eventsWithParticipants.filter(e => e.participantList.includes(memberFilter))
    : eventsWithParticipants;

  if (filtered.length === 0) {
    return `📅 ${rangeLabel}没有${memberFilter || "全员"}的日程安排。`;
  }

  const who = memberFilter || "全员";
  const lines: string[] = [`📅 ${rangeLabel}${who}日程（${filtered.length}条）\n`];
  const weekDayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  const byDay = new Map<string, typeof filtered>();
  for (const ev of filtered) {
    const cstOffset = 8 * 60 * 60 * 1000;
    const d = new Date(ev.startTime + cstOffset);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(ev);
  }

  for (const [dateKey, dayEvents] of Array.from(byDay.entries())) {
    const [y, mo, d] = dateKey.split("-").map(Number);
    const weekDay = weekDayNames[new Date(Date.UTC(y, mo-1, d)).getUTCDay()];
    lines.push(`▶ ${mo}月${d}日（${weekDay}）`);
    for (const ev of dayEvents) {
      const startStr = formatCSTTime(ev.startTime, "time");
      const endStr = formatCSTTime(ev.endTime, "time");
      const contactStr = ev.contactOrg ? ` （${ev.contactOrg}${ev.contactName ? "·" + ev.contactName : ""}）` : (ev.contactName ? ` （${ev.contactName}）` : "");
      const locationStr = ev.location ? ` @ ${ev.location}` : "";
      lines.push(`  ${startStr}–${endStr} ${ev.title}${contactStr}${locationStr}`);
      if (ev.participantList.length > 0) lines.push(`  参与：${ev.participantList.join("、")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ==================== 核心消息处理 ====================

async function handleCombinedMessage(
  env: Env,
  fromUser: string,
  combinedText: string,
  imageUrls: string[],
  senderName?: string,
): Promise<void> {
  const kv = env.SESSION_KV;
  const db = env.DB;
  const convCtx = await getOrCreateContext(kv, fromUser);
  const state = convCtx.state;

  // 查询意图（任何状态下都优先处理）
  const queryIntent = detectQueryIntent(combinedText);
  if (queryIntent) {
    const { start, end, label } = getQueryTimeRange(queryIntent.timeRange);
    const events = await dbGetEvents(db, { startTime: start, endTime: end, limit: 200 });
    const reply = formatScheduleList(events, label, queryIntent.member);
    await sendWeComReply(env, fromUser, reply);
    return;
  }

  // ==================== awaiting_confirm 状态 ====================
  if (state.phase === "awaiting_confirm") {
    const intent = detectUserIntent(combinedText);

    if (intent === "confirm") {
      const pending = state.pending;
      const startTime = cstToUtcMs(pending.startDate, pending.startTimeStr);
      const endTime = cstToUtcMs(pending.endDate, pending.endTimeStr);

      if (pending._updateId) {
        const updated = await dbUpdateEvent(db, pending._updateId, {
          title: pending.title, eventType: pending.eventType,
          participants: pending.participants.join(","), projectName: pending.projectName,
          startTime, endTime, location: pending.location, notes: pending.notes || undefined,
        });
        if (updated) {
          const replyContent = `✅ 日程已更新！\n${formatCSTTime(startTime, "date")} ${formatCSTTime(startTime, "time")}–${formatCSTTime(endTime, "time")}\n${updated.title}`;
          await sendWeComReply(env, fromUser, replyContent);
          await saveContext(kv, fromUser, {
            state: { phase: "done", lastEventId: updated.id, lastEventTitle: updated.title },
            lastMessageTime: Date.now(),
            history: [...convCtx.history, { role: "user", content: combinedText }, { role: "assistant", content: replyContent }],
          });
        }
      } else {
        const event = await dbCreateEvent(db, {
          title: pending.title, eventType: pending.eventType,
          participants: pending.participants.join(","), projectName: pending.projectName,
          startTime, endTime, location: pending.location,
          contactName: pending.contactName, contactTitle: pending.contactTitle,
          contactOrg: pending.contactOrg, notes: pending.notes || undefined,
          source: "wecom", rawMessage: state.originalText,
        });
        if (event) {
          const replyContent = `✅ 已添加到日历！\n${formatCSTTime(startTime, "date")} ${formatCSTTime(startTime, "time")}–${formatCSTTime(endTime, "time")}\n${event.title}`;
          await sendWeComReply(env, fromUser, replyContent);
          await saveContext(kv, fromUser, {
            state: { phase: "done", lastEventId: event.id, lastEventTitle: event.title },
            lastMessageTime: Date.now(),
            history: [...convCtx.history, { role: "user", content: combinedText }, { role: "assistant", content: replyContent }],
          });
        }
      }
      return;
    }

    // 先检测字段补充/修改指令（优先级高于 reject）
    const fieldPatch = detectFieldPatch(combinedText, state.pending);
    if (fieldPatch) {
      const updatedPending = { ...state.pending, ...fieldPatch };
      const confirmMsg = buildConfirmMessage(updatedPending, "（已更新，请重新确认）");
      await sendWeComReply(env, fromUser, confirmMsg);
      await saveContext(kv, fromUser, {
        state: { phase: "awaiting_confirm", pending: updatedPending, originalText: state.originalText },
        lastMessageTime: Date.now(),
        history: [...convCtx.history, { role: "user", content: combinedText }, { role: "assistant", content: confirmMsg }],
      });
      return;
    }

    // 重新解析
    const corrected = await parseScheduleFromMessage(env, combinedText, imageUrls, convCtx.history, senderName);
    if (corrected && corrected.action !== "none") {
      const confirmMsg = buildConfirmMessage(corrected);
      await sendWeComReply(env, fromUser, confirmMsg);
      await saveContext(kv, fromUser, {
        state: { phase: "awaiting_confirm", pending: corrected, originalText: combinedText },
        lastMessageTime: Date.now(),
        history: [...convCtx.history, { role: "user", content: combinedText }, { role: "assistant", content: confirmMsg }],
      });
    } else {
      const replyContent = `抱歉，我没有识别出日程信息。请重新描述，例如："明天下午3点和某某开会"`;
      await sendWeComReply(env, fromUser, replyContent);
      await saveContext(kv, fromUser, {
        state: { phase: "idle" },
        lastMessageTime: Date.now(),
        history: [...convCtx.history, { role: "user", content: combinedText }],
      });
    }
    return;
  }

  // ==================== done 状态（跟进操作）====================
  if (state.phase === "done") {
    const parsed = await parseScheduleFromMessage(env, combinedText, imageUrls, convCtx.history, senderName);
    if (parsed?.action === "delete") {
      const ok = await dbDeleteEvent(db, state.lastEventId);
      const replyContent = ok ? `🗑️ 已删除日程：${state.lastEventTitle}` : "删除失败，找不到对应日程。";
      await sendWeComReply(env, fromUser, replyContent);
      await saveContext(kv, fromUser, { state: { phase: "idle" }, lastMessageTime: Date.now(), history: convCtx.history });
      return;
    }
    if (parsed?.action === "update") {
      const confirmMsg = buildConfirmMessage(parsed, `（将修改上一条日程：${state.lastEventTitle}）`);
      await sendWeComReply(env, fromUser, confirmMsg);
      await saveContext(kv, fromUser, {
        state: { phase: "awaiting_confirm", pending: { ...parsed, _updateId: state.lastEventId }, originalText: combinedText },
        lastMessageTime: Date.now(),
        history: [...convCtx.history, { role: "user", content: combinedText }, { role: "assistant", content: confirmMsg }],
      });
      return;
    }
    // fall through 当新日程处理
  }

  // ==================== 默认：解析新日程 ====================
  const parsed = await parseScheduleFromMessage(env, combinedText, imageUrls, convCtx.history, senderName);

  if (!parsed || parsed.action === "none") {
    const replyContent = imageUrls.length > 0
      ? `抱歉，我没能从截图中识别出日程信息。\n可以补充一下时间和对象吗？例如："这是周五下午3点和XX投资人的会面"`
      : `抱歉，我没有从这条消息中识别出日程信息。\n请尝试这样说：明天下午三点和某某开会`;
    await sendWeComReply(env, fromUser, replyContent);
    await saveContext(kv, fromUser, {
      ...convCtx,
      lastMessageTime: Date.now(),
      history: [...convCtx.history, { role: "user", content: combinedText }],
    });
    return;
  }

  const confirmMsg = buildConfirmMessage(parsed);
  await sendWeComReply(env, fromUser, confirmMsg);
  await saveContext(kv, fromUser, {
    state: { phase: "awaiting_confirm", pending: parsed, originalText: combinedText },
    lastMessageTime: Date.now(),
    history: [...convCtx.history, { role: "user", content: combinedText }, { role: "assistant", content: confirmMsg }],
  });
}

// ==================== HTTP 请求路由 ====================

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // 企业微信回调验证 (GET)
  if (request.method === "GET" && (path === "/api/wecom/callback" || path === "/")) {
    const params = Object.fromEntries(url.searchParams);
    const { msg_signature, timestamp, nonce, echostr } = params;

    if (!env.WECOM_TOKEN) return new Response("Not configured", { status: 500 });

    const sig = await verifySignature(env.WECOM_TOKEN, timestamp, nonce, echostr);
    if (sig !== msg_signature) return new Response("Forbidden", { status: 403 });

    if (env.WECOM_ENCODING_AES_KEY && echostr) {
      const decrypted = await decryptMessage(env.WECOM_ENCODING_AES_KEY, echostr);
      if (decrypted) return new Response(decrypted);
    }
    return new Response(echostr);
  }

  // 企业微信消息接收 (POST)
  if (request.method === "POST" && (path === "/api/wecom/callback" || path === "/")) {
    // 立即返回 200，避免企业微信重试
    const responsePromise = new Response("success", { status: 200 });

    // 异步处理消息（使用 waitUntil 确保处理完成）
    const processPromise = (async () => {
      try {
        const rawXml = await request.text();
        if (!rawXml.trim()) return;

        // 解析外层 XML
        let msgType = parseXmlField(rawXml, "MsgType");
        let fromUser = parseXmlField(rawXml, "FromUserName");
        let content = parseXmlField(rawXml, "Content");
        let picUrl = parseXmlField(rawXml, "PicUrl");
        let mediaId = parseXmlField(rawXml, "MediaId");
        let senderName: string | undefined = getMemberNameByWeComId(fromUser) || undefined;

        // 解密加密消息
        const encryptField = parseXmlField(rawXml, "Encrypt");
        if (encryptField && env.WECOM_ENCODING_AES_KEY) {
          const decrypted = await decryptMessage(env.WECOM_ENCODING_AES_KEY, encryptField);
          if (!decrypted) return;
          msgType = parseXmlField(decrypted, "MsgType");
          fromUser = parseXmlField(decrypted, "FromUserName");
          content = parseXmlField(decrypted, "Content");
          picUrl = parseXmlField(decrypted, "PicUrl");
          mediaId = parseXmlField(decrypted, "MediaId");
          senderName = getMemberNameByWeComId(fromUser) || undefined;
        }

        if (!fromUser) return;

        console.log(`[WeCom] msgType=${msgType}, from=${fromUser}, senderName=${senderName}`);

        // ==================== 图片消息 ====================
        if (msgType === "image") {
          await sendWeComReply(env, fromUser, "收到截图，正在识别...");

          // 获取或创建图片缓冲区
          let buf = await getImageBuffer(env.SESSION_KV, fromUser);
          if (!buf) {
            buf = { imageUrls: [], textParts: [], firstMsgTime: Date.now(), senderName };
          }

          // 下载图片
          const imageSource = mediaId || picUrl;
          if (imageSource) {
            const dataUrl = await downloadWeComImage(env, imageSource);
            if (dataUrl) buf.imageUrls.push(dataUrl);
          }

          // 保存缓冲区（30秒后 KV 自动过期，相当于 timer）
          await saveImageBuffer(env.SESSION_KV, fromUser, buf);

          // 等待4秒后处理（Workers 中用 setTimeout 模拟）
          await new Promise(resolve => setTimeout(resolve, 4000));

          // 重新读取缓冲区（可能已被文字消息合并）
          const finalBuf = await getImageBuffer(env.SESSION_KV, fromUser);
          if (!finalBuf) return; // 已被处理

          await clearImageBuffer(env.SESSION_KV, fromUser);
          const combinedText = finalBuf.textParts.join(" ").trim();
          await handleCombinedMessage(env, fromUser, combinedText, finalBuf.imageUrls, finalBuf.senderName || senderName);
          return;
        }

        // ==================== 文字消息 ====================
        if (msgType === "text") {
          const messageText = content.replace(/@\S+/g, "").trim();
          if (!messageText) return;

          // 检查是否有待处理的图片缓冲区
          const buf = await getImageBuffer(env.SESSION_KV, fromUser);
          if (buf && buf.imageUrls.length > 0) {
            buf.textParts.push(messageText);
            await clearImageBuffer(env.SESSION_KV, fromUser);
            const combinedText = buf.textParts.join(" ").trim();
            await handleCombinedMessage(env, fromUser, combinedText, buf.imageUrls, buf.senderName || senderName);
            return;
          }

          // 检查是否在确认流程中
          const convCtx = await getOrCreateContext(env.SESSION_KV, fromUser);
          const isInConfirmFlow = convCtx.state.phase === "awaiting_confirm" || convCtx.state.phase === "awaiting_batch_confirm";
          const intent = detectUserIntent(messageText);

          if (!isInConfirmFlow && intent === "unknown") {
            const isQuery = detectQueryIntent(messageText);
            if (!isQuery) {
              await sendWeComReply(env, fromUser, "收到，正在识别日程...");
            }
          }

          await handleCombinedMessage(env, fromUser, messageText, [], senderName);
          return;
        }

        // ==================== 混合消息 ====================
        if (msgType === "mixed") {
          const messageText = content.replace(/@\S+/g, "").trim();
          const imageUrls: string[] = picUrl ? [picUrl] : [];
          await sendWeComReply(env, fromUser, "收到，正在识别...");
          await handleCombinedMessage(env, fromUser, messageText, imageUrls, senderName);
          return;
        }

      } catch (e) {
        console.error("[WeCom] Error processing message:", e);
      }
    })();

    // 使用 ctx.waitUntil 确保异步处理完成（在 fetch handler 中通过 event 传递）
    // 这里直接 await 处理（Workers 支持）
    await processPromise;
    return responsePromise;
  }

  // 健康检查
  if (path === "/health") {
    return new Response(JSON.stringify({ status: "ok", time: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not Found", { status: 404 });
}

// ==================== Workers 入口 ====================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
