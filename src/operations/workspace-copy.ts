import { cp } from "node:fs/promises";
import type { WorkspaceCopier } from "./ai-patch-driver.js";

// executeWorker() deliberately refuses any workspace containing .git (it
// must never be reachable from inside the isolated sandbox -- credentials,
// remote URLs, hooks, history). A patch is applied via `git apply`, which
// needs a real git repository, so the apply target and the verification
// sandbox can never be the same directory. This copies everything except
// .git from the git-apply workspace into a separate, clean destination that
// executeWorker's own check will accept.
export class GitIgnoringWorkspaceCopier implements WorkspaceCopier {
  async copy(source: string, destination: string): Promise<void> {
    await cp(source, destination, {
      recursive: true,
      filter: (path) => !path.split(/[\\/]/).includes(".git"),
      // Node's fs.cp() default (verbatimSymlinks: false) rewrites relative
      // symlinks to absolute paths pointing back at the *original* source
      // location -- exactly wrong here: node_modules/.bin/tsc is a relative
      // symlink ("../typescript/bin/tsc"), and without this flag the copy
      // resolves it to an absolute path back in the git-apply workspace
      // instead of the copy, so verification silently ran against stale or
      // missing binaries. verbatimSymlinks preserves the relative target
      // string as-is, which correctly re-resolves inside the new tree since
      // the relative structure is copied intact.
      verbatimSymlinks: true,
    });
  }
}
