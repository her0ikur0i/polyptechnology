import type { FailureReason, TaskState } from "./types.js";
export const transitionMap:Readonly<Record<TaskState,ReadonlySet<TaskState>>>={draft:new Set(["queued","cancelled"]),queued:new Set(["cancelled","budget_blocked","failed"]),leased:new Set(["running","queued","cancelled"]),running:new Set(["verifying","retry_wait","queued","needs_approval","budget_blocked","failed","cancelled"]),verifying:new Set(["succeeded","retry_wait","queued","budget_blocked","failed"]),retry_wait:new Set(["queued","cancelled","budget_blocked"]),needs_approval:new Set(["queued","cancelled"]),budget_blocked:new Set(["queued","cancelled"]),succeeded:new Set(),failed:new Set(),cancelled:new Set()};
export const workerStates=new Set<TaskState>(["leased","running","verifying"]);
export const controlSources=new Set<TaskState>(["draft","queued","retry_wait","needs_approval","budget_blocked"]);
export function canTransition(from:TaskState,to:TaskState):boolean{return transitionMap[from].has(to);}
export function retryable(reason:FailureReason):boolean{return reason!=="authentication"&&reason!=="policy"&&reason!=="budget";}
