import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { DATA_DIR } from "./config.ts";
import * as store from "./db.ts";

// A small sentence-embedding model, run in this process on the CPU. The ~23 MB download from
// Hugging Face happens once; after that the model loads from data/models and nothing leaves
// the machine.
const MODEL = "Xenova/all-MiniLM-L6-v2";
const BATCH = 32;

env.cacheDir = join(DATA_DIR, "models");
env.allowRemoteModels = !existsSync(join(env.cacheDir, MODEL, "onnx"));

let model: Promise<FeatureExtractionPipeline> | null = null;

function load(): Promise<FeatureExtractionPipeline> {
  model ??= pipeline("feature-extraction", MODEL, { dtype: "q8" }).catch((e) => {
    model = null; // retry on the next call
    throw e;
  });
  return model;
}

/** The text an article is judged by: headline, preview and feed tags. */
function input(job: store.EmbedJob): string {
  const tags = job.categories ? (JSON.parse(job.categories) as string[]).join(", ") : "";
  return [job.title, job.excerpt, tags && `Topics: ${tags}`].filter(Boolean).join("\n");
}

let running: Promise<number> | null = null;

/** Embeds every article and feedback row that lacks a vector. Returns how many were done. */
export function embedPending(): Promise<number> {
  running ??= (async () => {
    let done = 0;
    try {
      const fe = await load();
      for (let jobs = store.pendingEmbeddings(BATCH); jobs.length; jobs = store.pendingEmbeddings(BATCH)) {
        const out = await fe(jobs.map(input), { pooling: "mean", normalize: true });
        const dim = out.dims[1];
        const data = out.data as Float32Array;
        jobs.forEach((job, i) => store.saveEmbedding(job, data.slice(i * dim, (i + 1) * dim)));
        done += jobs.length;
      }
    } finally {
      running = null;
    }
    if (done) console.log(`[embed] ${done} new vectors`);
    return done;
  })();
  return running;
}
