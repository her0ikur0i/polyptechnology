import type { Account, Evaluation, Model, Provider, UsageAttribution } from "./types.js";

export class ProviderRegistry {
  private providers=new Map<string,Provider>(); private accounts=new Map<string,Account>(); private models=new Map<string,Model>();
  private readonly evaluations:Evaluation[]=[]; private readonly usage:UsageAttribution[]=[];
  addProvider(value:Provider):void{if(this.providers.has(value.id))throw new Error("duplicate provider");this.providers.set(value.id,{...value});}
  addAccount(value:Account):void{if(!this.providers.has(value.providerId))throw new Error("unknown provider");if(!value.secretRef.startsWith("secret://"))throw new Error("account requires a secret reference");if(this.accounts.has(value.id))throw new Error("duplicate account");this.accounts.set(value.id,{...value});}
  addModel(value:Model):void{const account=this.accounts.get(value.accountId);if(account===undefined||account.providerId!==value.providerId)throw new Error("model account/provider mismatch");if(this.models.has(value.id))throw new Error("duplicate model");const prices=[...value.prices].sort((a,b)=>a.effectiveFrom.getTime()-b.effectiveFrom.getTime());for(let i=1;i<prices.length;i++){const previous=prices[i-1]!,current=prices[i]!;if(previous.effectiveTo===undefined||previous.effectiveTo>current.effectiveFrom)throw new Error("model price periods overlap");}this.models.set(value.id,{...value,capabilities:new Set(value.capabilities),prices:value.prices.map(p=>({...p}))});}
  addEvaluation(value:Evaluation):void{if(!this.models.has(value.modelId))throw new Error("unknown model");if(value.quality<0||value.quality>1||value.successRate<0||value.successRate>1)throw new Error("evaluation scores must be 0..1");this.evaluations.push({...value});}
  addUsage(value:UsageAttribution):void{for(const key of [value.providerId,value.accountId,value.modelId,value.agentId,value.projectId,value.contractId,value.taskId,value.attemptId])if(key.length===0)throw new Error("usage attribution is incomplete");const account=this.accounts.get(value.accountId),model=this.models.get(value.modelId);if(!this.providers.has(value.providerId)||account?.providerId!==value.providerId||model?.accountId!==value.accountId)throw new Error("usage attribution references an unknown or mismatched registry entry");this.usage.push({...value});}
  listModels():ReadonlyArray<Model>{return [...this.models.values()].map(m=>({...m,capabilities:new Set(m.capabilities),prices:m.prices.map(p=>({...p}))}));}
  provider(id:string):Provider|undefined{const value=this.providers.get(id);return value===undefined?undefined:{...value};}
  account(id:string):Account|undefined{const value=this.accounts.get(id);return value===undefined?undefined:{...value};}
  evaluationScore(modelId:string):number|undefined{const rows=this.evaluations.filter(e=>e.modelId===modelId&&e.securityPass);if(rows.length===0)return undefined;return rows.reduce((n,e)=>n+e.quality*e.successRate,0)/rows.length;}
  hasFailedSecurityEvaluation(modelId:string):boolean{return this.evaluations.some(e=>e.modelId===modelId&&!e.securityPass);}
  usageRecords():ReadonlyArray<UsageAttribution>{return this.usage.map(u=>({...u}));}
}
