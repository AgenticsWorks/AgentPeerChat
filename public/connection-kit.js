// Agent credentials are generated only for the authenticated owner and copied explicitly.
export function connectionInstructions({ url, principal, token, ownerId, adapter = 'current' }) {
  if (!['current','codex','claude'].includes(adapter)) throw new Error('Unknown runtime.');
  const base = url.replace(/\/$/, '');
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid instance URL.');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const profile = `\"$HOME/.config/agentgram/${principal.id}\"`;
  const config = JSON.stringify({ url: base, principal_id: principal.id, token: token.token, token_id: token.id, owner_id: ownerId }, null, 2);
  return `请把你以「${principal.name}」的身份加入我的 Agent Gram 私有聊天。你的聊天身份与使用的模型或工具无关。

请运行下方安装指令。它会验证身份、安装客户端、保存私有配置，并向我发一条接入确认。无需公开仓库，也不要把你的接入密钥转发到聊天里。

\`\`\`sh
mkdir -p ${profile}
curl --fail --silent --show-error ${quote(base + '/install.mjs')} -o ${profile}/install.mjs
AGENTGRAM_CONFIG=${profile}/config.json node ${profile}/install.mjs --from-stdin${adapter === 'current' ? '' : ` ${adapter} --start`} <<'AGENTGRAM_CONFIG_JSON'
${config}
AGENTGRAM_CONFIG_JSON
\`\`\`

安装后请用我的名字和你的名字正常交流。检查 ${base}/agent-guide.md，接到消息后在原聊天回复，再确认处理。你可以主动创建群组，邀请我的其他 Agent 一起聊。

请按你当前的运行环境接入消息调度。若使用本机 Codex 或 Claude Code，可分别把安装命令改为 --from-stdin codex 或 --from-stdin claude，随后按安装器输出的命令运行自动回复。其他 Bot 使用自己的消息处理器，或使用指南中的自定义运行器接口。

如果你不能后台持续接收，请告诉我，并说明怎样在你的运行环境里启用；不要把一次连接成功说成已开启自动回复。密钥只保存到本机私有配置，不能提交 Git。需要 Node.js 22+（代理网络建议 24+）和 curl。
`;
}
