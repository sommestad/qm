import { WebClient } from "@slack/web-api";
import { sendJson } from "../http.ts";
import type { ServerDeps } from "../deps.ts";
import type { ApiCtx, Route } from "./route.ts";
import { briefingCardMessage, parseBriefingInput, type BriefingInput } from "../../slack/briefing-cards.ts";
import { openConversationFor } from "../../slack/delivery.ts";
import { NO_RETRY } from "../../slack/config.ts";

export async function postBriefingCard(client: any, owner: string, input: BriefingInput) {
  const auth = await client.auth.test();
  if (!auth.ok || !auth.team_id) throw new Error("Slack identity unavailable");
  const channel = await openConversationFor(client, [owner]);
  const info = await client.conversations.info({ channel });
  if (
    !info.ok ||
    !info.channel?.is_im ||
    !info.channel.user ||
    info.channel.is_ext_shared ||
    info.channel.is_pending_ext_shared
  )
    throw new Error("not a DM");
  const userInfo = await client.users.info({ user: info.channel.user });
  const member = userInfo.user;
  if (
    !userInfo.ok ||
    !member ||
    member.id !== info.channel.user ||
    member.is_stranger ||
    member.deleted ||
    member.is_bot ||
    member.is_restricted ||
    member.is_ultra_restricted ||
    member.team_id !== auth.team_id
  )
    throw new Error("not an internal member");
  if (member.id !== owner && member.profile?.email?.toLowerCase() !== owner.toLowerCase())
    throw new Error("wrong DM member");
  const result = await client.chat.postMessage({
    channel,
    ...briefingCardMessage(input),
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!result.ok || !result.ts) throw new Error("post not confirmed");
  return { channel, messageTs: result.ts };
}

export async function briefingBotToken(
  deps: Pick<ServerDeps, "slackInstallation" | "slackEnvBotToken">,
): Promise<string | undefined> {
  const installed = await deps.slackInstallation?.get();
  if (installed) return installed.botToken;
  const status = await deps.slackInstallation?.status();
  return status?.managed ? undefined : deps.slackEnvBotToken;
}

async function briefingCards(ctx: ApiCtx): Promise<void> {
  const { capability, deps, res } = ctx;
  if (!capability || capability.scopeId !== `personal:${capability.actorId}` || capability.botActor)
    return sendJson(res, 403, { error: "personal_scope_required" });
  if (!deps.slackBriefingCards) return sendJson(res, 503, { error: "briefing_cards_not_enabled" });
  const member = await deps.directory?.get(capability.actorId);
  if (!member || member.type !== "internal") return sendJson(res, 403, { error: "internal_member_required" });
  const rate = await deps.rateLimiter?.check(`briefing-cards:${capability.actorId}`);
  if (rate && !rate.allowed) return sendJson(res, 429, { error: "rate_limited" });
  let input;
  try {
    input = parseBriefingInput(ctx.body);
  } catch {
    return sendJson(res, 400, { error: "invalid_card" });
  }
  try {
    const token = await briefingBotToken(deps);
    if (!token) return sendJson(res, 503, { error: "briefing_cards_not_enabled" });
    const receipt = await postBriefingCard(
      new WebClient(token, { ...NO_RETRY, timeout: 10000 }),
      capability.actorId,
      input,
    );
    return sendJson(res, 200, receipt);
  } catch {
    return sendJson(res, 502, {
      error: "delivery_unconfirmed",
      message: "Check Slack before retrying; the message may have been posted.",
    });
  }
}

export const briefingCardRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/briefing-cards", auth: "either", handle: briefingCards },
];
