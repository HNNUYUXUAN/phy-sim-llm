import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const PAPER_MODEL_ROLES = Object.freeze(['visual','coder']);
const BAILIAN_MODELS = Object.freeze({visual:'qwen3.7-plus-2026-05-26',coder:'qwen3.8-max-0902'});
const BAILIAN_ALLOWED = new Set([...Object.values(BAILIAN_MODELS),"qwen3.7-plus-2026-05-26","qwen3.8-max-0902","qwen3.7-max-2026-06-08"]);
const pricingForModel = id => id.includes('3.8-max') || id.includes('3.7-max') ? [{max:1000000,input:12,output:36}] : id.includes('3.7-plus') ? [{max:256000,input:2,output:8},{max:1000000,input:6,output:24}] : id.includes('vl-plus') ? [{max:32000,input:1,output:10},{max:128000,input:1.5,output:15},{max:256000,input:3,output:30}] : [{max:32000,input:4,output:16},{max:128000,input:6,output:24},{max:256000,input:10,output:40},{max:1000000,input:20,output:200}];
export function validateBailianBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port ||
      !(url.hostname === "dashscope.aliyuncs.com" || /^(?:llm|ws)-[a-z0-9]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname)) ||
      url.pathname.replace(/\/$/, "") !== "/compatible-mode/v1") throw new Error("Bailian requires an official Beijing compatible-mode/v1 endpoint");
  return url.href.replace(/\/$/, "");
}
const DEFAULT_MAX_TOKENS = Object.freeze({ visual: 128, coder: 512 });

export function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const separator = trimmed.indexOf("=");
    if (separator <= 0) return [];
    const value = trimmed.slice(separator + 1).trim();
    return [[trimmed.slice(0, separator).trim(), /^(["']).*\1$/.test(value) ? value.slice(1,-1) : value]];
  }));
}

async function readLocalEnv(envPath) {
  try {
    return parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}
export async function loadLocalSecretValues() {
  const entries = [...Object.entries(await readLocalEnv(join(root,".env"))),...Object.entries(process.env)];
  return [...new Set(entries.filter(([name,value])=>/(?:API_KEY|API_SECRET|API_PASSWORD|APP_ID)$/.test(name) && value).map(([,value])=>value))];
}

function requiredValue(env, name) {
  return typeof env[name] === "string" ? env[name].trim() : "";
}

function buildProfile(role, env, route = "bailian", options = {}) {
  if (route === "bailian") {
    if (!BAILIAN_MODELS[role]) throw new Error("Unknown paper model role");
    const baseUrl = validateBailianBaseUrl(requiredValue(env,"DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1");
    const modelId=options.modelIds?.[role] ?? BAILIAN_MODELS[role];
    if(!BAILIAN_ALLOWED.has(modelId))throw Error('Unverified Bailian model ID');
    const pricingTiers=pricingForModel(modelId), last=pricingTiers.at(-1);
    return Object.freeze({role,route,provider:"alibaba-bailian",modelLabel:modelId,modelId,baseUrl,endpoint:baseUrl+"/chat/completions",credentialEnvName:"DASHSCOPE_API_KEY",credential:requiredValue(env,"DASHSCOPE_API_KEY"),credentialSource:options.preferLocalEnv?'local-env-first':'process-env-first',authEpoch:options.authEpoch ?? null,
      pricing:{input:last.input,output:last.output},pricingTiers,visualFreeQuota:false});
  }
  throw new Error('Only the Bailian Qwen route is supported');
}

export async function loadPaperModelProfiles(options = {}) {
  const envPath = options.envPath ?? join(root, ".env");
  const localEnv = await readLocalEnv(envPath);
  const env = options.preferLocalEnv ? {...process.env,...localEnv,...(options.env??{})} : { ...localEnv, ...process.env, ...(options.env ?? {}) };
  return Object.freeze(Object.fromEntries(PAPER_MODEL_ROLES.map((role) => [role, buildProfile(role, env, options.route ?? "bailian",options)])));
}

export function validatePaperModelProfile(profile) {
  if (profile?.route === "bailian") {
    const errors=[];
    if(profile.provider!=="alibaba-bailian" || !BAILIAN_ALLOWED.has(profile.modelId) || !BAILIAN_MODELS[profile.role]) errors.push("Invalid frozen Bailian model");
    try { if(validateBailianBaseUrl(profile.baseUrl)+"/chat/completions"!==profile.endpoint) errors.push("Invalid endpoint"); } catch {errors.push("Unapproved Bailian endpoint");}
    return errors;
  }
  return ['Only the Bailian Qwen route is supported'];
}

export function publicPaperModelProfile(profile) {
  return Object.freeze({
    role: profile.role,
    ...(profile.authEpoch ? {authEpoch:profile.authEpoch,credentialSource:profile.credentialSource} : {}),
    ...(profile.route ? { route:profile.route,pricing:profile.pricing,...(profile.pricingTiers ? {pricingTiers:profile.pricingTiers} : {}) } : {}),
    provider: profile.provider,
    modelLabel: profile.modelLabel,
    ...(profile.legacyModelId ? { legacyModelId: profile.legacyModelId } : {}),
    modelId: profile.modelId,
    baseUrl: profile.baseUrl,
    endpoint: profile.endpoint,
    credentialEnvName: profile.credentialEnvName,
    credentialConfigured: profile.provider === "iflytek-spark-image" ? Boolean(profile.appId && profile.apiKey && profile.apiSecret) : Boolean(profile.credential)
  });
}

export async function callPaperModel(role, options) {
  if (!Array.isArray(options?.messages) || options.messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  const profiles = options.profiles ?? await loadPaperModelProfiles(options);
  const profile = profiles[role];
  if (!profile) throw new Error(`Unknown paper model role: ${role}`);
  const errors = validatePaperModelProfile(profile);
  if (errors.length) throw new Error(`Paper model configuration is invalid: ${errors.join("; ")}`);
  if (!profile.credential) {
    throw new Error(`${role} credential is not configured; fill ${profile.credentialEnvName} in .env`);
  }

  let messages=options.messages;
  if (role === "visual") {
    if (!Array.isArray(options.imagePaths) || options.imagePaths.length !== 1) throw new Error("One image is required for Qwen visual requests");
    const bytes=await readFile(options.imagePaths[0]);
    if(bytes.length>4*1024*1024) throw new Error("Visual image exceeds 4 MiB");
    const mime=bytes[0]===0x89 ? "image/png" : bytes[0]===0xff ? "image/jpeg" : null;
    if(!mime) throw new Error("Visual image must be PNG/JPEG");
    messages=[{role:"user",content:[{type:"image_url",image_url:{url:`data:${mime};base64,${bytes.toString("base64")}`}},{type:"text",text:options.messages.map(m=>`${m.role}: ${m.content}`).join("\n\n")}]}];
  }
  const requestBody = {
    model: profile.modelId,
    messages,
    temperature: options.temperature ?? 0.1,
    ...(options.maxCompletionTokens ? {max_completion_tokens:options.maxCompletionTokens} : {max_tokens:options.maxTokens ?? DEFAULT_MAX_TOKENS[role]}),
    stream: options.stream ?? false,
    ...(options.stream ? { stream_options: { include_usage: true } } : {}),
    ...(typeof options.enableThinking === "boolean" ? { enable_thinking: options.enableThinking } : {}),
    ...(Number.isInteger(options.thinkingBudget) ? {thinking_budget:options.thinkingBudget} : {})
  };
  const fetchImpl = options.fetch ?? fetch;
  let response;
  try {
    response = await fetchImpl(profile.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${profile.credential}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000)
    });
  } catch (error) {
    throw new Error(`${role} transport outcome is unknown; no automatic retry was attempted`, { cause: error });
  }

  let responseText;
  if (requestBody.stream && response.ok) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", content = "", reasoning = "", usage = null, requestId = null, servedModel = null, finishReason = null, done = false;
    const accept = line => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { done = true; return; }
      if (!payload) return;
      const frame = JSON.parse(payload);
      if (frame.error) throw new Error("Provider returned a stream error");
      requestId = frame.id ?? frame.sid ?? requestId;
      servedModel = frame.model ?? servedModel;
      usage = frame.usage ?? usage;
      const choice = frame.choices?.[0];
      content += choice?.delta?.content ?? "";
      reasoning += choice?.delta?.reasoning_content ?? "";
      finishReason = choice?.finish_reason ?? finishReason;
      options.onProgress?.({ requestId, usage, finishReason, contentLength: content.length, reasoningLength: reasoning.length });
    };
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const line of lines) accept(line);
        if (chunk.done) { if (buffer) accept(buffer); break; }
      }
      if (!done || !finishReason) throw new Error("Stream ended without completion");
    } catch (cause) {
      const error = new Error(`${role} stream outcome is unknown; no automatic retry was attempted`, { cause });
      error.partialEvidence = { httpStatus: response.status, requestId, usage, finishReason, partialContent: content, partialReasoning: reasoning };
      throw error;
    } finally { reader.releaseLock(); }
    responseText = JSON.stringify({ id: requestId, model:servedModel, usage, choices: [{ finish_reason: finishReason, message: { content, reasoning_content: reasoning } }] });
  } else {
    try { responseText = await response.text(); }
    catch (cause) { throw new Error(`${role} response body outcome is unknown; no automatic retry was attempted`, { cause }); }
  }
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = { unparsedText: responseText };
  }
  // The authenticated request is never logged. Provider output is scrubbed before
  // retaining diagnostic evidence, including successful but empty completions.
  const secretValues = [profile.credential, profile.appId, profile.apiKey, profile.apiSecret].filter(Boolean);
  let sanitizedResponse = JSON.stringify(responseBody);
  for (const secret of secretValues) sanitizedResponse = sanitizedResponse.split(secret).join("[REDACTED]");
  const evidence = {
    httpStatus: response.status,
    requestId: responseBody?.id ?? responseBody?.sid ?? null,
    finishReason: responseBody?.choices?.[0]?.finish_reason ?? null,
    usage: responseBody?.usage ?? null,
    response: JSON.parse(sanitizedResponse)
  };
  if (!response.ok) {
    const error = new Error(`${role} failed with HTTP ${response.status}; no automatic retry was attempted`);
    error.evidence = evidence;
    throw error;
  }
  if(evidence.finishReason === 'length'){
    const error=new Error(`${role} returned a known truncated completion; not applied`);error.evidence=evidence;throw error;
  }
  if (!evidence.finishReason) {
    const error = new Error(`${role} completion status is unknown; not applied`);
    error.partialEvidence = evidence;
    throw error;
  }
  const content = responseBody?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const error = new Error(`${role} returned no message content`);
    error.evidence = evidence;
    throw error;
  }
  return Object.freeze({
    profile: publicPaperModelProfile(profile),
    httpStatus: response.status,
    content: content.trim(),
    servedModel:responseBody?.model ?? null,
    usage: responseBody?.usage ?? null,
    requestId: responseBody?.id ?? responseBody?.sid ?? null,
    finishReason: responseBody?.choices?.[0]?.finish_reason ?? null,
    response: evidence.response
  });
}
