#!/bin/bash
# 企业微信日程机器人 - Cloudflare Workers 一键部署脚本
# 使用方法：chmod +x deploy.sh && ./deploy.sh

set -e

echo "🚀 开始部署企业微信日程机器人到 Cloudflare Workers..."

# 检查 wrangler 是否已登录
echo ""
echo "Step 1: 检查 Cloudflare 登录状态..."
npx wrangler whoami || (echo "❌ 未登录，请先运行: npx wrangler login" && exit 1)

# 创建 KV 命名空间
echo ""
echo "Step 2: 创建 KV 命名空间（会话状态存储）..."
KV_RESULT=$(npx wrangler kv namespace create SESSION_KV 2>&1)
echo "$KV_RESULT"
KV_ID=$(echo "$KV_RESULT" | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)

KV_PREVIEW_RESULT=$(npx wrangler kv namespace create SESSION_KV --preview 2>&1)
echo "$KV_PREVIEW_RESULT"
KV_PREVIEW_ID=$(echo "$KV_PREVIEW_RESULT" | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)

# 创建 D1 数据库
echo ""
echo "Step 3: 创建 D1 数据库..."
D1_RESULT=$(npx wrangler d1 create schedule-bot-db 2>&1)
echo "$D1_RESULT"
D1_ID=$(echo "$D1_RESULT" | grep -o '"database_id": "[^"]*"' | head -1 | cut -d'"' -f4)

# 更新 wrangler.toml
echo ""
echo "Step 4: 更新 wrangler.toml 配置..."
if [ -n "$KV_ID" ] && [ -n "$KV_PREVIEW_ID" ] && [ -n "$D1_ID" ]; then
  sed -i "s/REPLACE_WITH_YOUR_KV_ID/$KV_ID/g" wrangler.toml
  sed -i "s/REPLACE_WITH_YOUR_KV_PREVIEW_ID/$KV_PREVIEW_ID/g" wrangler.toml
  sed -i "s/REPLACE_WITH_YOUR_D1_ID/$D1_ID/g" wrangler.toml
  echo "✅ wrangler.toml 已更新"
else
  echo "⚠️  无法自动提取 ID，请手动更新 wrangler.toml"
  echo "   KV_ID: $KV_ID"
  echo "   KV_PREVIEW_ID: $KV_PREVIEW_ID"
  echo "   D1_ID: $D1_ID"
fi

# 初始化数据库
echo ""
echo "Step 5: 初始化 D1 数据库表..."
npx wrangler d1 migrations apply schedule-bot-db --remote

# 设置 Secrets
echo ""
echo "Step 6: 设置企业微信和 Gemini 密钥..."
echo "请依次输入以下密钥（直接回车跳过已设置的）："
echo ""
echo "WECOM_CORP_ID（企业微信企业ID）:"
npx wrangler secret put WECOM_CORP_ID
echo ""
echo "WECOM_CORP_SECRET（企业微信应用 Secret）:"
npx wrangler secret put WECOM_CORP_SECRET
echo ""
echo "WECOM_TOKEN（企业微信回调 Token）:"
npx wrangler secret put WECOM_TOKEN
echo ""
echo "WECOM_ENCODING_AES_KEY（企业微信 EncodingAESKey）:"
npx wrangler secret put WECOM_ENCODING_AES_KEY
echo ""
echo "WECOM_AGENT_ID（企业微信应用 AgentId）:"
npx wrangler secret put WECOM_AGENT_ID
echo ""
echo "GEMINI_API_KEY（Google Gemini API Key）:"
npx wrangler secret put GEMINI_API_KEY

# 部署
echo ""
echo "Step 7: 部署到 Cloudflare Workers..."
npx wrangler deploy

echo ""
echo "✅ 部署完成！"
echo ""
echo "📋 下一步："
echo "1. 复制上方输出的 Workers URL（格式：https://wecom-schedule-bot.xxx.workers.dev）"
echo "2. 登录企业微信管理后台 → 应用管理 → 你的应用 → 接收消息"
echo "3. 将回调 URL 改为：https://wecom-schedule-bot.xxx.workers.dev/api/wecom/callback"
echo "4. 企业可信IP：Cloudflare Workers 的 IP 是固定的，无需手动添加（Cloudflare 全球 IP 段已在企业微信白名单中）"
echo ""
echo "🎉 完成后机器人就可以正常使用了！"
