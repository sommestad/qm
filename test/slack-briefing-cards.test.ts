import { test } from "node:test";
import assert from "node:assert/strict";
import {
  briefingCardMessage,
  briefingInputFromMessage,
  parseBriefingInput,
  isBriefingMark,
} from "../src/slack/briefing-cards.ts";
import { createBriefingCardActions } from "../src/slack/briefing-card-actions.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

const input = {
  title: "Kontrollera åtkomsten 🎉",
  summary: "Läs källan före svar.",
  sourceUrl: "https://example.com/source",
};
function fixture() {
  const turns: any[] = [];
  const ephemerals: any[] = [];
  const updates: any[] = [];
  let acked = false;
  const message = { ...briefingCardMessage(input), ts: "100.001", user: "UBOT" };
  const member = {
    id: "U1",
    team_id: "T1",
    deleted: false,
    is_bot: false,
    is_stranger: false,
    profile: { email: "reviewer@example.com" },
  };
  const info = { ok: true, channel: { is_im: true, user: "U1" } };
  const identity = { ok: true, actor: { externalId: "reviewer@example.com", isBot: false, isExternalGuest: false } };
  const client = {
    conversations: {
      info: async () => {
        assert.equal(acked, true);
        return info;
      },
      replies: async () => ({ messages: [message] }),
    },
    users: { info: async () => ({ ok: true, user: member }) },
    chat: {
      update: async (p: any) => {
        updates.push(p);
        Object.assign(message, p);
        return { ok: true };
      },
      postEphemeral: async (p: any) => {
        ephemerals.push(p);
      },
    },
  };
  const core = {
    submitTurn: async (p: any) => {
      turns.push(p);
      return { status: "queued", runId: "run-1" };
    },
  } as unknown as SlackCoreClient;
  const deps = {
    core,
    directory: { classifyUserCached: async () => identity },
    client,
    teamId: () => "T1",
    botUserId: () => "UBOT",
  };
  const click = {
    ack: async () => {
      acked = true;
    },
    body: { team: { id: "T1" }, user: { id: "U1" }, channel: { id: "D1" }, message: { ts: "100.001", blocks: [] } },
    action: { action_id: "briefing_draft" } as any,
  };
  return {
    member,
    turns,
    ephemerals,
    updates,
    message,
    info,
    identity,
    deps,
    click,
    actions: createBriefingCardActions(deps),
  };
}

test("Slack message explains native reactions without custom marks or storage", () => {
  const rendered = briefingCardMessage(input);
  assert.deepEqual(briefingInputFromMessage(rendered), input);
  assert.match(rendered.text, /✅ = klar, ⭐ = viktig/);
  assert.match(rendered.text, /Ta bort din reaktion/);
  assert.ok(!JSON.stringify(rendered).includes("checkboxes"));
  assert.ok(!JSON.stringify(rendered).includes("briefing_marks"));
  assert.equal(JSON.stringify(rendered).includes("datepicker"), false);
  assert.ok(JSON.stringify(rendered).includes("briefing_source"));
});
test("reject invalid text and source URLs", () => {
  for (const sourceUrl of ["http://example.com", "javascript:alert(1)", "https://user:pass@example.com", "bad"])
    assert.throws(() => parseBriefingInput({ ...input, sourceUrl }));
  assert.throws(() => parseBriefingInput({ ...input, title: "x".repeat(151) }));
  assert.throws(() => parseBriefingInput({ ...input, summary: "a\nb" }));
  assert.throws(() => briefingInputFromMessage({ blocks: [] }));
});
test("ack first, read actual bot message, submit read-only draft in same DM thread", async () => {
  const f = fixture();
  await f.actions.handle(f.click);
  assert.equal(f.turns.length, 1);
  const turn = f.turns[0];
  assert.equal(turn.readOnly, true);
  assert.equal(turn.liveActor, false);
  assert.equal(turn.async, true);
  assert.equal(turn.actor.externalId, "reviewer@example.com");
  assert.equal(turn.deliveryTarget, "D1:100.001");
  assert.match(turn.text, /https:\/\/example.com\/source/);
  assert.equal(f.ephemerals.length, 0);
});
test("repeated clicks and restarted handlers use core's existing run deduplication key", async () => {
  const f = fixture();
  await f.actions.handle(f.click);
  await createBriefingCardActions(f.deps).handle(f.click);
  assert.equal(f.turns[0].idempotencyKey, f.turns[1].idempotencyKey);
});
test("source link needs only acknowledgement", async () => {
  const f = fixture();
  f.click.action.action_id = "briefing_source";
  await f.actions.handle(f.click);
  assert.equal(f.turns.length, 0);
});
test("reject cross-workspace, wrong DM, revoked membership and foreign authored cards", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.click.body.team.id = "T2";
    },
    (f: ReturnType<typeof fixture>) => {
      f.info.channel.user = "U2";
    },
    (f: ReturnType<typeof fixture>) => {
      f.info.channel.is_im = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.ok = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.actor.isExternalGuest = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.actor.isBot = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.message.user = "OTHERBOT";
    },
    (f: ReturnType<typeof fixture>) => {
      f.message.ts = "other";
    },
  ]) {
    const f = fixture();
    mutate(f);
    await f.actions.handle(f.click);
    assert.equal(f.turns.length, 0);
    assert.equal(f.ephemerals.length, 1);
  }
});
test("ambiguous draft response gives no false success, retry uses same key", async () => {
  const f = fixture();
  f.deps.core.submitTurn = async () => {
    throw new Error("transport");
  };
  await f.actions.handle(f.click);
  assert.equal(f.ephemerals.length, 1);
});
test("actor allowlist is enforced", async () => {
  const f = fixture();
  await createBriefingCardActions({ ...f.deps, allowActor: () => false }).handle(f.click);
  assert.equal(f.turns.length, 0);
});

test("independent callback handlers cannot overwrite Slack reaction marks", async () => {
  const f = fixture();
  const reactions = [
    { name: "white_check_mark", users: ["U1"] },
    { name: "star", users: ["U1"] },
  ];
  Object.assign(f.message, { reactions });
  const before = structuredClone(f.message);
  const handlers = [f.actions, createBriefingCardActions(f.deps)];
  await Promise.all(handlers.map((h) => h.handle({ ...f.click, action: { action_id: "briefing_marks" } })));
  assert.equal(f.updates.length, 0);
  assert.equal(f.turns.length, 0);
  assert.deepEqual(f.message, before);
  assert.equal(f.ephemerals.length, 2);
  assert.ok(f.ephemerals.every((p) => p.text.includes("Slacks reaktioner")));
});

test("draft callbacks preserve reaction marks and use one key across handlers", async () => {
  const f = fixture();
  const reactions = [{ name: "star", users: ["U1"] }];
  Object.assign(f.message, { reactions });
  const before = structuredClone(f.message);
  await Promise.all([f.actions.handle(f.click), createBriefingCardActions(f.deps).handle(f.click)]);
  assert.equal(f.turns.length, 2);
  assert.equal(new Set(f.turns.map((t) => t.idempotencyKey)).size, 1);
  assert.deepEqual(f.message, before);
  assert.equal(f.updates.length, 0);
});

test("fresh membership overrides stale directory cache", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.member.deleted = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.member.is_bot = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.member.is_stranger = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.member.id = "U2";
    },
    (f: ReturnType<typeof fixture>) => {
      f.member.team_id = "T2";
    },
    (f: ReturnType<typeof fixture>) => {
      f.member.profile.email = "other@example.com";
    },
  ]) {
    const f = fixture();
    mutate(f);
    await f.actions.handle(f.click);
    assert.equal(f.turns.length, 0);
    assert.equal(f.updates.length, 0);
    assert.equal(f.ephemerals.length, 1);
  }
});

test("failure feedback does not reject the acknowledged callback", async () => {
  const f = fixture();
  f.info.ok = false;
  f.deps.client.chat.postEphemeral = async () => {
    throw new Error("Slack unavailable");
  };
  await assert.doesNotReject(f.actions.handle(f.click));
});

test("only completion and importance on a valid card are UI-only reactions", () => {
  for (const emoji of ["star", "white_check_mark"])
    assert.equal(isBriefingMark(briefingCardMessage(input), emoji), true);
  assert.equal(isBriefingMark(briefingCardMessage(input), "eyes"), false);
  assert.equal(isBriefingMark({ blocks: [] }, "star"), false);
  assert.equal(isBriefingMark({ blocks: {} as any }, "star"), false);
});

test("draft-only run explicitly discloses it cannot fetch the original source", async () => {
  const f = fixture();
  await f.actions.handle(f.click);
  assert.match(f.turns[0].text, /inte läst originalkällan på nytt/);
  assert.match(f.turns[0].gatewayContext.instructions, /Source access is unavailable/);
  assert.equal(f.turns[0].liveActor, false);
  assert.equal(f.turns[0].readOnly, true);
});

test("concurrent draft callbacks collapse onto one real core run", async () => {
  await import("./support/auto-fake-sprites.ts");
  const { buildApp } = await import("../src/wiring.ts");
  const { testConfig } = await import("./support/test-config.ts");
  const built = buildApp(testConfig());
  const f = fixture();
  const receipts: any[] = [];
  f.deps.core.submitTurn = async (body) => {
    const result = await built.slackCore.submitTurn(body);
    receipts.push(result);
    return result;
  };
  try {
    await Promise.all([f.actions.handle(f.click), createBriefingCardActions(f.deps).handle(f.click)]);
    assert.equal(receipts.length, 2);
    const run = await built.runs.getByDedupKey("briefing-draft:T1:D1:100.001");
    assert.ok(run);
    assert.equal(run.request.readOnly, true);
    assert.deepEqual(run.request.origin, { kind: "direct" });
    assert.equal(run.request.deliveryTarget, "D1:100.001");
    assert.equal(f.ephemerals.length, 0);
    assert.ok(receipts.every((r) => r.status === "queued" && r.runId === run.id));
  } finally {
    await built.runtime.stop();
  }
});
