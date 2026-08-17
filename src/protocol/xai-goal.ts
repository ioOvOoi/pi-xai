/**
 * Grok Build–style goal mode for Pi (lean port).
 *
 * Official: `/goal <objective>` + tool `update_goal` (xai-org/grok-build).
 * No classifier / subagent harness — session state + pursuit instructions.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const UPDATE_GOAL_TOOL_NAME = "update_goal";
export const GOAL_COMMAND_NAME = "goal";

export type GoalStatus = "active" | "paused" | "blocked" | "completed";

export interface GoalState {
  objective: string;
  status: GoalStatus;
  log: string[];
  blockedReason?: string;
  updatedAt: number;
}

let goal: GoalState | undefined;

export function getGoalState(): GoalState | undefined {
  return goal ? { ...goal, log: [...goal.log] } : undefined;
}

export function goalUsageMessage(): string {
  return (
    "Usage: /goal <objective>\n" +
    "  /goal status | pause | resume | clear\n" +
    "Set an objective to work toward until complete (Grok Build style)."
  );
}

export function goalInstruction(objective: string): string {
  return (
    `# /goal — pursue an objective\n\n` +
    `A goal has been set: ${objective}\n\n` +
    `Work directly on this goal and carry it as far as you can. Deliver ` +
    `everything the user asked for yourself: no follow-up questions, no ` +
    `manual steps left for the user. If the conversation continues, keep ` +
    `pursuing the goal until it is complete.\n\n` +
    `TRACKING: break the objective into concrete steps and track them ` +
    `(use a todo tool if available), marking each done as you finish it.\n\n` +
    `VERIFY AS YOU GO: test each change on the real path before moving on. ` +
    `A completion claim must be backed by evidence produced in this session, ` +
    `not assumptions.\n\n` +
    `Call update_goal(completed: true, message: "summary") ONLY when the ` +
    `goal is fully achieved. Call update_goal(blocked_reason: "reason") ` +
    `only when truly stuck after 3+ consecutive failed attempts at the ` +
    `same problem. Call update_goal(message: "status note") to log ` +
    `progress along the way. If update_goal returns an error, continue ` +
    `working the goal and report status in your reply instead.\n\n` +
    `Start now.`
  );
}

function pushLog(line: string): void {
  if (!goal) return;
  goal.log.push(line);
  if (goal.log.length > 40) goal.log = goal.log.slice(-40);
  goal.updatedAt = Date.now();
}

export function setGoal(objective: string): GoalState {
  const o = objective.trim();
  if (!o) throw new Error("empty objective");
  goal = {
    objective: o,
    status: "active",
    log: [`set: ${o}`],
    updatedAt: Date.now(),
  };
  return goal;
}

export function clearGoal(): void {
  goal = undefined;
}

export function pauseGoal(): GoalState {
  if (!goal) throw new Error("No active goal. Use /goal <objective> first.");
  if (goal.status === "completed") throw new Error("Goal already completed.");
  goal.status = "paused";
  pushLog("paused");
  return goal;
}

export function resumeGoal(): GoalState {
  if (!goal) throw new Error("No active goal. Use /goal <objective> first.");
  if (goal.status === "completed") throw new Error("Goal already completed. Set a new /goal.");
  goal.status = "active";
  delete goal.blockedReason;
  pushLog("resumed");
  return goal;
}

export function applyUpdateGoal(input: {
  completed?: boolean;
  message?: string;
  blocked_reason?: string;
}): { ok: boolean; summary: string; state?: GoalState } {
  if (!goal || goal.status === "completed") {
    return {
      ok: false,
      summary:
        "No active goal to update. User should run /goal <objective> first (goal harness off).",
    };
  }
  if (goal.status === "paused" && !input.completed && !input.blocked_reason) {
    return {
      ok: false,
      summary: "Goal is paused. User must /goal resume before progress updates.",
    };
  }

  const msg = input.message?.trim();
  const blocked = input.blocked_reason?.trim();

  if (blocked) {
    goal.status = "blocked";
    goal.blockedReason = blocked;
    pushLog(`blocked: ${blocked}`);
    return {
      ok: true,
      summary: `Goal blocked: ${blocked}. Waiting for user to /goal resume or clear.`,
      state: getGoalState(),
    };
  }

  if (input.completed) {
    goal.status = "completed";
    pushLog(msg ? `completed: ${msg}` : "completed");
    const summary = msg ? `Goal completed: ${msg}` : `Goal completed: ${goal.objective}`;
    return { ok: true, summary, state: getGoalState() };
  }

  if (msg) {
    if (goal.status === "blocked") {
      goal.status = "active";
      delete goal.blockedReason;
    }
    pushLog(msg);
    return { ok: true, summary: `Progress logged: ${msg}`, state: getGoalState() };
  }

  return {
    ok: false,
    summary: "update_goal requires message, completed: true, or blocked_reason.",
  };
}

export function formatGoalStatus(): string {
  if (!goal) return "No goal set. /goal <objective>";
  const lines = [`Goal: ${goal.objective}`, `Status: ${goal.status}`];
  if (goal.blockedReason) lines.push(`Blocked: ${goal.blockedReason}`);
  if (goal.log.length) {
    lines.push("Log:");
    for (const line of goal.log.slice(-8)) lines.push(`  - ${line}`);
  }
  return lines.join("\n");
}

async function kickoffGoal(
  ctx: {
    ui: { notify: (m: string, l?: string) => void };
    sendUserMessage?: (c: string) => Promise<void>;
  },
  instruction: string,
  fallback: string,
): Promise<void> {
  const send = (ctx as { sendUserMessage?: (c: string) => Promise<void> }).sendUserMessage;
  if (typeof send === "function") {
    await send.call(ctx, instruction);
    return;
  }
  ctx.ui.notify(fallback, "info");
}

export function registerXaiGoal(api: ExtensionAPI): void {
  api.registerTool(
    defineTool({
      name: UPDATE_GOAL_TOOL_NAME,
      label: "update_goal",
      description:
        "Report progress on the active goal set via /goal. Use message for status, completed:true when fully done, or blocked_reason when stuck after 3+ failed attempts.",
      parameters: Type.Object({
        completed: Type.Optional(
          Type.Boolean({
            description:
              "Set true ONLY when the goal is fully achieved. Ends goal mode. Prefer with message summary.",
          }),
        ),
        message: Type.Optional(
          Type.String({ description: "Short progress note or completion summary." }),
        ),
        blocked_reason: Type.Optional(
          Type.String({
            description:
              "Only when truly stuck after 3+ consecutive failures. Pauses goal as blocked.",
          }),
        ),
      }),
      async execute(_id, params) {
        const p = params as {
          completed?: boolean;
          message?: string;
          blocked_reason?: string;
        };
        const result = applyUpdateGoal(p);
        return {
          content: [{ type: "text", text: result.summary }],
          details: result,
        };
      },
    }),
  );

  api.registerCommand(GOAL_COMMAND_NAME, {
    description: "Grok Build–style goal mode: /goal <objective> | status | pause | resume | clear",
    async handler(args, ctx) {
      const raw = (args ?? "").trim();
      const first = raw.split(/\s+/)[0]?.toLowerCase() ?? "";

      if (!raw || first === "help") {
        ctx.ui.notify(goalUsageMessage(), "info");
        return;
      }

      if (first === "status") {
        ctx.ui.notify(formatGoalStatus(), "info");
        return;
      }

      if (first === "clear") {
        clearGoal();
        try {
          ctx.ui.setStatus("xai-goal", undefined);
        } catch {
          /* ignore */
        }
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }

      if (first === "pause") {
        try {
          pauseGoal();
          ctx.ui.notify(`Goal paused: ${getGoalState()!.objective}`, "info");
          try {
            ctx.ui.setStatus("xai-goal", "⏸ goal paused");
          } catch {
            /* ignore */
          }
        } catch (e) {
          ctx.ui.notify(String((e as Error).message || e), "warning");
        }
        return;
      }

      if (first === "resume") {
        try {
          resumeGoal();
          const g = getGoalState()!;
          const instruction = goalInstruction(g.objective);
          try {
            ctx.ui.setStatus(
              "xai-goal",
              `🎯 ${g.objective.length > 36 ? g.objective.slice(0, 33) + "…" : g.objective}`,
            );
          } catch {
            /* ignore */
          }
          await kickoffGoal(ctx as any, instruction, `Goal resumed: ${g.objective}`);
        } catch (e) {
          ctx.ui.notify(String((e as Error).message || e), "warning");
        }
        return;
      }

      let objective = raw;
      if (first === "edit") {
        objective = raw.slice(first.length).trim();
        if (!objective) {
          ctx.ui.notify("Usage: /goal edit <new objective>", "warning");
          return;
        }
      }

      try {
        setGoal(objective);
        const short = objective.length > 36 ? objective.slice(0, 33) + "…" : objective;
        try {
          ctx.ui.setStatus("xai-goal", `🎯 ${short}`);
        } catch {
          /* ignore */
        }
        const instruction = goalInstruction(objective);
        await kickoffGoal(ctx as any, instruction, `Goal set: ${objective}`);
      } catch (e) {
        ctx.ui.notify(String((e as Error).message || e), "error");
      }
    },
  });

  // Session-scoped memory: drop goal when session is replaced.
  api.on("session_start", (event) => {
    if (event.reason === "startup") return; // keep if same process warm path ever reuses
    clearGoal();
  });

  api.on("before_agent_start", async () => {
    if (!goal || goal.status !== "active") return;
    return {
      message: {
        customType: "xai-goal",
        content: `Active goal (${goal.status}): ${goal.objective}\nUse update_goal for progress/completion.`,
        display: false,
      },
    };
  });
}
