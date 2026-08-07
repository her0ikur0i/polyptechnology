import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalService } from "../src/approvals/service.js";
import { MemoryApprovalRepository } from "../src/approvals/memory-repository.js";
import { generateApprovalToken, hashApprovalToken, parseApprovalToken } from "../src/approvals/token.js";
import { handleTelegramCallback, parseTelegramCallback, TelegramApprovalGateway, type TelegramTransport } from "../src/telegram/gateway.js";

const target={kind:"command",id:"deploy-1",summary:"Deploy release",risk:"L3",rollback:"Restore prior release"};

test("tokens are opaque, unique, and persisted only as hashes",()=>{const a=generateApprovalToken(),b=generateApprovalToken();assert.notEqual(a,b);assert.equal(parseApprovalToken(a),a);assert.notEqual(hashApprovalToken(a),a);assert.equal(parseApprovalToken("bad"),undefined);});

test("authorized decision is terminal, audited, and replay-safe",async()=>{const repo=new MemoryApprovalRepository();const service=new ApprovalService(repo,"chat","user");const requested=await service.request(target,60_000,new Date(1_000));const result=await service.decide(requested.token,"approved","chat","user",new Date(2_000));assert.equal(result.outcome,"decided");assert.equal((await repo.find(requested.approvalId))?.status,"approved");assert.equal((await service.decide(requested.token,"denied","chat","user",new Date(3_000))).outcome,"replayed");assert.equal(repo.events.length,2);assert.equal(repo.audit.length,2);assert.ok(!JSON.stringify(repo.events).includes(requested.token));});

test("wrong chat, wrong user, forged, and expired callbacks fail closed",async()=>{for(const [chat,user,now,outcome] of [["wrong","user",2_000,"unauthorized"],["chat","wrong",2_000,"unauthorized"],["chat","user",62_000,"expired"]] as const){const repo=new MemoryApprovalRepository();const service=new ApprovalService(repo,"chat","user");const req=await service.request(target,60_000,new Date(1_000));assert.equal((await service.decide(req.token,"approved",chat,user,new Date(now))).outcome,outcome);assert.equal((await repo.find(req.approvalId))?.status,"pending");}const service=new ApprovalService(new MemoryApprovalRepository(),"chat","user");assert.equal((await service.decide("A".repeat(43),"approved","chat","user")).outcome,"invalid");});

test("repository reconstruction retains durable state abstraction",async()=>{const repo=new MemoryApprovalRepository();const first=new ApprovalService(repo,"chat","user");const req=await first.request(target,60_000,new Date(1_000));const reconstructed=new ApprovalService(repo,"chat","user");assert.equal((await reconstructed.decide(req.token,"denied","chat","user",new Date(2_000))).outcome,"decided");});

test("Telegram delivery failure leaves approval pending",async()=>{const repo=new MemoryApprovalRepository();const service=new ApprovalService(repo,"chat","user");const req=await service.request(target,60_000,new Date(1_000));const transport:TelegramTransport={send:async()=>{throw new Error("offline");}};await assert.rejects(new TelegramApprovalGateway(transport,"chat").deliver(target.summary,req.token,new Date(61_000)),/offline/);assert.equal((await repo.find(req.approvalId))?.status,"pending");});

test("Telegram callback parser requires exact action, token, chat, and user",()=>{const token=generateApprovalToken();assert.deepEqual(parseTelegramCallback({callback_query:{data:`approve:${token}`,from:{id:22},message:{chat:{id:11}}}}),{decision:"approved",token,chatId:"11",userId:"22"});assert.equal(parseTelegramCallback({callback_query:{data:"approve:bad",from:{id:22},message:{chat:{id:11}}}}),undefined);assert.equal(parseTelegramCallback({callback_query:{data:`approve:${token}`,from:{id:22}}}),undefined);});

test("Telegram handler delegates only a structurally valid callback",async()=>{const token=generateApprovalToken();let calls=0;const service={decide:async()=>{calls+=1;return {outcome:"decided"};}};assert.equal((await handleTelegramCallback({},service)).outcome,"invalid");assert.equal(calls,0);assert.equal((await handleTelegramCallback({callback_query:{data:`deny:${token}`,from:{id:"user"},message:{chat:{id:"chat"}}}},service)).outcome,"decided");assert.equal(calls,1);});
