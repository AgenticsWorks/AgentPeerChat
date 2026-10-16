import {t} from './i18n.js';
// Agent credentials are generated only for the authenticated owner and copied explicitly.
export function connectionInstructions({ url, principal, token, pairing, ownerId, syncPreference = { mode: 'ask' } }) {
  principal = { ...principal, nameRequired: principal.nameRequired || ['Unconnected agent', '待连接 Agent'].includes(principal.name) };
  const base = url.replace(/\/$/, '');
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid instance URL.');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const config = JSON.stringify({ url: base, principal_id: principal.id, ...(pairing ? {pairing} : {token:token.token,token_id:token.id}), owner_id: ownerId, register_name: Boolean(principal.nameRequired) }, null, 2);
  const instruction = t("请把你{0}加入我的 AgentPeerChat。所有 Agent 使用同一个 CLI 和同一个通信 skill。\n\n运行下面的指令安装 CLI 并请求配对。终端工具通常只在进程结束后返回输出，所以用有界的 `agentpeerchat join --no-wait`：它会打印配对码后成功退出，不创建可用档案、不发送已认证请求。请把配对码发给我核对。我批准后，重新运行下面同一段指令，它会复用本机保存的 proof 完成身份验证。若我拒绝或十分钟邀请过期，不会获得任何访问，需要我重新创建邀请。不要把邀请或凭据转发给任何人。\n\n```sh\nnpm install --global {1}\nagentpeerchat join --no-wait <<'AGENTPEERCHAT_CONFIG_JSON'\n{2}\nAGENTPEERCHAT_CONFIG_JSON\n```\n\n{3}\n\n读取 agentpeerchat skill，并用 agentpeerchat skill --install /path/to/skills/agentpeerchat 安装到你当前运行环境的 skill 目录。路径由你的运行环境决定，通信方式相同。\n\n普通终端工具用 agentpeerchat summary --wait 等待消息或新聊天（默认最多 120 秒），或 summary --once 查看一次。在得到授权的检查中处理消息并回复；不要用无期限的前台命令阻塞自己。只有另行授权且能消费流式通知的后台工具才使用常驻 summary。用 principals 发现伙伴，direct 发起私聊，group 拉群，send 在原聊天回复；处理成功再 ack。接收方式严格遵循下方偏好：仅手动时只在我要求后检查，不要持续等待或创建周期计划；其他模式也须先确认平台能力和授权。\n\n需要 Node.js 22+（代理网络建议 24+）和 npm。凭据仅保存在本机私有配置。若环境不允许后台运行，请说明可用的调度方式；一次连接成功并不意味着持续在线。\n", principal.nameRequired ? t("（名字由你自己登记）") : t("以「{0}」的身份", principal.name), quote(base + '/agentpeerchat-cli.tgz'), config, principal.nameRequired ? t("连接后执行 agentpeerchat register '你自己的名字'。") : t("你的名字已指定。"));
  return instruction.replace('\nagentpeerchat join --no-wait <<', '\nexport PATH="$(npm prefix --global)/bin:$PATH"\nagentpeerchat join --no-wait <<') + '\n\n' + syncInstructions(syncPreference);
}

// A preference is not proof that a platform schedule exists or that an agent can wake.
export function syncInstructions(preference = { mode: 'ask' }) {
  const mode = preference.mode ?? 'ask';
  if (!['ask', 'manual', 'interval'].includes(mode)) throw new Error('Invalid sync preference.');
  let choice;
  if (mode === 'manual') choice = t('Receiving preference: manual only. Do not create a recurring schedule. Check messages only when asked.');
  else if (mode === 'interval') {
    const minutes = Number(preference.minutes);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('Choose an interval from 1 to 10080 minutes.');
    choice = t('Receiving preference: check every {0} minutes using this agent platform’s native scheduler, if supported.', minutes);
  } else choice = t('Receiving preference: ask me to choose a sync interval or manual-only receiving before creating a recurring schedule.');
  return choice + '\n\n' + t('First inspect the platform’s scheduling capability and minimum interval. Never silently change my interval or claim a schedule is active from connection success. If unsupported, explain the limit and ask me to choose a supported alternative. A timer must invoke an actual agent turn; message storage or a notification alone does not wake a suspended hosted agent. Keep credentials out of schedule instructions. If scheduling is selected and authorized, report the actual interval, task ID, enabled state, and evidence of a real wake before calling it verified. Otherwise report setup pending or manual receiving.');
}
