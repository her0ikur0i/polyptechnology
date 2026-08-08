import {
  publicationPlan,
  publicationPush,
  validateGitArguments,
  validateOwnedPaths,
  type Command,
  type PublicationContext,
} from "./git-publication.js";
import type { ContractPublication, Gate } from "./types.js";
export interface GitExecutor {
  execute(command: Command): Promise<void>;
  head(cwd: string): Promise<string>;
  parents(sha: string, cwd: string): Promise<ReadonlyArray<string>>;
  changedPaths(
    baselineSha: string,
    sha: string,
    cwd: string,
  ): Promise<ReadonlyArray<string>>;
  contractId(sha: string, cwd: string): Promise<string | undefined>;
}
export interface PublicationRecorder {
  assertGates(contractId: string, gates: ReadonlyArray<Gate>): Promise<void>;
  preparing(contractId: string, baselineSha: string): Promise<void>;
  prepared(contractId: string, sha: string): Promise<void>;
  published(contractId: string, sha: string): Promise<void>;
}
export async function publishContract(
  contract: ContractPublication,
  context: PublicationContext,
  git: GitExecutor,
  recorder: PublicationRecorder,
): Promise<string> {
  validateGitArguments(contract, context);
  await recorder.assertGates(contract.contractId, contract.gates);
  if (
    contract.preparing === true &&
    contract.preparedSha === undefined &&
    context.headSha !== contract.baselineSha
  ) {
    const parents = await git.parents(context.headSha, context.repositoryPath),
      trailer = await git.contractId(context.headSha, context.repositoryPath),
      paths = await git.changedPaths(
        contract.baselineSha,
        context.headSha,
        context.repositoryPath,
      );
    if (
      parents.length !== 1 ||
      parents[0] !== contract.baselineSha ||
      trailer !== contract.contractId ||
      paths.length === 0
    )
      throw new Error("cannot reconcile prepared publication");
    validateOwnedPaths(paths, contract.ownedPaths);
    await recorder.prepared(contract.contractId, context.headSha);
    await git.execute(publicationPush(context.headSha, context));
    await recorder.published(contract.contractId, context.headSha);
    return context.headSha;
  }
  const plan = publicationPlan(contract, context);
  if (contract.preparedSha !== undefined) {
    await git.execute(plan[0]!);
    await recorder.published(contract.contractId, contract.preparedSha);
    return contract.preparedSha;
  }
  if (contract.preparing !== true)
    await recorder.preparing(contract.contractId, contract.baselineSha);
  await git.execute(plan[0]!);
  await git.execute(plan[1]!);
  const sha = await git.head(context.repositoryPath);
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error("invalid prepared commit SHA");
  await recorder.prepared(contract.contractId, sha);
  await git.execute(publicationPush(sha, context));
  await recorder.published(contract.contractId, sha);
  return sha;
}
