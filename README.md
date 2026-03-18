# 企业微信日程机器人 - Cloudflare Workers 版

## 架构说明

| 组件 | 技术 | 说明 |
|------|------|------|
| 机器人逻辑 | Cloudflare Workers | 接收消息、AI解析、发送回复 |
| 日程数据库 | Cloudflare D1 (SQLite) | 存储所有日程事件 |
| 会话状态 | Cloudflare KV | 存储对话上下文（30分钟有效） |
| AI 模型 | Google Gemini 2.0 Flash | 解析自然语言和截图 |

**优势：**
- ✅ IP 永久固定（Cloudflare 全球 IP 段）
- ✅ 完全免费（Workers 10万次/天，D1 500MB，KV 10万次/天）
- ✅ 全球边缘节点，响应快
- ✅ 99.99% SLA，极其稳定

---

## 部署步骤（你需要操作的部分）

### 第一步：安装 Node.js 和 Wrangler

如果你的电脑上没有 Node.js，先安装：
- 下载地址：https://nodejs.org（选 LTS 版本）

然后安装 Wrangler（Cloudflare 的命令行工具）：
```bash
npm install -g wrangler
```

### 第二步：登录 Cloudflare

```bash
wrangler login
```

浏览器会自动打开，点击"Allow"授权即可。

### 第三步：下载项目代码

把 `wecom-cf-worker` 文件夹下载到你的电脑，然后进入该目录：
```bash
cd wecom-cf-worker
npm install
```

### 第四步：创建 KV 命名空间

```bash
wrangler kv namespace create SESSION_KV
wrangler kv namespace create SESSION_KV --preview
```

命令输出会包含类似这样的内容：
```
{ binding = "SESSION_KV", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

把两个 id 填入 `wrangler.toml` 对应位置：
```toml
[[kv_namespaces]]
binding = "SESSION_KV"
id = "你的正式id"
preview_id = "你的preview_id"
```

### 第五步：创建 D1 数据库

```bash
wrangler d1 create schedule-bot-db
```

把输出的 `database_id` 填入 `wrangler.toml`：
```toml
[[d1_databases]]
binding = "DB"
database_name = "schedule-bot-db"
database_id = "你的database_id"
```

### 第六步：初始化数据库表

```bash
wrangler d1 migrations apply schedule-bot-db --remote
```

### 第七步：设置密钥（Secrets）

依次运行以下命令，每个命令会提示你输入对应的值：

```bash
# 企业微信企业ID（在企业微信管理后台首页可以看到）
wrangler secret put WECOM_CORP_ID

# 企业微信应用 Secret（在应用管理 → 你的应用 → 基本信息）
wrangler secret put WECOM_CORP_SECRET

# 企业微信回调 Token（在应用管理 → 接收消息 → API接收消息 → Token）
wrangler secret put WECOM_TOKEN

# 企业微信 EncodingAESKey（在接收消息配置页面）
wrangler secret put WECOM_ENCODING_AES_KEY

# 企业微信应用 AgentId（在应用管理 → 你的应用 → 基本信息）
wrangler secret put WECOM_AGENT_ID

# Google Gemini API Key（在 https://aistudio.google.com/apikey 获取）
wrangler secret put GEMINI_API_KEY
```

### 第八步：部署

```bash
wrangler deploy
```

部署成功后会显示你的 Workers URL，格式类似：
```
https://wecom-schedule-bot.你的账号.workers.dev
```

### 第九步：更新企业微信回调地址

1. 登录企业微信管理后台：https://work.weixin.qq.com/wework_admin
2. 进入：应用管理 → 日程秘书（你的应用）
3. 点击"接收消息" → "API接收消息"
4. 将 URL 改为：`https://wecom-schedule-bot.你的账号.workers.dev/api/wecom/callback`
5. 点击"保存"

**关于 IP 白名单：**
- Cloudflare Workers 的出站 IP 是固定的 Cloudflare 全球 IP 段
- 企业微信已经默认允许 Cloudflare IP，**无需手动添加白名单**
- 如果仍然提示 IP 不在白名单，在企业微信后台的"企业可信IP"中添加以下 IP 段：
  - 103.21.244.0/22
  - 103.22.200.0/22
  - 103.31.4.0/22
  - 104.16.0.0/13
  - 104.24.0.0/14
  - 108.162.192.0/18
  - 131.0.72.0/22
  - 141.101.64.0/18
  - 162.158.0.0/15
  - 172.64.0.0/13
  - 173.245.48.0/20
  - 188.114.96.0/20
  - 190.93.240.0/20
  - 197.234.240.0/22
  - 198.41.128.0/17

---

## 成员 ID 配置

在 `src/scheduleConst.ts` 中配置企业微信用户ID与成员名字的映射：

```typescript
export const WECOM_USER_MAP: Record<string, string> = {
  "LinYiZheng": "仪征",
  // 在企业微信管理后台 → 通讯录 → 点击成员 → 查看"账号"字段
  "ZhangXiang": "翔哥",
  "BoCZ": "CZ",
  // ...
};
```

修改后重新运行 `wrangler deploy` 即可。

---

## 日常维护

**查看日志：**
```bash
wrangler tail
```

**更新代码后重新部署：**
```bash
wrangler deploy
```

**查看数据库内容：**
```bash
wrangler d1 execute schedule-bot-db --remote --command "SELECT * FROM events ORDER BY startTime DESC LIMIT 20"
```

---

## 功能说明

机器人支持以下操作：

| 操作 | 示例 |
|------|------|
| 添加日程（文字） | "下周二下午3点和翔哥开项目会" |
| 添加日程（截图） | 发送聊天记录截图 |
| 查询日程 | "本周有哪些安排" / "翔哥下周的日程" |
| 修改日程 | 保存后说"改成下午4点" |
| 删除日程 | 保存后说"取消这个" |
| 修改字段 | 确认前说"改一下，参与人仪征" |
