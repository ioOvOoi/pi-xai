import { describe, expect, test, beforeEach } from "vitest";
import {
  applyUpdateGoal,
  clearGoal,
  formatGoalStatus,
  getGoalState,
  goalInstruction,
  pauseGoal,
  resumeGoal,
  setGoal,
} from "../src/protocol/xai-goal.ts";

describe("xai-goal (Grok Build lean port)", () => {
  beforeEach(() => clearGoal());

  test("goalInstruction carries objective and update_goal contract", () => {
    const text = goalInstruction("ship the widget");
    expect(text).toContain("ship the widget");
    expect(text).toContain("update_goal(completed: true");
    expect(text).toContain("blocked_reason");
  });

  test("lifecycle: set → progress → complete", () => {
    setGoal("ship widget");
    expect(getGoalState()?.status).toBe("active");
    expect(applyUpdateGoal({ message: "scaffolded" }).ok).toBe(true);
    const done = applyUpdateGoal({ completed: true, message: "shipped" });
    expect(done.ok).toBe(true);
    expect(getGoalState()?.status).toBe("completed");
    expect(applyUpdateGoal({ message: "late" }).ok).toBe(false);
  });

  test("pause / resume / block", () => {
    setGoal("fix pause");
    pauseGoal();
    expect(getGoalState()?.status).toBe("paused");
    expect(applyUpdateGoal({ message: "nope" }).ok).toBe(false);
    resumeGoal();
    expect(applyUpdateGoal({ blocked_reason: "stuck thrice" }).ok).toBe(true);
    expect(getGoalState()?.status).toBe("blocked");
    expect(formatGoalStatus()).toContain("stuck thrice");
  });
});
