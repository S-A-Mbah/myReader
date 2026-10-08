/**
 * Runtime configuration: config.json, overridable by environment variables.
 *
 * Bind host: loopback only (PRD §7, "never expose the server on the network"). The one
 * exception is READALOUD_HOST=0.0.0.0, set by the Docker image: inside a container the
 * server must listen on the container's interface to be reachable at all, and exposure
 * is then controlled by publishing the port to the host's loopback only
 * (127.0.0.1:3000:3000 in compose.yaml). Any other value is ignored.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = process.env.READALOUD_HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
const DTYPES = new Set(['fp32', 'fp16', 'q8', 'q4', 'q4f16']);

/** @returns {Record<string, unknown>} */
function readConfigFile() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {};
    throw new Error(`config.json is not valid JSON: ${/** @type {Error} */ (err).message}`, { cause: err });
  }
}

/**
 * @typedef {Object} Config
 * @property {number} port
 * @property {string} model
 * @property {'fp32'|'fp16'|'q8'|'q4'|'q4f16'} dtype
 * @property {string} defaultVoice
 * @property {string} cacheDir absolute path for downloaded model files
 */

/** @returns {Config} */
export function loadConfig() {
  const file = readConfigFile();
  const env = process.env;
  const port = Number(env.PORT ?? env.READALOUD_PORT ?? file.port ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  const dtype = String(env.READALOUD_DTYPE ?? file.dtype ?? 'fp32');
  if (!DTYPES.has(dtype)) throw new Error(`Invalid dtype "${dtype}". Use one of: ${[...DTYPES].join(', ')}`);
  const cacheDir = path.resolve(ROOT, String(env.READALOUD_CACHE_DIR ?? file.cacheDir ?? '.cache/models'));
  return {
    port,
    model: String(file.model ?? 'onnx-community/Kokoro-82M-v1.0-ONNX'),
    dtype: /** @type {Config['dtype']} */ (dtype),
    defaultVoice: String(env.READALOUD_VOICE ?? file.defaultVoice ?? 'af_heart'),
    cacheDir,
  };
}
