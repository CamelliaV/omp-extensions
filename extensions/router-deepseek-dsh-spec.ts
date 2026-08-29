import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type RouterPhase = "anchored" | "promoted";
type FlashBand = "spec" | "react" | "weak";

type RouterState = {
   version: 1;
   phase: RouterPhase;
   model: string;
   fullTools: string[];
   flashBand?: FlashBand;
};

const STATE_TYPE = "io.github.soeur.dsh-router-spec.omp.v1";
const PRO_MODEL_PREFIX = "deepseek-v4-pro";
const FLASH_MODEL_PREFIX = "deepseek-v4-flash";
const PRO_SYSTEM_PROMPT = ["You are a helpful software engineer assistant."];
const PRO_FIRST_TURN_TOOLS = ["read"];
const FLASH_FIRST_TURN_TOOLS: Readonly<Record<FlashBand, readonly string[]>> = {
   spec: ["read", "edit", "glob", "grep"],
   react: ["read", "write", "edit"],
   weak: ["read", "write", "edit"],
};

const FLASH_SPEC_PERSONA =
   "You are a helpful software engineer assistant.\n" +
   "Reason in the first-person plural planning register. Keep that register after every tool result: continue with " +
   "'We found...', 'We need...', or 'We should...'; do not switch to 'I', 'Let me', or impersonal narration.";
const FLASH_REACT_PERSONA =
   "You are a hands-on software engineer who delivers working output fast.\n" +
   "Work directly: write or edit code, then verify it by reading and running. " +
   "Keep the loop tight — produce, verify, fix — and do not build test " +
   "harnesses, scaffolding, or ceremony the user did not ask for. " +
   "Finish with a usable deliverable and a short summary.\n" +
   "Think deeply first, then produce.";
const FLASH_WEAK_PERSONA =
   "You are a helpful assistant.\n" +
   "Before acting, decide the task type (build or fix) and adopt the matching " +
   "style: build → hands-on production; fix → inspect-and-plan.\n" +
   "Before acting, briefly review what you have already done in this session and continue from where you left off; " +
   "do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or " +
   "exhaustive grep/glob scans.\n" +
   "Think deeply first, then produce.";
const FLASH_GUIDE_WEAK =
   "Router: classify this task (build or fix) now, then adopt the matching style — build: direct production; " +
   "fix: inspect-first. Think deeply first, then commit and act.";
const FLASH_GUIDE_DEEP =
   "Router: classify this task (build or fix) now, then adopt the matching style — build: direct production; " +
   "fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend " +
   "reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block " +
   "with a decision or an information need.";

const REACT_TASK_RE =
   /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi;
const SPEC_TASK_RE =
   /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi;
const COMPLEX_TASK_RE =
   /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i;

type LeanToolSchema = {
   description: string;
   parameters: Record<string, unknown>;
};

const LEAN_TOOL_SCHEMAS: Readonly<Record<string, LeanToolSchema>> = {
   bash: {
      description: "Run a command in a persistent shell.",
      parameters: {
         type: "object",
         properties: { command: { type: "string" } },
         required: ["command"],
      },
   },
   pwsh: {
      description: "Run a command in a persistent shell.",
      parameters: {
         type: "object",
         properties: { command: { type: "string" } },
         required: ["command"],
      },
   },
   read: {
      description: "Read a text file.",
      parameters: {
         type: "object",
         properties: { path: { type: "string" } },
         required: ["path"],
      },
   },
};

function rewriteFirstTurnToolSchemas(payload: unknown): unknown {
   if (typeof payload !== "object" || payload === null) return payload;
   const body = payload as Record<string, unknown>;
   if (!Array.isArray(body.tools)) return payload;

   let changed = false;
   const tools = body.tools.map((tool: unknown) => {
      if (typeof tool !== "object" || tool === null) return tool;
      const entry = tool as Record<string, unknown>;
      const providerFunction = entry.function;

      if (typeof providerFunction === "object" && providerFunction !== null) {
         const name = (providerFunction as Record<string, unknown>).name;
         const schema = typeof name === "string" ? LEAN_TOOL_SCHEMAS[name] : undefined;
         if (!schema) return tool;
         changed = true;
         return {
            type: "function",
            function: { name, description: schema.description, parameters: schema.parameters },
         };
      }

      const name = entry.name;
      const schema = typeof name === "string" ? LEAN_TOOL_SCHEMAS[name] : undefined;
      if (!schema) return tool;
      changed = true;
      return { name, description: schema.description, input_schema: schema.parameters };
   });

   return changed ? { ...body, tools } : payload;
}
function classifyFlashTask(text: string): FlashBand {
   const react = text.match(REACT_TASK_RE)?.length ?? 0;
   const spec = text.match(SPEC_TASK_RE)?.length ?? 0;
   if (spec > 0) return "spec";
   if (react > 0) return "react";
   return "weak";
}

function flashSystemPrompt(base: string[], band: FlashBand): string[] {
   if (band === "spec") return [FLASH_SPEC_PERSONA, ...base];
   if (band === "react") return [FLASH_REACT_PERSONA, ...base];
   return [FLASH_WEAK_PERSONA, ...base];
}

function flashGuidance(band: FlashBand, task: string): string {
   if (band === "spec") {
      return "Router: this is a FIX task. Inspect first and reason deeply before repairing. " +
         "Start your reasoning with the exact sentence: 'We need to inspect the code first.' " +
         "Keep using the 'We' planning register in later reasoning blocks after tool results.";
   }
   if (band === "react") {
      return "Router: this is a BUILD task. Use hands-on production, verify the result, and converge. " +
         "Think deeply first, then commit and act.";
   }
   return task.length > 120 || COMPLEX_TASK_RE.test(task) ? FLASH_GUIDE_DEEP : FLASH_GUIDE_WEAK;
}

export default function dshRouterSpec(pi: ExtensionAPI): void {
   let baselineTools: string[] = [];
   let state: RouterState | undefined;
   let changingTools = false;

   pi.setLabel("DSH Router Spec");

   function currentModel(ctx: ExtensionContext) {
      return ctx.model ?? ctx.models.current();
   }

   function currentModelKey(ctx: ExtensionContext): string {
      const model = currentModel(ctx);
      return model ? `${model.provider}/${model.id}` : "未选择";
   }

   function currentModelId(ctx: ExtensionContext): string | undefined {
      return currentModel(ctx)?.id.toLowerCase().split("/").at(-1);
   }

   function isProModel(ctx: ExtensionContext): boolean {
      return (currentModelId(ctx) ?? "").startsWith(PRO_MODEL_PREFIX);
   }

   function isFlashModel(ctx: ExtensionContext): boolean {
      return (currentModelId(ctx) ?? "").startsWith(FLASH_MODEL_PREFIX);
   }

   function isTargetModel(ctx: ExtensionContext): boolean {
      return isProModel(ctx) || isFlashModel(ctx);
   }

   function availableTools(toolNames: string[]): string[] {
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      return [...new Set(toolNames)].filter((name) => available.has(name));
   }

   function firstTurnTools(fullTools: string[], ctx: ExtensionContext): string[] {
      const enabled = new Set(fullTools);
      const tools: string[] = [];
      const shell = ["bash", "pwsh"].find((name) => enabled.has(name));
      if (shell) tools.push(shell);
      const core = isFlashModel(ctx)
         ? FLASH_FIRST_TURN_TOOLS[state?.flashBand ?? "weak"]
         : PRO_FIRST_TURN_TOOLS;
      for (const name of core) {
         if (enabled.has(name)) tools.push(name);
      }
      return tools;
   }

   async function applyTools(toolNames: string[]) {
      changingTools = true;
      try {
         await pi.setActiveTools(availableTools(toolNames));
      } finally {
         changingTools = false;
      }
   }

   function latestState(ctx: ExtensionContext): RouterState | undefined {
      let latest: RouterState | undefined;
      for (const entry of ctx.sessionManager.getBranch()) {
         if (entry.type === "custom" && entry.customType === STATE_TYPE) {
            latest = entry.data as RouterState;
         }
      }
      return latest;
   }

   function hasAssistantHistory(ctx: ExtensionContext): boolean {
      return ctx.sessionManager
         .getBranch()
         .some((entry) => entry.type === "message" && entry.message.role === "assistant");
   }

   function persistState() {
      if (state) pi.appendEntry<RouterState>(STATE_TYPE, state);
   }

   async function restoreSession(ctx: ExtensionContext) {
      state = latestState(ctx);
      if (!state) {
         await applyTools(baselineTools);
         return;
      }

      if (state.phase === "anchored" && isTargetModel(ctx)) {
         await applyTools(firstTurnTools(state.fullTools, ctx));
         return;
      }

      await applyTools(state.fullTools);
   }

   async function promote(ctx: ExtensionContext, reason: "tool_call" | "turn_end") {
      if (state?.phase !== "anchored" || changingTools || !isTargetModel(ctx)) return;

      await applyTools(state.fullTools);
      state = { ...state, phase: "promoted" };
      persistState();
      pi.logger.debug(`dsh-router-spec: promoted after ${reason}`, {
         model: state.model,
         toolCount: state.fullTools.length,
      });
   }

   pi.on("session_start", async (_event, ctx) => {
      baselineTools = pi.getActiveTools();
      await restoreSession(ctx);
   });

   pi.on("session_switch", async (_event, ctx) => {
      await restoreSession(ctx);
   });

   pi.on("session_branch", async (_event, ctx) => {
      await restoreSession(ctx);
   });

   pi.on("session_tree", async (_event, ctx) => {
      await restoreSession(ctx);
   });

   pi.on("before_agent_start", async (event, ctx) => {
      if (!isTargetModel(ctx)) {
         if (state?.phase === "anchored") await applyTools(state.fullTools);
         return;
      }

      if (state?.phase === "promoted" && isProModel(ctx)) return;

      if (!state) {
         if (hasAssistantHistory(ctx)) return;

         const fullTools = pi.getActiveTools();
         state = {
            version: 1,
            phase: "anchored",
            model: currentModelKey(ctx),
            fullTools,
            flashBand: isFlashModel(ctx) ? classifyFlashTask(event.prompt) : undefined,
         };
         persistState();
         pi.logger.debug("dsh-router-spec: anchored", {
            model: state.model,
            band: state.flashBand ?? "pro-we",
            tools: firstTurnTools(fullTools, ctx),
         });
         if (ctx.hasUI) {
            const route = state.flashBand ? `Flash ${state.flashBand}` : "Pro We";
            ctx.ui.notify(`DSH Router Spec 已锚定：${route}`, "info");
         }
      } else if (isFlashModel(ctx) && !state.flashBand) {
         state = { ...state, flashBand: classifyFlashTask(event.prompt) };
         persistState();
      }

      if (isFlashModel(ctx)) {
         if (state.phase === "anchored") {
            await applyTools(firstTurnTools(state.fullTools, ctx));
         }
         const band = state.flashBand ?? "weak";
         pi.logger.debug("dsh-router-spec: Flash base prompt ready", {
            parts: event.systemPrompt.length,
            chars: event.systemPrompt.reduce((total, part) => total + part.length, 0),
         });
         return {
            systemPrompt: flashSystemPrompt(event.systemPrompt, band),
            message: {
               customType: "dsh-router-guidance",
               content: flashGuidance(band, event.prompt),
               display: false,
               attribution: "user",
            },
         };
      }

      await applyTools(firstTurnTools(state.fullTools, ctx));
      return { systemPrompt: PRO_SYSTEM_PROMPT };
   });

   pi.on("before_provider_request", async (event, ctx) => {
      if (state?.phase !== "anchored" || !isProModel(ctx)) return;
      const payload = rewriteFirstTurnToolSchemas(event.payload);
      pi.logger.debug("dsh-router-spec: injected Pro lean tool schemas", {
         model: currentModelKey(ctx),
         tools: firstTurnTools(state.fullTools, ctx),
      });
      return payload;
   });

   pi.on("tool_call", async (event, ctx) => {
      if (state?.phase !== "anchored" || !isTargetModel(ctx)) return;

      let revisedInput: Record<string, unknown> | undefined;
      if (isProModel(ctx)) {
         const input = event.input as Record<string, unknown>;
         const intent = typeof input.i === "string" ? input.i : undefined;
         if (event.toolName === "bash" || event.toolName === "pwsh") {
            revisedInput = { ...input, i: intent ?? "Executing anchored command" };
         } else if (event.toolName === "read") {
            revisedInput = { ...input, i: intent ?? "Reading anchored file" };
         }
      }

      await promote(ctx, "tool_call");
      return revisedInput ? { input: revisedInput } : undefined;
   });

   pi.on("turn_end", async (_event, ctx) => {
      await promote(ctx, "turn_end");
   });

   pi.registerCommand("dsh-router-status", {
      description: "显示 DeepSeek V4 Pro/Flash 的 DSH spec 轨迹路由状态",
      handler: async (_args, ctx) => {
         state = latestState(ctx) ?? state;
         const ready = isTargetModel(ctx) && !state && !hasAssistantHistory(ctx);
         const phase = state?.phase ?? (ready ? "ready" : "inactive");
         const fullTools = state?.fullTools ?? baselineTools;
         ctx.ui.notify(
            [
               `模型：${currentModelKey(ctx)}`,
               `状态：${phase}`,
               `路由：${state?.flashBand ?? (isProModel(ctx) ? "pro-we" : "未分类")}`,
               `首轮工具：${firstTurnTools(fullTools, ctx).join(", ") || "无"}`,
            ].join("\n"),
            isTargetModel(ctx) ? "info" : "warning",
         );
      },
   });
}
