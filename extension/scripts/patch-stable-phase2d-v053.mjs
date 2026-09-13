import fs from 'node:fs';

const path = 'src/guitarEarBrowser.js';
let text = fs.readFileSync(path, 'utf8');
const marker = `  ort.env.wasm.wasmPaths = {\n    mjs: ORT_MJS_URL(),\n    wasm: ORT_WASM_URL(),\n  };\n`;
if (!text.includes(marker)) throw new Error('missing ORT wasm setup marker');

const stableBlock = `${marker}\n  // v0.5.3 stable product baseline: keep the proven Phase-2d acoustic model.\n  // Phase-2e remains in source for later A/B work, but is intentionally not\n  // selected in this package so stroke-density is the only musical variable.\n  {\n    const session = await ort.InferenceSession.create(PHASE2D_MODEL_URL(), {\n      executionProviders: ['wasm'],\n      graphOptimizationLevel: 'all',\n      externalData: [{\n        path: 'guitar-ear-v0.2d-core.onnx.data',\n        data: PHASE2D_MODEL_DATA_URL(),\n      }],\n    });\n    return {\n      session,\n      phase: 'phase2d-stable',\n      model: PHASE2D_MODEL_NAME,\n      modelSha256: null,\n      graphOptimizationLevel: 'all',\n      fallbackReason: null,\n    };\n  }\n`;

text = text.replace(marker, stableBlock);
fs.writeFileSync(path, text);
console.log('STABLE_PHASE2D_V053_PATCH_OK');
