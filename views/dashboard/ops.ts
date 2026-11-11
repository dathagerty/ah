// jj operations the dashboard runs for a tab: what the page may ask for
// (resolveOp), and running it in the tab's workspace (runOp).

// TODO(david): doc
export type OpResult =
  | { ok: true; args: string[] }
  | { ok: false; status: 400; error: string }

// TODO(david): doc
export type RunResult = { ok: true; operation: string } | { ok: false; error: string }

// TODO(david): doc
export function resolveOp(_body: unknown): OpResult {
  throw new Error("not yet")
}

// TODO(david): doc
export async function runOp(_root: string, _args: string[]): Promise<RunResult> {
  throw new Error("not yet")
}
