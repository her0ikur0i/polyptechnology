import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeBranch,
  isSafeRemoteUrl,
} from "../src/control-api/project-push.js";

test("branch names reject shell metacharacters and traversal", () => {
  assert.equal(isSafeBranch("main"), true);
  assert.equal(isSafeBranch("feature/issue-42"), true);
  assert.equal(isSafeBranch("release-1.2.3"), true);
  assert.equal(isSafeBranch("main; rm -rf /"), false);
  assert.equal(isSafeBranch("../../etc/passwd"), false);
  assert.equal(isSafeBranch("$(whoami)"), false);
  assert.equal(isSafeBranch("-"), false);
  assert.equal(isSafeBranch(""), false);
});

test("remote URLs allow real transports but reject local paths", () => {
  assert.equal(isSafeRemoteUrl("https://github.com/her0ikur0i/repo.git"), true);
  assert.equal(
    isSafeRemoteUrl("https://x-access-token:tok@github.com/u/r.git"),
    true,
  );
  assert.equal(isSafeRemoteUrl("ssh://git@github.com/u/r.git"), true);
  assert.equal(isSafeRemoteUrl("git@github.com:u/r.git"), true);
  assert.equal(isSafeRemoteUrl("/etc/passwd"), false);
  assert.equal(isSafeRemoteUrl("../secrets"), false);
  assert.equal(isSafeRemoteUrl("file:///etc/passwd"), false);
  assert.equal(isSafeRemoteUrl(""), false);
});
