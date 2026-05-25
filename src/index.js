require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cron = require("node-cron");
const Stripe = require("stripe");
const { v4: uuidv4 } = require("uuid");
const { Telegraf, Markup } = require("telegraf");

const db = require("./db");
const { detectLang, t, getEffects } = require("./services/i18n");
const { nowISO, parseScheduleArgs } = require("./services/utils");

const BOT_TOKEN = process.env.BOT_TOKEN;
const STRIPE_PAYMENT_LINK =
  process.env.STRIPE_PAYMENT_LINK || "https://buy.stripe.com/14A9AS2AN7CK6sL7Azawo00";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || "https://t.me";
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || "https://t.me";
const PORT = Number(process.env.PORT || 3000);
const LICENSE_SECRET = process.env.LICENSE_SECRET || "CHANGE_ME";
const LICENSE_SEEDS = (process.env.PREMIUM_LICENSE_SEEDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required in .env");
}

const bot = new Telegraf(BOT_TOKEN);
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const activeBattles = new Map();
const scheduleRunners = new Map();

const upsertGroupStmt = db.prepare(`
INSERT INTO groups (chat_id, title, created_at, updated_at)
VALUES (@chat_id, @title, @now, @now)
ON CONFLICT(chat_id)
DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at
`);

const upsertDefaultSettingsStmt = db.prepare(`
INSERT INTO settings (chat_id)
VALUES (?)
ON CONFLICT(chat_id) DO NOTHING
`);

const getGroupStmt = db.prepare("SELECT * FROM groups WHERE chat_id=?");
const getSettingsStmt = db.prepare("SELECT * FROM settings WHERE chat_id=?");
const setDurationStmt = db.prepare("UPDATE settings SET battle_duration_sec=? WHERE chat_id=?");
const setLanguageStmt = db.prepare("UPDATE groups SET language_mode=?, updated_at=? WHERE chat_id=?");
const setJoinBtnStmt = db.prepare("UPDATE settings SET join_button_text=? WHERE chat_id=?");
const setWinnerTplStmt = db.prepare("UPDATE settings SET winner_message_template=? WHERE chat_id=?");
const setGifStmt = db.prepare("UPDATE settings SET gif_enabled=? WHERE chat_id=?");
const setEffectsStmt = db.prepare("UPDATE settings SET custom_effects_json=? WHERE chat_id=?");

const createBattleStmt = db.prepare(`
INSERT INTO battles (id, chat_id, created_by_user_id, status, started_at)
VALUES (?, ?, ?, 'recruiting', ?)
`);
const closeBattleStmt = db.prepare(`
UPDATE battles SET status='finished', ended_at=?, winner_user_id=?, winner_username=? WHERE id=?
`);

const addPlayerStmt = db.prepare(`
INSERT OR IGNORE INTO players (battle_id, user_id, username, first_name, joined_at)
VALUES (?, ?, ?, ?, ?)
`);
const countPlayersStmt = db.prepare("SELECT COUNT(*) as c FROM players WHERE battle_id=?");
const listPlayersStmt = db.prepare("SELECT user_id, username, first_name FROM players WHERE battle_id=?");

const getLicenseStmt = db.prepare("SELECT * FROM licenses WHERE code=?");
const activateLicenseStmt = db.prepare(`
UPDATE licenses
SET is_used=1, used_by_chat_id=?, used_by_user_id=?, activated_at=?
WHERE code=? AND is_used=0
`);
const setPremiumStmt = db.prepare("UPDATE groups SET is_premium=1, updated_at=? WHERE chat_id=?");
const getEventStmt = db.prepare("SELECT event_id FROM stripe_events WHERE event_id=?");
const addEventStmt = db.prepare("INSERT INTO stripe_events (event_id, event_type, created_at) VALUES (?, ?, ?)");

const deleteSchedulesByChatStmt = db.prepare("DELETE FROM schedules WHERE chat_id=?");
const insertScheduleStmt = db.prepare(`
INSERT INTO schedules (id, chat_id, type, time_hhmm, weekday, run_at, enabled, created_by_user_id, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
`);
const listSchedulesStmt = db.prepare("SELECT * FROM schedules WHERE enabled=1");
const getScheduleByChatStmt = db.prepare("SELECT * FROM schedules WHERE chat_id=? AND enabled=1");

function hashLicense(seed) {
  const normalized = seed.trim().toUpperCase();
  const digest = crypto.createHmac("sha256", LICENSE_SECRET).update(normalized).digest("hex").toUpperCase();
  return `${digest.slice(0, 5)}-${digest.slice(5, 10)}`;
}

function seedLicenses() {
  const now = nowISO();
  const insert = db.prepare("INSERT OR IGNORE INTO licenses (code, created_at) VALUES (?, ?)");
  for (const seed of LICENSE_SEEDS) insert.run(hashLicense(seed), now);
}

function getLang(ctx, group, settings) {
  const fixed = group?.language_mode && group.language_mode !== "auto" ? group.language_mode : settings?.fixed_language;
  return detectLang(ctx.from?.language_code, fixed);
}

async function isAdmin(ctx) {
  const chatId = String(ctx.chat.id);
  const userId = ctx.from.id;
  const admins = await ctx.telegram.getChatAdministrators(chatId);
  return admins.some((a) => a.user.id === userId);
}

function ensureGroup(ctx) {
  const chatId = String(ctx.chat.id);
  upsertGroupStmt.run({ chat_id: chatId, title: ctx.chat.title || "", now: nowISO() });
  upsertDefaultSettingsStmt.run(chatId);
  return {
    group: getGroupStmt.get(chatId),
    settings: getSettingsStmt.get(chatId),
  };
}

function activatePremiumForChat(chatId, userId, buyerDmId) {
  const now = nowISO();
  db.transaction(() => {
    upsertGroupStmt.run({ chat_id: String(chatId), title: "", now });
    upsertDefaultSettingsStmt.run(String(chatId));
    setPremiumStmt.run(now, String(chatId));
  })();
  // Privacy-first: do not post payment confirmation in group.
  if (buyerDmId) {
    bot.telegram
      .sendMessage(
        String(buyerDmId),
        `✅ Payment confirmed.\nPremium was activated for group: ${chatId}\n\nYou can now use premium commands in that group: /schedule, /setbutton, /setwinner, /seteffect, /setgif`
      )
      .catch(() => {});
  }
}

function startWebhookServer() {
  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });

  app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send("Stripe webhook disabled");

    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send("Bad signature");
    }

    if (getEventStmt.get(event.id)) return res.status(200).send("already processed");

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const targetChatId = session.metadata?.chat_id;
        const buyerUserId = session.metadata?.user_id || "unknown";
        const buyerDmId = session.metadata?.buyer_dm_id || null;
        if (targetChatId) activatePremiumForChat(targetChatId, buyerUserId, buyerDmId);
      }
      addEventStmt.run(event.id, event.type, nowISO());
      return res.status(200).send("ok");
    } catch (err) {
      console.error("Webhook handling failed:", err);
      return res.status(500).send("error");
    }
  });

  app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
  });
}

async function startBattle(ctx, chatId, creatorUserId, lang, settings) {
  if (activeBattles.has(chatId)) {
    return ctx.reply(t(lang, "battle_running"));
  }

  const battleId = uuidv4();
  const duration = [30, 60, 90].includes(settings.battle_duration_sec) ? settings.battle_duration_sec : 30;
  createBattleStmt.run(battleId, chatId, String(creatorUserId), nowISO());

  const joinText = settings.join_button_text || t(lang, "join_button");
  const sent = await ctx.reply(
    `${t(lang, "battle_started")}\n${t(lang, "countdown", { sec: duration, count: 0 })}`,
    Markup.inlineKeyboard([Markup.button.callback(joinText, `battle_join:${battleId}`)])
  );

  const state = {
    battleId,
    chatId,
    messageId: sent.message_id,
    remaining: duration,
    timer: null,
    interval: null,
  };

  state.interval = setInterval(async () => {
    state.remaining -= 5;
    if (state.remaining <= 0) return;
    const count = countPlayersStmt.get(battleId).c;
    try {
      await ctx.telegram.editMessageText(
        chatId,
        state.messageId,
        undefined,
        `${t(lang, "battle_started")}\n${t(lang, "countdown", { sec: state.remaining, count })}`,
        { reply_markup: Markup.inlineKeyboard([Markup.button.callback(joinText, `battle_join:${battleId}`)]).reply_markup }
      );
    } catch (_) {}
  }, 5000);

  state.timer = setTimeout(async () => {
    clearInterval(state.interval);
    await finishBattle(ctx.telegram, state, lang, settings);
  }, duration * 1000);

  activeBattles.set(chatId, state);
}

async function finishBattle(telegram, state, lang, settings) {
  activeBattles.delete(state.chatId);
  const players = listPlayersStmt.all(state.battleId);

  if (players.length < 2) {
    await telegram.sendMessage(state.chatId, t(lang, "need_two_players"));
    closeBattleStmt.run(nowISO(), null, null, state.battleId);
    return;
  }

  const names = players.map((p) => ({
    user_id: p.user_id,
    // 通常演出ではメンションを避ける（通知スパム防止）
    name: p.first_name || p.username || `user_${p.user_id}`,
    mention: `<a href="tg://user?id=${p.user_id}">${(p.first_name || p.username || `user_${p.user_id}`).replace(
      /</g,
      "&lt;"
    ).replace(/>/g, "&gt;")}</a>`,
  }));

  const participantList = names.map((n, i) => `${i + 1}. ${n.name}`).join("\n");
  await telegram.sendMessage(
    state.chatId,
    `👥 Participants (${names.length})\n${participantList}\n\n🎬 Battle Start!`
  );

  const defaultEffects = getEffects(lang);
  let effects = defaultEffects;
  if (settings.custom_effects_json) {
    try {
      const custom = JSON.parse(settings.custom_effects_json);
      if (Array.isArray(custom) && custom.length > 0) effects = custom;
    } catch (_) {}
  }

  let alive = [...names];
  while (alive.length > 1) {
    const loserIdx = Math.floor(Math.random() * alive.length);
    const loser = alive[loserIdx];
    const candidates = alive.filter((x) => x.user_id !== loser.user_id);
    const attacker = candidates[Math.floor(Math.random() * candidates.length)];
    const effect = effects[Math.floor(Math.random() * effects.length)];
    await telegram.sendMessage(state.chatId, effect.replaceAll("{a}", attacker.name).replaceAll("{b}", loser.name));
    alive.splice(loserIdx, 1);
  }

  const winner = alive[0];
  const winnerTemplate = settings.winner_message_template || t(lang, "winner", { user: "{user}" });
  await telegram.sendMessage(state.chatId, winnerTemplate.replaceAll("{user}", winner.mention), {
    parse_mode: "HTML",
  });
  closeBattleStmt.run(nowISO(), winner.user_id, winner.name, state.battleId);
}

function clearScheduleRunner(chatId) {
  const runner = scheduleRunners.get(chatId);
  if (!runner) return;
  if (runner.kind === "cron") runner.task.stop();
  if (runner.kind === "timeout") clearTimeout(runner.timer);
  scheduleRunners.delete(chatId);
}

function registerSchedule(schedule) {
  const chatId = String(schedule.chat_id);
  clearScheduleRunner(chatId);

  if (schedule.type === "daily") {
    const [hh, mm] = schedule.time_hhmm.split(":").map(Number);
    const expr = `${mm} ${hh} * * *`;
    const task = cron.schedule(expr, () => autoBattle(chatId));
    scheduleRunners.set(chatId, { kind: "cron", task });
    return;
  }

  if (schedule.type === "weekly") {
    const [hh, mm] = schedule.time_hhmm.split(":").map(Number);
    const expr = `${mm} ${hh} * * ${schedule.weekday}`;
    const task = cron.schedule(expr, () => autoBattle(chatId));
    scheduleRunners.set(chatId, { kind: "cron", task });
    return;
  }

  if (schedule.type === "once" && schedule.run_at) {
    const ms = new Date(schedule.run_at).getTime() - Date.now();
    if (ms <= 0) return;
    const timer = setTimeout(() => autoBattle(chatId), ms);
    scheduleRunners.set(chatId, { kind: "timeout", timer });
  }
}

async function autoBattle(chatId) {
  if (activeBattles.has(chatId)) return;

  const group = getGroupStmt.get(chatId);
  const settings = getSettingsStmt.get(chatId);
  if (!group || !settings) return;

  const lang = detectLang("en", group.language_mode === "auto" ? null : group.language_mode);

  const battleId = uuidv4();
  const duration = [30, 60, 90].includes(settings.battle_duration_sec) ? settings.battle_duration_sec : 30;
  createBattleStmt.run(battleId, chatId, "scheduler", nowISO());

  const joinText = settings.join_button_text || t(lang, "join_button");
  const sent = await bot.telegram.sendMessage(
    chatId,
    `${t(lang, "battle_started")}\n${t(lang, "countdown", { sec: duration, count: 0 })}`,
    { reply_markup: Markup.inlineKeyboard([Markup.button.callback(joinText, `battle_join:${battleId}`)]).reply_markup }
  );

  const state = { battleId, chatId, messageId: sent.message_id, remaining: duration };
  state.interval = setInterval(async () => {
    state.remaining -= 5;
    if (state.remaining <= 0) return;
    const count = countPlayersStmt.get(battleId).c;
    try {
      await bot.telegram.editMessageText(
        chatId,
        state.messageId,
        undefined,
        `${t(lang, "battle_started")}\n${t(lang, "countdown", { sec: state.remaining, count })}`,
        { reply_markup: Markup.inlineKeyboard([Markup.button.callback(joinText, `battle_join:${battleId}`)]).reply_markup }
      );
    } catch (_) {}
  }, 5000);

  state.timer = setTimeout(async () => {
    clearInterval(state.interval);
    activeBattles.delete(chatId);
    await finishBattle(bot.telegram, state, lang, settings);
  }, duration * 1000);

  activeBattles.set(chatId, state);
}

function loadSchedulesOnBoot() {
  const rows = listSchedulesStmt.all();
  for (const row of rows) registerSchedule(row);
}

bot.use(async (ctx, next) => {
  if (!ctx.chat) return next();
  if (!["group", "supergroup"].includes(ctx.chat.type) && ctx.chat.type !== "private") return next();
  if (["group", "supergroup"].includes(ctx.chat.type)) ensureGroup(ctx);
  return next();
});

bot.command("premium", async (ctx) => {
  const { group, settings } = ctx.chat?.type === "private" ? { group: null, settings: null } : ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  await ctx.reply(t(lang, "premium_info", { url: STRIPE_PAYMENT_LINK }));
});

bot.command("buy", async (ctx) => {
  if (!stripe || !STRIPE_PRICE_ID) {
    return ctx.reply("Auto-payment is not configured yet. Please set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.");
  }

  const userId = String(ctx.from.id);
  const args = ctx.message.text.split(" ").slice(1);
  let chatId;

  if (["group", "supergroup"].includes(ctx.chat?.type)) {
    if (!(await isAdmin(ctx))) return ctx.reply("Admins only.");
    chatId = String(ctx.chat.id);
    ensureGroup(ctx);
  } else if (ctx.chat?.type === "private") {
    if (args.length !== 1) {
      return ctx.reply(
        "Usage in DM:\n/buy -1001234567890\n\nTip: run /groupid in your target group first."
      );
    }
    chatId = args[0].trim();
    try {
      const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
      if (!["creator", "administrator"].includes(member.status)) {
        return ctx.reply("You must be an admin of that target group.");
      }
    } catch (_) {
      return ctx.reply(
        "Cannot access that group. Make sure:\n1) Bot is in the group\n2) group id is correct\n3) you are an admin"
      );
    }
    const now = nowISO();
    upsertGroupStmt.run({ chat_id: chatId, title: "", now });
    upsertDefaultSettingsStmt.run(chatId);
  } else {
    return ctx.reply("Use in group or private chat.");
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      metadata: {
        chat_id: chatId,
        user_id: userId,
        buyer_dm_id: String(ctx.from.id),
      },
    });
    await ctx.reply(`💳 Pay here to auto-activate Premium:\n${session.url}\n\nTarget group: ${chatId}`);
  } catch (err) {
    console.error("Failed to create checkout session:", err);
    await ctx.reply("Failed to create payment session. Please try again later.");
  }
});

bot.command("battle", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return ctx.reply("Use in group only.");
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
  await startBattle(ctx, String(ctx.chat.id), ctx.from.id, lang, settings);
});

bot.action(/battle_join:(.+)/, async (ctx) => {
  const battleId = ctx.match[1];
  const chatId = String(ctx.chat.id);
  const state = activeBattles.get(chatId);
  if (!state || state.battleId !== battleId) return ctx.answerCbQuery("Expired.");

  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);

  if (ctx.from.is_bot) return ctx.answerCbQuery(t(lang, "bot_cannot_join"), { show_alert: true });
  const before = countPlayersStmt.get(battleId).c;
  addPlayerStmt.run(battleId, String(ctx.from.id), ctx.from.username || null, ctx.from.first_name || null, nowISO());
  const after = countPlayersStmt.get(battleId).c;
  if (before === after) {
    return ctx.answerCbQuery(t(lang, "already_joined"), { show_alert: true });
  }
  await ctx.answerCbQuery(t(lang, "joined_ok"));
});

bot.command("license", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const isGroup = ["group", "supergroup"].includes(ctx.chat?.type);

  if (isGroup) {
    const { group, settings } = ensureGroup(ctx);
    const lang = getLang(ctx, group, settings);
    if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
    if (args.length !== 1) return ctx.reply(t(lang, "license_usage"));

    const code = args[0].trim().toUpperCase();
    const lic = getLicenseStmt.get(code);
    if (!lic || lic.is_used) return ctx.reply(t(lang, "license_ng"));

    const result = activateLicenseStmt.run(String(ctx.chat.id), String(ctx.from.id), nowISO(), code);
    if (result.changes !== 1) return ctx.reply(t(lang, "license_ng"));

    setPremiumStmt.run(nowISO(), String(ctx.chat.id));
    return ctx.reply(t(lang, "license_ok"));
  }

  // Private chat flow:
  // /license XXXXX-XXXXX -1001234567890
  if (ctx.chat?.type === "private") {
    if (args.length !== 2) {
      return ctx.reply(
        "Usage in DM:\n/license XXXXX-XXXXX -1001234567890\n\nTip: run /groupid in your target group first."
      );
    }

    const code = args[0].trim().toUpperCase();
    const targetChatId = args[1].trim();
    const lic = getLicenseStmt.get(code);
    if (!lic || lic.is_used) return ctx.reply("Invalid License");

    try {
      const member = await ctx.telegram.getChatMember(targetChatId, ctx.from.id);
      if (!["creator", "administrator"].includes(member.status)) {
        return ctx.reply("You must be an admin of that target group.");
      }
    } catch (_) {
      return ctx.reply(
        "Cannot access that group. Make sure:\n1) Bot is in the group\n2) group id is correct\n3) you are an admin"
      );
    }

    db.transaction(() => {
      upsertGroupStmt.run({ chat_id: targetChatId, title: "", now: nowISO() });
      upsertDefaultSettingsStmt.run(targetChatId);
      const result = activateLicenseStmt.run(targetChatId, String(ctx.from.id), nowISO(), code);
      if (result.changes !== 1) throw new Error("activate_failed");
      setPremiumStmt.run(nowISO(), targetChatId);
    })();

    return ctx.reply(`Premium Activated for group: ${targetChatId}`);
  }
});

bot.command("groupid", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) {
    return ctx.reply("Use this command in a group.");
  }
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
  return ctx.reply(`Group ID: ${ctx.chat.id}`);
});

function dmGuideText() {
  return [
    "📘 Premium Setup Guide (DM)",
    "",
    "1) In your target group, run: /groupid",
    "2) Copy the group id (example: -1001234567890)",
    "3) In this DM, run: /buy -1001234567890",
    "4) Complete Stripe payment from the generated link",
    "5) You'll receive DM confirmation when Premium is activated",
    "",
    "Notes:",
    "- You must be an admin of the target group",
    "- Bot must be in the target group",
    "- 1 payment = 1 group premium activation",
  ].join("\n");
}

bot.command("helpdm", async (ctx) => {
  if (ctx.chat?.type !== "private") return ctx.reply("Use this command in DM.");
  return ctx.reply(dmGuideText());
});

bot.start(async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  return ctx.reply(dmGuideText());
});

bot.command("settings", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return ctx.reply("Use in group only.");
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));

  const schedule = getScheduleByChatStmt.get(String(ctx.chat.id));
  const text = [
    t(lang, "settings_title"),
    `Premium: ${group.is_premium ? "ON" : "OFF"}`,
    `Duration: ${settings.battle_duration_sec}s`,
    `Language: ${group.language_mode}`,
    `GIF: ${settings.gif_enabled ? "ON" : "OFF"}`,
    `Button: ${settings.join_button_text || "(default)"}`,
    `Winner Template: ${settings.winner_message_template || "(default)"}`,
    `Schedule: ${schedule ? `${schedule.type}` : "none"}`,
    "",
    "Commands:",
    "/setduration 30|60|90",
    "/setlanguage auto|ja|en|zh",
    "/setgif on|off (premium)",
    "/setbutton <text> (premium)",
    "/setwinner <template with {user}> (premium)",
    "/seteffect add <text with {a} and {b}> (premium)",
    "/seteffect reset (premium)",
  ].join("\n");
  await ctx.reply(text);
});

bot.command("setduration", async (ctx) => {
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));

  const sec = Number(ctx.message.text.split(" ")[1]);
  if (![30, 60, 90].includes(sec)) return ctx.reply("Use 30 / 60 / 90");
  setDurationStmt.run(sec, String(ctx.chat.id));
  await ctx.reply(t(lang, "duration_set", { sec }));
});

bot.command("setlanguage", async (ctx) => {
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));

  const mode = (ctx.message.text.split(" ")[1] || "").trim();
  if (!["auto", "ja", "en", "zh"].includes(mode)) return ctx.reply("Use auto / ja / en / zh");
  setLanguageStmt.run(mode, nowISO(), String(ctx.chat.id));
  await ctx.reply(t(lang, "language_set", { lang: mode }));
});

bot.command("setgif", async (ctx) => {
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
  if (!group.is_premium) return ctx.reply(t(lang, "premium_only"));
  const mode = (ctx.message.text.split(" ")[1] || "").toLowerCase();
  if (!["on", "off"].includes(mode)) return ctx.reply("Use on/off");
  setGifStmt.run(mode === "on" ? 1 : 0, String(ctx.chat.id));
  await ctx.reply("OK");
});

bot.command("setbutton", async (ctx) => {
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
  if (!group.is_premium) return ctx.reply(t(lang, "premium_only"));
  const value = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!value) return ctx.reply("/setbutton <text>");
  setJoinBtnStmt.run(value, String(ctx.chat.id));
  await ctx.reply("OK");
});

bot.command("setwinner", async (ctx) => {
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
  if (!group.is_premium) return ctx.reply(t(lang, "premium_only"));
  const value = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!value || !value.includes("{user}")) return ctx.reply("Need template with {user}");
  setWinnerTplStmt.run(value, String(ctx.chat.id));
  await ctx.reply("OK");
});

bot.command("seteffect", async (ctx) => {
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
  if (!group.is_premium) return ctx.reply(t(lang, "premium_only"));

  const args = ctx.message.text.split(" ").slice(1);
  if (args[0] === "reset") {
    setEffectsStmt.run(null, String(ctx.chat.id));
    return ctx.reply("OK");
  }
  if (args[0] !== "add") return ctx.reply("/seteffect add <text with {a} and {b}> | /seteffect reset");
  const line = args.slice(1).join(" ").trim();
  if (!line.includes("{a}") || !line.includes("{b}")) return ctx.reply("Need {a} and {b}");
  let arr = [];
  if (settings.custom_effects_json) {
    try { arr = JSON.parse(settings.custom_effects_json); } catch (_) {}
  }
  arr.push(line);
  setEffectsStmt.run(JSON.stringify(arr), String(ctx.chat.id));
  await ctx.reply("OK");
});

bot.command("schedule", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return ctx.reply("Use in group only.");
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
  if (!group.is_premium) return ctx.reply(t(lang, "premium_only"));

  const parsed = parseScheduleArgs(ctx.message.text.split(" ").slice(1));
  if (!parsed) return ctx.reply(t(lang, "schedule_usage"));

  const chatId = String(ctx.chat.id);
  deleteSchedulesByChatStmt.run(chatId);
  clearScheduleRunner(chatId);

  const now = nowISO();
  const row = {
    id: uuidv4(),
    chat_id: chatId,
    type: parsed.type,
    time_hhmm: parsed.time_hhmm,
    weekday: parsed.weekday,
    run_at: parsed.run_at,
    created_by_user_id: String(ctx.from.id),
    created_at: now,
    updated_at: now,
  };

  insertScheduleStmt.run(
    row.id,
    row.chat_id,
    row.type,
    row.time_hhmm,
    row.weekday,
    row.run_at,
    row.created_by_user_id,
    row.created_at,
    row.updated_at
  );

  registerSchedule(row);
  await ctx.reply(t(lang, "schedule_saved"));
});

bot.command("unschedule", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) return ctx.reply("Use in group only.");
  const { group, settings } = ensureGroup(ctx);
  const lang = getLang(ctx, group, settings);
  if (!(await isAdmin(ctx))) return ctx.reply(t(lang, "admin_only"));
  if (!group.is_premium) return ctx.reply(t(lang, "premium_only"));

  deleteSchedulesByChatStmt.run(String(ctx.chat.id));
  clearScheduleRunner(String(ctx.chat.id));
  await ctx.reply(t(lang, "schedule_removed"));
});

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  if (ctx?.reply) ctx.reply("An error occurred. Please try again.");
});

seedLicenses();
loadSchedulesOnBoot();
startWebhookServer();

bot.launch().then(() => {
  console.log("Telegram Rumble Bot is running.");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
