import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VENDOR_DIR = `${REPO_ROOT}/vendor/problem-specifications`;
export const CORPUS_DIR = `${REPO_ROOT}/corpus`;
export const REFERENCES_DIR = `${REPO_ROOT}/references`;
export const DATA_DIR = `${REPO_ROOT}/data`;

/** Where the Aven workspace lives; overridable for CI or a pinned checkout. */
export const AVEN_LANG_DIR =
  process.env["AVEN_LANG_DIR"] ?? resolve(REPO_ROOT, "..", "aven-lang");
