/**
 * Telegram client for Pi Durable harness.
 *
 * Unlike the pi-coding-agent extension which hooks into agent lifecycle,
 * this is a client that:
 * 1. Receives messages via grammY bot
 * 2. Submits them to the harness via conversation.submit()
 * 3. Watches events via watchEvents() to stream responses back
 * 4. Sends queued attachments after the turn completes
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bot, Context as GrammyContext, InputFile, InlineKeyboard } from "grammy";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Conversation } from "@earendil-works/pi-durable";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { watchEvents, type AgentEvent, type AgentEventStream } from "@earendil-works/pi-durable";
import { createTelegramSharedState, VALID_REACTIONS, type TelegramSharedState, type TelegramButton, type ReplyKeyboard } from "./shared-state.js";

export { createTelegramSharedState, VALID_REACTIONS, type TelegramSharedState, type TelegramButton, type ReplyKeyboard } from "./shared-state.js";

export interface TelegramClientConfig {
  botToken: string;
  ownerId: number;
  tempDir?: string;
  /** Shared state for extension coordination. If not provided, creates internal state. */
  sharedState?: TelegramSharedState;
}

export interface TelegramClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Send a notification to the owner (for background task completions) */
  notify(message: string): Promise<void>;
}

const MAX_MESSAGE_LENGTH = 4096;
const PREVIEW_THROTTLE_MS = 750;

export async function createTelegramClient(
  harness: Harness,
  config: TelegramClientConfig,
): Promise<TelegramClient> {
  const context = BACKGROUND_CONTEXT;
  const bot = new Bot(config.botToken);
  const tempDir = config.tempDir ?? join(process.env.WOLF_DEN ?? "/tmp", "telegram");
  
  // Use provided shared state or create internal (for backwards compat)
  const telegramState = config.sharedState ?? createTelegramSharedState();

  // Track the owner's chat ID for bot API access
  let ownerChatId: number | undefined;
  let lastSentMessageId: number | undefined;

  // Expose direct bot API for pin/edit/unpin tools
  telegramState.botApi = {
    async pinChatMessage(chatId: number, messageId: number) {
      await bot.api.pinChatMessage(chatId, messageId, { disable_notification: true });
    },
    async unpinChatMessage(chatId: number, messageId: number) {
      await bot.api.unpinChatMessage(chatId, messageId);
    },
    async editMessageText(chatId: number, messageId: number, text: string, parseMode?: string) {
      await bot.api.editMessageText(chatId, messageId, text, parseMode ? { parse_mode: parseMode as any } : undefined);
    },
    getChatId() { return ownerChatId; },
    getLastMessageId() { return lastSentMessageId; },
  };

  // Track active streams per chat
  const activeStreams = new Map<number, {
    stream: AgentEventStream;
    conversationId: string;
    pendingText: string;
    lastSentText: string;
    messageId?: number;
    replyToId?: number;
    flushTimer?: ReturnType<typeof setTimeout>;
    listening: boolean;  // Only process events when true (prevents snapshot replay)
  }>();

  // Track pending media groups (multiple photos sent together)
  const pendingMediaGroups = new Map<string, {
    chatId: number;
    messageId: number;
    caption: string;
    images: Array<{ data: string; mediaType: string }>;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Get root conversation
  let root: Conversation;

  async function sendOrUpdateMessage(
    chatId: number,
    text: string,
    replyTo?: number,
    buttons?: TelegramButton[][],
    replyKeyboard?: ReplyKeyboard,
  ): Promise<number> {
    const state = activeStreams.get(chatId);
    
    // Truncate if too long
    const truncated = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + "\n\n...(truncated)"
      : text;

    // Build markup - inline keyboard takes priority, then reply keyboard
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let reply_markup: any;
    if (buttons && buttons.length > 0) {
      const kb = new InlineKeyboard();
      for (const row of buttons) {
        for (const btn of row) {
          kb.text(btn.text, btn.callbackData);
        }
        kb.row();
      }
      reply_markup = kb;
    } else if (replyKeyboard) {
      // Reply keyboard (persistent keyboard below input)
      reply_markup = {
        keyboard: replyKeyboard.keyboard.map(row => row.map(text => ({ text }))),
        one_time_keyboard: replyKeyboard.oneTime ?? true,
        resize_keyboard: replyKeyboard.resize ?? true,
      };
    }

    if (state?.messageId && !buttons && !replyKeyboard) {
      // Update existing message (only if no new buttons/keyboard)
      try {
        await bot.api.editMessageText(chatId, state.messageId, truncated, {
          parse_mode: "Markdown",
        });
        return state.messageId;
      } catch {
        // If edit fails (e.g., message unchanged), try sending new
      }
    }
    
    // Send new message - try Markdown, fall back to plain text if parsing fails
    let sent;
    try {
      sent = await bot.api.sendMessage(chatId, truncated, {
        parse_mode: "Markdown",
        reply_markup,
      });
    } catch (e) {
      // Markdown parsing failed, send as plain text
      sent = await bot.api.sendMessage(chatId, truncated, {
        reply_markup,
      });
    }
    
    // Log outgoing message
    const preview = truncated.length > 60 ? truncated.slice(0, 57) + "..." : truncated;
    const extras = [buttons?.length && `${buttons.flat().length} btn`, replyKeyboard && "kbd"].filter(Boolean);
    console.log(`[tg] \u2192 ${preview}${extras.length ? ` [${extras.join(", ")}]` : ""}`);
    
    lastSentMessageId = sent.message_id;
    return sent.message_id;
  }

  async function sendAttachments(chatId: number, conversationId: string): Promise<void> {
    const attachments = telegramState.queuedAttachments.get(conversationId);
    if (!attachments || attachments.length === 0) return;

    for (const attachment of attachments) {
      try {
        const fileData = await readFile(attachment.path);
        const inputFile = new InputFile(fileData, attachment.fileName);
        
        // Determine file type by extension
        const ext = attachment.fileName.toLowerCase().split('.').pop();
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext ?? '');
        
        if (isImage) {
          await bot.api.sendPhoto(chatId, inputFile);
        } else {
          await bot.api.sendDocument(chatId, inputFile);
        }
      } catch (err) {
        console.error(`[telegram] Failed to send attachment ${attachment.fileName}:`, err);
        await bot.api.sendMessage(chatId, `Failed to send: ${attachment.fileName}`);
      }
    }

    // Clear queued attachments
    telegramState.queuedAttachments.delete(conversationId);
  }

  async function downloadTelegramFile(fileId: string, fileName: string): Promise<string> {
    await mkdir(tempDir, { recursive: true });
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error("No file path returned");

    const url = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const localPath = join(tempDir, `${Date.now()}-${fileName}`);
    await writeFile(localPath, buffer);
    return localPath;
  }

  function scheduleFlush(chatId: number): void {
    const state = activeStreams.get(chatId);
    if (!state) return;

    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
    }

    state.flushTimer = setTimeout(async () => {

      if (state.pendingText && state.pendingText !== state.lastSentText) {
        try {
          const msgId = await sendOrUpdateMessage(chatId, state.pendingText, state.replyToId);
          state.messageId = msgId;
          state.lastSentText = state.pendingText;
        } catch (err) {
          console.error("[telegram] flush error:", err);
        }
      }
    }, PREVIEW_THROTTLE_MS);
  }

  async function handleEvents(chatId: number, events: readonly AgentEvent[]): Promise<void> {
    const state = activeStreams.get(chatId);
    if (!state) return;
    

    
    if (!state.listening) return;

    for (const event of events) {
      if (event.type === "message_update" && state.listening) {
        // Track text and log tool calls
        for (const change of event.changes) {
          if (change.type === "text_delta") {
            state.pendingText += change.delta;
          } else if (change.type === "toolcall_start") {
            const tc = change as { name?: string };
            if (tc.name) {
              console.log(`[tg] ⚙ ${tc.name}`);
              // Notify user of long-running tool calls
              const longRunning = ["kb_reorg", "kb_sweep_start", "memory_consolidate"];
              if (longRunning.includes(tc.name)) {
                try {
                  await bot.api.sendMessage(chatId, `⚙️ Running ${tc.name}...`);
                } catch { /* ignore send errors */ }
              }
            }
          }
        }
      } else if (event.type === "tool_execution_start" && state.listening) {
        const toolEvent = event as { toolName?: string };
        if (toolEvent.toolName) {
          console.log(`[tg] ⚙ ${toolEvent.toolName}`);
          const longRunning = ["kb_reorg", "kb_sweep_start", "memory_consolidate"];
          if (longRunning.includes(toolEvent.toolName)) {
            try {
              await bot.api.sendMessage(chatId, `⚙️ Running ${toolEvent.toolName}...`);
            } catch { /* ignore */ }
          }
        }
      } else if (event.type === "message_end" && state.listening) {
        // Extract text from the completed message entry
        const entry = (event as { entry?: { value?: { content?: Array<{ type: string; text?: string }> } } }).entry;
        if (entry?.value?.content) {
          const text = entry.value.content
            .filter((b): b is { type: string; text: string } => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("");
          if (text && !state.pendingText) {
            state.pendingText = text;

          }
        }
      } else if (event.type === "run_end" && state.listening) {
        console.log(`[tg] Run complete`);
        // Run completed - clear timers (we use submission.wait for sending)
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
        }
        // Send any queued attachments
        await sendAttachments(chatId, state.conversationId);
        // Stop listening but keep stream alive for next message
        state.listening = false;
        state.pendingText = "";
        state.lastSentText = "";
        state.messageId = undefined;
      }
    }
  }

  interface ImageAttachment {
    data: string;  // base64
    mediaType: string;
  }

  async function handleMessage(ctx: GrammyContext, messageText: string, replyToId?: number, images?: ImageAttachment[]): Promise<void> {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;

    if (!chatId || !userId) return;

    // Owner check
    if (config.ownerId && userId !== config.ownerId) {
      await ctx.reply("Not authorized.");
      return;
    }

    // Track owner chat ID for bot API tools
    ownerChatId = chatId;

    // Log incoming message
    const preview = messageText.length > 60 ? messageText.slice(0, 57) + "..." : messageText;
    console.log(`[tg] ← ${preview}${images?.length ? ` +${images.length} img` : ""}`);

    try {
      // Send typing indicator
      await ctx.replyWithChatAction("typing");

      // Reuse existing stream or create new one
      let state = activeStreams.get(chatId);
      if (!state) {
        const stream = await watchEvents(harness, root.id, context);
        state = {
          stream,
          conversationId: String(root.id),
          pendingText: "",
          lastSentText: "",
          replyToId,
          listening: false,
        };
        activeStreams.set(chatId, state);

        // Start event listener (runs for all future events)
        state.stream.start(async (events) => {
          await handleEvents(chatId, events);
        });
      } else {
        // Reset state for new message
        state.pendingText = "";
        state.lastSentText = "";
        state.messageId = undefined;
        state.replyToId = replyToId;
      }

      // Enable listening BEFORE submit to catch all events
      state.listening = true;
      console.log(`[tg] Submitting...`);
      
      // Build content - text only or with images
      type TextContent = { type: "text"; text: string };
      type ImageContent = { type: "image"; data: string; mimeType: string };
      let content: string | (TextContent | ImageContent)[];
      if (images && images.length > 0) {
        const blocks: (TextContent | ImageContent)[] = [
          { type: "text", text: `[telegram] ${messageText}` },
        ];
        for (const img of images) {
          blocks.push({
            type: "image",
            data: img.data,
            mimeType: img.mediaType,
          });
        }
        content = blocks;
      } else {
        content = `[telegram] ${messageText}`;
      }
      
      const submission = await root.submit(
        { type: "input", content },
        context,
      );
      
      // Keep typing indicator alive while waiting (expires every ~5s)
      const typingInterval = setInterval(async () => {
        try { await ctx.replyWithChatAction("typing"); } catch { /* ignore */ }
      }, 4000);
      
      // Wait for the submission to be answered
      let settled;
      try {
        settled = await submission.wait(context);
      } finally {
        clearInterval(typingInterval);
      }
      const settledAny = settled as { status: string; type: string; answer?: unknown };
      console.log(`[tg] Settled:`, JSON.stringify(settledAny).slice(0, 300));
      if (settledAny.status === "done" && settledAny.type === "input" && settledAny.answer) {
        const answerId = settledAny.answer;
        // Read the answer entry
        const answer = await root.commit(
          (tx) => tx.entry(AssistantEntry, answerId as Parameters<typeof tx.entry>[1]),
          context,
        );
        console.log(`[tg] Answer keys:`, answer ? Object.keys(answer) : 'null');
        if (answer?.model) {
          const content = answer.model as unknown as Array<{ type?: string; text?: string; content?: Array<{ type: string; text?: string }> }>;
          console.log(`[tg] Response content:`, JSON.stringify(content).slice(0, 800));
          // Extract text from assistant message content
          let text = "";
          for (const block of content) {
            if (block.type === "text" && block.text) {
              text += block.text;
            } else if (block.content) {
              // Nested content structure
              for (const inner of block.content) {
                if (inner.type === "text" && inner.text) {
                  text += inner.text;
                }
              }
            }
          }
          // Get queued items
          const convId = String(root.id);
          const buttons = telegramState.queuedButtons.get(convId);
          const replyKeyboard = telegramState.queuedReplyKeyboards.get(convId);
          const reaction = telegramState.queuedReactions.get(convId);
          telegramState.queuedButtons.delete(convId);
          telegramState.queuedReplyKeyboards.delete(convId);
          telegramState.queuedReactions.delete(convId);

          // Send reaction if queued
          if (reaction && replyToId) {
            // Validate reaction is Telegram-allowed
            const validReaction = VALID_REACTIONS.has(reaction) ? reaction : "👍";
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await bot.api.setMessageReaction(chatId, replyToId, [{ type: "emoji", emoji: validReaction as any }]);
            } catch {
              // Reaction failed - not critical
            }
          }

          // Send text response if any
          if (text) {
            await sendOrUpdateMessage(chatId, text, replyToId, buttons, replyKeyboard);
          } else {
            console.log(`[tg] No text extracted from response`);
          }
        }
      }
    } catch (err) {
      console.error("[telegram] error handling message:", err);
      try {
        await ctx.reply("Error processing message.");
      } catch {
        // May fail if ctx is from callback_query
      }
      activeStreams.delete(chatId);
    }
  }

  // Handle text messages (includes reply keyboard button taps)
  bot.on("message:text", async (ctx) => {
    const text = ctx.message?.text;
    if (!text) return;
    await handleMessage(ctx, text, ctx.message?.message_id);
  });

  // Handle inline button callback queries
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery?.data;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;

    if (!data || !chatId || !userId) return;

    // Owner check
    if (config.ownerId && userId !== config.ownerId) {
      await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
      return;
    }

    // Acknowledge immediately (must happen within ~10s or Telegram times out)
    await ctx.answerCallbackQuery().catch(() => {});
    // Remove buttons from the clicked message to prevent stale clicks
    try {
      const originalText = ctx.callbackQuery?.message?.text ?? "";
      // Find the button's display text (not callback_data)
      const keyboard = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard ?? [];
      let buttonText = data;  // Fallback to callback_data
      for (const row of keyboard) {
        for (const btn of row) {
          if ("callback_data" in btn && btn.callback_data === data) {
            buttonText = btn.text;
            break;
          }
        }
      }
      await ctx.editMessageText(`${originalText}\n\n✓ _${buttonText}_`, { parse_mode: "Markdown" });
    } catch {
      // May fail if message is too old or already edited
    }

    try {
      // Submit callback data as a message to the harness
      await handleMessage(ctx as unknown as GrammyContext, data, ctx.callbackQuery?.message?.message_id);
    } catch (err) {
      console.error("[telegram] callback_query error:", err);
    }
  });

  // Helper to download a photo as base64
  async function downloadPhoto(fileId: string): Promise<{ data: string; mediaType: string }> {
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error("No file path returned");

    const url = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "jpg";
    const mediaType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";

    return { data: buffer.toString("base64"), mediaType };
  }

  // Handle photos (including media groups)
  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message?.photo;
    const caption = ctx.message?.caption ?? "";
    const mediaGroupId = ctx.message?.media_group_id;
    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    
    if (!photo || photo.length === 0 || !chatId || !messageId) return;

    try {
      const largest = photo[photo.length - 1];
      const imageData = await downloadPhoto(largest.file_id);

      if (mediaGroupId) {
        // Part of a media group - collect and wait for more
        let group = pendingMediaGroups.get(mediaGroupId);
        if (!group) {
          group = {
            chatId,
            messageId,
            caption: caption || "[Photos attached]",
            images: [],
            timer: setTimeout(async () => {
              // Process the collected group
              const g = pendingMediaGroups.get(mediaGroupId);
              if (g) {
                pendingMediaGroups.delete(mediaGroupId);
                await handleMessage(ctx, g.caption, g.messageId, g.images);
              }
            }, 500),  // Wait 500ms for more photos
          };
          pendingMediaGroups.set(mediaGroupId, group);
        } else {
          // Update caption if this message has one
          if (caption) group.caption = caption;
          // Reset timer
          clearTimeout(group.timer);
          group.timer = setTimeout(async () => {
            const g = pendingMediaGroups.get(mediaGroupId);
            if (g) {
              pendingMediaGroups.delete(mediaGroupId);
              await handleMessage(ctx, g.caption, g.messageId, g.images);
            }
          }, 500);
        }
        group.images.push(imageData);
      } else {
        // Single photo - process immediately
        const text = caption || "[Photo attached]";
        await handleMessage(ctx, text, messageId, [imageData]);
      }
    } catch (err) {
      console.error("[telegram] photo download error:", err);
      await ctx.reply("Failed to process photo.");
    }
  });

  // Handle documents
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message?.document;
    const caption = ctx.message?.caption ?? "";
    if (!doc) return;

    try {
      const fileName = doc.file_name ?? "document";
      const localPath = await downloadTelegramFile(doc.file_id, fileName);
      const text = caption
        ? `${caption}\n\n[Attached file: ${localPath}]`
        : `[Attached file: ${localPath}]`;
      await handleMessage(ctx, text, ctx.message?.message_id);
    } catch (err) {
      console.error("[telegram] document download error:", err);
      await ctx.reply("Failed to process document.");
    }
  });

  // Global error handler to prevent crashes
  bot.catch((err) => {
    console.error("[telegram] Bot error:", err.message);
  });

  return {
    async start() {
      root = await harness.root(context);
      console.log("[telegram] Bot starting with token:", config.botToken.slice(0, 10) + "...");
      console.log("[telegram] Owner ID:", config.ownerId);
      
      // Test the token first
      try {
        const me = await bot.api.getMe();
        console.log(`[telegram] Bot verified: @${me.username}`);
      } catch (err) {
        console.error("[telegram] Failed to verify bot:", err);
        return;
      }
      
      bot.start({
        onStart: (info) => {
          console.log(`[telegram] Bot @${info.username} connected and polling`);
        },
      }).catch((err) => {
        console.error("[telegram] Bot error:", err);
      });
    },

    async stop() {
      console.log("[telegram] Bot stopping...");
      for (const [, state] of activeStreams) {
        if (state.flushTimer) clearTimeout(state.flushTimer);
        await state.stream.stop();
      }
      activeStreams.clear();
      await bot.stop();
    },

    async notify(message: string) {
      try {
        await bot.api.sendMessage(config.ownerId, message);
      } catch (err) {
        console.error("[telegram] notify failed:", err instanceof Error ? err.message : err);
      }
    },
  };
}
