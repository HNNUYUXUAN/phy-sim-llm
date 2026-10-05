import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { callPaperModel, publicPaperModelProfile, loadLocalSecretValues } from "./paper-models.mjs";
import { hash, saveJson } from "./experiment-preflight.mjs";

export const LIMIT_CNY = 200;
export const PRICES = Object.freeze({ input: 12, output: 36, visual: 36 });
export function reserveFor(role, messages, maxTokens, pricing = null, imageByteBound = 0) {
  const input = Buffer.byteLength(JSON.stringify(messages), "utf8") + (role === "visual" ? 4096 : 1024) + imageByteBound;
  const prices=pricing ?? (role === "visual" ? {input:0,output:0} : {input:PRICES.input,output:PRICES.output});
  // Reserve a second full output allowance for separately charged reasoning.
  return { inputTokens: input, outputTokens: maxTokens * 2,
    cny: (input * prices.input + maxTokens * 2 * prices.output) / 1e6,
    visualTokens: role === "visual" && !pricing ? input + maxTokens : 0,
    ...(pricing ? {pricing} : {}) };
}
export function chargeFor(role, usage, reserve) {
  const input = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  const reasoning = reserve.completionIncludesReasoning ? 0 : usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? 0;
  // Adding reported reasoning even if included is intentionally conservative.
  if (!Number.isFinite(input) || !Number.isFinite(completion)) return { ...reserve, basis: "reserved-upper-bound-usage-unavailable" };
  const output = completion + reasoning;
  if (input > reserve.inputTokens || output > reserve.outputTokens) throw new Error("Provider usage exceeds the reserved token bound; stop and reconcile billing");
  const prices=reserve.pricing ?? (role === "visual" ? {input:0,output:0} : {input:PRICES.input,output:PRICES.output});
  return { inputTokens: input, outputTokens: output,
    cny: (input * prices.input + output * prices.output) / 1e6,
    visualTokens: role === "visual" && !reserve.pricing ? input + completion : 0,
    basis: "reported-usage-conservative-reasoning" };
}
async function maybeJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
export class Journal {
  constructor(root, profiles, options={}) { this.root = root; this.profiles = profiles; this.calls = []; this.category=options.category ?? 'access'; this.transport=options.transport ?? callPaperModel; }
  async init() {
    await mkdir(join(this.root, "calls"), { recursive: true });
    this.manifestPath = join(this.root, "budget.json");
    const prior = await maybeJson(this.manifestPath);
    if (prior) {
      this.calls=prior.calls;
      for(const c of this.calls){const r=await maybeJson(join(this.root,'calls',c.id+'.json'));if(!r || r.status!==c.status)throw Error('Call/budget journal mismatch: '+c.id);if(r.result && r.responseHash!==hash(JSON.stringify(r.result)))throw Error('Cached response hash mismatch: '+c.id);}
      return this;
    }
    await this.persist(); return this;
  }
  async persist() {
    const spentCny = this.calls.reduce((n, c) => n + (c.cost?.cny ?? c.reserve.cny), 0);
    const visualTokens = this.calls.reduce((n, c) => n + (c.cost?.visualTokens ?? c.reserve.visualTokens), 0);
    const categoryLimits={access:15,formal:145,repair:40};
    const categories=Object.fromEntries(Object.entries(categoryLimits).map(([k,limit])=>[k,{limitCny:limit,spentCny:this.calls.filter(c=>(c.category??'access')===k).reduce((n,c)=>n+(c.cost?.cny??c.reserve.cny),0)}]));
    await saveJson(this.manifestPath, { limitCny: LIMIT_CNY, authorization:'explicit live invocation with --budget-cny 200', spentCny, remainingCny: LIMIT_CNY - spentCny,categories, prices: PRICES, calls: this.calls });
  }
  async call(id, role, { messages, imagePaths, maxTokens, maxCompletionTokens,thinkingBudget, temperature = 0.2, stream, enableThinking, timeoutMs = 240000, onProgress }) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid immutable call id");
    const path = join(this.root, "calls", id + ".json");
    const existing = await maybeJson(path);
    const request = { model: this.profiles[role].modelId, messages, maxTokens, temperature,
      ...(this.profiles[role].authEpoch ? {provider:this.profiles[role].provider,endpoint:this.profiles[role].endpoint,authEpoch:this.profiles[role].authEpoch} : {}),
      ...(maxCompletionTokens ? {maxCompletionTokens} : {}),...(thinkingBudget!==undefined ? {thinkingBudget} : {}),
      ...(stream !== undefined ? { stream } : {}),
      ...(enableThinking !== undefined ? { enableThinking } : {}),
      ...(imagePaths ? { images: await Promise.all(imagePaths.map(async image => ({ sha256: hash(await readFile(image)), file: image.replaceAll("\\", "/").split("/").at(-1) }))) } : {}) };
    const requestHash = hash(JSON.stringify(request));
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error(`Frozen request changed on resume: ${id}`);
      if (existing.status === "complete") return existing.result;
      throw new Error(`Call ${id} is ${existing.status}; no automatic retry permitted`);
    }
    if (this.calls.some(c => c.status === "pending" || (c.status === "unknown" && !c.continuationAuthorized))) throw new Error("A previous call has an unresolved transport outcome");
    const imageByteBound=this.profiles[role].provider !== "iflytek-spark-image" && imagePaths ? (await Promise.all(imagePaths.map(async image=>Math.ceil((await readFile(image)).length*4/3)))).reduce((a,b)=>a+b,0) : 0;
    const inputBound = Buffer.byteLength(JSON.stringify(messages),"utf8") + (role === "visual" ? 4096 : 1024) + imageByteBound;
    const tiers = this.profiles[role].pricingTiers;
    const tier = tiers?.find(t => inputBound <= t.max);
    if(tiers && !tier) throw new Error("Conservative input bound exceeds verified model context/pricing range");
    const reserve = reserveFor(role, messages, maxCompletionTokens??maxTokens, tier ? {input:tier.input,output:tier.output} : this.profiles[role].pricing ?? null, imageByteBound);
    if(maxCompletionTokens){reserve.outputTokens=maxCompletionTokens+10;reserve.cny=(reserve.inputTokens*reserve.pricing.input+reserve.outputTokens*reserve.pricing.output)/1e6;reserve.completionIncludesReasoning=true;}
    const spent = this.calls.reduce((n, c) => n + (c.cost?.cny ?? c.reserve.cny), 0);
    const visualUsed = this.calls.reduce((n, c) => n + (c.cost?.visualTokens ?? c.reserve.visualTokens), 0);
    if (spent + reserve.cny > LIMIT_CNY) throw new Error(`Budget gate: next call would exceed ${LIMIT_CNY} CNY`);
    const categoryLimit={access:15,formal:145,repair:40}[this.category];
    if(!categoryLimit)throw Error('Invalid budget category');
    const categorySpent=this.calls.filter(c=>(c.category??'access')===this.category).reduce((n,c)=>n+(c.cost?.cny??c.reserve.cny),0);
    if(categorySpent+reserve.cny>categoryLimit)throw Error('Category budget gate: '+this.category);
    if (visualUsed + reserve.visualTokens > 2000000) throw new Error("Free image quota gate; paid vision calls are not authorized");
    const secrets = [...await loadLocalSecretValues(),...Object.values(this.profiles).flatMap(p => [p.credential, p.appId, p.apiKey, p.apiSecret]).filter(Boolean)];
    if (secrets.some(secret => JSON.stringify(request).includes(secret))) throw new Error("Credential in request material");
    const entry = { id, role, category:this.category,status: "pending", reserve };
    this.calls.push(entry);
    await this.persist();
    const record = { id, role, status: "pending", profile: publicPaperModelProfile(this.profiles[role]), request, requestHash, reserve, startedAt: new Date().toISOString() };
    await saveJson(path, record);
    const started = Date.now();
    let lastProgress = 0;
    let progressWrite = Promise.resolve();
    const captureProgress = progress => {
      onProgress?.(progress);
      if (Date.now()-lastProgress < 2000) return;
      lastProgress=Date.now();
      const safe = {id,at:new Date().toISOString(),...progress};
      progressWrite = progressWrite.then(() => saveJson(join(this.root,"calls",id+"-progress.json"),safe));
    };
    try {
      const result = await this.transport(role, { profiles: this.profiles, messages, imagePaths, maxTokens,maxCompletionTokens,thinkingBudget, temperature, stream, enableThinking, timeoutMs, onProgress:captureProgress });
      let scrubbed = JSON.stringify(result);
      for (const secret of secrets) scrubbed = scrubbed.split(secret).join("[REDACTED]");
      record.result = JSON.parse(scrubbed);
      record.status = "complete";
      entry.cost = chargeFor(role, result.usage, reserve);
      entry.status = "complete";
      record.responseHash = hash(scrubbed);
    } catch (error) {
      record.status = error.evidence ? "failed-known" : "unknown";
      record.error = error.message;
      for (const secret of secrets) record.error = record.error.split(secret).join('[REDACTED]');
      if (error.evidence) record.evidence = error.evidence;
      if (error.partialEvidence) {
        let partial = JSON.stringify(error.partialEvidence);
        for (const secret of secrets) partial = partial.split(secret).join("[REDACTED]");
        record.partialEvidence = JSON.parse(partial);
      }
      entry.status = record.status;
      entry.cost = chargeFor(role, error.evidence?.usage, reserve);
      throw error;
    } finally {
      await progressWrite;
      record.durationMs = Date.now() - started; record.finishedAt = new Date().toISOString();
      await saveJson(path, record); await this.persist();
    }
    return record.result;
  }
}
